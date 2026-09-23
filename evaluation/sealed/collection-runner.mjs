// Private, opt-in supervisor for a frozen v2 local repository cohort. It does
// not curate tasks, approve labels, authenticate execution or promote policy.
// One-shot attempts own all model transport and private-oracle boundaries.
import { types } from "node:util";
import { ArtifactStore } from "./artifacts.mjs";
import {
  inspectOneShotLocalRepositoryV2Preflight,
  runOneShotLocalRepositoryV2Attempt,
} from "./local-repository-attempt.mjs";
import { SealedPublicPacketBridge } from "./public-packet.mjs";
import { hashJson } from "./schema.mjs";
import { SealedStore } from "./store.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ASSIGNMENT_FIELDS = [
  "assignmentId",
  "handle",
  "baselineReference",
  "scopeReference",
  "oracleReference",
  "providerId",
];

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
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      throw new Error(`${label} refuses accessors or unexpected fields`);
    result[name] = descriptor.value;
  }
  return result;
}

function denseAssignments(input) {
  if (
    !Array.isArray(input) ||
    types.isProxy(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > 2000 ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    throw new Error("Cohort assignments must be a dense plain array");
  const assignments = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      throw new Error("Cohort assignments refuse holes and accessors");
    assignments.push(
      fields(descriptor.value, ASSIGNMENT_FIELDS, "Cohort assignment"),
    );
  }
  return assignments;
}

function assertPriorTerminal(item, plan) {
  if (!item.reservation || !item.receipt)
    throw new Error("Cohort has an unresolved attempt reservation");
  const receipt = item.receipt;
  const task = plan.tasks.find(
    (entry) => entry.taskId === item.assignment.taskId,
  );
  const providers = plan.configurations[item.assignment.arm].providers;
  const call = item.calls[0] ?? null;
  const claim = item.oracleInvocation;
  const verdict = item.oracleVerdict;
  const foreign = () => {
    throw new Error("Cohort cannot resume across a foreign terminal attempt");
  };
  if (
    !task ||
    task.stateFormatVersion !== "repo-snapshot-v1" ||
    !task.executionScopeSha256 ||
    !["candidate-rejected", "provider-error", "collector-crashed"].includes(
      receipt.status,
    ) ||
    receipt.outcome.success !== null ||
    receipt.observations.length !== 0 ||
    item.calls.length > 1 ||
    receipt.reservationId !== item.reservation.reservationId ||
    receipt.reservationSha256 !== hashJson(item.reservation) ||
    receipt.callReceiptSha256s.length !== item.calls.length ||
    item.calls.some(
      (entry, index) =>
        !entry.receipt ||
        receipt.callReceiptSha256s[index] !== hashJson(entry.receipt),
    ) ||
    item.calls.some((call) => {
      const provider = providers.find(
        (entry) => entry.providerId === call.reservation.providerId,
      );
      return (
        !provider ||
        provider.kind !== "local" ||
        provider.modelIdentity.kind !== "local-weights" ||
        provider.pricingSha256 !== null ||
        call.reservation.reservedCostUsd !== 0
      );
    })
  )
    foreign();
  if (
    (claim &&
      (claim.kind !== "sealed-call-bound-repository-v2-invocation-claim" ||
        claim.reservationId !== item.reservation.reservationId ||
        claim.assignmentId !== item.assignment.assignmentId ||
        claim.taskId !== task.taskId ||
        claim.baselineSha256 !== task.baselineSha256 ||
        claim.scopeSha256 !== task.executionScopeSha256 ||
        claim.oracleSha256 !== task.oracleSha256 ||
        claim.publicDispatchSha256 !== hashJson(item.publicDispatch) ||
        !call ||
        call.receipt.status !== "completed" ||
        claim.callId !== call.reservation.callId ||
        claim.callReservationSha256 !== hashJson(call.reservation) ||
        claim.callReceiptSha256 !== hashJson(call.receipt) ||
        claim.responseSha256 !== call.receipt.responseSha256)) ||
    (verdict && (!claim || verdict.claimSha256 !== hashJson(claim)))
  )
    foreign();
  if (receipt.status === "collector-crashed") {
    if (
      receipt.publicRequestSha256 !== null ||
      receipt.proposalSha256 !== null ||
      receipt.resultSourceSha256 !== null ||
      receipt.outcome.verificationSha256 !== null ||
      receipt.outcome.runtimeSha256 !== null
    )
      foreign();
    return;
  }
  if (
    !item.publicDispatch ||
    !call ||
    receipt.publicRequestSha256 !== item.publicDispatch.publicPacketSha256 ||
    receipt.outcome.policyViolation !== false ||
    receipt.outcome.runtimeSha256 !== null
  )
    foreign();
  if (receipt.status === "provider-error") {
    if (
      call.receipt.status !== "provider-error" ||
      claim ||
      verdict ||
      receipt.proposalSha256 !== null ||
      receipt.resultSourceSha256 !== null ||
      receipt.outcome.verificationSha256 !== null
    )
      foreign();
    return;
  }
  if (call.receipt.status !== "completed") foreign();
  if (claim) {
    if (
      !verdict ||
      receipt.proposalSha256 !== claim.proposalSha256 ||
      receipt.resultSourceSha256 !== claim.resultSourceSha256 ||
      receipt.outcome.verificationSha256 !== verdict.verificationSha256
    )
      foreign();
  } else if (
    verdict ||
    receipt.proposalSha256 === null ||
    receipt.resultSourceSha256 !== null ||
    receipt.outcome.verificationSha256 !== null
  )
    foreign();
}

function pendingAssignments(inspection) {
  if (inspection.closure)
    throw new Error("Cohort collection is already closed");
  const pending = [];
  let seenPending = false;
  for (const item of inspection.assignments) {
    if (item.receipt) {
      if (seenPending)
        throw new Error("Cohort terminal attempts are not an ordinal prefix");
      assertPriorTerminal(item, inspection.plan);
    } else if (item.reservation) {
      // Only the owner of the transport can fence it. Never recover or retry.
      throw new Error(
        `Cohort reservation ${item.reservation.reservationId} is unresolved; fence transport before explicit recovery`,
      );
    } else {
      seenPending = true;
      pending.push(item.assignment);
    }
  }
  return pending;
}

/**
 * Execute exactly the remaining frozen assignments in ordinal order. Handles
 * are fresh in-process bridge handles and must be re-retained on process
 * restart. Every pending input is privately preflighted before the first
 * reservation; each one-shot runner rechecks its inputs immediately before
 * reservation. A thrown or open attempt stops the cohort without retry,
 * recovery, closure, or any second model call for that assignment.
 */
export async function runOneShotLocalRepositoryV2Cohort(input, runtime) {
  const {
    store,
    artifacts,
    bridge,
    collectionId,
    assignments: supplied,
  } = fields(
    input,
    ["store", "artifacts", "bridge", "collectionId", "assignments"],
    "Local repository cohort",
  );
  if (
    !(store instanceof SealedStore) ||
    !(artifacts instanceof ArtifactStore) ||
    !(bridge instanceof SealedPublicPacketBridge) ||
    typeof collectionId !== "string" ||
    !ID.test(collectionId)
  )
    throw new Error("Cohort needs trusted sealed stores and collection ID");
  const assignments = denseAssignments(supplied);
  const before = store.inspectCollection(collectionId);
  const pending = pendingAssignments(before);
  if (assignments.length !== pending.length)
    throw new Error("Cohort input does not cover every pending assignment");
  const tasks = new Map(before.plan.tasks.map((task) => [task.taskId, task]));
  const oneShot = [];
  for (const [index, assignment] of pending.entries()) {
    const provided = assignments[index];
    const task = tasks.get(assignment.taskId);
    if (
      !task ||
      task.stateFormatVersion !== "repo-snapshot-v1" ||
      !task.executionScopeSha256 ||
      provided.assignmentId !== assignment.assignmentId ||
      typeof provided.providerId !== "string" ||
      !ID.test(provided.providerId)
    )
      throw new Error("Cohort input differs from frozen v2 assignment order");
    oneShot.push({
      store,
      artifacts,
      bridge,
      handle: provided.handle,
      collectionId,
      assignmentId: assignment.assignmentId,
      baselineReference: provided.baselineReference,
      scopeReference: provided.scopeReference,
      oracleReference: provided.oracleReference,
      providerId: provided.providerId,
    });
  }
  // Verify all source/scope/oracle/recipe/provider bindings before consuming
  // even the first assignment. No private case bytes leave this collector.
  for (const request of oneShot) {
    const preflight = await inspectOneShotLocalRepositoryV2Preflight(
      request,
      runtime,
    );
    if (
      preflight.planSha256 !== before.planSha256 ||
      preflight.assignmentId !== request.assignmentId ||
      preflight.promotionEligible !== false
    )
      throw new Error("Cohort preflight differs from its frozen plan");
  }

  for (const request of oneShot) {
    const observation = await runOneShotLocalRepositoryV2Attempt(
      request,
      runtime,
    );
    const current = store.inspectCollection(collectionId);
    const item = current.assignments.find(
      (entry) => entry.assignment.assignmentId === request.assignmentId,
    );
    if (
      current.planSha256 !== before.planSha256 ||
      !item?.receipt ||
      observation.promotionEligible !== false ||
      observation.attemptReceiptSha256 !== hashJson(item.receipt)
    )
      throw new Error("Cohort attempt differs from its retained settlement");
    assertPriorTerminal(item, current.plan);
  }

  const final = store.inspectCollection(collectionId);
  if (
    final.planSha256 !== before.planSha256 ||
    final.assignments.length !== before.plan.assignments.length ||
    final.assignments.some((item) => !item.receipt)
  )
    throw new Error("Cohort is incomplete and cannot be closed");
  for (const item of final.assignments) assertPriorTerminal(item, final.plan);
  const closure = store.closeCollection(collectionId);
  if (!closure.complete || closure.planSha256 !== before.planSha256)
    throw new Error("Cohort closure did not cover every frozen assignment");
  return Object.freeze({
    kind: "sealed-local-repository-v2-cohort-observation",
    version: "1.0.0",
    projectId: before.plan.projectId,
    collectionId,
    planSha256: before.planSha256,
    assignmentCount: final.assignments.length,
    terminalCount: final.assignments.length,
    crashedCount: final.assignments.filter(
      (item) => item.receipt.status === "collector-crashed",
    ).length,
    providerErrorCount: final.assignments.filter(
      (item) => item.receipt.status === "provider-error",
    ).length,
    closureSha256: hashJson(closure),
    promotionEligible: false,
    authorityStatus: "local-analysis-only",
  });
}
