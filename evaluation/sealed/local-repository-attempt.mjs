// One bounded, analysis-only local-model repository attempt. The caller first
// retains an exact public packet with SealedPublicPacketBridge. No repository
// path, arbitrary mount, paid provider or private case result crosses this API.
import { types } from "node:util";
import { ArtifactStore } from "./artifacts.mjs";
import { SealedPublicPacketBridge } from "./public-packet.mjs";
import { inspectRepositoryV2RuntimeFiles } from "./repository-scope-v2.mjs";
import { inspectRepositorySnapshotInventory } from "./repository-snapshot.mjs";
import { hashJson } from "./schema.mjs";
import { SealedStore } from "./store.mjs";
import { runProtectedRepositoryOracle } from "./oracle-runtime/repository-host.mjs";
import { runProtectedRepositoryV2Oracle } from "./oracle-runtime/repository-host-v2.mjs";
import {
  applyRepositoryProposal,
  parseRepositoryOracle,
  projectRepositoryExecutionTree,
  RepositoryProposalRejectedError,
  repositorySha256,
} from "./oracle-runtime/repository.mjs";
import {
  assertRepositoryV2RecipeScope,
  deriveRepositoryV2CandidateTree,
  parseRepositoryV2Oracle,
  parseRepositoryV2Scope,
} from "./oracle-runtime/repository-v2.mjs";
import { localDockerEndpoint } from "./worker-runtime/host.mjs";
import { runOneShotLocalModelWorker } from "./worker-runtime/local-worker.mjs";
import { inspectPublicPacket } from "./worker-runtime/packet.mjs";
import { parseRetainedLocalProposal } from "./worker-runtime/proposal.mjs";

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

async function preflightV1({
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
  const provider = frozenProvider(inspection.plan, assignment, providerId);

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
    return {
      mode: "v1",
      task,
      planSha256: inspection.planSha256,
      packet,
      requestedModel: provider.requestedModel,
      sourcePaths: recipe.sourcePaths,
      baselineFiles: tree.files.map((entry) => ({
        path: entry.path,
        source: selected.find((file) => file.path === entry.path).content,
        mode: entry.mode,
      })),
    };
  } finally {
    publicBytes?.fill(0);
    oracleBytes?.fill(0);
    publicRetained.fill(0);
    oracleRetained?.fill(0);
  }
}

async function preflightV2({
  store,
  artifacts,
  bridge,
  handle,
  collectionId,
  assignmentId,
  baselineRef,
  scopeRef,
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
    task.executionScopeSha256 !== scopeRef.sha256 ||
    baselineRef.sha256 !== task.baselineSha256 ||
    oracleRef.sha256 !== task.oracleSha256
  )
    throw new Error("V2 repository attempt differs from its frozen task");
  const provider = frozenProvider(inspection.plan, assignment, providerId);
  let publicRetained;
  let scopeRetained;
  let oracleRetained;
  let publicBytes;
  let scopeBytes;
  let oracleBytes;
  try {
    publicRetained = await artifacts.get(retained.artifact);
    scopeRetained = await artifacts.get(scopeRef);
    oracleRetained = await artifacts.get(oracleRef);
    publicBytes = Buffer.from(publicRetained);
    scopeBytes = Buffer.from(scopeRetained);
    oracleBytes = Buffer.from(oracleRetained);
    const ack = inspectPublicPacket(publicBytes);
    const packet = JSON.parse(publicBytes.toString("utf8"));
    if (
      ack.taskId !== task.taskId ||
      ack.repositoryId !== task.repositoryId ||
      packet.baselineSha256 !== baselineRef.sha256
    )
      throw new Error("V2 public packet differs from frozen task");
    const scope = parseRepositoryV2Scope(scopeBytes);
    if (
      scope.baselineSnapshot.sha256 !== baselineRef.sha256 ||
      scope.baselineSnapshot.bytes !== baselineRef.bytes
    )
      throw new Error("V2 execution scope differs from frozen baseline");
    const { recipe } = parseRepositoryV2Oracle(oracleBytes);
    const { scopeSha256 } = assertRepositoryV2RecipeScope(recipe, scope);
    if (scopeSha256 !== scopeRef.sha256 || recipe.imageId !== repositoryImageId)
      throw new Error("V2 recipe differs from frozen image or safe scope");
    const editable = scope.entries.filter(
      (entry) => entry.type === "file" && entry.class === "public-editable",
    );
    if (
      task.allowedOutputPaths.length !== editable.length ||
      task.allowedOutputPaths.some(
        (name, index) => name !== editable[index].path,
      )
    )
      throw new Error("V2 output paths differ from frozen editable scope");
    const snapshot = await inspectRepositorySnapshotInventory({
      artifacts,
      rootReference: baselineRef,
    });
    if (snapshot.receipt.rootSha256 !== baselineRef.sha256)
      throw new Error("V2 repository snapshot changed identity");
    const baselineTree = await inspectRepositoryV2RuntimeFiles({
      artifacts,
      scope,
      inventoryEntries: snapshot.entries,
    });
    const runtimePaths = new Set(
      scope.entries
        .filter(
          (entry) =>
            entry.type === "file" &&
            entry.class === "operator-declared-runtime",
        )
        .map((entry) => entry.path.toLowerCase()),
    );
    if (
      packet.files.some((file) => runtimePaths.has(file.path.toLowerCase())) ||
      editable.some((entry) => {
        const source = packet.files.find((file) => file.path === entry.path);
        return (
          !source ||
          source.kind !== "source" ||
          source.sha256 !== entry.sha256 ||
          Buffer.byteLength(source.content, "utf8") !== entry.bytes
        );
      })
    )
      throw new Error("V2 public source differs from frozen execution scope");
    return {
      mode: "v2",
      task,
      planSha256: inspection.planSha256,
      packet,
      scope,
      baselineTree,
      requestedModel: provider.requestedModel,
    };
  } finally {
    publicBytes?.fill(0);
    scopeBytes?.fill(0);
    oracleBytes?.fill(0);
    publicRetained?.fill(0);
    scopeRetained?.fill(0);
    oracleRetained?.fill(0);
  }
}

