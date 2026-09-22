# Snapshot Java compiler proof

Only the packaged `SnapshotJava` helper is compiled. Target sources are in-memory
`JavaFileObject`s passed to `JavacTask.parse()` and `analyze()`, never `generate()`
or `call()`. Annotation processing is disabled twice; the restricted file manager
permits trusted JDK platform types, denies application class/source/module paths,
plugin classloaders and file outputs. No Maven/Gradle command, repository config,
annotation processor, source initializer or target class is executed.

This is Java 17 language/platform declaration binding, not build verification.
Supported edges: compiler-selected static/private/final methods, methods on final
classes, explicit nongeneric constructors, and explicit single-type imports.
Overloads are distinguished by compiler elements and exact declaration spans.
Virtual/interface calls, generic callables/owners, method references, anonymous
constructors, wildcard/static import edges, Java modules and unavailable external
dependencies remain unresolved. Every selected Java file is mandatory provenance;
one type/syntax error prevents bindings for the entire selected snapshot.

Bounds: 64 files, 4 MiB source, 16 MiB encoded input, 100,000 AST nodes,
5,000 edges, 2 MiB output, 10-second analysis deadline. Heap/metaspace/code-cache
limits are 192/128/32 MiB. Unix samples RSS and kills sustained usage over 512 MiB;
that is not an instantaneous total-memory limit. Helper compilation has a separate
30-second deadline. Fixed JDK discovery currently supports macOS and Linux, not
Windows; unavailable compilers return explicit syntax-only diagnostics. Discovery
is cached until process restart. Helper/version identity must be included in the
snapshot cache identity by the caller.

Run native tests with `npx vitest run packages/engine/tests/context-java.test.ts`.
For offline Linux proof, preprovision `graph-engineering-verify:local` and the
digest-pinned Temurin image in `Dockerfile`, then run from repository root:

```sh
docker build --pull=false --network=none -f packages/engine/tests/fixtures/java-runtime/Dockerfile -t graph-java-native-test:local .
docker run --rm --network=none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m --memory=1g --cpus=2 --pids-limit=128 --cap-drop=ALL --security-opt=no-new-privileges graph-java-native-test:local
```

The container runs as UID 65534. `/tmp` needs executable mappings for native
Tree-sitter/SQLite dependencies and only holds generated test/helper artifacts.
No global JDK installation or live external service is needed. Test receipts
print actual JDK/helper identities; image tags alone are not reproducible proof.

Observed verification: all 14 tests passed on macOS/ARM64 OpenJDK `26.0.1`
and network-disabled Linux/ARM64 Temurin `21.0.12+8-LTS`, including actual
ContextEngine indexing/export exclusions, modified-source snapshot invalidation,
overload/shadowing cases and annotation-processor/initializer nonexecution.
The final Linux fixture image was
`sha256:d29a1953e45df1a2228987355855efa12fdeadd700d021df62e7e531a60336c0`;
compiled helper class identity on both JDKs was
`77c56872b752869fc0e5cc03eb6f1dfe8467e00670bbd4ec48420c4f90ddc1e5`.
No Windows result or support for untested Java language/build configurations is
inferred from these measurements.

Primary API references: [JavacTask](https://docs.oracle.com/en/java/javase/21/docs/api/jdk.compiler/com/sun/source/util/JavacTask.html),
[JavaFileManager](https://docs.oracle.com/en/java/javase/21/docs/api/java.compiler/javax/tools/JavaFileManager.html),
[javac options](https://docs.oracle.com/en/java/javase/21/docs/specs/man/javac.html).
