/** Only this fixed helper is compiled. Repository Java remains in-memory data. */
export const JAVA_HELPER = String.raw`
import java.io.*;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.security.MessageDigest;
import java.util.*;
import javax.lang.model.element.*;
import javax.tools.*;
import com.sun.source.tree.*;
import com.sun.source.util.*;

public final class SnapshotJava {
  static final int MAX_INPUT=16777216, MAX_SOURCE=4194304, MAX_FILES=64, MAX_UPDATES=5000;
  record Symbol(String id,String name,String kind,int start,int end){}
  record Edge(String id,String kind,int start,int end){}
  static final class Source extends SimpleJavaFileObject {
    final String path,text; final List<Symbol> symbols; final List<Edge> edges;
    Source(String path,String text,List<Symbol> symbols,List<Edge> edges)throws Exception{
      super(new URI("snapshot",null,"/"+path,null),Kind.SOURCE);this.path=path;this.text=text;this.symbols=symbols;this.edges=edges;
    }
    public CharSequence getCharContent(boolean ignored){return text;}
    public String getName(){return path;}
  }
  /** The sole delegated reads are platform types from the trusted JDK. */
  static final class SnapshotManager extends ForwardingJavaFileManager<StandardJavaFileManager>{
    SnapshotManager(StandardJavaFileManager manager){super(manager);}
    boolean platform(Location location){String n=location.getName();return n.equals("PLATFORM_CLASS_PATH")||n.equals("SYSTEM_MODULES")||n.startsWith("SYSTEM_MODULES[");}
    public boolean hasLocation(Location location){return platform(location)&&super.hasLocation(location);}
    public ClassLoader getClassLoader(Location location){return null;}
    public <S> ServiceLoader<S> getServiceLoader(Location location,Class<S> service)throws IOException{throw new IOException("Plugins disabled");}
    public Iterable<JavaFileObject> list(Location location,String name,Set<JavaFileObject.Kind> kinds,boolean recurse)throws IOException{return platform(location)?super.list(location,name,kinds,recurse):List.of();}
    public JavaFileObject getJavaFileForInput(Location location,String name,JavaFileObject.Kind kind)throws IOException{return platform(location)?super.getJavaFileForInput(location,name,kind):null;}
    public FileObject getFileForInput(Location location,String name,String relative)throws IOException{return platform(location)?super.getFileForInput(location,name,relative):null;}
    public JavaFileObject getJavaFileForOutput(Location location,String name,JavaFileObject.Kind kind,FileObject sibling)throws IOException{throw new IOException("Outputs disabled");}
    public FileObject getFileForOutput(Location location,String name,String relative,FileObject sibling)throws IOException{throw new IOException("Outputs disabled");}
    // On newer JDKs ForwardingJavaFileManager delegates these directly; declare
    // their signatures without @Override so the helper still builds on JDK 17.
    public JavaFileObject getJavaFileForOutputForOriginatingFiles(Location location,String name,JavaFileObject.Kind kind,FileObject... originating)throws IOException{throw new IOException("Outputs disabled");}
    public FileObject getFileForOutputForOriginatingFiles(Location location,String name,String relative,FileObject... originating)throws IOException{throw new IOException("Outputs disabled");}
    public Location getLocationForModule(Location location,String name)throws IOException{return platform(location)?super.getLocationForModule(location,name):null;}
    public Location getLocationForModule(Location location,JavaFileObject file)throws IOException{return platform(location)?super.getLocationForModule(location,file):null;}
    public Iterable<Set<Location>> listLocationsForModules(Location location)throws IOException{return platform(location)?super.listLocationsForModules(location):List.of();}
    public String inferModuleName(Location location)throws IOException{return platform(location)?super.inferModuleName(location):null;}
    public String inferBinaryName(Location location,JavaFileObject file){return platform(location)?super.inferBinaryName(location,file):null;}
    public boolean contains(Location location,FileObject file)throws IOException{return platform(location)&&super.contains(location,file);}
  }
  static int bounded(int value,int max){if(value<0||value>max)throw new IllegalArgumentException("Input limit");return value;}
  static String string(DataInputStream input,int max)throws Exception{
    int length=bounded(input.readInt(),max);byte[] bytes=input.readNBytes(length);if(bytes.length!=length)throw new EOFException();
    return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
  }
  static String quote(String value){StringBuilder out=new StringBuilder("\"");for(int i=0;i<value.length();i++){char c=value.charAt(i);if(c=='"'||c=='\\')out.append('\\').append(c);else if(c<32||c>126)out.append(String.format("\\u%04x",(int)c));else out.append(c);}return out.append('"').toString();}
  static String strings(Collection<String> values){StringJoiner out=new StringJoiner(",","[","]");for(String value:values)out.add(quote(value));return out.toString();}
  static void result(List<String> updates,Collection<String> diagnostics,int analyzed){System.out.println("{\"version\":"+quote(Runtime.version().toString())+",\"updates\":["+String.join(",",updates)+"],\"diagnostics\":"+strings(diagnostics)+",\"analyzedFiles\":"+analyzed+"}");}
  static String sha(String text)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));}
  static final class Bindings extends TreePathScanner<Void,Void>{
    final Trees trees; final Map<URI,Source> files; final List<String> updates; final Set<String> notes; final String provenance;
    Bindings(Trees trees,Map<URI,Source> files,List<String> updates,Set<String> notes,String provenance){this.trees=trees;this.files=files;this.updates=updates;this.notes=notes;this.provenance=provenance;}
    long start(CompilationUnitTree unit,Tree tree){return trees.getSourcePositions().getStartPosition(unit,tree);}
    long end(CompilationUnitTree unit,Tree tree){return trees.getSourcePositions().getEndPosition(unit,tree);}
    String target(Element element){
      TreePath declaration=trees.getPath(element);if(declaration==null)return null;Source file=files.get(declaration.getCompilationUnit().getSourceFile().toUri());if(file==null)return null;
      String kind,name=element.getSimpleName().toString();Tree leaf=declaration.getLeaf();
      if(element.getKind()==ElementKind.CONSTRUCTOR){kind="constructor_declaration";name=element.getEnclosingElement().getSimpleName().toString();}
      else if(element.getKind()==ElementKind.METHOD)kind="method_declaration";
      else if(element.getKind()==ElementKind.CLASS)kind="class_declaration";
      else if(element.getKind()==ElementKind.INTERFACE)kind="interface_declaration";
      else if(element.getKind()==ElementKind.ENUM)kind="enum_declaration";
      else if(element.getKind()==ElementKind.RECORD)kind="record_declaration";
      else return null;
      long first=start(declaration.getCompilationUnit(),leaf),last=end(declaration.getCompilationUnit(),leaf);String found=null;
      for(Symbol symbol:file.symbols)if(symbol.kind.equals(kind)&&symbol.name.equals(name)&&symbol.start==first&&symbol.end==last){if(found!=null)return null;found=symbol.id;}return found;
    }
    void add(Tree tree,String kind,Element element){
      String target=target(element);if(target==null)return;CompilationUnitTree unit=getCurrentPath().getCompilationUnit();Source source=files.get(unit.getSourceFile().toUri());if(source==null)return;
      long first=start(unit,tree),last=end(unit,tree);String edge=null;for(Edge candidate:source.edges)if(candidate.kind.equals(kind)&&candidate.start==first&&candidate.end==last){if(edge!=null)return;edge=candidate.id;}
      if(edge==null)return;if(updates.size()>=MAX_UPDATES)throw new IllegalStateException("Binding limit");updates.add("{\"edgeId\":"+quote(edge)+",\"to\":"+quote(target)+",\"sources\":"+provenance+"}");
    }
    boolean fixed(ExecutableElement method){
      if(!method.getTypeParameters().isEmpty()||method.getEnclosingElement() instanceof TypeElement owner&&!owner.getTypeParameters().isEmpty()){notes.add("Java generic callables retain syntax-only evidence.");return false;}
      if(method.getKind()==ElementKind.CONSTRUCTOR)return true;
      Set<Modifier> modifiers=method.getModifiers();boolean fixed=modifiers.contains(Modifier.STATIC)||modifiers.contains(Modifier.PRIVATE)||modifiers.contains(Modifier.FINAL)||method.getEnclosingElement().getModifiers().contains(Modifier.FINAL);
      if(!fixed||modifiers.contains(Modifier.ABSTRACT)){notes.add("Java virtual/interface dispatch retains syntax-only evidence.");return false;}return true;
    }
    public Void visitMethodInvocation(MethodInvocationTree tree,Void ignored){Element element=trees.getElement(new TreePath(getCurrentPath(),tree.getMethodSelect()));if(element instanceof ExecutableElement method&&fixed(method))add(tree,"calls",method);return super.visitMethodInvocation(tree,ignored);}
    public Void visitNewClass(NewClassTree tree,Void ignored){Element element=trees.getElement(getCurrentPath());if(tree.getClassBody()==null&&element instanceof ExecutableElement constructor&&fixed(constructor))add(tree,"calls",constructor);else notes.add("Java anonymous/dynamic constructors retain syntax-only evidence.");return super.visitNewClass(tree,ignored);}
    public Void visitImport(ImportTree tree,Void ignored){if(!tree.isStatic()&&!tree.getQualifiedIdentifier().toString().endsWith(".*")){Element element=trees.getElement(new TreePath(getCurrentPath(),tree.getQualifiedIdentifier()));if(element instanceof TypeElement)add(tree,"imports",element);}else notes.add("Java wildcard/static import edges retain syntax-only evidence.");return null;}
  }
  public static void main(String[] args){
    if(args.length==1&&args[0].equals("--identity")){System.out.println(Runtime.version());return;}
    try{analyze();}catch(Throwable error){result(List.of(),List.of("Java analyzer rejected input, source, or resource limits; syntax evidence retained."),0);}
  }
  static void analyze()throws Exception{
    byte[] encoded=System.in.readNBytes(MAX_INPUT+1);if(encoded.length>MAX_INPUT)throw new IllegalArgumentException("Input size");
    DataInputStream input=new DataInputStream(new ByteArrayInputStream(Base64.getDecoder().decode(encoded)));
    if(input.readInt()!=0x4a415631)throw new IllegalArgumentException("Protocol");int maxNodes=bounded(input.readInt(),100000);if(maxNodes==0)throw new IllegalArgumentException("Nodes");int count=bounded(input.readInt(),MAX_FILES),bytes=0;List<Source> sources=new ArrayList<>();Map<URI,Source> files=new HashMap<>();Set<String> paths=new TreeSet<>();
    for(int index=0;index<count;index++){
      String path=string(input,4096),digest=string(input,64),text=string(input,MAX_SOURCE);bytes+=text.getBytes(StandardCharsets.UTF_8).length;if(bytes>MAX_SOURCE||!sha(text).equals(digest)||!paths.add(path))throw new IllegalArgumentException("Identity");
      List<Symbol> symbols=new ArrayList<>();for(int n=bounded(input.readInt(),100000);n>0;n--)symbols.add(new Symbol(string(input,128),string(input,10000),string(input,100),input.readInt(),input.readInt()));
      List<Edge> edges=new ArrayList<>();for(int n=bounded(input.readInt(),100000);n>0;n--)edges.add(new Edge(string(input,128),string(input,100),input.readInt(),input.readInt()));
      Source source=new Source(path,text,symbols,edges);sources.add(source);files.put(source.toUri(),source);
    }
    if(input.read()!=-1)throw new IllegalArgumentException("Trailing data");
    JavaCompiler compiler=ToolProvider.getSystemJavaCompiler();if(compiler==null)throw new IllegalStateException("JDK unavailable");boolean[] errors={false};DiagnosticListener<JavaFileObject> listener=diagnostic->{if(diagnostic.getKind()==Diagnostic.Kind.ERROR)errors[0]=true;};
    try(StandardJavaFileManager standard=compiler.getStandardFileManager(listener,Locale.ROOT,StandardCharsets.UTF_8)){
      for(StandardLocation location:List.of(StandardLocation.CLASS_PATH,StandardLocation.SOURCE_PATH,StandardLocation.ANNOTATION_PROCESSOR_PATH,StandardLocation.MODULE_PATH,StandardLocation.UPGRADE_MODULE_PATH,StandardLocation.ANNOTATION_PROCESSOR_MODULE_PATH))standard.setLocation(location,List.of());
      SnapshotManager manager=new SnapshotManager(standard);JavacTask task=(JavacTask)compiler.getTask(Writer.nullWriter(),manager,listener,List.of("-proc:none","-implicit:none","-Xlint:none","--release","17","-encoding","UTF-8"),null,sources);task.setProcessors(List.of());
      List<CompilationUnitTree> units=new ArrayList<>();for(CompilationUnitTree unit:task.parse()){if(unit.getModule()!=null)throw new IllegalArgumentException("Modules unsupported");units.add(unit);}int[] nodes={0};for(CompilationUnitTree unit:units)new TreeScanner<Void,Void>(){public Void scan(Tree tree,Void v){if(tree!=null&&++nodes[0]>maxNodes)throw new IllegalStateException("Nodes");return super.scan(tree,v);}}.scan(unit,null);
      if(!errors[0])task.analyze();if(errors[0]){result(List.of(),List.of("Java type/syntax errors or unavailable dependencies retain syntax-only evidence for the snapshot."),0);return;}
      List<String> updates=new ArrayList<>();Set<String> notes=new TreeSet<>();Bindings bindings=new Bindings(Trees.instance(task),files,updates,notes,strings(paths));for(CompilationUnitTree unit:units)bindings.scan(unit,null);result(updates,notes,sources.size());
    }
  }
}
`;
