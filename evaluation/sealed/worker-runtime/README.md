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
Recovery must fence in-flight transport. A separate local model relay is
described below; this intake acknowledgment alone remains unfinished worker
execution. A separate narrow private digest verifier exists, but general
protected engineering-oracle execution and signed provenance are still absent.

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

## Experimental local model worker relay

`runOneShotLocalModelWorker()` is a trusted `SealedPublicPacketBridge.dispatch()`
callback for **one frozen local provider call**. The offline Docker guest gets
only the bridge-retained canonical public packet and frozen model name/output
limit. It builds an OpenAI-compatible JSON request. The host compares every
byte with its own deterministic builder, retains those exact bytes in the
private `ArtifactStore`, rechecks the active dispatch claim, and durably
reserves the call **before** sending any request byte. The host—not the
container—then POSTs the same bytes to the frozen `127.0.0.1` or `[::1]`
provider origin at `/v1/chat/completions`. The endpoint receives no oracle,
private memory, host environment, credential, or filesystem mount from this
adapter. Only `local` providers with a frozen local-weights identity are
accepted; paid/cloud providers and API keys are not supported here.

A bounded HTTP response **body** is retained unmodified before call settlement;
the transport status is recorded separately, but original wire headers and
status-line bytes are not captured. A received partial body is retained when
possible after an interrupted response, with the call marked ambiguous.
A valid in-scope JSON proposal is also retained, but is **not applied or
verified**. Invalid/out-of-scope proposals or a different reported model
become provider errors while their raw response remains available for audit.
A timeout, interrupted request or
unretained response is conservatively ambiguous and must never be retried.
The returned observation names request/response/proposal byte references and
is unsigned, replayable, and `promotionEligible: false`; it does not settle the
engineering attempt or establish a held-out outcome.

```js
let observation;
const dispatch = await bridge.dispatch({
  handle,
  reservationId,
  send: async (publicBytes, metadata) => {
    observation = await runOneShotLocalModelWorker(publicBytes, metadata, {
      store,
      artifacts,
      providerId: "frozen-local-provider-id",
      imageId, // immutable image ID from the explicit offline build above
      endpoint, // explicit local Unix Docker socket
      signal, // supervisor-owned abort signal
    });
  },
});
// dispatch is only the durable bridge claim; observation is unsigned local
// transport bookkeeping. The trusted collector still owns recovery/settlement.
```

The model server itself is **outside the container** and is neither isolated
nor attested by this adapter. The frozen weights hashes are caller-supplied
commitments, not independently verified against the running Qwen instance.
The reported response model must exactly match the frozen requested model;
aliases that the server reports under a different name are rejected. A local
model may retain its own logs. The
host and Docker daemon remain trusted. A race between the final ledger check
and HTTP dispatch is not atomic; the supervisor must fence in-flight transport
before abandoning an attempt. No general protected engineering oracle,
independent review, signed transport provenance, or promotion authority is
supplied by this relay. The separate digest verifier covers only one exact-byte
question.
`local-no-api-charge` means no marginal external API charge, not zero machine
cost. The adapter performs no paid inference.

The pure test runs without Docker. The opt-in native test uses a fake loopback
model server, never a paid or running Qwen model:

```sh
node --test evaluation/sealed/tests/local-worker.test.mjs
GRAPH_SEALED_PUBLIC_INTAKE_NATIVE_TESTS=1 \
GRAPH_SEALED_PUBLIC_INTAKE_IMAGE=sha256:<resolved-image-id> \
GRAPH_SEALED_PUBLIC_DOCKER_ENDPOINT=unix:///var/run/docker.sock \
  node --test evaluation/sealed/tests/local-worker.test.mjs
```
