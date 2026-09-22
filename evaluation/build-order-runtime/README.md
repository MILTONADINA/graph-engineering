# Historical clean-workspace build proof

This fixture verifies the `clean-workspace-dependency-order` historical task against the exact 880-file Git tree at `942f75f7d86f9774f87c4083b41f601e571afcb7`. It does not execute arbitrary candidate JavaScript or shell text. The existing pure `candidate-build-order.mjs` guard permits only the original `package.json` with bounded changes to three build-order scripts; all other fields, scripts and dependencies must match history.

The guard expands the candidate's restricted npm grammar into operations. The container translates those operations to fixed npm argv against unchanged historical workspace files. Candidate root scripts are never installed or executed. The underlying workspace scripts and tests are trusted, pinned historical code.

## Provision, then verify offline

Use Node 24+ and a local Docker engine. Full Git history containing both pinned revisions is required. Provisioning is explicit and may access the npm registry; it does not install anything on the host or run package lifecycle scripts:

```sh
node evaluation/build-order-runtime/provision.mjs
GRAPH_ENGINE_BUILD_ORDER_DOCKER_TESTS=1 node --test evaluation/verify-build-order.test.mjs
```

Individual detailed receipts:

```sh
node evaluation/verify-build-order.mjs baseline
node evaluation/verify-build-order.mjs repair
```

Every typecheck/test witness uses a separate container and newly copied workspace. All four workspace `dist` directories must initially be absent. Dependencies remain in the read-only image, with workspace links redirected to the fresh source copy. No active worktree outputs are removed. Runtime is network-disabled, unprivileged, resource-bounded, capability-free, and has no host mounts. Host environment credentials are not forwarded. This fixture allows trusted historical tests to spawn local subprocesses and use loopback; it is not the arbitrary-code QuickJS fixture.

The baseline must actually fail with missing `create-graph-app` entrypoint evidence. The projected repair must build the scaffolder and contracts before both downstream commands and finish both successfully. Timeouts, missing dependencies, container errors, and unrelated build failures cannot count as repair success. Pure structural ordering alone never passes the real proof.

## Identities and limits

Receipts include exact candidate source hash, historical commit/tree/source manifest, pinned Node image, immutable local image ID, runtime module hashes, lockfile hash, and full installed dependency-tree digest. Source blobs are checked against Git object identities and hashes before provisioning, and checked again after installation and before each workspace copy. Native SQLite, ONNX and esbuild are preflighted during image provisioning.

Ten legacy lock entries omit integrity fields. Their versions remain pinned, and their actual installed bytes contribute to the dependency-tree digest, but this does **not** supply missing upstream tarball attestations. The receipt lists those entries explicitly.

This is retrospective Linux fixture evidence for the constrained `package.json` task—not native macOS/Windows coverage, a general npm interpreter, unseen/held-out performance, independently reviewed labels, model success, or permission to promote any decision category. The two historically opt-in engine tests (Docker worker execution and downloaded embedding weights) retain their original skip conditions; no models, Docker socket, network or downloaded weights are supplied to the inner test suite.
