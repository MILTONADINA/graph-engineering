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
- AC2: A plan freezes the complete referenced registration. `plan-approve`
  shows its revision, image, argv, outputs, reads and limits, and the plan's
  content hash binds them. A generator-only plan needs no worker provider.
- AC3: A generator runs only in a disposable offline, read-only-root container
  with a writable workspace view, no forwarded credentials, no shell
  interpolation, a locally present pinned image and bounded resources/time.
- AC4: The engine walks the entire view after exit and refuses symlinks,
  special files, deletions, mode changes, binary content, out-of-root writes,
  protected/ignored/credential paths, excess files or bytes, and changes to
  tests a tester wrote. An existing empty file is not edited until the
  proposal format can safely express that edit.
- AC5: Safe output becomes an ordinary proposal and passes write-scope,
  collision, secret, verification-inventory, checkpoint, rollback, required
  checks, security and review gates. The original checkout is untouched.
- AC6: A cloud-authored plan counts generators as local roles, so it cannot
  combine one with a non-local worker or reviewer.
- AC7: A pending generator at its pre-patch state reruns on reconciled resume;
  a completed step or a pending step already at its recorded post-patch state
  is not rerun. No-op output records no changed path.
- AC8: The container and output limits stop a generator within the project
  policy's ceilings.
- AC9: Before start/resume reservation, dispatch and each patch application,
  every generator still needing dispatch or application must have a live
  registration with the same ID, revision and canonical fields as the plan's
  frozen copy. Removing or replacing it revokes unapplied use even without
  required plan approval; re-adding the same ID cannot revive an old plan.
  A completed step, or a strictly validated pending checkpoint whose full
  post-patch fingerprint already matches the workspace, may be reconciled
  as historical output without rerunning its revoked command. An independent
  sibling cannot apply first after a registration is revoked.

## Evidence

The local implementation's focused pure tests pass, but the managed-service
and HTTP tests could not start in the current sandbox because it denies the
owner socket. The opt-in Docker test counts as execution evidence only when CI
runs it with `GRAPH_ENGINE_DOCKER_TESTS=1`; it was skipped locally. Synthetic
fixtures and mocks alone do not show that a specific user-supplied generator
image is safe or correct. Keep this spec draft until exact-head CI and review.

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
