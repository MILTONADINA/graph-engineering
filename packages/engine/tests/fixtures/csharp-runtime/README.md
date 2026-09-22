# Snapshot-only C# compiler proof

The fixed packaged helper uses SDK8 Roslyn to parse/type-check repository text from bounded stdin JSON. It does not emit or execute repository assemblies. Helper provisioning invokes trusted `csc.dll` directly with `/noconfig` and explicit trusted reference assemblies; it does not evaluate MSBuild projects, restore packages, load source generators/analyzers/plugins, or discover repository dependencies. Compiler-selected static method declarations are matched to exact snapshot symbol/call spans. External framework calls remain unbound because their declarations are not in the snapshot.

The supported project format is deliberately smaller than general `.csproj`: one literal `Microsoft.NET.Sdk` project and one property group targeting `net8.0`, optional disabled implicit usings, nullable enable/disable, C#12 and Library output. XML comments, entities, conditions, imports/items/tasks, packages/project references, other frameworks and ambient `.props`/`.targets`/`global.json` cause explicit fallback. Parent projects containing nested projects also abstain: SDK default source globs can include child sources, so silently excluding them would be inaccurate. Files without a supported represented project are analyzed individually, not merged. All represented project files and project metadata are required provenance for each edge.

Static non-generic methods, aliases and compiler-selected overloads are supported. Instance/virtual/interface calls, delegates, dynamic calls, generics, extension methods, partial methods and preprocessor directives remain syntax-only. This is bounded declaration binding over represented snapshot source, not a complete project build or runtime dispatch proof.

Limits: 64 C# files plus 32 metadata files; 4 MiB source; 16 MiB input; 100,000 AST nodes; 5,000 updates; 64 provenance records per edge; 2 MiB combined process output; 5-second analysis deadline checked both by timer and monotonic elapsed time. Native .NET managed GC heap is limited to 256 MiB; that is not a whole-process memory cap. Unix adds a 384-MiB RSS watchdog. It retries one zero-RSS/no-process sample to handle process-exit notification races; missing `ps`, malformed/error samples or actual over-limit RSS fail closed. Native Windows currently has managed-heap/deadline/output/node limits but no RSS watchdog. Helper compilation has a separate 60-second deadline. Cached runtime descriptors and nested hashes are immutable; execution uses only the trusted cached descriptor after caller identity comparison. Service restart is needed after SDK provisioning/replacement.

## Reproduce

Preprovision `graph-engineering-verify:local` and this exact SDK image. The fixture does not install host .NET or evaluate target code:

```sh
docker pull mcr.microsoft.com/dotnet/sdk@sha256:78235e09001f52b6592c458ac010775ebac6725422e80cd0c1650590f67b2743
GRAPH_ENGINE_CSHARP_DOCKER_TESTS=1 npm test -w @graph-engineering/engine -- tests/context-csharp.test.ts
docker build --pull=false --network=none -f packages/engine/tests/fixtures/csharp-runtime/Dockerfile -t graph-csharp-native-test:local .
docker run --rm --network=none --read-only --tmpfs /tmp:rw,exec,nosuid,size=768m --memory=1536m --cpus=2 --pids-limit=128 --cap-drop=ALL --security-opt=no-new-privileges graph-csharp-native-test:local
```

The native fixture requires successful runtime discovery (`GRAPH_ENGINE_REQUIRE_CSHARP_RUNTIME=1`); unavailable-runtime skips cannot count as that proof. The first command only provisions the trusted image and may use the network. Test containers and build `RUN` steps disable networking. Docker may still consult registry metadata when resolving a pinned build base.

## Observed receipt, 2026-09-22

Linux/ARM64, SDK8.0.425, framework/reference pack8.0.31, Roslyn4.11.0.0:

- Mac-driven isolated helper suite: 8 passed, 6 explicit native/fixture skips.
- Native Linux discovery/compilation/transport/indexing suite: 10 passed, 4 Docker-orchestration skips.
- Source helper SHA-256: `315a14fb61d144604107fc83fb9f01e653cfdf92b5a8455b4bc2ad69c4eb75c0`.
- Compiled helper SHA-256: `f7ed8b7070e3d0cef9e1e2c0c4b4f3662a85302ef1e7552ba4f2eeedf448d5c9`.
- Runtime identity: `5929ab90b305435843368afdeef63eba4747bd078bce9b5c1599fe60aaea57fc`.
- Verification dependency base image: `sha256:b8fbb70d27b3989e2243e466c967214cc4496197d8a7a961d8e3907200218a1a`.

The Mac has no trusted SDK8 installation and retains explicit syntax-only fallback. Discovery includes fixed trusted macOS, Linux and Windows locations; Linux proof does not establish successful native macOS/Windows execution. Tests cover private-source/config export filtering, current exclusions, config-driven snapshot changes, getters that switch paths after comparison, inherited startup-hook/dependency-probing rejection, inert static constructors/module initializers, aliases/overloads/shadowing, malformed project metadata and resource fallback.