/** Recheck the original response and test only public patch semantics. */
async function inspectCompletedProposal(
  store,
  artifacts,
  collectionId,
  reservation,
  model,
  frozen,
) {
  const item = store
    .inspectCollection(collectionId)
    .assignments.find(
      (entry) => entry.reservation?.reservationId === reservation.reservationId,
    );
  const call = item?.calls.find(
    (entry) => entry.reservation.callId === model.callId,
  );
  if (
    item?.calls.length !== 1 ||
    call?.receipt?.status !== "completed" ||
    call.receipt.responseSha256 !== model.response.sha256 ||
    call.receipt.reportedModel !== frozen.requestedModel ||
    item.oracleInvocation ||
    item.oracleVerdict
  )
    throw new Error("Completed model proposal differs from retained call");
  let responseBytes;
  let proposalBytes;
  let parsed;
  try {
    responseBytes = await artifacts.get(model.response);
    parsed = parseRetainedLocalProposal(
      responseBytes,
      frozen.task,
      frozen.packet,
      frozen.requestedModel,
    );
    proposalBytes = await artifacts.get(model.proposal);
    if (
      proposalBytes.length !== parsed.proposalBytes.length ||
      !Buffer.from(proposalBytes).equals(parsed.proposalBytes) ||
      repositorySha256(parsed.proposalBytes) !== model.proposal.sha256
    )
      throw new Error("Retained model proposal differs from original response");
    try {
      if (frozen.mode === "v2") {
        const candidate = deriveRepositoryV2CandidateTree({
          scope: frozen.scope,
          baselineTree: frozen.baselineTree,
          publicFiles: frozen.packet.files,
          proposalBytes: parsed.proposalBytes,
          allowedOutputPaths: frozen.task.allowedOutputPaths,
        });
        candidate.manifestBytes.fill(0);
      } else {
        applyRepositoryProposal(
          frozen.baselineFiles,
          parsed.proposalBytes,
          frozen.task.allowedOutputPaths,
          frozen.sourcePaths,
        );
      }
    } catch (cause) {
      if (!(cause instanceof RepositoryProposalRejectedError)) throw cause;
      return { executable: false, proposalSha256: model.proposal.sha256 };
    }
    return { executable: true, proposalSha256: model.proposal.sha256 };
  } finally {
    responseBytes?.fill(0);
    proposalBytes?.fill(0);
    parsed?.proposalBytes.fill(0);
  }
}

