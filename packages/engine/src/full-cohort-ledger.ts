// Structural accounting only. Hashes and local event chains are not signatures or authority.
import { z } from "zod";
import {
  assignmentSchema,
  attemptReceiptSchema,
  callReceiptSchema,
  callReservationSchema,
  closureSchema,
  collectionPlanSchema,
  decodeJson,
  digestSchema,
  eventSchema,
  exposureRegistrySchema,
  freezeJson,
  hashJson,
  oracleInvocationClaimSchema,
  publicDispatchClaimSchema,
  reservationSchema,
  validateCollectionPlan,
} from "./sealed-collection-schema.js";

export const cohortInspectionSchema = z
  .object({
    plan: collectionPlanSchema,
    planSha256: digestSchema,
    registry: exposureRegistrySchema,
    assignments: z
      .array(
        z
          .object({
            assignment: assignmentSchema,
            reservation: reservationSchema.nullable(),
            publicDispatch: publicDispatchClaimSchema.nullable().optional(),
            oracleInvocation: oracleInvocationClaimSchema.nullable().optional(),
            receipt: attemptReceiptSchema.nullable(),
            calls: z
              .array(
                z
                  .object({
                    reservation: callReservationSchema,
                    receipt: callReceiptSchema.nullable(),
                  })
                  .strict(),
              )
              .max(100),
          })
          .strict(),
      )
      .min(2)
      .max(2000),
    events: z
      .array(z.object({ event: eventSchema, sha256: digestSchema }).strict())
      .min(1)
      .max(100_000),
    closure: closureSchema.nullable(),
    promotionEligible: z.literal(false),
  })
  .strict();
export type CohortInspection = z.infer<typeof cohortInspectionSchema>;
export const cohortPinsSchema = z
  .object({
    planSha256: digestSchema,
    registrySha256: digestSchema,
    baselineConfigurationSha256: digestSchema,
    candidateConfigurationSha256: digestSchema,
  })
  .strict();
export type CohortPins = z.infer<typeof cohortPinsSchema>;
export type CohortAssignment = CohortInspection["assignments"][number];
const fields = [
  "inputTokens",
  "outputTokens",
  "costUsd",
  "reportedCostUsd",
  "chargedCostUsd",
] as const;
const require = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(`Invalid full-cohort ledger: ${message}`);
};
const same = (a: unknown, b: unknown) => hashJson(a) === hashJson(b);
const time = (value: string) => Date.parse(value);
function permitsLocalNoApiCharge(provider: {
  kind: string;
  endpointOrigin: string;
}): boolean {
  const endpoint = new URL(provider.endpointOrigin);
  return (
    ["local", "laya"].includes(provider.kind) &&
    ["http:", "https:"].includes(endpoint.protocol) &&
    !endpoint.username &&
    !endpoint.password &&
    ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
  );
}

