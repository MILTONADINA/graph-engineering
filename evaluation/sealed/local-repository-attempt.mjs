// One bounded, analysis-only local-model repository attempt. The caller first
// retains an exact public packet with SealedPublicPacketBridge. No repository
// path, arbitrary mount, paid provider or private case result crosses this API.
import { types } from "node:util";
import { ArtifactStore } from "./artifacts.mjs";
import { SealedPublicPacketBridge } from "./public-packet.mjs";
import { inspectRepositorySnapshotInventory } from "./repository-snapshot.mjs";
import { hashJson } from "./schema.mjs";
import { SealedStore } from "./store.mjs";
import { runProtectedRepositoryOracle } from "./oracle-runtime/repository-host.mjs";
import {
  parseRepositoryOracle,
  projectRepositoryExecutionTree,
} from "./oracle-runtime/repository.mjs";
import { localDockerEndpoint } from "./worker-runtime/host.mjs";
import { runOneShotLocalModelWorker } from "./worker-runtime/local-worker.mjs";
import { inspectPublicPacket } from "./worker-runtime/packet.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;

function fields(input, names, label) {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== names.length
  )
    throw new Error(`${label} has invalid fields`);
  const result = Object.create(null);
  for (const name of names) {
    const field = Object.getOwnPropertyDescriptor(input, name);
    if (!field?.enumerable || !Object.hasOwn(field, "value"))
      throw new Error(`${label} refuses accessors or unexpected fields`);
    result[name] = field.value;
  }
  return result;
}

function reference(input, label) {
  const value = fields(input, ["sha256", "bytes"], label);
  if (
    typeof value.sha256 !== "string" ||
    !SHA.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > 2_000_000
  )
    throw new Error(`${label} needs a bounded original-byte reference`);
  return value;
}

function frozenProvider(plan, assignment, providerId) {
  const provider = plan.configurations[assignment.arm].providers.find(
    (item) => item.providerId === providerId,
  );
  if (
    !provider ||
    provider.kind !== "local" ||
    provider.modelIdentity.kind !== "local-weights" ||
    provider.pricingSha256 !== null
  )
    throw new Error(
      "Repository attempt requires a frozen local-weights provider",
    );
  const url = new URL(provider.endpointOrigin);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.origin !== provider.endpointOrigin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Repository attempt requires a frozen IP loopback origin");
  return provider;
}

async function preflight({
  store,
  artifacts,
  bridge,
  handle,
  collectionId,
  assignmentId,
  baselineRef,
  oracleRef,
  providerId,
  repositoryImageId,
}) {
  const retained =
    SealedPublicPacketBridge.prototype.inspectRetainedHandle.call(
      bridge,
      handle,
      store,
      artifacts,
    );
  const inspection = store.inspectCollection(collectionId);
  const assignment = inspection.plan.assignments.find(
    (item) => item.assignmentId === assignmentId,
  );
  const task = inspection.plan.tasks.find(
    (item) => item.taskId === assignment?.taskId,
  );
  if (
    inspection.closure ||
    !assignment ||
    !task ||
    retained.collectionId !== collectionId ||
    retained.taskId !== task.taskId ||
    retained.planSha256 !== inspection.planSha256 ||
    retained.artifact.sha256 !== task.publicPacketSha256 ||
    task.stateFormatVersion !== "repo-snapshot-v1" ||
    task.executionScopeSha256 !== undefined ||
    baselineRef.sha256 !== task.baselineSha256 ||
    oracleRef.sha256 !== task.oracleSha256
  )
    throw new Error("Repository attempt differs from its frozen v1 task");
  frozenProvider(inspection.plan, assignment, providerId);

  // Check all frozen inputs before consuming the one allowed assignment. The
  // oracle remains local; only selected public source/docs goes to the model.
  const publicRetained = await artifacts.get(retained.artifact);
  let oracleRetained;
  let publicBytes;
  let oracleBytes;
  try {
    oracleRetained = await artifacts.get(oracleRef);
    publicBytes = Buffer.from(publicRetained);
    oracleBytes = Buffer.from(oracleRetained);
    const ack = inspectPublicPacket(publicBytes);
    const packet = JSON.parse(publicBytes.toString("utf8"));
    if (
      ack.taskId !== task.taskId ||
      ack.repositoryId !== task.repositoryId ||
      packet.baselineSha256 !== baselineRef.sha256
    )
      throw new Error("Repository public packet differs from frozen task");
    const { recipe } = parseRepositoryOracle(oracleBytes);
    if (recipe.imageId !== repositoryImageId)
      throw new Error("Repository image differs from frozen private recipe");
    if (
      task.allowedOutputPaths.length > recipe.sourcePaths.length ||
      task.allowedOutputPaths.some((name) => !recipe.sourcePaths.includes(name))
    )
      throw new Error("Repository output scope exceeds frozen source paths");
    const snapshot = await inspectRepositorySnapshotInventory({
      artifacts,
      rootReference: baselineRef,
    });
    const tree = projectRepositoryExecutionTree(
      snapshot.entries,
      recipe.sourcePaths,
    );
    const selected = packet.files.filter((file) => file.kind === "source");
    if (
      selected.length !== tree.files.length ||
      tree.files.some((entry) => {
        const source = selected.find((file) => file.path === entry.path);
        return (
          !source ||
          source.sha256 !== entry.sha256 ||
          Buffer.byteLength(source.content, "utf8") !== entry.bytes
        );
      })
    )
      throw new Error("Repository execution source differs from public packet");
  } finally {
    publicBytes?.fill(0);
    oracleBytes?.fill(0);
    publicRetained.fill(0);
    oracleRetained?.fill(0);
  }
  return { task, planSha256: inspection.planSha256 };
}

