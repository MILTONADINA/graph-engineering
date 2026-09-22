# Local validation — 2026-09-22 UTC

These are development observations, not production calibration or a claimed
percentage reduction in model cost. Private run databases retain detailed
events and failures. No paid model calls were authorized or made.

## Real local inference

The opt-in `evaluation/managed-smoke.mjs` used the existing Qwen endpoint, the
pinned local Laya checkpoint, and a network-disabled `node:24-alpine` container.
Run `2167781e-9fc0-4ede-b1cf-a067f2cb610e` succeeded between
03:41:35.714 and 03:43:08.307 UTC. It corrected a synthetic one-based pagination
offset, passed the independent existing tests, and left its original checkout
unchanged. The ledger recorded 2,564 input tokens (worker plus decisions), 84
output tokens, and $0 marginal external API cost. Eleven shadow decision
records were captured. Human acceptance remained pending.

This result followed an earlier cancelled attempt with the server's default
thinking behavior. The successful run explicitly disabled local thinking.
Cancelled calls retain unknown usage instead of inventing zero-token charges.
The synthetic result is ineligible for production promotion.

A measured warm Laya request contained two typed questions and recorded **one
actual model forward pass**, 77 input tokens, 275.38 ms inference time, and
318.56 ms client elapsed time on MPS. This is one observation, not a latency
distribution, accuracy evaluation, or calibrated confidence claim. The English
checkpoint is pinned to `1c5edc17a7acd8701df6fc341c0d179f1c62c982`, SDK 0.3.5.

Jina's real FP32 offline smoke test retrieved the expected security source
after verified-cache provisioning. A real MCP stdio client discovered six
tools and retrieved six explicitly exportable source items with local
diagnostics filtered. The first cold semantic request exceeded its original
timeout; retry after vector preparation succeeded. This is a startup-latency
limitation, not evidence of subsecond cold retrieval.

## Repository task and assisted recovery

Run `708c8067-c452-4e6f-bc3a-4470e477457c` exercised this repository itself:
Qwen generated regression coverage for zero and negative API-spend ceilings.
Its first test used an incorrect import and expected a value from a void
assertion. The implementation assistant corrected those two errors in the
stopped, retained workspace and recorded an explicit
`reconciliation.assisted_patch` event. This was **not an autonomous model
success**, a human PR approval, or production calibration evidence.

The run also exposed real integration defects: inconsistent nested public
`.graph` path handling, request framing outside retrieval's budget, and Node
24's native recursive dependency copy failing under the restricted Docker
bind mount. These were corrected with regression coverage. Infrastructure
setup failures now stop before consuming another model repair attempt.

The corrected test passed the repository build/typecheck/test command in its
offline container. The separate graph-validator fixture then exposed its
dependence on an environment-template file deliberately omitted by the
privacy policy. The harness fix uses six explicit blank assignments in its
own temporary fixture and independently tests the absent-environment warnings;
it does not relax secret exclusions or suppress validator diagnostics.

After recorded assisted reconciliation, the complete configured offline
verification succeeded at **04:16:07.794 UTC**. The engine marked automated
checks passed, human acceptance pending, and security/architecture review
required. The successful verification used image
`sha256:d57d4ad69174ff62a010beda995e1e552ad16ec468782715b9a7a8dee218bd84`.
The run did not automatically modify or publish the original checkout; the
reviewed regression test and harness fix were separately committed to the
feature stack. An intervening worker requested a nonexistent contracts source
path and stopped safely; that failed attempt also remains in the event log.

Repair requests were cancelled while the shared local server had concurrent
and queued work. Aggregate input/output usage therefore remains unknown,
with completed-call records and unresolved reservations preserved. Recorded
marginal external API cost is $0. Do not convert this run into an accuracy,
latency, or cost-savings benchmark.

## Unassisted historical replay

The new local-only historical runner replayed the repository's recorded
zero-budget schema defect on 2026-09-22, **07:06:05.923–07:07:05.177 UTC**.
It supplied Qwen only the broken contracts source from commit
`3bb1556272160080e4748737c5358b226608e303`, the objective and JSON-input
acceptance criteria. The known repair was used only to validate the independent
harness, never as worker context. The harness rejects every edit outside the
budget-schema initializer and requires its replacement to be inert, bounded
numeric-schema literals before compilation. The oracle projects only the recorded
schema repair, excluding unrelated historical interface additions. One worker
call produced a patch that passed the external, network-disabled Docker checks
without assistant correction. Reported usage was **3,387 input tokens, 161 output
tokens, $0 marginal API spend**; worker-adapter elapsed time was 58.25 seconds
on the shared local server. This is not an isolated inference-latency benchmark.

