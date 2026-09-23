# Public-packet intake sandbox

This is a bounded **intake and content acknowledgment**, not an engineering
worker. It does not call a model, create a proposal, inspect a private oracle,
verify a repair, settle an attempt, or issue promotion evidence. The trusted
collector still owns the frozen plan and the one-time dispatch claim.

Provision the fixed image explicitly, using a locally available, digest-pinned
Node base image. Runtime dispatch never builds, pulls or installs anything:

```sh
docker --host unix:///var/run/docker.sock build --pull=false --network=none \
  -f evaluation/sealed/worker-runtime/Dockerfile \
  -t graph-sealed-public-intake:local evaluation/sealed/worker-runtime
docker --host unix:///var/run/docker.sock image inspect \
  --format '{{.Id}}' graph-sealed-public-intake:local
```

Use your actual local Unix socket. This adapter does not support Windows Docker
Desktop named pipes. Pass the resulting immutable `sha256:` image ID and local
endpoint to `runPublicPacketIntake()`.
It is compatible with `SealedPublicPacketBridge.dispatch()` as its trusted
`send` callback; capture the returned observation outside the bridge:

```js
let intakeObservation;
const claim = await bridge.dispatch({
  handle,
  reservationId,
  send: async (publicBytes, metadata) => {
    intakeObservation = await runPublicPacketIntake(publicBytes, metadata, {
      imageId,
      endpoint,
    });
  },
});
// claim is ledger metadata. intakeObservation is a local process observation.
// Neither is a settled attempt or proof of delivery to a model.
```

The guest receives **only the exact canonical packet bytes via stdin**. It
refuses packets outside the builder's public source/document shape, rechecks
each file hash and applies the exporter's conservative secret-pattern screen.
That screen is not complete DLP; only the bridge's fresh export policy can
authorize which source paths are public. A direct call to the helper does not
prove that a packet passed the bridge or that its source was approved.

Runtime Docker arguments enforce no network, no host mounts or host paths, a
read-only filesystem, non-root UID, no capabilities or new privileges, bounded
CPU/memory/PIDs, no container log driver and one-shot `--rm` execution. The
Docker client gets a fixed minimal environment; it does not inherit provider
keys, `NODE_OPTIONS`, Docker context or host home. Input is capped at 2 MB,
combined output at 4 KB and process time at 15 seconds. The exact owned
container name is force-removed after each outcome. An unavailable Docker
daemon or unconfirmed cleanup fails closed.

The guest emits one hash/length/task-identity acknowledgment and never echoes
source. This acknowledgment is unsigned and replayable. A malicious local
Docker daemon, image provisioner or host administrator can defeat these
controls; image ID alone does not prove supply-chain provenance. The bridge's
claim can precede zero delivery, and a timeout can follow partial delivery.
Recovery must fence in-flight transport. Protected execution, oracle isolation,
original model request/response bytes and signed provenance remain separate
unfinished boundaries.

Pure tests run with the sealed suite:

```sh
node --test evaluation/sealed/tests/worker-sandbox.test.mjs
```

After explicit image provisioning, opt into the native Docker test using the
resolved image ID and local endpoint; it checks the bridge packet hash and that
private-memory/oracle canaries never enter the sent bytes:

```sh
GRAPH_SEALED_PUBLIC_INTAKE_NATIVE_TESTS=1 \
GRAPH_SEALED_PUBLIC_INTAKE_IMAGE=sha256:<resolved-image-id> \
GRAPH_SEALED_PUBLIC_DOCKER_ENDPOINT=unix:///var/run/docker.sock \
  node --test evaluation/sealed/tests/worker-sandbox.test.mjs
```
