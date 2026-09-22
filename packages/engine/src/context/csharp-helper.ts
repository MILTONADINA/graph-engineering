/** Fixed helper compiled with trusted SDK Roslyn only; target source is never emitted. */
export const CSHARP_HELPER = String.raw`
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

record Symbol(string Id,string Name,string Kind,int Start,int End,int NameStart);
record Edge(string Id,string Kind,int Start,int End);
record FileInput(string Path,string Hash,string Text,Symbol[] Symbols,Edge[] Edges);
record Group(string Id,string[] Files,string[] Sources,bool Nullable);
record Input(FileInput[] Files,Group[] Groups,int MaxNodes);
record Update(string EdgeId,string To,string[] Sources);
static class SnapshotCSharp {
 static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy=JsonNamingPolicy.CamelCase, UnmappedMemberHandling=JsonUnmappedMemberHandling.Disallow };
 static string Version => typeof(CSharpCompilation).Assembly.GetName().Version!.ToString();
 static void Result(List<Update> updates,SortedSet<string> diagnostics,int analyzed) => Console.WriteLine(JsonSerializer.Serialize(new {version=Version,updates,diagnostics,analyzedFiles=analyzed},Json));
 static int Main(string[] args) {
  try {
   if(args.Length==1&&args[0]=="--identity"){Console.WriteLine(Version);return 0;}
   if(args.Length!=2||args[0]!="--references")throw new Exception();
   Analyze(args[1]); return 0;
  } catch { Result(new(),new(){"C# analyzer rejected input, source or resource limits; syntax evidence retained."},0); return 0; }
 }
 static void Analyze(string referenceDirectory) {
  using var stream=Console.OpenStandardInput();using var buffer=new MemoryStream();var block=new byte[8192];int read;
  while((read=stream.Read(block,0,block.Length))>0){buffer.Write(block,0,read);if(buffer.Length>16777216)throw new Exception();}
  var input=JsonSerializer.Deserialize<Input>(buffer.ToArray(),Json)!;
  if(input.Files.Length>96||input.Groups.Length>64||input.MaxNodes<1||input.MaxNodes>100000)throw new Exception();
  var files=new Dictionary<string,FileInput>(StringComparer.Ordinal);var total=0;
  foreach(var file in input.Files){total+=Encoding.UTF8.GetByteCount(file.Text);if(total>4194304||Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(file.Text))).ToLowerInvariant()!=file.Hash||!files.TryAdd(file.Path,file))throw new Exception();}
  var references=Directory.GetFiles(referenceDirectory,"*.dll").OrderBy(value=>value,StringComparer.Ordinal).ToArray();
  if(references.Length<1||references.Length>300)throw new Exception();
  var metadata=references.Select(name=>MetadataReference.CreateFromFile(name)).ToArray();
  var updates=new List<Update>();var notes=new SortedSet<string>(StringComparer.Ordinal);int analyzed=0,nodes=0;
  foreach(var group in input.Groups) {
   var provenance=group.Files.Concat(group.Sources).Distinct(StringComparer.Ordinal).OrderBy(name=>name,StringComparer.Ordinal).ToArray();
   if(provenance.Length>64||provenance.Any(name=>!files.ContainsKey(name)))throw new Exception();
   var trees=new List<SyntaxTree>();bool unsupported=false;
   foreach(var name in group.Files) {
    var tree=CSharpSyntaxTree.ParseText(files[name].Text,new CSharpParseOptions(LanguageVersion.CSharp12,DocumentationMode.None,SourceCodeKind.Regular),name,Encoding.UTF8);
    var root=tree.GetRoot();foreach(var node in root.DescendantNodesAndSelf())if(++nodes>input.MaxNodes)throw new Exception();
    if(root.DescendantTrivia(descendIntoTrivia:true).Any(item=>item.IsDirective)){unsupported=true;notes.Add("C# preprocessing/directive-dependent sources retain syntax-only evidence for the project.");}
    trees.Add(tree);
   }
   if(unsupported)continue;
   var compilation=CSharpCompilation.Create("Snapshot",trees,metadata,new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary,concurrentBuild:false,allowUnsafe:false,nullableContextOptions:group.Nullable?NullableContextOptions.Enable:NullableContextOptions.Disable));
   if(compilation.GetDiagnostics().Any(item=>item.Severity==DiagnosticSeverity.Error)){notes.Add("C# type/syntax errors or unavailable dependencies retain syntax-only evidence for the project.");continue;}
   analyzed+=trees.Count;
   foreach(var tree in trees) {
    var model=compilation.GetSemanticModel(tree);var file=files[tree.FilePath];
    foreach(var call in tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>()) {
     var info=model.GetSymbolInfo(call);
     if(info.CandidateReason!=CandidateReason.None||info.Symbol is not IMethodSymbol method){notes.Add("C# unresolved/ambiguous or dynamic calls retain syntax-only evidence.");continue;}
     if(method.MethodKind!=MethodKind.Ordinary||!method.IsStatic||method.IsGenericMethod||method.IsVirtual||method.IsAbstract||method.IsOverride||method.IsExtensionMethod||method.ContainingType.IsGenericType||method.PartialDefinitionPart!=null||method.PartialImplementationPart!=null){notes.Add("C# instance/virtual/interface, delegate, extension, generic and partial calls retain syntax-only evidence.");continue;}
     var declared=method.DeclaringSyntaxReferences;
     if(declared.Length!=1||declared[0].GetSyntax() is not MethodDeclarationSyntax declaration||!files.TryGetValue(declaration.SyntaxTree.FilePath,out var target)){notes.Add("C# external or unavailable declarations retain syntax-only evidence.");continue;}
     var symbols=target.Symbols.Where(item=>item.Kind=="method_declaration"&&item.Name==method.Name&&item.Start==declaration.Span.Start&&item.End==declaration.Span.End&&item.NameStart==declaration.Identifier.Span.Start).ToArray();
     var edges=file.Edges.Where(item=>item.Kind=="calls"&&item.Start==call.Span.Start&&item.End==call.Span.End).ToArray();
     if(symbols.Length!=1||edges.Length!=1)continue;
     if(updates.Count>=5000)throw new Exception();updates.Add(new(edges[0].Id,symbols[0].Id,provenance));
    }
   }
  }
  Result(updates,notes,analyzed);
 }
}
`;