The receipt is retained privately at
`.graph/local/historical-qwen-guarded-20260922.json`. It retains generated source
and records source, harness, profile and image hashes. The final verification
image was `sha256:b8fbb70d27b3989e2243e466c967214cc4496197d8a7a961d8e3907200218a1a`.
Seven harness regressions and three actual Docker marker/early-exit attacks
passed/rejected as expected before this fresh model attempt.

The earlier `.graph/local/historical-qwen-20260922.json` receipt remains as
preliminary history: its marker-only verifier lacked the inert-change guard,
so it is not counted as independently verified repair evidence. The new attempt
started again from broken source; no preliminary patch or oracle reached the
worker. An initial harness-only validation also incorrectly
expected the historical repair to reject non-finite JavaScript numbers; that
validation failed before any model call. The replay was corrected to match its
recorded JSON-configuration scope. Separately, current programmatic schema
validation now rejects non-finite numbers with regression tests.

This is a single retrospective, restricted schema repair—not unassisted completion
of a broad repository task, independent engineering calibration, or a paired
token-savings result. It cannot promote any decision category. The earlier
assisted full-repository run and its failures remain unchanged.

## Verification and operations

The earlier backend-foundation complete check passed 59 CLI, 9 dashboard, and 212 engine tests
(four opt-in tests excluded from that default run), plus typechecks and
production builds. Existing Docker-enabled suites passed all 19 tests, and the
new backend-composition suite passed all seven tests with Docker enabled.
Its generated Product/Invoice code compiled under strict TypeScript and passed
29 emitted/integration checks in an offline container against locked dependencies.
The generated-app checks mock database operations; no live PostgreSQL/migration
coverage is claimed. The real embedding test was exercised separately earlier.
Six desktop/mobile browser checks, 20 standalone graph-validator checks,
nine Python sidecar tests, package-content validation and the production dependency
audit also passed after these changes. Counts describe observed checkpoints, not a promise that
later regression additions leave counts unchanged.

The expanded 21-renderer checkpoint subsequently passed the complete workspace
check: 59 CLI, 9 dashboard and 249 engine tests, six explicit opt-in skips,
typechecks and production builds. Both backend container suites passed 13 engine
tests, including strict generated-code compilation and separate 29-test foundation
and 37-test CRUD suites. The new testing-template suite passed against a disposable
PostgreSQL instance inside its network-disabled container: selected-table cleanup,
foreign-key refusal without CASCADE, and preservation of an unlisted table were
executed as real SQL. No host database or provider credentials were used.

The first fork CI run for this checkpoint correctly flagged three stale graph
fixture expectations: the hardened integration template now requires an explicit
`TEST_DATABASE_URL`. The fixed fixture documents that seventh required variable
and independently tests its omission; all 21 standalone validator checks pass.
This change preserves the missing-environment warnings instead of suppressing them.

Nine actual historical cases now have pinned intake provenance. Two additional
retrospective fixture adapters reproduce failing baselines and passing recorded
repairs across 22 variant checks, without model/network calls. These are not
arbitrary-patch verifiers, independent labels, or paired model measurements; see
[the corpus evidence and limits](calibration-corpus.md).

Live lexical indexing also exercised the compiler pass on this repository:
929 files, 263 parsed sources and 666 text-only records. Its receipt explicitly
reports omitted credential-like fixtures, source fragments with syntax errors,
unsupported package imports and ambiguous/missing module targets. The compiler
does not infer complete coverage from the absence of a crash.

All 60 cross-language synthetic tasks failed in their broken state and passed
their supplied oracle in 120 actual offline container runs; see
[the fixture receipt](../evaluation/fixture-validation-2026-09-22.json).
Those are harness checks, not 60 model-generated repairs.

The [10,000-file benchmark](context-benchmark-10000.json) records source size,
timing, memory and storage overhead with explicit synthetic/no-embedding limits.
The live project's context/run databases and allowed private configuration
were backed up and checksum-verified into a new staged restore directory.
The restore was not activated and does not replace current data or retained
workspaces.

## Full implemented-catalog runtime expansion

All 42 implemented catalog entries now have registered, exact-manifest-checked
renderers; 13 planned entries remain unavailable. The previous 21-renderer
checkpoint above remains historical evidence rather than being relabeled.

The following additional checks ran locally without paid inference, host database
access, provider credentials, or network access during generated-code execution:

- Backend and CRUD: strict TypeScript plus 36 and 44 generated tests, including
  generic parser errors and redaction of internal messages and logs.