function terminalReceipt(
  store,
  collectionId,
  reservation,
  publicSha256,
  status,
  publicProposalSha256 = null,
  expectedClaimKind = "sealed-call-bound-repository-invocation-claim",
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
      publicProposalSha256 === null &&
      (!item.oracleInvocation ||
        !item.oracleVerdict ||
        item.oracleInvocation.kind !== expectedClaimKind)) ||
    (status === "candidate-rejected" &&
      publicProposalSha256 !== null &&
      (!SHA.test(publicProposalSha256) ||
        item.oracleInvocation ||
        item.oracleVerdict)) ||
    (status === "provider-error" &&
      (publicProposalSha256 !== null ||
        item.oracleInvocation ||
        item.oracleVerdict))
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
    proposalSha256: oracle?.proposalSha256 ?? publicProposalSha256,
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
      ...(publicProposalSha256 === null
        ? []
        : [
            "Public proposal rejected before private oracle; no private test ran.",
          ]),
    ],
  };
}

/** One frozen repository assignment, with mode-specific preflight and oracle. */
async function runOneShotLocalRepositoryCore(input, runtime, mode) {
  const inputNames = [
    "store",
    "artifacts",
    "bridge",
    "handle",
    "collectionId",
    "assignmentId",
    "baselineReference",
    "oracleReference",
    "providerId",
  ];
  if (mode === "v2") inputNames.push("scopeReference");
  const {
    store,
    artifacts,
    bridge,
    handle,
    collectionId,
    assignmentId,
    baselineReference,
    scopeReference,
    oracleReference,
    providerId,
  } = fields(input, inputNames, "Local repository attempt");
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
  const scopeRef =
    mode === "v2" ? reference(scopeReference, "V2 execution scope") : null;
  const oracleRef = reference(oracleReference, "Private repository oracle");
  const preflightInput = {
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
  };
  const frozen =
    mode === "v2"
      ? await preflightV2({ ...preflightInput, scopeRef })
      : await preflightV1(preflightInput);
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
    let publicProposalSha256 = null;
    if (model.status === "completed") {
      if (!model.response || !model.proposal)
        throw new Error("Completed local model call lacks retained originals");
      const candidate = await inspectCompletedProposal(
        store,
        artifacts,
        collectionId,
        reservation,
        model,
        frozen,
      );
      if (candidate.executable) {
        const oracleInput = {
          store,
          artifacts,
          collectionId,
          reservationId: reservation.reservationId,
          expectedPlanSha256: frozen.planSha256,
          baselineReference: baselineRef,
          oracleReference: oracleRef,
          callId: model.callId,
          responseReference: model.response,
        };
        const oracleRuntime = {
          imageId: repositoryImageId,
          endpoint: dockerEndpoint,
          signal,
        };
        const oracle =
          mode === "v2"
            ? await runProtectedRepositoryV2Oracle(
                { ...oracleInput, scopeReference: scopeRef },
                oracleRuntime,
              )
            : await runProtectedRepositoryOracle(oracleInput, oracleRuntime);
        if (
          !oracle.verificationRecorded ||
          oracle.reservationId !== reservation.reservationId ||
          oracle.callId !== model.callId ||
          oracle.promotionEligible !== false
        )
          throw new Error(
            "Repository oracle did not retain its private verdict",
          );
      } else {
        publicProposalSha256 = candidate.proposalSha256;
      }
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
        publicProposalSha256,
        mode === "v2"
          ? "sealed-call-bound-repository-v2-invocation-claim"
          : "sealed-call-bound-repository-invocation-claim",
      ),
    );
    return Object.freeze({
      kind:
        mode === "v2"
          ? "sealed-local-repository-v2-attempt-observation"
          : "sealed-local-repository-attempt-observation",
      version: mode === "v2" ? "2.0.0" : "1.0.0",
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

/**
 * One frozen v1 selected-source repository assignment and local model call.
 * Uncertain delivery or oracle execution stays open for explicit recovery.
 */
export async function runOneShotLocalRepositoryAttempt(input, runtime) {
  return runOneShotLocalRepositoryCore(input, runtime, "v1");
}

/**
 * One frozen v2 operator-declared safe-tree assignment and local model call.
 * This does not make the scope independently reviewed or promotion-eligible.
 */
export async function runOneShotLocalRepositoryV2Attempt(input, runtime) {
  return runOneShotLocalRepositoryCore(input, runtime, "v2");
}
