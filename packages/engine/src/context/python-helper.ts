/** Fixed trusted program: source files arrive only as JSON data on stdin. */
export const PYTHON_HELPER = String.raw`
import sys, resource
resource.setrlimit(resource.RLIMIT_CPU, (3, 3))
if sys.platform != 'darwin': resource.setrlimit(resource.RLIMIT_AS, (268435456, 268435456))
resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
import ast, symtable, json, hashlib, posixpath

max_rss_kib = 256 * 1024
def check_peak_rss():
    # ru_maxrss is bytes on macOS and KiB on Linux. Unlike a parent ps sample,
    # this high-water mark cannot miss a short-lived analyzer's peak allocation.
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if sys.platform == 'darwin': peak /= 1024
    if peak > max_rss_kib: raise MemoryError('RSS limit')

def main():
    global max_rss_kib
    payload = json.loads(sys.stdin.buffer.read(16777217))
    max_rss_kib = payload['maxRssKiB']
    if type(max_rss_kib) is not int or not 0 < max_rss_kib <= 256 * 1024: raise ValueError('RSS limit')
    check_peak_rss()
    files = payload['files']
    limit = payload['maxNodes']
    if len(files) > 500: raise ValueError('file limit')
    diagnostics, updates, scopes, calls, imports, writes, mutations = set(), [], {}, [], [], [], []
    count = 0
    def note(message): diagnostics.add(message)
    def bind(scope, name, value): scope['bindings'].setdefault(name, []).append(value)
    def symbol(file, node):
        matches = [item for item in file['symbols'] if item['name'] == node.name and item['source']['startLine'] == node.lineno and item['kind'] != 'file']
        return matches[0]['id'] if len(matches) == 1 else None
    def child_table(table, node):
        found = [item for item in table.get_children() if item.get_name() == node.name and item.get_lineno() == node.lineno]
        return found[0] if len(found) == 1 else None
    def create_scope(file, table, parent=None, kind='module'):
        return {'file':file, 'table':table, 'parent':parent, 'kind':kind, 'bindings':{}, 'loaded':set(), 'unsafe':False}
    def scan(node, scope, conditional=False):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            kind = 'class' if isinstance(node, ast.ClassDef) else 'function'
            target = symbol(scope['file'], node)
            bind(scope,node.name,('definition',target) if target and not conditional and not node.decorator_list else ('unknown',None))
            table = child_table(scope['table'],node)
            if table is None: return
            child = create_scope(scope['file'],table,scope,kind)
            if kind == 'function':
                for argument in list(node.args.posonlyargs)+list(node.args.args)+list(node.args.kwonlyargs)+([node.args.vararg] if node.args.vararg else [])+([node.args.kwarg] if node.args.kwarg else []): bind(child,argument.arg,('unknown',None))
            for item in node.body: scan(item,child)
            # Defaults, annotations, decorators, metaclasses and bases execute
            # in other scopes; deliberately omit calls there rather than guess.
            return
        if isinstance(node,(ast.Lambda,ast.ListComp,ast.SetComp,ast.DictComp,ast.GeneratorExp)):
            # Assignment expressions inside comprehensions can mutate an outer
            # binding; reject those names even though calls here are omitted.
            for item in ast.walk(node):
                if isinstance(item,ast.NamedExpr) and isinstance(item.target,ast.Name): bind(scope,item.target.id,('unknown',None))
            return
        if isinstance(node,(ast.Global,ast.Nonlocal)):
            scope['unsafe']=True
            for name in node.names:
                parent=scope
                while parent:
                    bind(parent,name,('unknown',None)); parent=parent['parent']
            return
        if isinstance(node,ast.Name) and isinstance(node.ctx,(ast.Store,ast.Del)): bind(scope,node.id,('unknown',None))
        if isinstance(node,ast.Attribute) and isinstance(node.ctx,(ast.Store,ast.Del)): writes.append((scope,node))
        if isinstance(node,ast.ExceptHandler) and node.name: bind(scope,node.name,('unknown',None))
        if isinstance(node,(getattr(ast,'MatchAs',ast.Pass),getattr(ast,'MatchStar',ast.Pass))) and getattr(node,'name',None): bind(scope,node.name,('unknown',None))
        if isinstance(node,getattr(ast,'MatchMapping',ast.Pass)) and getattr(node,'rest',None): bind(scope,node.rest,('unknown',None))
        if isinstance(node,ast.Import):
            imports.append((scope,node))
            for item in node.names:
                if not conditional: scope['loaded'].add(item.name)
                bind(scope,item.asname or item.name.split('.')[0],('unknown',None) if conditional else ('module',item.name if item.asname else item.name.split('.')[0],0))
            return
        if isinstance(node,ast.ImportFrom):
            imports.append((scope,node))
            for item in node.names:
                if item.name == '*': scope['unsafe']=True; note('star imports remain unresolved')
                else: bind(scope,item.asname or item.name,('unknown',None) if conditional else ('import',node.module or '',node.level,item.name))
            return
        if isinstance(node,ast.Call):
            if isinstance(node.func,ast.Name) and node.func.id in ('eval','exec','globals','locals','__import__'):
                scopes[scope['file']['path']]['unsafe']=True; note('dynamic namespace evaluation remains unresolved')
            if isinstance(node.func,ast.Name) and node.func.id in ('setattr','delattr') and len(node.args)>=2: mutations.append((scope,node))
            calls.append((scope,node))
        branch = conditional or isinstance(node,(ast.If,ast.For,ast.AsyncFor,ast.While,ast.Try,ast.With,ast.AsyncWith,getattr(ast,'Match',ast.If),getattr(ast,'TryStar',ast.Try)))
        for child in ast.iter_child_nodes(node): scan(child,scope,branch)
    for file in files:
        if hashlib.sha256(file['text'].encode('utf-8')).hexdigest()!=file['hash']: note('stale source rejected'); continue
        try:
            tree=ast.parse(file['text'],filename=file['path'])
            table=symtable.symtable(file['text'],file['path'],'exec')
            count += sum(1 for _ in ast.walk(tree))
            if count > limit: raise ValueError('AST node limit')
            scope=create_scope(file,table); scopes[file['path']]=scope
            scan(tree,scope)
            if '__getattr__' in scope['bindings']: scope['unsafe']=True; note('dynamic module attributes remain unresolved')
        except (SyntaxError, RecursionError):
            if file['path'] in scopes: scopes[file['path']]['unsafe']=True
            note('syntax or compiler scope error; syntax evidence retained')
    def module(name,scope,level=0):
        parts=name.split('.') if name else []
        if any(not part.isidentifier() for part in parts): return None
        if level:
            package=scope['file']['path'].split('/')[:-1]
            if len(package)<level: return None
            parts=package[:len(package)-level+1]+parts
        if not parts: return None
        base='/'.join(parts)
        found=[path for path in (base+'.py',base+'/__init__.py') if path in scopes]
        if len(found)!=1: note('missing or ambiguous snapshot module remains unresolved'); return None
        if scopes[found[0]]['unsafe']: return None
        for index in range(1,len(parts)):
            initializer='/'.join(parts[:index])+'/__init__.py'
            if initializer not in scopes: note('namespace packages or unrepresented package roots remain unresolved'); return None
            if scopes[initializer]['unsafe']: return None
        return found[0]
    def lookup(scope,name):
        if scope['unsafe'] or scopes[scope['file']['path']]['unsafe']: return None
        try: entry=scope['table'].lookup(name)
        except KeyError: return None
        if scope['kind']!='module' and entry.is_global(): scope=scopes[scope['file']['path']]
        elif entry.is_free() or entry.is_nonlocal():
            scope=scope['parent']
            while scope and scope['kind']=='class': scope=scope['parent']
            return lookup(scope,name) if scope else None
        bindings=list(dict.fromkeys(scope['bindings'].get(name,[])))
        return (scope,bindings[0]) if len(bindings)==1 else None
    def resolve(found,seen=None,evidence=None):
        if not found: return None
        seen=set() if seen is None else seen
        evidence=set() if evidence is None else evidence
        scope,binding=found; identity=(scope['file']['path'],id(scope),binding)
        if identity in seen or len(seen)>64 or scope['unsafe'] or scopes[scope['file']['path']]['unsafe']: return None
        seen=seen|{identity}; evidence=evidence|{scope['file']['path']}
        if binding[0]=='definition': return ('symbol',binding[1],evidence)
        if binding[0]=='module':
            path=module(binding[1],scope,binding[2]); return ('module',path,evidence|{path}) if path else None
        if binding[0]=='import':
            path=module(binding[1],scope,binding[2])
            if not path: return None
            target=scopes[path]; name=binding[3]
            found=lookup(target,name)
            if found: return resolve(found,seen,evidence|{path})
            # Python can import a submodule from a regular package.
            if path.endswith('/__init__.py'):
                child=module(path[:-12].replace('/','.')+'.'+name,scope)
                if child: return ('module',child,evidence|{path,child})
        return None
    def expression(scope,node):
        if isinstance(node,ast.Name): return resolve(lookup(scope,node.id))
        if isinstance(node,ast.Attribute):
            parent=expression(scope,node.value)
            if parent and parent[0]=='module':
                target=scopes[parent[1]]
                found=lookup(target,node.attr)
                if found: return resolve(found,evidence=parent[2])
                if parent[1].endswith('/__init__.py'):
                    dotted=parent[1][:-12].replace('/','.')+'.'+node.attr
                    current=scope; loaded=False
                    while current:
                        if any(name==dotted or name.startswith(dotted+'.') for name in current['loaded']): loaded=True
                        current=current['parent']
                    if not loaded: return None
                    child=module(dotted,scope)
                    if child: return ('module',child,parent[2]|{child})
        return None
    # Module attribute writes make that export mutable across the whole snapshot.
    for scope,node in writes:
        parent=expression(scope,node.value)
        if parent and parent[0]=='module': bind(scopes[parent[1]],node.attr,('unknown',None))
    for scope,node in mutations:
        parent=expression(scope,node.args[0])
        if parent and parent[0]=='module':
            name=node.args[1]
            if isinstance(name,ast.Constant) and isinstance(name.value,str): bind(scopes[parent[1]],name.value,('unknown',None))
            else: scopes[parent[1]]['unsafe']=True
    def edge(scope,node,kind):
        file=scope['file']; lines=file['text'].splitlines(keepends=True)
        def offset(line,column):
            text=''.join(lines[:line-1])+lines[line-1].encode('utf-8')[:column].decode('utf-8')
            return len(text.encode('utf-16-le'))//2
        start=offset(node.lineno,node.col_offset); end=offset(node.end_lineno,node.end_col_offset)
        found=[item for item in file['edges'] if item['kind']==kind and file['spans']['edges'].get(item['id'])=={'start':start,'end':end}]
        return found[0] if len(found)==1 else None
    def update(scope,node,kind,target,evidence):
        item=edge(scope,node,kind)
        if not item or len(evidence)>64: return
        sources=[]
        for path in sorted(evidence):
            parts=path.split('/')
            ancestors=['/'.join(parts[:index])+'/__init__.py' for index in range(1,len(parts))]
            for source in [path]+ancestors:
                if source in scopes:
                    record=next(value['source'] for value in scopes[source]['file']['symbols'] if value['kind']=='file')
                    if record not in sources: sources.append(record)
        if len(sources)>64: note('binding provenance limit exceeded'); return
        updates.append({'edgeId':item['id'],'to':target,'sources':sources})
        if len(updates)>5000: raise ValueError('update limit')
    for scope,node in calls:
        if scope['unsafe']: continue
        target=expression(scope,node.func)
        if target and target[0]=='symbol': update(scope,node,'calls',target[1],target[2])
    for scope,node in imports:
        if scope['unsafe'] or scopes[scope['file']['path']]['unsafe']: continue
        paths=[module(item.name,scope) for item in node.names] if isinstance(node,ast.Import) else [module(node.module or '',scope,node.level)]
        if len(set(paths))==1 and paths[0]:
            path=paths[0]; target=next(item['id'] for item in scopes[path]['file']['symbols'] if item['kind']=='file')
            update(scope,node,'imports',target,{path})
    return {'version':'.'.join(map(str,sys.version_info[:3])),'updates':updates,'diagnostics':sorted(diagnostics),'analyzedFiles':len(scopes)}
try:
    output = json.dumps(main(),separators=(',',':')).encode('utf-8')
    check_peak_rss()
    sys.stdout.buffer.write(output)
except Exception:
    print(json.dumps({'version':'.'.join(map(str,sys.version_info[:3])),'updates':[],'diagnostics':['Python static analysis exceeded a resource limit or failed; syntax evidence retained'],'analyzedFiles':0}))
`;