/** Independently reconcile a detached inspection against externally selected pins. */
export function validateFullCohortLedger(
  input: unknown,
  pinInput: unknown,
): CohortInspection {
  const pins = cohortPinsSchema.parse(decodeJson(pinInput));
  const inspection = cohortInspectionSchema.parse(decodeJson(input));
  const { plan, planSha256 } = validateCollectionPlan(
    inspection.plan,
    inspection.registry,
    { expectedRegistrySha256: pins.registrySha256 },
  );
  require(inspection.planSha256 === planSha256 &&
    pins.planSha256 === planSha256, "plan digest mismatch");
  for (const arm of ["baseline", "candidate"] as const)
    require(hashJson(plan.configurations[arm]) ===
      pins[
        `${arm}ConfigurationSha256`
      ], "frozen configuration digest mismatch");
  require(same(
    inspection.assignments.map((item) => item.assignment),
    plan.assignments,
  ), "complete preassigned task/arm inventory differs");

  const artifacts = new Map<
    string,
    { type: string; parent?: string; timestamp: string }
  >();
  const add = (
    type: string,
    payload: unknown,
    timestamp: string,
    parent?: string,
  ) => {
    const identity = `${type}:${hashJson(payload)}`;
    require(!artifacts.has(identity), "duplicate artifact");
    artifacts.set(identity, { type, parent, timestamp });
    return identity;
  };
  const registered = add("registered", plan, plan.createdAt);
  const reservationIds = new Set<string>(),
    callIds = new Set<string>(),
    recordIds = new Set<string>();
  for (const item of inspection.assignments) {
    const {
      assignment,
      reservation,
      publicDispatch,
      oracleInvocation,
      receipt,
      calls,
    } = item;
    const task = plan.tasks.find((task) => task.taskId === assignment.taskId)!;
    const config = plan.configurations[assignment.arm];
    if (!reservation) {
      require(publicDispatch == null &&
        oracleInvocation == null &&
        receipt === null &&
        calls.length ===
          0, "unreserved assignment contains dispatch, oracle, receipts or calls");
      continue;
    }
    require(!reservationIds.has(
      reservation.reservationId,
    ), "duplicate reservation ID");
    reservationIds.add(reservation.reservationId);
    require(same(reservation, {
      version: "1.0.0",
      kind: "sealed-attempt-reservation",
      reservationId: reservation.reservationId,
      collectionId: plan.collectionId,
      assignmentId: assignment.assignmentId,
      taskId: task.taskId,
      stableTaskId: task.stableTaskId,
      stableFamilyId: task.stableFamilyId,
      exposureDomain: task.exposureDomain,
      arm: assignment.arm,
      ordinal: assignment.ordinal,
      attemptOrdinal: 1,
      planSha256,
      configurationSha256: hashJson(config),
      taskSha256: hashJson(task),
      reservedAt: reservation.reservedAt,
    }), "reservation does not join its frozen task/arm/configuration");
    require(time(reservation.reservedAt) >= time(plan.notBefore) &&
      time(reservation.reservedAt) <
        time(plan.expiresAt), "attempt outside collection window");
    const attemptEvent = add(
      "attempt-reserved",
      reservation,
      reservation.reservedAt,
      registered,
    );
    let publicDispatchEvent: string | undefined;
    if (publicDispatch) {
      require(same(publicDispatch, {
        version: "1.0.0",
        kind: "sealed-public-dispatch-claim",
        reservationId: reservation.reservationId,
        reservationSha256: hashJson(reservation),
        collectionId: plan.collectionId,
        assignmentId: assignment.assignmentId,
        taskId: task.taskId,
        taskSha256: hashJson(task),
        planSha256,
        publicPacketSha256: task.publicPacketSha256,
        publicPacketBytes: publicDispatch.publicPacketBytes,
        claimedAt: publicDispatch.claimedAt,
      }), "public dispatch claim differs from its frozen attempt");
      require(time(publicDispatch.claimedAt) >= time(reservation.reservedAt) &&
        time(publicDispatch.claimedAt) < time(plan.expiresAt) &&
        time(publicDispatch.claimedAt) - time(reservation.reservedAt) <
          config.maxDurationMs, "public dispatch outside frozen attempt deadline");
      publicDispatchEvent = add(
        "public-dispatch-claimed",
        publicDispatch,
        publicDispatch.claimedAt,
        attemptEvent,
      );
    }
    if (oracleInvocation) {
      require(publicDispatch, "oracle invocation lacks public dispatch");
      require(same(oracleInvocation, {
        version: "1.0.0",
        kind: "sealed-oracle-invocation-claim",
        reservationId: reservation.reservationId,
        reservationSha256: hashJson(reservation),
        collectionId: plan.collectionId,
        assignmentId: assignment.assignmentId,
        taskId: task.taskId,
        taskSha256: hashJson(task),
        planSha256,
        publicDispatchSha256: hashJson(publicDispatch),
        oracleSha256: task.oracleSha256,
        proposalSha256: oracleInvocation.proposalSha256,
        imageId: oracleInvocation.imageId,
        claimedAt: oracleInvocation.claimedAt,
      }), "oracle invocation differs from frozen attempt");
      require(![
        task.oracleSha256,
        task.publicPacketSha256,
        task.referenceRepairSha256,
      ].includes(
        oracleInvocation.proposalSha256,
      ), "oracle role used as proposal");
      require(time(oracleInvocation.claimedAt) >=
        time(publicDispatch!.claimedAt) &&
        time(oracleInvocation.claimedAt) < time(plan.expiresAt) &&
        time(oracleInvocation.claimedAt) - time(reservation.reservedAt) <
          config.maxDurationMs, "oracle invocation outside frozen attempt deadline");
      add(
        "oracle-invocation-claimed",
        oracleInvocation,
        oracleInvocation.claimedAt,
        publicDispatchEvent,
      );
    }
    require(calls.length <=
      config.maxCallsPerAttempt, "frozen call limit exceeded");
    let reservedTotal = 0;
    for (const [index, call] of calls.entries()) {
      const r = call.reservation,
        c = call.receipt;
      require(!callIds.has(
        r.callId,
      ), "duplicate call ID, including across arms");
      callIds.add(r.callId);
      require(r.reservationId === reservation.reservationId &&
        r.ordinal === index, "call identity or ordinal mismatch");
      const provider = config.providers.find(
        (provider) =>
          provider.providerId === r.providerId &&
          provider.requestedModel === r.requestedModel,
      );
      require(provider, "call provider/model not in frozen configuration");
      require(time(r.reservedAt) >= time(reservation.reservedAt) &&
        time(r.reservedAt) < time(plan.expiresAt) &&
        time(r.reservedAt) - time(reservation.reservedAt) <
          config.maxDurationMs, "call outside frozen attempt deadline");
      if (config.maxCostUsdPerAttempt !== null) {
        require(r.reservedCostUsd !==
          null, "unknown reservation within capped budget");
        reservedTotal += r.reservedCostUsd!;
        require(Number.isFinite(reservedTotal) &&
          reservedTotal <=
            config.maxCostUsdPerAttempt, "frozen reserved budget exceeded");
      }
      const callEvent = add("call-reserved", r, r.reservedAt, attemptEvent);
      if (!c) continue;
      require(c.callId === r.callId &&
        c.reservationSha256 === hashJson(r), "call receipt identity mismatch");
      require(time(c.finishedAt) >=
        time(r.reservedAt), "call settles before reservation");
      require(c.status !== "completed" ||
        (c.responseSha256 &&
          c.reportedModel), "completed call lacks original response/model");
      require(c.usage.basis !==
        "aggregate", "individual call claims aggregate usage");
      require(c.usage.basis !== "reviewed-rate-card" ||
        c.usage.pricingSha256 ===
          provider!.pricingSha256, "rate card differs from frozen pricing");
      require(c.usage.basis !== "local-no-api-charge" ||
        permitsLocalNoApiCharge(
          provider!,
        ), "hosted provider claims local no-API-charge usage");
      add("call-settled", c, c.finishedAt, callEvent);
    }
    if (!receipt) continue;
    require(receipt.reservationId === reservation.reservationId &&
      receipt.reservationSha256 ===
        hashJson(reservation), "attempt receipt identity mismatch");
    require(calls.every(
      (call) => call.receipt,
    ), "terminal attempt omits call settlement");
    require(same(
      receipt.callReceiptSha256s,
      calls.map((call) => hashJson(call.receipt)),
    ), "attempt call inventory mismatch");
    require(time(receipt.finishedAt) >= time(reservation.reservedAt) &&
      calls.every(
        (call) => time(call.receipt!.finishedAt) <= time(receipt.finishedAt),
      ), "attempt settles before reservation or call");
    require(receipt.usage.basis ===
      "aggregate", "attempt sum presented as independent billing");
    for (const field of fields) {
      const expected =
        !calls.length ||
        calls.some((call) => call.receipt!.usage[field] === null)
          ? null
          : calls.reduce((sum, call) => sum + call.receipt!.usage[field]!, 0);
      require(expected === null ||
        Number.isFinite(expected), "aggregate overflow");
      require(receipt.usage[field] ===
        expected, `attempt ${field} must sum every call exactly once`);
    }
    require(receipt.publicRequestSha256 === null ||
      receipt.publicRequestSha256 ===
        task.publicPacketSha256, "public packet differs from commitment");
    if (oracleInvocation)
      require(time(oracleInvocation.claimedAt) <= time(receipt.finishedAt) &&
        (receipt.status !== "completed" ||
          receipt.proposalSha256 ===
            oracleInvocation.proposalSha256), "attempt settlement conflicts with oracle invocation");
    require(receipt.status !== "completed" ||
      (calls.length &&
        receipt.publicRequestSha256 &&
        receipt.proposalSha256 &&
        receipt.resultSourceSha256 &&
        receipt.outcome.success !== null &&
        receipt.outcome.verificationSha256 &&
        receipt.outcome
          .runtimeSha256), "completed attempt lacks checkable outcome artifacts");
    require(receipt.status === "completed" ||
      receipt.outcome.success !==
        true, "noncompleted attempt claims a successful outcome");
    require(!["collector-crashed", "infrastructure-error"].includes(
      receipt.status,
    ) ||
      receipt.outcome.success ===
        null, "infrastructure failure claims a known outcome");
    require(!calls.some(
      (call) =>
        call.reservation.reservedCostUsd !== null &&
        call.receipt!.usage.costUsd !== null &&
        call.receipt!.usage.costUsd > call.reservation.reservedCostUsd,
    ) || receipt.outcome.policyViolation, "overspend lacks policy violation");
    for (const observation of receipt.observations) {
      require(!recordIds.has(
        observation.recordId,
      ), "duplicate original observation ID");
      recordIds.add(observation.recordId);
      const call = calls.find(
        (call) => call.reservation.callId === observation.callId,
      );
      require(call &&
        call.reservation.providerId ===
          observation.providerId, "observation references another or missing call");
      require(call!.receipt!.reportedModel === null ||
        call!.receipt!.reportedModel ===
          observation.model, "observation model differs from original response");
      require(observation.category === task.category &&
        observation.stateFormatVersion ===
          task.stateFormatVersion, "observation category/state differs from task");
      require(new Set(observation.candidates).size ===
        observation.candidates.length &&
        (observation.selected === null ||
          observation.candidates.includes(
            observation.selected,
          )), "ambiguous observation candidates");
      require(time(observation.observedAt) >=
        time(call!.reservation.reservedAt) &&
        time(observation.observedAt) <=
          time(
            receipt.finishedAt,
          ), "observation outside call/attempt chronology");
    }
    add("attempt-settled", receipt, receipt.finishedAt, attemptEvent);
  }
  const { closure, events } = inspection;
  if (closure) {
    require(inspection.assignments.every(
      (item) => !item.reservation || item.receipt,
    ), "closed collection retains pending attempts");
    const inventory = inspection.assignments.map((item) => ({
      assignmentId: item.assignment.assignmentId,
      taskId: item.assignment.taskId,
      arm: item.assignment.arm,
      ordinal: item.assignment.ordinal,
      status: item.receipt ? "terminal" : "not-attempted",
      reservationSha256: item.reservation ? hashJson(item.reservation) : null,
      receiptSha256: item.receipt ? hashJson(item.receipt) : null,
      callReservationSha256s: item.calls.map((call) =>
        hashJson(call.reservation),
      ),
      callReceiptSha256s: item.calls.map((call) =>
        call.receipt ? hashJson(call.receipt) : null,
      ),
    }));
    require(closure.collectionId === plan.collectionId &&
      closure.planSha256 === planSha256 &&
      same(closure.inventory, inventory) &&
      closure.complete ===
        inspection.assignments.every(
          (item) => !!item.receipt,
        ), "closure omits or changes cohort assignments");
    require(closure.eventHeadSha256 ===
      events.at(-2)?.sha256, "closure event head mismatch");
    add("closed", closure, closure.closedAt, registered);
  }
  let previous: string | null = null,
    previousTime = -Infinity;
  const positions = new Map<string, number>();
  for (const [index, entry] of events.entries()) {
    const event = entry.event,
      identity = `${event.type}:${event.payloadSha256}`,
      artifact = artifacts.get(identity);
    require(event.collectionId === plan.collectionId &&
      event.sequence === index + 1 &&
      event.previousSha256 === previous &&
      hashJson(event) === entry.sha256, "event identity/chain mismatch");
    require(artifact &&
      !positions.has(identity), "event has missing or duplicate artifact");
    require(time(event.createdAt) >= previousTime &&
      time(event.createdAt) >=
        time(artifact!.timestamp), "event chronology mismatch");
    require(!artifact!.parent ||
      positions.has(
        artifact!.parent,
      ), "artifact event precedes its reservation");
    positions.set(identity, index);
    previous = entry.sha256;
    previousTime = time(event.createdAt);
  }
  require(positions.size === artifacts.size &&
    events[0].event.type === "registered" &&
    (!closure ||
      events.at(-1)!.event.type ===
        "closed"), "complete event/artifact inventory mismatch");
  for (const item of inspection.assignments)
    if (item.receipt)
      require(item.calls.every(
        (call) =>
          positions.get(`call-settled:${hashJson(call.receipt)}`)! <
          positions.get(`attempt-settled:${hashJson(item.receipt)}`)!,
      ), "attempt event precedes terminal call accounting");
  // Frozen assignment ordinals govern execution, not the serialization order of
  // the plan's arrays. An unfinished/unattempted earlier arm cannot be skipped.
  const ordered = [...inspection.assignments].sort(
    (a, b) => a.assignment.ordinal - b.assignment.ordinal,
  );
  for (const [index, item] of ordered.entries()) {
    if (!item.reservation) continue;
    const previousAttempt = ordered[index - 1];
    if (previousAttempt) {
      require(previousAttempt.receipt !==
        null, "attempt skips an earlier unfinished frozen assignment");
      require(positions.get(
        `attempt-settled:${hashJson(previousAttempt.receipt)}`,
      )! <
        positions.get(
          `attempt-reserved:${hashJson(item.reservation)}`,
        )!, "attempt reservation violates frozen sequential assignment order");
      require(time(previousAttempt.receipt!.finishedAt) <=
        time(
          item.reservation.reservedAt,
        ), "attempt reservation predates the previous frozen assignment settlement");
    }
    if (item.publicDispatch) {
      const claimedPosition = positions.get(
        `public-dispatch-claimed:${hashJson(item.publicDispatch)}`,
      )!;
      require(item.calls.every(
        (call) =>
          claimedPosition <
          positions.get(`call-reserved:${hashJson(call.reservation)}`)!,
      ), "public dispatch claim follows a model-call reservation");
      require(!item.receipt ||
        claimedPosition <
          positions.get(
            `attempt-settled:${hashJson(item.receipt)}`,
          )!, "public dispatch claim follows attempt settlement");
    }
    if (item.oracleInvocation && item.receipt)
      require(positions.get(
        `oracle-invocation-claimed:${hashJson(item.oracleInvocation)}`,
      )! <
        positions.get(
          `attempt-settled:${hashJson(item.receipt)}`,
        )!, "oracle invocation follows attempt settlement");
    for (const [callIndex, call] of item.calls.entries()) {
      const position = positions.get(
        `call-reserved:${hashJson(call.reservation)}`,
      )!;
      if (callIndex) {
        const previousCall = item.calls[callIndex - 1];
        require(positions.get(
          `call-reserved:${hashJson(previousCall.reservation)}`,
        )! < position &&
          time(previousCall.reservation.reservedAt) <=
            time(
              call.reservation.reservedAt,
            ), "call reservation event order differs from its ordinal");
      }
      // Calls may run concurrently. Once an overrun has actually been settled,
      // however, reserving another call is forbidden even if a stale budget fits.
      for (const settled of item.calls) {
        if (
          settled.receipt &&
          settled.reservation.reservedCostUsd !== null &&
          settled.receipt.usage.costUsd !== null &&
          settled.receipt.usage.costUsd > settled.reservation.reservedCostUsd
        )
          require(position <
            positions.get(
              `call-settled:${hashJson(settled.receipt)}`,
            )!, "call reserved after a known settled budget overrun");
      }
    }
  }
  return freezeJson(inspection);
}
