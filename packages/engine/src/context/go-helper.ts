/** Fixed trusted program. Repository text is JSON data; only this helper is compiled. */
export const GO_HELPER = String.raw`
package main

import (
 "crypto/sha256"
 "encoding/hex"
 "encoding/json"
 "errors"
 "go/ast"
 "go/parser"
 "go/token"
 "go/types"
 "io"
 "os"
 "runtime"
 "runtime/debug"
 "sort"
 "strconv"
 "strings"
 "unicode/utf16"
)

type Symbol struct { ID, Name, Kind string; NameStart int }
type Edge struct { ID, Kind string; Start, End int }
type File struct { Path, Hash, Text string; Symbols []Symbol; Edges []Edge }
type Group struct { ID, GoVersion, MinimumVersion string; Files, Sources []string; Imports map[string]string }
type Input struct { Files []File; Groups []Group; MaxNodes int }
type checked struct { pkg *types.Package; info *types.Info; trees []*ast.File; paths []string; failed bool }
type analyzer struct { input Input; files map[string]*File; groups map[string]Group; done map[string]*checked; busy map[string]bool; fset *token.FileSet; nodes int; diagnostics map[string]bool; updates []map[string]interface{} }
type snapshotImporter struct { a *analyzer; owner Group }
func newerThanRuntime(required string)bool {
 if required==""{return false};left:=strings.Split(strings.TrimPrefix(required,"go"),".");right:=strings.Split(strings.TrimPrefix(runtime.Version(),"go"),".")
 for index:=0;index<3;index++{a,b:=0,0;var err error;if index<len(left){a,err=strconv.Atoi(left[index]);if err!=nil{return true}};if index<len(right){b,err=strconv.Atoi(right[index]);if err!=nil{return true}};if a!=b{return a>b}};return false
}
func (i snapshotImporter) Import(name string) (*types.Package,error) {
 id,ok:=i.owner.Imports[name]; if !ok {i.a.diagnostics["external, standard-library, relative, or unrepresented imports remain unresolved"]=true;return nil,errors.New("snapshot import unavailable")}
 result:=i.a.check(id);if result.failed || result.pkg==nil || result.pkg.Name()=="main" {return nil,errors.New("snapshot package unavailable")};return result.pkg,nil
}
func (a *analyzer) check(id string) *checked {
 if value:=a.done[id];value!=nil{return value}
 if a.busy[id]{a.diagnostics["cyclic imports remain unresolved"]=true;return &checked{failed:true}}
 group,ok:=a.groups[id];if !ok{return &checked{failed:true}}
 a.busy[id]=true; defer delete(a.busy,id)
 result:=&checked{info:&types.Info{Uses:map[*ast.Ident]types.Object{},Defs:map[*ast.Ident]types.Object{},Selections:map[*ast.SelectorExpr]*types.Selection{},Instances:map[*ast.Ident]types.Instance{}}}
 if newerThanRuntime(group.MinimumVersion){result.failed=true;a.diagnostics["module/workspace requires an unavailable newer Go compiler"]=true;a.done[id]=result;return result}
 for _,name:=range group.Files {
  file:=a.files[name];if file==nil{result.failed=true;break}
  tree,err:=parser.ParseFile(a.fset,name,file.Text,parser.AllErrors|parser.ParseComments|parser.SkipObjectResolution)
  if err!=nil{result.failed=true;a.diagnostics["syntax errors retain syntax-only evidence"]=true;continue}
  for _,item:=range tree.Imports {value,err:=strconv.Unquote(item.Path.Value);if err!=nil||value=="C"||value=="unsafe"||item.Name!=nil&&(item.Name.Name=="."||item.Name.Name=="_"){result.failed=true;a.diagnostics["cgo, unsafe, dot and side-effect imports remain unresolved"]=true}}
  ast.Inspect(tree,func(node ast.Node)bool{if node!=nil{a.nodes++;if a.nodes>a.input.MaxNodes{panic("AST budget")}};return true})
  result.trees=append(result.trees,tree);result.paths=append(result.paths,name)
 }
 if !result.failed {
  config:=types.Config{Importer:snapshotImporter{a,group},GoVersion:group.GoVersion,Error:func(error){result.failed=true}}
  pkg,err:=config.Check(id,a.fset,result.trees,result.info);result.pkg=pkg
  if err!=nil{result.failed=true;a.diagnostics["type-check errors retain syntax-only evidence for the affected package"]=true}
 }
 a.done[id]=result;return result
}
func (a *analyzer) offset(position token.Pos)(*File,int){
 p:=a.fset.PositionFor(position,false);file:=a.files[p.Filename];if file==nil||p.Offset<0||p.Offset>len(file.Text){return nil,-1}
 return file,len(utf16.Encode([]rune(file.Text[:p.Offset])))
}
func (a *analyzer) symbol(object *types.Func) string {
 file,offset:=a.offset(object.Pos());if file==nil{return ""}
 found:="";for _,item:=range file.Symbols{if item.Kind=="function_declaration"&&item.Name==object.Name()&&item.NameStart==offset{if found!=""{return ""};found=item.ID}};return found
}
func (a *analyzer) edge(file *File,node ast.Node,kind string)string{
 first,start:=a.offset(node.Pos());last,end:=a.offset(node.End());if first!=file||last!=file{return ""}
 found:="";for _,item:=range file.Edges{if item.Kind==kind&&item.Start==start&&item.End==end{if found!=""{return ""};found=item.ID}};return found
}
func (a *analyzer) evidence(id string,seen map[string]bool,paths map[string]bool)bool {
 if seen[id]{return true};seen[id]=true;group,ok:=a.groups[id];if !ok||a.done[id]==nil||a.done[id].failed{return false}
 for _,name:=range append(append([]string{},group.Files...),group.Sources...){paths[name]=true}
 for _,tree:=range a.done[id].trees{for _,item:=range tree.Imports{name,err:=strconv.Unquote(item.Path.Value);if err!=nil||!a.evidence(group.Imports[name],seen,paths){return false}}}
 return len(paths)<=64
}
func (a *analyzer) bind(id string){
 result:=a.done[id];if result==nil||result.failed{return};paths:=map[string]bool{}
 if !a.evidence(id,map[string]bool{},paths){a.diagnostics["binding provenance exceeds limits or contains unsupported dependencies"]=true;return}
 sources:=[]string{};for name:=range paths{sources=append(sources,name)};sort.Strings(sources)
 add:=func(edge,target string){if edge==""||target==""{return};if len(a.updates)>=5000{panic("binding budget")};a.updates=append(a.updates,map[string]interface{}{"edgeId":edge,"to":target,"sources":sources})}
 group:=a.groups[id]
 for index,tree:=range result.trees {
  file:=a.files[result.paths[index]]
  for _,item:=range tree.Imports {
   name,_:=strconv.Unquote(item.Path.Value);target:=a.groups[group.Imports[name]]
   if len(target.Files)!=1{a.diagnostics["multi-file package imports have no single-file graph target; direct calls may still resolve"]=true;continue}
   other:=a.files[target.Files[0]];if other==nil{continue};for _,symbol:=range other.Symbols{if symbol.Kind=="file"{add(a.edge(file,item,"imports"),symbol.ID)}}
  }
  ast.Inspect(tree,func(node ast.Node)bool{
   call,ok:=node.(*ast.CallExpr);if !ok{return true};var object types.Object
   switch expression:=call.Fun.(type){
    case *ast.Ident:object=result.info.Uses[expression]
    case *ast.SelectorExpr:
     base,ok:=expression.X.(*ast.Ident);if !ok||result.info.Selections[expression]!=nil{a.diagnostics["method and indirect call forms remain syntax-only"]=true;return true}
     if _,ok:=result.info.Uses[base].(*types.PkgName);!ok{a.diagnostics["method and indirect call forms remain syntax-only"]=true;return true};object=result.info.Uses[expression.Sel]
    default:a.diagnostics["generic, method, function-value and dynamic call forms remain syntax-only"]=true;return true
   }
   function,ok:=object.(*types.Func);if !ok{if _,ok:=object.(*types.Var);ok{a.diagnostics["function-value calls remain syntax-only"]=true};return true}
   signature,ok:=function.Type().(*types.Signature);if !ok||signature.Recv()!=nil||signature.TypeParams().Len()>0{a.diagnostics["generic and method calls remain syntax-only"]=true;return true}
   add(a.edge(file,call,"calls"),a.symbol(function));return true
  })
 }
}
func main(){
 debug.SetMemoryLimit(192<<20);runtime.GOMAXPROCS(1)
 defer func(){if recover()!=nil{json.NewEncoder(os.Stdout).Encode(map[string]interface{}{"error":"Go analyzer resource or input limit"})}}()
 raw,err:=io.ReadAll(io.LimitReader(os.Stdin,16777217));if err!=nil||len(raw)>16777216{panic("input budget")}
 input:=Input{};decoder:=json.NewDecoder(strings.NewReader(string(raw)));decoder.DisallowUnknownFields()
 if decoder.Decode(&input)!=nil||decoder.Decode(new(interface{}))!=io.EOF||len(input.Files)>600||len(input.Groups)>250||input.MaxNodes<1||input.MaxNodes>100000{panic("input shape")}
 a:=analyzer{input:input,files:map[string]*File{},groups:map[string]Group{},done:map[string]*checked{},busy:map[string]bool{},fset:token.NewFileSet(),diagnostics:map[string]bool{},updates:[]map[string]interface{}{}}
 size:=0;for index:=range input.Files{file:=&input.Files[index];size+=len(file.Text);digest:=sha256.Sum256([]byte(file.Text));if size>4194304||a.files[file.Path]!=nil||hex.EncodeToString(digest[:])!=file.Hash{panic("source identity")};a.files[file.Path]=file}
 ids:=[]string{};for _,group:=range input.Groups{if a.groups[group.ID].ID!=""{panic("duplicate package")};a.groups[group.ID]=group;ids=append(ids,group.ID)};sort.Strings(ids)
 for _,id:=range ids{a.check(id)};analyzed:=0;for _,id:=range ids{if !a.done[id].failed{analyzed+=len(a.groups[id].Files)};a.bind(id)}
 notes:=[]string{};for message:=range a.diagnostics{notes=append(notes,"Go static binding limitation: "+message+".")};sort.Strings(notes)
 json.NewEncoder(os.Stdout).Encode(map[string]interface{}{"version":runtime.Version(),"updates":a.updates,"diagnostics":notes,"analyzedFiles":analyzed})
}
`;