- Authentication: 34 generated/security tests and 13 actual PostgreSQL tests,
  including concurrent token consumption, password-reset/refresh races, stale
  login rejection, rollback, expired-access logout and refresh/logout races.
  Logout revokes account-wide refresh sessions; existing access JWTs still expire
  according to their TTL. Email delivery remains an explicit application adapter.
- Storage: strict TypeScript plus 21 checks using actual multipart parsing and
  offline SDK signing. Provider requests were mocked; no S3/IAM/provider
  compatibility claim is made. The default empty-body presigning checksum was
  identified and corrected before the final signer tests passed.
- Database and DevOps: 13 engine tests with both Docker opt-ins, actual isolated
  PostgreSQL generation/migration/seed checks and offline generated-image builds.
  Tests cover transaction rollback, history drift, operation serialization and
  ambient PostgreSQL credential fallback. Reversing committed migrations is not
  claimed. Remote seeding is deliberately unsupported without another boundary.
- Express scaffold: strict source/test compilation, 17 generated checks and a
  compiled-server health probe, followed by 26 checks preserving its original
  tests after error-handler composition. Its isolated dependency fixture reported
  zero production/development audit findings at this checkpoint.
- Frontend: strict TypeScript, 31 generated/hook/security checks, a real Next
  production build and Chromium login/logout, registration, escaped table cells,
  pagination and two-tab refresh serialization. This fixture uses a local
  contract API, not the generated authentication backend. Web Locks require a
  supported secure browser context; arbitrary cross-site cookie deployments are
  not validated by the same-site, different-port test.

A separate [real full-stack fixture](fullstack-runtime.md) then passed both engine
checks, strict generated compilation, 37 backend and three frontend emitted tests,
actual Drizzle SQL generation and repeated guarded migrations on PostgreSQL 16.
Chromium exercised the production-built Next frontend against the actual generated
Express backend: login, `/me`, expired-JWT refresh, logout and expired-access logout,
with real refresh-row assertions. Secure/HttpOnly/SameSite cookie behavior and a
different-site rejection were observed through fixture-only HTTPS proxies, not an
API stub. The backend used explicit test-mode loopback PostgreSQL; this does not
prove production PostgreSQL TLS, external email delivery or arbitrary deployment
topologies. The resolved fixture image was
`sha256:911de3a2baede24c377cb8a3b49eb75abdc2bb74934c00ba846bc952a0c78a71`.

Cross-component review corrected the project ledger to use the actual invocation
ID and complete emitted file inventory, rather than a hardcoded template ID.
Root public ledgers remain opt-in and are not private engine state or execution
receipts. A fixture naming error initially exposed a container-only storage test
to default host discovery; the fixture now uses the explicit `.fixture` extension
and is copied into tests only inside its intended generated application.

The Windows CI diagnostic failure at commit `4daa165` was an overly strict test
expectation: absent trusted CPython must report an explicit syntax-only fallback.
The focused fix passed 22 tests locally; fork run `35703779516` at `629915a` passed
all six checks. This receipt does not certify later commits before their own CI.

## Compiler resource-limit corrections

Fork run `35707812487` at `932dfe9` passed macOS, Windows, generated-apps and
sidecar checks, but failed the combined Python resource-limit assertion on both
Linux runners. That assertion did not identify which option failed, so its exact
failing limit cannot be recovered from the log. The investigation reproduced two
independent enforcement gaps: results could beat an overdue timer callback, and
a short-lived analyzer could finish between parent RSS samples.

The corrected resolver includes synchronous spawn in its monotonic deadline and
rejects late completion independently of timer delivery. The fixed helper checks
its own peak RSS before publishing output. Deterministic before/after checks
showed the prior resolver accepting 20 ms of synchronous spawn or completion work
under a 5 ms budget; the corrected resolver rejected both. The old helper ignored
the low RSS limit; the corrected helper rejected it without a parent `ps` sample.
Offline Linux ARM checks repeated node/output/deadline/RSS limits 30 times each
without accepting evidence. Default deadline regressions no longer assume that
every interpreter must take more than 1 ms to finish. CI confirmation of a later
commit remains separate from these local observations.

