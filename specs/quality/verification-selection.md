# Reviewed per-plan verification selection

- ID: verification-selection
- Status: implemented
- Area: quality

## Problem

Projects can register checks for several independent areas, while a bounded
task needs only the relevant optional checks plus every mandatory check. A
model must not invent replacement commands, omit mandatory gates, or silently
reuse approval after catalogue drift. Selection must be explicit, stable and
bound to the existing approved plan without changing the project catalogue.

This follow-on is separate from installed-worker identity. It was released in
[PR #123](https://github.com/MILTONADINA/graph-engineering/pull/123) at
`104accacf0c4389699bfab3f32140095e13654fa`. Required CI run `36820953784`,
attempt 1, passed all nine jobs on checked head
`37ffe9ca190dab56864efa99b60110c262225edd`; checked and merged commits share
tree `edd348f0ea2a5d5db62857ed8876633459ded732`. Scoped source review found
no blockers. The PR verification record has full build/job identities and
limitations; this is not a claim of live inference or consumer acceptance.
Local Laya's design-only recommendation was
`explicit_names` (reported score 0.6335), consistent with using operator-assigned
IDs rather than inferred positions. That recommendation is not authority to
weaken checks or approve a plan; no Jev call was used for this design choice.

## Acceptance criteria

- AC1: Catalogue entries retain `image` and exact `argv`, optionally adding a unique stable `id` and boolean `optional`. Omitted/false optional means mandatory; true requires an ID. IDs match an ASCII alphanumeric leading character followed by up to 79 alphanumerics, underscores or hyphens. Legacy anonymous duplicate checks remain valid. Invalid metadata and duplicate IDs are refused without rewriting the catalogue.
  - Test: packages/contracts/tests/verification-selection.test.ts :: preserves anonymous legacy checks and accepts mandatory-default named checks
  - Test: packages/contracts/tests/verification-selection.test.ts :: requires unique stable IDs and refuses unnamed optional or malformed catalogue entries
  - Test: packages/engine/tests/verification-selection-cli.test.ts :: refuses duplicate IDs and unnamed optional registration without rewriting the catalogue
- AC2: `check-add --id <id> [--optional] <image> -- <argv...>` parses metadata only before the image. Trailing command-owned options remain byte-for-byte arguments. CLI `plan --check <id>` is repeatable and forwards the exact explicit selection, including with `--spec`; engine, HTTP and MCP accept the same `checkIds` input and never accept caller-supplied replacement commands.
  - Test: packages/engine/tests/verification-selection-cli.test.ts :: registers check metadata only before the image and preserves command-owned options
  - Test: packages/engine/tests/verification-selection-cli.test.ts :: passes the same explicit selection through spec-based planning
  - Test: packages/engine/tests/verification-selection-api.test.ts :: accepts registered check IDs through HTTP without accepting caller commands
  - Test: packages/engine/tests/verification-selection-api.test.ts :: applies registered selection through %s MCP without exporting check commands or granting approval
- AC3: Omitted selection selects every registered check. Explicit IDs are nonempty, unique and bounded to 1,000; every catalogue entry must be named, every selected ID known, and every mandatory ID included. Checks execute in catalogue order, and all selected optional checks become required for this plan's success. No decision model can narrow the resolved set further.
  - Test: packages/engine/tests/verification-selection-cli.test.ts :: omitted selection keeps every check and explicit selection rejects unknown duplicate or omitted mandatory IDs
  - Test: packages/engine/tests/verification-selection.test.ts :: omitted selection freezes every configured check and its full ordered catalogue identity
  - Test: packages/engine/tests/verification-selection.test.ts :: requires mandatory entries and resolves explicit selections in catalogue order
  - Test: packages/engine/tests/verification-selection.test.ts :: refuses explicit selection while even one legacy entry is unnamed
  - Test: packages/engine/tests/plan-verification-selection.test.ts :: runs the exact approved selected checks for a local worker without skipping mandatory checks
  - Test: packages/engine/tests/plan-verification-selection.test.ts :: omitted selection retains all checks for worker and all-generator plans
  - Test: packages/engine/tests/plan-verification-selection.test.ts :: a failing selected optional check still fails the run
- AC4: Every new plan freezes full resolved verification descriptors and `verificationSelection: { catalogueSha256, checkIds }`, with stored `checkIds: null` meaning all. The whole-catalogue digest binds unselected entries, catalogue/argv order and metadata presence, not JSON object-key order. Full-plan approval and its CLI display include the complete selection and descriptors; selectors grant no approval.
  - Test: packages/contracts/tests/verification-selection.test.ts :: validates complete frozen all-check and explicit-selection bindings
  - Test: packages/engine/tests/verification-selection-cli.test.ts :: forwards repeated check IDs, keeps catalogue execution order and shows the full approval binding
  - Test: packages/engine/tests/verification-selection.test.ts :: ignores object key order but binds catalogue order, argv order and explicit field presence
  - Test: packages/engine/tests/verification-selection.test.ts :: validates catalogue inputs before producing a public digest
- AC5: Start, resumed execution and retained selection validation refuse catalogue drift or inconsistent descriptors and require a fresh plan, never rebinding an old approval. This includes unselected check changes. Legacy plans without the selection object retain old behavior only while both current and retained entries have no own `id` or `optional` metadata.
  - Test: packages/engine/tests/verification-selection.test.ts :: refuses altered resolved commands or a selector inconsistent with its retained descriptors
  - Test: packages/engine/tests/verification-selection.test.ts :: allows old all-anonymous plans only while both retained and current checks lack selection metadata
  - Test: packages/engine/tests/plan-verification-selection.test.ts :: refuses catalogue drift at %s start without dispatch
  - Test: packages/engine/tests/plan-verification-selection.test.ts :: refuses catalogue drift at %s resume using the retained run plan without fresh approval evidence
  - Test: packages/engine/tests/plan-verification-selection.test.ts :: rejects stored descriptor tampering even with approval of the altered plan
  - Test: packages/engine/tests/plan-verification-selection.test.ts :: rechecks catalogue drift after a worker slot wait before any worker reservation
  - Test: packages/engine/tests/plan-verification-selection.test.ts :: refuses catalogue drift %s verification without publishing success
  - Test: packages/engine/tests/plan-verification-selection.test.ts :: refuses changed catalogue at review approval even when retained checks passed
  - Test: packages/engine/tests/plan-verification-selection.test.ts :: rechecks after asynchronous completion decisions immediately before publication
- AC6: Verifier/run evidence retains stable named check identity, while anonymous legacy receipt shape stays unchanged. Required checks, container isolation, snapshot verification, tester protections, approval/publication, security review and native-worker controls remain independent and cannot be bypassed by selection. Cloud MCP must not export registered command/image details.
  - Test: packages/engine/tests/verification-check-identity.test.ts :: retains named check identities in verifier results without changing legacy receipts or command order
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: always runs every required check and cannot accept a worker's claim that tests passed

## Security considerations

An ID selects an operator-registered descriptor; it is not executable text, a
file path, a glob or a new verification registration. Only explicitly optional
checks may be omitted; default mandatory behavior is preserved. Selection
does not shrink the verification working set, allow network access, suppress
failure of a selected check, grant plan approval, or bypass security and review
gates. An operator must intentionally name and classify existing checks before
explicit selection becomes available. The complete catalogue digest invalidates
stale plans even when an edited optional entry was not selected.

Keep command/image descriptors local where existing MCP privacy boundaries
require it; interface refusals must not echo registered command text. Tests and
examples use synthetic toy projects only. A mocked verifier result proves
selection and evidence plumbing, not a live container or accepted engineering
result. Existing required CI remains the release gate.

## Non-goals

No automatic classification of mandatory checks, inferred ID migration,
arbitrary command selection, runtime decision-based omission, new provider
calls, consumer-specific check catalogue, CI bypass, plan approval authority,
container network changes, or private-project integration is introduced.
