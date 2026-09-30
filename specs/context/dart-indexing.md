# Dart syntax indexing

- ID: dart-indexing
- Status: ready
- Area: context

## Problem

Dart and Flutter repositories need the same bounded, source-backed context as the other supported languages: declarations to search, imports and calls to follow, and honest coverage when something could not be read. The pinned tree-sitter grammars already include Dart, but its tree differs from the others: a function's signature and body are sibling nodes, calls are selector chains rather than call expressions, and named constructors carry several names. The generic extractor would credit every function body to its file and miss the calls. Dart support starts at the syntax level and must not change anything for repositories that have no Dart files; resolved bindings wait for a Dart analyzer that runs sandboxed.

## Acceptance criteria

- AC1: Indexing a Dart package records its top-level functions, classes, named and factory constructors, static and instance methods, getters and extensions, pairing each signature with the body that follows it; its imports (prefixed or not), exports and part directives as unresolved import edges; and calls read from selector chains and cascades, credited to the declaration whose body holds them. A bare call is linked, as a heuristic lexical candidate, only to the one declaration of that name in the same file, when that declaration is a top-level or local function that no parameter, variable, field, loop, catch or pattern binding in the file could shadow; every other call, such as a member call, a call through a prefixed import, a call to a function in another file of the library or a constructor call, stays unresolved.
  - Test: packages/engine/tests/context-dart.test.ts :: indexes Dart declarations, imports and selector calls from the toy package
- AC2: Valid Dart that the pinned grammar cannot parse, such as an unnamed `library;`, null-aware elements, dot shorthands and labeled statements, is reported as the `syntax errors; graph may be incomplete` coverage diagnostic for exactly the file that holds it; the file's declarations are kept as partial evidence, and it links no calls.
  - Test: packages/engine/tests/context-dart.test.ts :: reports Dart syntax the pinned grammar cannot parse as incomplete coverage
- AC6: A repository without Dart files keeps the snapshot identity it had before Dart indexing existed, key for key, so its stored snapshots and plans stay valid. A repository with Dart files adds a Dart-only extractor version to its identity, and cached Dart syntax carries that version, so a change to Dart extraction re-parses only Dart files.
  - Test: packages/engine/tests/context.test.ts :: keeps snapshot identity unchanged for repositories without Dart files

### Later

These need the sandboxed Dart analyzer and have no tests yet.

- AC3: The analyzer binds declarations from an isolated copy of the snapshot's Dart sources and never materializes or honours repository configuration (`analysis_options.yaml`, `pubspec.yaml` dependencies, `.dart_tool/`, build hooks); it never runs pub, build runners or repository code.
- AC4: Only bindings in a documented allowed subset are promoted, such as direct calls to top-level functions and static members through relative, prefixed or same-package imports and `part` files; everything outside it, such as dynamic dispatch, generated code and other packages, keeps syntax evidence.
- AC5: An analyzer that is unavailable, untrusted, over its node or output bounds or past its fixed time cap reports exactly its documented diagnostic, keeps syntax evidence only and adds no bindings; the cap is a security bound and is not raised for slow runners.

## Security considerations

Repository content is untrusted. Syntax indexing only parses Dart text with the pinned WebAssembly grammar: it never runs `dart`, `flutter`, pub, build runners or repository code, reads no package configuration and downloads nothing. Dart files pass the same gitignore, exclusion, size and credential screening as every other file before they are parsed. The Dart-only extractor version keeps a Dart change from re-identifying other repositories, whose stored plans are bound to their snapshot identity. The later analyzer must be a pre-provisioned, sandboxed runtime with node, output and time bounds, like the other native binders.

## Non-goals

Syntax indexing does not resolve Dart imports or calls across files, infer types, model inheritance or dispatch, or run the Dart analyzer, pub or Flutter. It adds no Semgrep rules for Dart, since the pinned scanner image has no Dart rule set. The Dart and Flutter verification recipes in [verification images](../../docs/verification-images.md) are starting points, not tested images.
