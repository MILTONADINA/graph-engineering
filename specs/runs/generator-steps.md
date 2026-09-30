# Offline generator steps

- ID: generator-steps
- Status: draft
- Area: runs

## Problem

A reviewed code generator may need to update tracked source during a managed
run. It must not execute on the host or gain authority from a plan that names
an unregistered or subsequently revoked command. Its output must face the
same proposal, checkpoint, verification, security and review gates as a
worker's patch.

## Acceptance criteria

- AC1: Only an operator's CLI can add, replace, remove or list registrations.
  Each registration has an opaque fresh revision, a digest-pinned or local-ID
  image, exact argv, safe relative output roots and bounded limits. A same-ID
  replacement gets a new revision. MCP and HTTP expose no registration write.
  - Test: packages/engine/tests/cli.test.ts :: registers only safe pinned generators, preserves argv, and revokes old revisions
  - Test: packages/engine/tests/generator-contract.test.ts :: requires a digest-pinned image, exact safe output roots, and bounded limits
  - Test: packages/engine/tests/mcp.test.ts :: lets a connected client plan, start, follow, list and cancel runs only when enabled
  - Test: packages/engine/tests/server-auth.test.ts :: does not list generator commands through generic dashboard responses
- AC2: A plan freezes the complete referenced registration. `plan-approve`
  shows its revision, image, argv, outputs, reads and limits, and the plan's
  content hash binds them. A generator-only plan needs no worker provider.
  - Test: packages/engine/tests/cli.test.ts :: shows the frozen generator registration in plan-approve
  - Test: packages/engine/tests/generator-contract.test.ts :: compares every frozen field independently of JSON object key order
  - Test: packages/engine/tests/planning.test.ts :: counts model workers but not generator or template steps
- AC3: A generator runs only in a disposable offline, read-only-root container
  with a writable workspace view, no forwarded credentials, no shell
  interpolation, a locally present pinned image and bounded resources/time.
  - Test: packages/engine/tests/generator.test.ts :: uses the pinned offline sandbox and captures a scoped proposal without changing the workspace
  - Test: packages/engine/tests/generator.test.ts :: omits credential-named source files from the container view
  - Test: packages/engine/tests/generator.test.ts :: runs a local image with no network, no host credential and a read-only root
- AC4: The engine walks the entire view after exit and refuses symlinks,
  special files, deletions, mode changes, binary content, out-of-root writes,
  protected/ignored/credential paths, excess files or bytes, and changes to
  tests a tester wrote. An existing empty file is not edited until the
  proposal format can safely express that edit.
  - Test: packages/engine/tests/generator.test.ts :: refuses a generated symlink
  - Test: packages/engine/tests/generator.test.ts :: refuses a generated FIFO without opening it
  - Test: packages/engine/tests/generator.test.ts :: refuses changes outside roots, deletions, mode changes and existing empty-file edits
  - Test: packages/engine/tests/generator.test.ts :: refuses ignored generated output and keeps the workspace untouched
  - Test: packages/engine/tests/generator.test.ts :: refuses an empty %s output directory
  - Test: packages/engine/tests/generator.test.ts :: enforces registered output limits %#
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses a generator proposal that changes the tester's test
- AC5: Safe output becomes an ordinary proposal and passes write-scope,
  collision, secret, verification-inventory, checkpoint, rollback, required
  checks, security and review gates. The original checkout is untouched.
  - Test: packages/engine/tests/generator.test.ts :: uses the pinned offline sandbox and captures a scoped proposal without changing the workspace
  - Test: packages/engine/tests/dag.test.ts :: rejects sibling collisions before any patch, including case aliases
  - Test: packages/engine/tests/dag.test.ts :: rolls back a patch whose ignore-rule edit hides an earlier generated file and stays resumable
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses a generator proposal that changes the tester's test
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: always runs every required check and cannot accept a worker's claim that tests passed
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: shows the reviewer every step's change
- AC6: A cloud-authored plan counts generators as local roles, so it cannot
  combine one with a non-local worker or reviewer.
  - Test: packages/engine/tests/model-roles.test.ts :: counts every non-worker step as local without changing provider roles
  - Test: packages/engine/tests/mcp.test.ts :: refuses a cloud client's plan whose workers, tester and reviewer are not all local or all non-local
