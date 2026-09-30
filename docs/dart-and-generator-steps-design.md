# Design: Dart/Flutter support and sandboxed generator steps

Designed on 2026-09-30 against fork `dev` at `96cf8b2`. Current delivery status:

- The independent approval/worker-controls release merged through
  [PR #118](https://github.com/MILTONADINA/graph-engineering/pull/118) into
  fork `dev` at `d22d69ad0f08bbc95fa2209d42171234817f780d` after all nine
  exact-head checks and scoped source/contract review passed. It contains no
  Dart or generator implementation, and approval adoption requires neither.
  Included PRs #112/#113 are closed.
  The separate automatic post-merge
  [run 36762274094](https://github.com/MILTONADINA/graph-engineering/actions/runs/36762274094)
  (attempt 1 on `d22d69a`) ended cancelled, with eight jobs passing and Linux
  x64 cancelled during `npm run check`; no test failure or cancellation cause
  was recorded, and this session did not cancel or rerun it. This is not green
  post-merge evidence; the nine-job checked-head run and identical-tree merge
  recorded in the handover remain the approval-release evidence.
- The Dart syntax, model-role, generator and analyzer changes from PRs
  #114–#117 merged through [PR #119](https://github.com/MILTONADINA/graph-engineering/pull/119)
  into fork `dev` at `09427fe33a273f8426580b806eafdb5717e702a7` on
  2026-09-30 at 21:33:03 UTC. Exact checked head
  `84dcbbe162e4cf90883a5095c2ac912fce74ffd4` and the merged commit share tree
  `76d24aebb95eeb1d431fc23d0973220846d8b37b`.
  [CI run 36777117238](https://github.com/MILTONADINA/graph-engineering/actions/runs/36777117238),
  attempt 1, passed all nine required jobs, including native Dart and generator
  integration checks in Linux x64 job `110097698965`. Independent scoped
  agent review and main-session review found no blockers; no external human
  approval or separate post-merge CI success is claimed. Dart, generator and
  expanded deadline specs are `implemented`. Mixed finite-deadline coverage
  preserves API/local/unknown cases alongside template and generator envelopes.
- Historical generator evidence: native Docker isolation/capture passed in
  run 36768502119 before the later Dart failure on
  `04f49778d76b354f5d24a46c61649154f878625c`. That run was not green and is
  not the release evidence; final-head CI above supersedes it.
- Historical Dart validation: the old native CI attempt failed runtime discovery. Three focused
  cases for the explicit empty-`PATH` metadata correction and a metadata-only
  BuildKit probe now pass; neither executes the actual analyzer. Follow-up
  commit `fb3eebf` copies `env` from that existing pinned base without a new download
  or custom compiler and validates the exact `[env, -i, --, <absolute-AOT-runtime>]`
  entrypoint with fixed executable paths. The Dart resolver identity advances
  to version 2; the SDK remains 3.13.3. Four focused image/prefix guard cases
  passed. The engine build completed with source manifest
  `7ffa8987bab1b51828a0e09ccf99bf3bc89e4567334e272d724fae66ee7b1f81`
  over 121 files; scoped runtime-port review found no blockers. The live AOT
  empty-environment and bounded-timeout cases passed in run 36768502119,
  but direct/imported binding returned zero analyzed files. Focused diagnostic
  [run 36772700675](https://github.com/MILTONADINA/graph-engineering/actions/runs/36772700675)
  then identified a memory-monitor failure before initialization. A second
  diagnostic-only run, 36773291042, passed binding without a runtime change;
  this showed the failure was intermittent, not that it was fixed. The CLI's
  documented two-sample operation makes the old 1.2-second sampling allowance
  fragile. The correction gives each stats command three seconds while keeping
  the analyzer's independent 15-second deadline, hard 768-MiB cgroup cap,
  malformed-sample rejection and output limits unchanged. Resolver identity 3
  invalidates only Dart-bearing snapshot caches. Three focused fake-clock
  regressions pass through the real command helper or LSP deadline. Native
  [run 36774307816](https://github.com/MILTONADINA/graph-engineering/actions/runs/36774307816)
  then caught the exact startup race: Docker reported a missing container,
  followed by `0B / 0B`, without either sample exhausting its deadline.
  The follow-up maps only that anchored empty-stats sentinel to the existing
  startup-only missing-sample grace. It never treats it as healthy zero RSS;
  genuine zero, malformed output and missing samples at or after three seconds
  still fail closed. Eight focused startup regressions pass.
  A subsequent diagnostic run, 36775946203, showed valid definitions and
  client termination but a correctly labelled container already being
  auto-removed. The cleanup correction handles only the same-name
  removal-in-progress response with one 250-ms settling pause, then still
  requires two successful empty daemon listings separated by 250 ms. Eight
  additional regressions cover successful confirmation and refusal on wrong
  ownership, unrelated errors, present/reappearing containers and unavailable
  daemon responses. The current build manifest is
  `cb2878c24080100d101056e23b1db9f404d6b00ac37b99c8ede37bb67ea4e07b`
  over 121 files. The combined corrections passed the direct/imported native
  binding regression on `d7612cd08b5eeabd6a6d7cd374c3924a464c1ce4` in
  [run 36776596177](https://github.com/MILTONADINA/graph-engineering/actions/runs/36776596177),
  job `110095953506`. That focused evidence preceded the completed final
  nine-check CI and review above, including native binding/provenance,
  empty-AOT-environment and real bounded-timeout cases. The
  pinned-runtime, fixed resource bounds and no-target-code-execution
  constraints below continue to govern it.
- Flutter's synthetic widget fixture and verification recipe remain
  documentation-only, without native CI or end-to-end execution claims.
  Native synthetic fixtures are not live-provider inference, production
  calibration or held-out promotion evidence. The runtime-release pin above
  remains fixed across documentation-only follow-ups.
- The decisions recorded below were settled during design. Follow them
  unless new evidence says otherwise, and record any change in the PR.

All fixtures and examples must stay synthetic toy projects.

## What shapes both designs

- **Hash pins.** Only `evaluation/**` and the lockfiles are pinned.
  `validate-fixtures.test.mjs` hashes `tasks.mjs`, `run.mjs`,
  `validate-fixtures.mjs` and `receipt.mjs`, and asserts exactly six
  languages × ten tasks. The cloud-graph receipt pins the root
  `package-lock.json`. Its oracle pins _historical_ hashes of `index.ts` and
  `mcp.ts`, not the current files, so engine `src/` edits are safe. Neither
  upgrade touches a pinned file or needs a new npm dependency.
- **Snapshot identity.** `start()` refuses a plan when
  `snapshot.id !== plan.snapshotId`. Every `*Bindings` key enters that
  identity unconditionally, so a careless identity change voids every stored
  plan.
- **One fail-open path.** `modelRoles()` in `service.ts` counts `template`
  steps as local and `worker` steps by their provider, but skips any other
  kind. A new step kind would silently escape the round-7/9 rule that keeps a
  cloud client's plan on one side of the export boundary. The fix counts
  every kind other than `worker` as local instead of skipping it.

## Upgrade A: Dart and Flutter

### Syntax indexing (PR 1, no toolchain)

- `tree-sitter-dart.wasm` already ships in the pinned `tree-sitter-wasms`
  and parses under the pinned `web-tree-sitter`.
- Its tree shape breaks the generic extractor, so Dart has its own:
  - `function_signature` and `method_signature` are _siblings_ of
    `function_body`, so the generic extractor would credit function bodies
    to the file;
  - calls are an `identifier` followed by `selector` → `argument_part`; there
    is no `call_expression`;
  - named constructors carry several `name` fields;
  - imports are `library_import`, `library_export` and `part_directive`.
- The extractor pairs each signature with the body after it, reads calls
  from selector chains, and adds `initialized_variable_definition`,
  `formal_parameter` and `initialized_identifier` to the shadowing rules.
- Grammar coverage: records, patterns, switch expressions, class modifiers,
  extension types, enhanced enums and if-case parse. `library;` and
  null-aware elements (`[?x]`) fail, which surfaces as the existing "syntax
  errors; graph may be incomplete" diagnostic.

### Resolved bindings (PR 2)

Use the Dart SDK's own analysis server over LSP, mirroring the Rust adapter.

- **Pinned toolchain.** A minimal analyzer image is built from the exact
  official Dart 3.13.3 Linux x64 image digest. It retains the AOT runtime,
  analyzer snapshot, `version`, SDK `lib/` source, needed runtime libraries,
  and the pinned base's `env` utility for the fixed environment-clearing prefix,
  but not `bin/dart`, project executables, pub tools or `*.dill`. The derived
  image ID binds all retained bytes; the runtime inspects it, records that ID
  in the Dart-only snapshot identity and runs by ID, not by a mutable tag.
  The reviewed build/installation is the trust root; labels alone are not
  cryptographic attestation against a malicious local Docker operator.
- **What gets resolved.** Only unique top-level functions, static methods,
  constructors and prefixed-import calls. Everything else stays syntax-only.
  Edges carry `resolution.engine: "dart-analyzer"`, with the validated root
  manifest and every analyzed Dart file as provenance. A `Location` answer
  proves only an exact eligible target name; a `LocationLink` also has to
  match the query origin and an eligible declaration range. Recognized
  generated-code suffixes/headers are excluded, but unmarked generated code
  cannot be identified reliably.
- **Starting bounds, to calibrate:** 250 files, 4 MiB, 100,000 nodes, 2,000
  queries, 2 MiB output, 15 s, a sampled 768 MiB memory watchdog,
  `--network=none --read-only`.
- **Rejected alternatives:**
  - a `package:analyzer` helper compiled like Go's: more precise, but about
    25 pub packages become a new supply chain, and its API churns;
  - syntax only: honest, but no bindings.

A read-only spike on 2026-09-30 (Dart 3.13.3, synthetic code only) gave a
conditional go. LSP `textDocument/definition` resolved Dart calls
accurately, and about 250 files took roughly 1 to 10 s at 140 to 380 MiB.
The design must follow what it found:

- **Repository code must never run.** A repository-controlled
  `analysis_options.yaml` at any depth, including one that names the package
  itself as a plugin, made the server compile and load that code in-process,
  even offline. New-style `plugins:` entries also triggered `dart pub upgrade`
  and network attempts. So:
  - Build the sandbox tree from `*.dart` files only, with no symlinks.
  - Drop every `analysis_options.yaml`, `pubspec.yaml`, `.dart_tool/`,
    `package_config.json` and `tools/analyzer_plugin/` at every depth.
  - Write the engine's own package config outside the tree, listing only the
    package itself (from a strictly validated `name:`), and pass it with
    `--packages`.
  - Refuse files with `// @dart=` language-version overrides.
- **Launch the AOT snapshot directly.** Never go through `dart`, dartdev or
  the Flutter wrapper; a package-manager `dart` can be a shell wrapper that
  rewrites cache stamps. The command is
  `dartaotruntime --old_gen_heap_size=640 <sdk>/bin/snapshots/analysis_server_aot.dart.snapshot --protocol=lsp --suppress-analytics --cache=<run>/cache --packages=<run>/package_config.json`.
  - Run it with an empty environment and no `HOME`. The fixed image entrypoint
    is `/opt/graph-dart/bin/env -i -- /opt/graph-dart/bin/dartaotruntime`.
    Empty Docker CLI/image environment alone is insufficient because runc
    can add `HOME` before the entrypoint runs. The prefix clears these defaults
    before AOT execution; it adds no shell, compiler or downloaded dependency.
    Image validation requires this exact prefix/target and only `PATH=` in
    image metadata. Native CI separately exercises post-runc environment
    clearing; image inspection is not process-environment evidence.
  - Never pass `--diagnostic-port`.
- **Block process creation and deny the network.** A trimmed SDK is
  portable to Linux and Docker. The analyzer container uses a checked
  restrictive seccomp profile that denies `fork`/`vfork`, permits `clone`
  only for threads and returns ENOSYS for `clone3`, plus offline networking,
  a read-only root and bounded memory/PIDs. If that profile or image is
  unavailable, retain syntax evidence only. Docker seccomp permits the
  initial `execve` and cannot by itself rule out later same-process exec;
  the minimal image, sanitized source-only view, and absence of repository
  package/plugin configuration provide the no-target-code boundary. The
  read-only Mac spike's `sandbox-exec` finding is not a production fallback.
- **Package scope.** Initially promote only an unambiguous single root
  `pubspec.yaml` package name. Do not materialize that manifest; write an
  engine-owned package config outside the Dart source view. A monorepo with
  nested package manifests stays syntax-only until a reviewed multi-root
  mapping exists, rather than guessing which `package:` import owns a file.
- **Readiness.** The server is ready at the first `$/analyzerStatus` with
  `isAnalyzing: false` that follows the first `true`.
  - Open a sliding window of about 8 files before querying; that took one
    99k-line run from 13.8 s to 3.8 s.
  - Keep an RSS watchdog and a wall-clock deadline.
  - Treat end-of-stream as failure even at exit code 0.
  - `didChange` on a document that isn't open kills the server.
- **Answers.**
  - Positions are UTF-16 only.
  - `dynamic` calls return nothing.
  - An implicit `call()` resolves to the variable, not to a function.
  - Interface calls resolve to the abstract declaration.

### Verification recipes (docs only)

The existing offline check model already fits. PR 1 adds Dart and Flutter
recipes to `verification-images.md`:

- a digest-pinned base image with `PUB_CACHE=/opt/pub-cache`;
- warm the cache by running the real check during the image build
  (`dart pub get --enforce-lockfile && dart test`), then `chmod -R a+rX`;
- for Flutter, use the official SDK archive, checked against its published
  SHA-256:
  - the SDK directory must be writable by the check's user ID;
  - `safe.directory` must be set;
  - analytics must be turned off;
- the check itself runs on a copy, because pub writes `.dart_tool/`:
  `sh -c "cp -R . /tmp/src && cd /tmp/src && flutter pub get --offline --enforce-lockfile && flutter test --no-pub"`;
- label the recipe a starting point until it has been exercised end to end,
  as the doc already does for its non-Maven recipes.

The [synthetic Flutter widget fixture](flutter-widget-fixture.md) contains
documentation-only package, widget and test snippets. An operator must generate
and review its real lockfile with a selected SDK before exercising the recipe;
neither the fixture nor this design claims native Flutter execution.

### Files

| File                                                                                 | Change                                                                                                           |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/index.ts`                                                    | `Language` gains `"dart"`; `resolution.engine` gains `"dart-analyzer"`                                           |
| `packages/engine/src/context/parser.ts`                                              | `.dart` mapping; route Dart to its extractor; a Dart-only cache version                                          |
| `packages/engine/src/context/dart-syntax.ts` (new)                                   | Signature/body pairing, selector calls, imports, shadowing                                                       |
| `packages/engine/src/context/index.ts`                                               | Dart identity keys only when `.dart` files exist; `resolveDartBindings` in PR 2                                  |
| `packages/engine/src/context/dart.ts`, `dart-snapshot.ts`, `dart-lsp.ts` (new, PR 2) | Runtime, preparation and validation, with a new bounded Dart LSP transport; the Rust transport is not refactored |
| `packages/engine/src/mcp.ts`                                                         | The `symbol_search` language list                                                                                |
| `packages/engine/tests/fixtures/dart/`                                               | A toy `toy_counter` package (`lib/`, `bin/`, `test/`, a committed `pubspec.lock`)                                |
| `docs/flutter-widget-fixture.md`                                                     | Documentation-only toy Flutter package, widget and test; no fabricated lockfile or native execution evidence     |
| `.github/workflows/ci.yml`                                                           | A new _step_ in the Linux x64 job (job names are pinned; step names are not)                                     |
| `docs/platform.md`, `context-lifecycle.md`, `verification-images.md`                 | Documentation; `specs/context/code-indexing.md` AC1 ("seven" families becomes eight)                             |

### Spec `specs/context/dart-indexing.md`

The tests land in the same PR as the criteria they cover, because
`spec-check` refuses a link to a missing test whatever the status.

| AC  | Criterion                                                                       | Test                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1 | Symbols, imports and calls from the toy package; unproven calls stay unresolved | `context-dart.test.ts`: indexes Dart declarations, imports and selector calls from the toy package                                                                                                                                                                                            |
| AC2 | Grammar gaps are reported as incomplete coverage                                | `context-dart.test.ts`: reports Dart syntax the pinned grammar cannot parse as incomplete coverage                                                                                                                                                                                            |
| AC3 | Source-only preparation and pinned-runtime identity                             | `context-dart-snapshot.test.ts`: prepares only bounded Dart source, with eligible calls and declarations; rejects source aliases, executable configuration and untrusted metadata; `context-dart-runtime.test.ts`: does not accept a caller-provided runtime or execute any host Dart wrapper |
| AC4 | Only exact unique declaration targets are promoted                              | `context-dart-snapshot.test.ts`: maps UTF-16 query positions and accepts only exact unique local targets; native top-level binding test is CI-gated                                                                                                                                           |
| AC5 | Failure and cleanup remain fail-closed                                          | `context-dart-runtime.test.ts`: treats stdout end as failure even when the analyzer exits successfully; retains the source view when Docker cannot prove the owned container is absent; native real timeout test is CI-gated                                                                  |
| AC6 | Non-Dart repositories keep their snapshot IDs                                   | `context.test.ts`: keeps snapshot identity unchanged for repositories without Dart files                                                                                                                                                                                                      |

### Decisions

| Question                                          | Decision                                                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A1. How does Dart enter the snapshot identity?    | Keys only when Dart files exist (built on the Dart branch), rather than bumping `PARSER_VERSION`                                    |
| A2. Where does the analyzer runtime come from?    | The hash-pinned, locally built Linux x64 Docker image only; no host path or mutable tag execution                                   |
| A3. Should the Flutter fixture run in CI?         | Deferred; the [toy widget fixture](flutter-widget-fixture.md) and verification recipes remain documentation, not native CI evidence |
| A4. Should the security scan gate `pubspec.lock`? | Now: the Dart branch adds it to the scanner's lockfiles                                                                             |

## Upgrade B: `generator` steps

A new plan step kind alongside `worker` and `template`. It runs a pinned,
operator-registered command inside the offline sandbox over the run
workspace, and its file changes become the step's proposal. A typical use is
regenerating a toy OpenAPI client from `api/toy.yaml` into a tracked
`src/generated/`.

### Approach

- **Registration.** An operator registers
  `{id, revision, image, argv, outputs, reads?, limits}` in
  `.graph/project.json`. `generator-add` assigns a fresh opaque revision on
  every registration, including a same-ID re-add.
  - The image must be digest-pinned or a local image ID, which is stricter
    than `check-add`.
  - `outputs` are exact relative roots.
  - Only the CLI can register; there is no MCP tool or dashboard route.
  - `.graph/**` is a protected path, so no run can register or change a
    generator.
  - Output bounds are part of the registration and can only lower the global
    limits.
- **Plan binding and revocation.** A plan copies the complete registration,
  including its revision, as it copies `verification`; when plan approval is
  required, the content hash covers the image and argv. The copy fixes what
  may run, but does not grant continuing authority. At start, resume, before
  generator dispatch and before applying its proposal, a live registration
  with the same ID and revision must still exist and its canonical fields
  must match the plan's copy. A missing or changed registration refuses
  pending work; a same-ID re-add cannot revive an old plan. Never substitute
  a live command into an existing plan. Create a fresh plan after a change.
- **Running.** The generator gets a view built from the run workspace, as
  `verifyInContainer` does. The container runs with the verification flags
  plus `--read-only --tmpfs /tmp` and `--pull=never`, and is killed on abort.
- **Capture.** Walk the entire bounded view after exit so new paths outside
  declared roots cannot hide; only changes under those roots may become an
  ordinary `WorkerProposal`. The existing `runDag` rules then apply unchanged:
  - write scope and collisions;
  - `prepareProposal` secret screening;
  - the pending and after-patch markers, and rollback;
  - the verification inventory, review and the security gate.

Output capture options:

- G1: a writable bind-mounted view with a post-run walk. It matches
  `check-add` semantics, but output size is only bounded after the run, which
  is the same exposure a check already has.
- G2, a hardening option: a tmpfs workspace, with the output sent as an
  archive on stdout and read by a hand-written bounded reader. It needs `sh`
  and `tar` in the image, an entrypoint override, and a `command()` that
  returns bytes.
- G3, rejected: the generator emits its own manifest. That is not generic.

### Files

| File                                              | Change                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/index.ts`                 | `kind` gains `"generator"`; `generatorId`; `GeneratorRegistration`; `ProjectConfig.generators` and its schema; `ExecutionPlan.generators`                                                                                                                                                                                                                            |
| `packages/engine/src/execution/generator.ts`      | New: view, container, walk, diff, limits                                                                                                                                                                                                                                                                                                                             |
| `packages/engine/src/execution/dag.ts`            | Step schema; `validateDag` requires `generatorId` and forbids `providerId`, `templateId`, `inputs` and `effort` on generator steps                                                                                                                                                                                                                                   |
| `packages/engine/src/service.ts`                  | Generator-only plans mirror template-only ones (no worker, tester or repair); fix the `templateRuntimeCapability(step.templateId!)` branch; send any non-worker step down the DAG path; a `generate` branch; `modelRoles` counts every non-worker kind as local; an image preflight with `LocalDetailError`, as `assertVerificationImages` does; a tester-file guard |
| `packages/engine/src/planning.ts`                 | `likelyWorkerTurns` counts only `kind === "worker"`                                                                                                                                                                                                                                                                                                                  |
| `packages/engine/src/cli.ts`                      | `generator-add <id> <image> --output <path>… [--read <glob>…] -- <argv…>`, `generator-remove`, `generators`; `plan-approve` shows the registration                                                                                                                                                                                                                   |
| `packages/engine/src/mcp.ts`, `server.ts`         | Step enums gain `generator` and `generatorId` (both use `.strict()`); no registration surface                                                                                                                                                                                                                                                                        |
| `packages/dashboard/src/RunsPage.tsx`             | It labels any non-template step as a worker today                                                                                                                                                                                                                                                                                                                    |
| `docs/dag-and-template-runtime.md`, `platform.md` | Documentation; `specs/integration/plan-approval.md` AC2                                                                                                                                                                                                                                                                                                              |

### Safety analysis

- **Command injection.** argv is an array handed to `docker run` with no
  host shell, and plans carry no parameters. Neither a plan author, a cloud
  client nor a planner can alter the command.
- **Network and environment.** `--network=none`. GE adds only `HOME=/tmp`
  and `CI=true` to the container environment and does not forward host
  credential variables. It does not strip environment entries supplied by the
  registered image or Docker defaults. The operator-reviewed image and local
  Docker daemon remain trust roots; this is not the Dart analyzer's separate
  empty-process-environment contract.
- **Resources.** `--memory`, `--cpus` and `--pids-limit`, plus the step's own
  policy timeout.
- **Output size.** At most 50 changed files (the checkpoint cap), 1 MiB per
  file and 8 MiB in total. Logs are redacted and kept local.
- **Symlinks and escapes.**
  - The whole view is walked with bounded `readdir` and `lstat`; files are
    opened `O_NOFOLLOW`.
  - Symlinks, special files, non-UTF-8 or NUL content, mode changes and
    deletions are refused.
  - Outside the roots, input files must be unchanged; new files there are
    refused, not silently discarded.
  - The existing proposal contract cannot replace the content of an existing
    empty file because its `before` substring must be nonempty. Refuse that
    case until a separately reviewed proposal extension supports it.
- **Secrets.** Excluded paths never enter the view. Output content is
  screened, and credential-named output paths are refused.
- **Protected and ignored paths.** Output under `.graph/`, `node_modules/`
  or a Git-ignored path is refused or rolled back. A generator whose default
  output is under `node_modules/` must be redirected to a tracked directory.
- **Tester files.** A generator may not change the tester's tests.
- **Determinism and idempotency.**
  - Each run records `{imageId, argvHash, inputsHash, outputsHash}`, and a
    no-op completes with no paths.
  - Completed steps never rerun.
  - A pending step still at its pre-patch state reruns the container, since
    nothing was applied.
  - A pending step at its post-patch state is recorded as applied without
    rerunning.
  - `generate()` never touches the run workspace, so `runDag`'s "a proposal
    worker modified the workspace" check still holds.
- **Export rule.** A generator reads private files, so it counts as a local
  role. A cloud client's plan that mixes a generator with a cloud worker is
  therefore refused.
- **Live revocation.** Check every registration referenced by a plan before
  reserving work, so a sibling step cannot apply first. Check again at each
  generator launch and before its output is applied; revocation during a run
  discards unapplied output. Completed steps remain historical evidence. A
  pending checkpoint whose full post-patch fingerprint already matches the
  retained workspace may be reconciled as applied without running the image;
  validate that checkpoint and its dependency order before exempting it from
  the live-registration check.

### Spec `specs/runs/generator-steps.md`

Environment-gated tests count for `implemented` only when a CI step runs
them with the switch set; the Docker tests fit the existing
`GRAPH_ENGINE_DOCKER_TESTS` step.

The [generator spec](../specs/runs/generator-steps.md#acceptance-criteria)
owns the full criteria and exact executable test bindings. This summary uses
the same AC numbers; it does not substitute planned test names for evidence.

| AC  | Criterion summary                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------- |
| AC1 | Operator-only CLI registration, pinned image, exact argv, safe roots and fresh revisions                                |
| AC2 | Complete frozen registration shown for approval and bound by the plan hash; no worker required for generator-only plans |
| AC3 | Disposable offline, read-only-root container with a writable view, no forwarded credentials and bounded execution       |
| AC4 | Whole-view capture refuses unsafe paths/content, unsupported edits, excess output and changes to tester-created files   |
| AC5 | Safe output passes the ordinary proposal, scope, checkpoint, verification, security and review gates                    |
| AC6 | Generators count as local roles under the cloud-authored plan's one-side rule                                           |
| AC7 | Reconciled pre-patch work reruns; completed or matching post-patch work does not; no-op output changes no paths         |
| AC8 | Container and output limits remain within project policy ceilings                                                       |
| AC9 | Live registration changes revoke pending dispatch/application; only validated historical output is exempt               |

### Decisions

| Question                                                  | Decision                                                                                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1. How is output captured?                               | G1, the bind-mounted view with a bounded post-run walk                                                                                                           |
| B2. What about generators that write over 50 files?       | Split them across steps, rather than giving generators higher caps                                                                                               |
| B3. Are deletions supported?                              | No, they are refused                                                                                                                                             |
| B4. How is determinism checked?                           | Record hashes only; don't run twice                                                                                                                              |
| B5. Does MCP list generators?                             | No                                                                                                                                                               |
| B6. What if the live registration changes after planning? | Refuse pending use of the plan's frozen copy unless the live ID, revision and canonical fields still match; approval, when present, does not override revocation |

### Order

1. The `modelRoles` fix with its test, which is useful on its own.
2. The contracts and DAG changes.
3. `generator.ts`.
4. The CLI and MCP surface, and the docs.