function terminalReceipt(
  store,
  collectionId,
  reservation,
  publicSha256,
  status,
) {
  const inspection = store.inspectCollection(collectionId);
  const item = inspection.assignments.find(
    (entry) => entry.reservation?.reservationId === reservation.reservationId,
  );
  const calls = item?.calls ?? [];
  if (
    inspection.closure ||
    !item ||
    item.receipt ||
    calls.length !== 1 ||
    !calls[0].receipt ||
    (status === "candidate-rejected" &&
      (!item.oracleInvocation ||
        !item.oracleVerdict ||
        item.oracleInvocation.kind !==
          "sealed-call-bound-repository-invocation-claim")) ||
    (status === "provider-error" &&
      (item.oracleInvocation || item.oracleVerdict))
  )
    throw new Error(
      "Repository attempt cannot settle an incomplete observation",
    );
  const call = calls[0].receipt;
  if (
    (status === "candidate-rejected" && call.status !== "completed") ||
    (status === "provider-error" && call.status !== "provider-error")
  )
    throw new Error("Repository call outcome differs from terminal attempt");
  const oracle = item.oracleInvocation;
  return {
    version: "1.0.0",
    kind: "sealed-attempt-receipt",
    reservationId: reservation.reservationId,
    reservationSha256: hashJson(reservation),
    status,
    finishedAt: new Date().toISOString(),
    publicRequestSha256: publicSha256,
    proposalSha256: oracle?.proposalSha256 ?? null,
    resultSourceSha256: oracle?.resultSourceSha256 ?? null,
    observations: [],
    callReceiptSha256s: [hashJson(call)],
    outcome: {
      success: null,
      policyViolation: false,
      verificationSha256: item.oracleVerdict?.verificationSha256 ?? null,
      runtimeSha256: null,
    },
    usage: { ...call.usage, basis: "aggregate" },
    limitations: [
      "Local one-call repository observation only; no independently measured success, held-out provenance or promotion authority.",
    ],
  };
}

/**
 * Run one frozen v1 repository assignment with one local model call. The
 * collector owns the bridge/store/vault and never gives the model the oracle.
 * An exception after reservation leaves that assignment open for explicit
 * fenced recovery; this function never retries or abandons ambiguous delivery.
 */
