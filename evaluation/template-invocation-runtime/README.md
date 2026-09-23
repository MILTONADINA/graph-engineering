# Historical template-invocation verifier

This fixture executes candidate graph-validator JavaScript and compiles candidate JSON schemas **inside QuickJS/WASM in a resource-bounded, network-disabled Docker container**. Candidate code is never imported by host Node. The host owns the expected outcomes; the guest returns only the observed CLI JSON and captured exit status, never a `passed` assertion.

## Provision and run

Provisioning is explicit and may download the pinned Node image and locked npm dependencies. It copies only six reviewed runtime/build files and ten immutable baseline schema blobs into an owned temporary build context. It does not upload the repository, install into the active workspace, or call a model.

```sh
node evaluation/template-invocation-runtime/provision.mjs
GRAPH_ENGINE_TEMPLATE_GUEST_TESTS=1 GRAPH_ENGINE_HISTORY_TESTS=1 node --test evaluation/candidate-template-invocations.test.mjs evaluation/verify-template-invocations.test.mjs
node evaluation/verify-template-invocations.mjs --validate-history --expected-sha256 443b490cd991b9afaa77a66ccb8eea7466d438e50b20f80170dd3a4cd237f049 --output .graph/local/template-history-new.json
```

Output paths must be new; receipt writes are exclusive and private (`0600`). Substitute `--candidate candidate-files.json` for `--validate-history` to verify a JSON object mapping allowed repository-relative paths to complete candidate source strings. No shell command or patch-execution language is accepted.

The public API is `verifyTemplateCandidate(files)`, `pinnedTemplateCandidate("base" | "repair")`, and `validateTemplateHistory()` from `evaluation/verify-template-invocations.mjs`.

## Exact historical scope

Task: `distinct-template-node-invocations`; baseline `e9bdbe0096a86ff467736016f1a9f9e060115469`; repair `a07076c273117bd488a8971258c82c5eb149cf29`.

Allowed candidate paths:

- `graph-templates/tools/validate-graph/index.js` (required)
- `graph-templates/tools/validate-graph/contracts.js` (optional)
- `graph-templates/tools/validate-graph/validate.js` (optional)
- `graph-templates/artifacts/architecture.schema.json` (optional)
- `graph-templates/artifacts/test.schema.json` (optional)

The original intake listed validator modules but omitted two necessary schema changes. This verifier records those schema Git blob IDs and hashes as an explicit supplement; it does not mutate the reviewed corpus or silently give baseline candidates repaired schemas. All ten schema files originate from the baseline. Candidate schema overlays may modify only invocation-related fields/version conditions and description annotations; unrelated baseline constraints must remain unchanged.

The 37 independently constructed fixtures exercise valid repeated-template invocations and explicit instance edges, duplicate instance IDs, dangling edges and bindings, ambiguous/wrong-template dependencies, ordering/cycles/conflicts, planned and missing templates, manifest identity, per-instance test coverage, legacy singleton compatibility and ambiguous legacy duplicates, artifact aliases, schema constraints, and non-artifact JSON exclusion. Fixtures use small explicit template registries rather than the historical repair's tests or large example projects.

Baseline validation must complete every fixture and fail specific invocation-identity witnesses. The repaired revision must complete and pass every positive and negative fixture. A crash, protocol error, interpreter failure or deadline cannot serve as a baseline behavioral witness. Repair modules without the accompanying schema changes are also tested and must fail actual schema validation.

## Isolation and evidence limits

Each fixture uses a fresh container and QuickJS realm. Docker is pinned to a local socket/named pipe and immutable image SHA: no network, host mounts, forwarded credentials, privileges, additional capabilities, writable image, automatic pulls or dependency installation. The guest has only a read-only in-memory fixture filesystem, fixed POSIX path operations, pinned Ajv/formats, inert process arguments, and bounded CLI output. Approved missing fixture files behave like `ENOENT`; attempts to read host paths or require unknown modules permanently fail that invocation.

QuickJS has memory/stack/interrupt limits, with an independent 7.5-second host deadline and 512-MiB container limit. Candidate-created pending jobs cannot be accepted. Prototype serialization hooks cannot rewrite captured exit status. These are defense-in-depth limits, not a guarantee against runtime vulnerabilities or a malicious operator who replaces the trusted image/host.

Receipts bind candidate source bytes, supplementary historical schema identities, provisioned schema bytes, runtime/lock/QuickJS-WASM/Ajv-bundle hashes, immutable image ID, and host verifier/oracle source hashes. This is a known-history mechanical verifier, not a held-out benchmark, paired worker measurement, independent review, calibrated routing result, or production-promotion authority. All fixture receipts explicitly report `modelCalls: 0` and `promotionEligible: false`.