- AC7: A pending generator at its pre-patch state reruns on reconciled resume;
  a completed step or a pending step already at its recorded post-patch state
  is not rerun. No-op output records no changed path.
  - Test: packages/engine/tests/generator.test.ts :: captures no changed paths when a generator leaves existing output unchanged
  - Test: packages/engine/tests/dag.test.ts :: re-runs a pending step when the acknowledged workspace is back at its pre-patch state
  - Test: packages/engine/tests/dag.test.ts :: records a pending step as applied when the acknowledged workspace matches its post-patch state
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: allows resume after a completed generator was revoked when only worker work remains
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: reconciles an already-applied generator patch after revocation only with a consistent pending checkpoint
- AC8: The container and output limits stop a generator within the project
  policy's ceilings.
  - Test: packages/engine/tests/generator-contract.test.ts :: requires distinct IDs and a timeout no greater than policy
  - Test: packages/engine/tests/generator.test.ts :: uses the pinned offline sandbox and captures a scoped proposal without changing the workspace
  - Test: packages/engine/tests/generator.test.ts :: enforces registered output limits %#
  - Test: packages/engine/tests/dag.test.ts :: stops a step that ignores its signal at the step's time limit
- AC9: Before start/resume reservation, dispatch and each patch application,
  every generator still needing dispatch or application must have a live
  registration with the same ID, revision and canonical fields as the plan's
  frozen copy. Removing or replacing it revokes unapplied use even without
  required plan approval; re-adding the same ID cannot revive an old plan.
  A completed step, or a strictly validated pending checkpoint whose full
  post-patch fingerprint already matches the workspace, may be reconciled
  as historical output without rerunning its revoked command. An independent
  sibling cannot apply first after a registration is revoked.
  - Test: packages/engine/tests/generator-contract.test.ts :: compares every frozen field independently of JSON object key order
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses removed, replaced and same-ID re-added registrations before start or resume with plan approval %s
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: refuses dispatch after a prior step removes a pending generator with plan approval %s
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: discards generated output when registration changes before application with plan approval %s
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: blocks the first independent sibling's patch when another generator is revoked
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: allows resume after a completed generator was revoked when only worker work remains
  - Test: packages/engine/tests/managed-dag-safety.test.ts :: reconciles an already-applied generator patch after revocation only with a consistent pending checkpoint

## Evidence

The local implementation's focused pure tests pass. The earlier owner-socket
blocker was lifted, and 12 previously blocked managed-service, HTTP and CLI
cases passed in the private continuation. The first exact-head CI attempt
stopped on a Dart diagnostic assertion before reaching the native Docker
stage; the opt-in generator Docker test therefore has not run in CI. It counts
as native execution evidence only when CI runs it with
`GRAPH_ENGINE_DOCKER_TESTS=1`, and it was skipped locally. Synthetic fixtures
and mocks alone do not show that a specific user-supplied generator image is
safe or correct. Keep this spec draft until exact-head CI and review.

## Security considerations

Treat registered images and their argv as operator-approved executable code,
not as trusted output. Docker isolation is a defense in depth boundary: the
engine mounts only a disposable source view, forwards no provider credentials,
disables container networking and extra capabilities, and validates the entire
view before proposing any workspace change. The operator must trust the local
Docker daemon and provision an image whose digest or local ID they reviewed.
The engine still applies the normal proposal, verification, security and
review gates; a generator's successful exit never grants authority to bypass
them. Credential-named files are excluded from input copying and rejected as
outputs, but those path heuristics are not a substitute for keeping secrets
out of the source tree.
Because the view is a writable bind mount, a pathological registered image can
consume local disk or create more entries than the bounded permission-recovery
cleanup will traverse. If container removal cannot be confirmed, the engine
retains the private view instead of deleting files while a container might
still be using them. An operator must inspect and recover any retained view.

## Non-goals

Generator registration is not offered to MCP clients. A successful generator
step does not authorize deployment, merge, human acceptance or autonomous
decision-model promotion.