The shared command transport now also rejects successful exits observed after
its deadline. Three focused checks cover ordinary success, output overflow, and
a real subprocess exit while timeout callback delivery is deliberately disabled.
Go's new compiler helper passed both offline helper and native Linux tests; see
[the versioned runtime proof and limitations](context-lifecycle.md#snapshot-only-go-bindings).

## Java and C# compiler verification

The Go/Python checkpoint `dfe64b8` passed all six fork jobs in run
`35710027894`, including the expanded storage, database, frontend, and real
full-stack browser integrations. This does not certify subsequent commits.

Subsequent compiler integration checks used explicitly required native runtimes,
so an unavailable compiler could not silently skip its entire proof. Network-disabled,
nonroot Linux/ARM64 fixtures passed 11 Go tests (six nested Docker cases skipped),
15 Java tests (no skips), and 10 C# tests (four nested Docker cases skipped).
Java additionally passed 14 native Mac checks before the fixture-presence assertion
was added. C# and Go remain explicitly unavailable on this Mac; no host compiler
was installed. These are bounded declaration-binding tests, not whole-project
builds or complete runtime call graphs.

Independent review corrected mutable runtime descriptors and getter-based
check/use races; subprocess arguments now come only from the immutable trusted
identity. Invalid XML comments can no longer be stripped into apparently valid
C# project configuration. A process-exit/RSS-sampling race now permits one
bounded zero/no-process recheck, while missing samplers and excessive memory
still fail closed. The expanded Python suite passed 18 checks, including real
interpreter runs with injected zero/no-process, missing-sampler and over-limit
samples. Reproducible Java/C# fixtures and exact subsets are linked from
[context lifecycle](context-lifecycle.md).

## Linux Python accounting correction

The subsequent Java/C# checkpoint `cf1465f` passed five of six fork jobs in
run `35712316286`. Linux x64 failed the unchanged seven-language context test:
the Python helper incorrectly reported a resource-limit fallback. An isolated
reproduction showed `ru_maxrss` retaining 414,108 KiB from the large pre-exec
Node parent while the new interpreter's `/proc/self/status` reported a peak of
8,380 KiB. This was a false rejection, not evidence that the interpreter had
exceeded its 256-MiB allowance.

The corrected Linux helper reads the current interpreter image's `VmHWM` from
that fixed kernel path with bounded, strict parsing. Address-space, CPU, parent
RSS and wall limits remain unchanged. Tests require a successful real binding
under an inflated parent, rejection at a 1-KiB limit, retained enforcement after
a 64-MiB allocation is freed, and rejection of malformed/oversized accounting.
The Python/context suite passed all 36 checks in offline Linux and 33 checks on
macOS (three Linux-only cases skipped). These local results do not certify a
new fork CI run before it completes.

## Rust declaration binding integration

The pinned `rust-analyzer 0.3.3057-standalone` adapter was integrated into context
indexing, snapshot identity, graph storage and provenance-aware retrieval. Its
official archive and expanded binary hashes were verified by the reproducible
provisioning script, without host/global installation. The isolated Linux ARM64
adapter suite passed 33 checks. Independent review reproduced and verified fixes
for shared-crate module ownership, duplicate declaration/import bindings, and
argument-position `impl Trait` targets. None of those cases now promotes an edge.

The additional real-runtime context integration exercises SQLite persistence,
unchanged snapshot reuse, changed-source invalidation, complete private-source
provenance, cloud export filtering and historical exclusion changes. The fixture
passed 34 tests; its unavailable-runtime-only case correctly skipped because the
native runtime was present. The exact image was
`sha256:84b677b893faae715f1b4c127447cbcc685845bc86227c265e031dcee9a27f93`.
The fixture
does not evaluate Cargo/configuration or compile/run repository code. Runtime
availability is mandatory in its native job. macOS/Windows retain explicit
fallback; the feature is LSP declaration navigation, not full Rust compilation.

The full local `npm run check` passed: 59 scaffold tests, nine dashboard tests,
347 engine tests, and all typechecks/builds. The 47 skipped engine tests include
native-runtime and separately opted-in container cases; they are not counted as
successful execution. Fork CI for this newer stack remains separate evidence.

## Cross-platform Rust URI correction

Fork run `35713754141` at `a833127` passed the new Linux Go/Java/C#/Rust
runtime steps, but Windows exposed an unhandled `fileURLToPath` error for a
drive-less Unix URI in a negative test. Invalid, nonlocal and platform-invalid
target URIs now retain unresolved evidence rather than throwing. Fourteen
adversarial URI forms and a valid-link control preserve exact canonical-path,
range and provenance checks. The adapter snapshot version was incremented.
The targeted suite passed 33 native Linux checks and 26 Mac checks (seven native
cases skipped). Windows confirmation remains a separate later CI result.

## Remaining evidence boundaries

Hosted Jev/cloud inference, real native worker execution, reviewed engineering
labels, paired baseline/candidate costs, and production promotion were not
tested or inferred. Codex's installed schema lacks required restricted read
roots; Claude needs API-key authentication; Cursor's native CLI is absent.
MCP configuration is independent of these native worker limitations.

Fork branch protections were verified for `main` and `dev`. Feature-stack CI
runs on the fork. No PR approval, merge, upstream synchronization or main push
is part of these measurements.