export async function runOneShotLocalRepositoryAttempt(input, runtime) {
  const {
    store,
    artifacts,
    bridge,
    handle,
    collectionId,
    assignmentId,
    baselineReference,
    oracleReference,
    providerId,
  } = fields(
    input,
    [
      "store",
      "artifacts",
      "bridge",
      "handle",
      "collectionId",
      "assignmentId",
      "baselineReference",
      "oracleReference",
      "providerId",
    ],
    "Local repository attempt",
  );
  const runtimeNames = ["intakeImageId", "repositoryImageId", "endpoint"];
  if (
    runtime &&
    typeof runtime === "object" &&
    !types.isProxy(runtime) &&
    Object.hasOwn(runtime, "signal")
  )
    runtimeNames.push("signal");
  const {
    intakeImageId,
    repositoryImageId,
    endpoint,
    signal = null,
  } = fields(runtime, runtimeNames, "Local repository runtime");
  if (
    !(store instanceof SealedStore) ||
    !(artifacts instanceof ArtifactStore) ||
    !(bridge instanceof SealedPublicPacketBridge) ||
    ![collectionId, assignmentId, providerId].every(
      (value) => typeof value === "string" && ID.test(value),
    ) ||
    ![intakeImageId, repositoryImageId].every(
      (value) => typeof value === "string" && IMAGE.test(value),
    ) ||
    (signal !== null &&
      (types.isProxy(signal) || !(signal instanceof AbortSignal)))
  )
    throw new Error("Local repository attempt needs trusted frozen identities");
  const dockerEndpoint = localDockerEndpoint(endpoint);
  signal?.throwIfAborted();
  const baselineRef = reference(baselineReference, "Repository baseline");
  const oracleRef = reference(oracleReference, "Private repository oracle");
  const frozen = await preflight({
    store,
    artifacts,
    bridge,
    handle,
    collectionId,
    assignmentId,
    baselineRef,
    oracleRef,
    providerId,
    repositoryImageId,
  });
  signal?.throwIfAborted();
  const reservation = store.reserveAttempt(collectionId, assignmentId);
  try {
    let model;
    const dispatch = await SealedPublicPacketBridge.prototype.dispatch.call(
      bridge,
      {
        handle,
        reservationId: reservation.reservationId,
        send: async (bytes, metadata) => {
          model = await runOneShotLocalModelWorker(bytes, metadata, {
            store,
            artifacts,
            providerId,
            imageId: intakeImageId,
            endpoint: dockerEndpoint,
            signal,
          });
        },
      },
    );
    if (
      !model ||
      model.reservationId !== reservation.reservationId ||
      model.claimSha256 !== dispatch.claimSha256
    )
      throw new Error("Local model observation differs from public dispatch");
    let status;
    if (model.status === "completed") {
      if (!model.response || !model.proposal)
        throw new Error("Completed local model call lacks retained originals");
      const oracle = await runProtectedRepositoryOracle(
        {
          store,
          artifacts,
          collectionId,
          reservationId: reservation.reservationId,
          expectedPlanSha256: frozen.planSha256,
          baselineReference: baselineRef,
          oracleReference: oracleRef,
          callId: model.callId,
          responseReference: model.response,
        },
        { imageId: repositoryImageId, endpoint: dockerEndpoint, signal },
      );
      if (
        !oracle.verificationRecorded ||
        oracle.reservationId !== reservation.reservationId ||
        oracle.callId !== model.callId ||
        oracle.promotionEligible !== false
      )
        throw new Error("Repository oracle did not retain its private verdict");
      status = "candidate-rejected";
    } else if (model.status === "provider-error") {
      status = "provider-error";
    } else {
      throw new Error("Local model call has an ambiguous outcome");
    }
    const receipt = store.completeAttempt(
      terminalReceipt(
        store,
        collectionId,
        reservation,
        dispatch.publicPacketSha256,
        status,
      ),
    );
    return Object.freeze({
      kind: "sealed-local-repository-attempt-observation",
      version: "1.0.0",
      collectionId,
      assignmentId,
      reservationId: reservation.reservationId,
      status,
      attemptReceiptSha256: hashJson(receipt),
      promotionEligible: false,
    });
  } catch (cause) {
    // A model POST, Docker child or oracle claim can be in an unknown state.
    // Never retry/abandon it here; the supervisor must fence transport first.
    const error = new Error(
      `Repository assignment ${assignmentId} may be incomplete; inspect reservation ${reservation.reservationId} and explicitly fence transport before recovery`,
      { cause },
    );
    error.reservationId = reservation.reservationId;
    throw error;
  }
}
