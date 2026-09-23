import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  evaluateFullCohort,
  freezeCohortCalibration,
} from "../src/full-cohort-evaluation.js";
import {
  validateFullCohortLedger,
  type CohortInspection,
} from "../src/full-cohort-ledger.js";
import { hashJson } from "../src/sealed-collection-schema.js";
import { evaluateDecisions, type EvaluationDataset } from "../src/decisions.js";

const date = "2026-01-02T00:00:00.000Z",
  digest = (value: string) => hashJson({ fixture: value });
const limitations = [
  "Synthetic fixture only; no collection, independent signatures or authority.",
];
function calibration(): EvaluationDataset {
  return {
    version: "1.0.0",
    provenance: {
      origin: "synthetic",
      datasetId: "synthetic-calibration",
      population: "Synthetic bounded accounting calibration fixture only.",
      repositoryIds: ["repo"],
      riskStrata: ["low"],
      reviewedBy: "fixture-reviewer",
      reviewedAt: date,
      limitations,
    },
    rows: Array.from({ length: 50 }, (_, i) => ({
      split: "calibration",
      category: "worker",
      provider: "jev",
      model: "decision-snapshot",
      selected: "local",
      expected: "local",
      confidence: 1,
      caseId: `cal-case-${i}`,
      taskId: `cal-task-${i}`,
      baselineSuccess: true,
      candidateSuccess: true,
      baselineCost: 2,
      candidateCost: 1,
      policyViolation: false,
    })),
  };
}
function chain(inspection: CohortInspection, close = true) {
  const events: CohortInspection["events"] = [];
  const event = (
    type: CohortInspection["events"][number]["event"]["type"],
    payload: unknown,
  ) => {
    const value = {
      version: "1.0.0" as const,
      kind: "sealed-ledger-event" as const,
      collectionId: inspection.plan.collectionId,
      sequence: events.length + 1,
      type,
      createdAt: date,
      previousSha256: events.at(-1)?.sha256 ?? null,
      payloadSha256: hashJson(payload),
    };
    events.push({ event: value, sha256: hashJson(value) });
  };
  event("registered", inspection.plan);
  for (const item of [...inspection.assignments].sort(
    (a, b) => a.assignment.ordinal - b.assignment.ordinal,
  )) {
    if (item.reservation) event("attempt-reserved", item.reservation);
    for (const call of item.calls) {
      event("call-reserved", call.reservation);
      if (call.receipt) event("call-settled", call.receipt);
    }
    if (item.receipt) event("attempt-settled", item.receipt);
  }
  inspection.closure = close
    ? {
        version: "1.0.0",
        kind: "sealed-collection-closure",
        collectionId: inspection.plan.collectionId,
        planSha256: inspection.planSha256,
        closedAt: date,
        complete: inspection.assignments.every((item) => !!item.receipt),
        promotionEligible: false,
        inventory: inspection.assignments.map((item) => ({
          assignmentId: item.assignment.assignmentId,
          taskId: item.assignment.taskId,
          arm: item.assignment.arm,
          ordinal: item.assignment.ordinal,
          status: item.receipt ? "terminal" : "not-attempted",
          reservationSha256: item.reservation
            ? hashJson(item.reservation)
            : null,
          receiptSha256: item.receipt ? hashJson(item.receipt) : null,
          callReservationSha256s: item.calls.map((call) =>
            hashJson(call.reservation),
          ),
          callReceiptSha256s: item.calls.map((call) => hashJson(call.receipt)),
        })),
        eventHeadSha256: events.at(-1)!.sha256,
        limitations,
      }
    : null;
  if (inspection.closure) event("closed", inspection.closure);
  inspection.events = events;
}
function refresh(item: CohortInspection["assignments"][number]) {
  if (!item.receipt) return;
  item.receipt.callReceiptSha256s = item.calls.map((call) =>
    hashJson(call.receipt),
  );
  for (const field of [
    "inputTokens",
    "outputTokens",
    "costUsd",
    "reportedCostUsd",
    "chargedCostUsd",
  ] as const)
    item.receipt.usage[field] =
      !item.calls.length ||
      item.calls.some(
        (call) => !call.receipt || call.receipt.usage[field] === null,
      )
        ? null
        : item.calls.reduce(
            (sum, call) => sum + call.receipt!.usage[field]!,
            0,
          );
}
function resealEvents(inspection: CohortInspection) {
  for (const [index, entry] of inspection.events.entries()) {
    entry.event.sequence = index + 1;
    entry.event.previousSha256 = inspection.events[index - 1]?.sha256 ?? null;
    if (entry.event.type === "closed") {
      inspection.closure!.eventHeadSha256 = entry.event.previousSha256!;
      entry.event.payloadSha256 = hashJson(inspection.closure);
    }
    entry.sha256 = hashJson(entry.event);
  }
}
function additionalCall(item: CohortInspection["assignments"][number]) {
  const call = structuredClone(item.calls[0]);
  call.reservation.callId += "-second";
  call.reservation.ordinal = 1;
  call.reservation.reservedCostUsd = 0;
  call.receipt!.callId = call.reservation.callId;
  call.receipt!.reservationSha256 = hashJson(call.reservation);
  call.receipt!.usage.costUsd =
    call.receipt!.usage.reportedCostUsd =
    call.receipt!.usage.chargedCostUsd =
      0;
  item.calls.push(call);
  refresh(item);
  return call;
}
function makeFixture(taskCount = 60) {
  const data = calibration(),
    thresholds = freezeCohortCalibration(data);
  const configuration: CohortInspection["plan"]["configurations"]["candidate"] =
    {
      version: "1.0.0",
      kind: "sealed-frozen-configuration",
      configurationId: "candidate",
      implementationSha256: digest("implementation"),
      policySha256: digest("policy"),
      promptSha256: digest("prompt"),
      contextImplementationSha256: digest("context"),
      categoryStateVersions: [
        { category: "worker", stateFormatVersion: "worker-v1" },
      ],
      providers: [
        {
          providerId: "jev-worker",
          kind: "jev",
          endpointOrigin: "https://fixture.invalid",
          requestedModel: "decision-snapshot",
          modelIdentity: {
            kind: "provider-snapshot",
            snapshotId: "decision-snapshot",
          },
          effort: null,
          maxOutputTokens: 1000,
          samplingSha256: digest("sampling"),
          pricingSha256: digest("prices"),
        },
      ],
      maxCallsPerAttempt: 3,
      maxCostUsdPerAttempt: 1000,
      maxDurationMs: 3600000,
    };
  const registry: CohortInspection["registry"] = {
    version: "1.0.0",
    kind: "sealed-exposure-registry",
    registryId: "fixture-registry",
    createdAt: date,
    entries: [],
  };
  const plan: CohortInspection["plan"] = {
    version: "1.0.0",
    kind: "sealed-collection-plan",
    collectionId: "fixture-cohort",
    projectId: "fixture-project",
    createdAt: date,
    notBefore: date,
    expiresAt: "2027-01-01T00:00:00.000Z",
    population: "Synthetic held-out accounting fixture, not unseen evidence.",
    samplingRule:
      "Every synthetic task is preassigned to both arms in fixed order.",
    exposureRegistrySha256: hashJson(registry),
    trustPolicySha256: digest("trust"),
    calibrationDatasetSha256: hashJson(data),
    thresholdsSha256: hashJson(thresholds),
    configurations: {
      baseline: {
        ...structuredClone(configuration),
        configurationId: "baseline",
      },
      candidate: configuration,
    },
    producerIds: ["fixture-producer"],
    limitations,
    tasks: Array.from({ length: taskCount }, (_, i) => ({
      version: "1.0.0",
      kind: "sealed-task-commitment",
      taskId: `task-${i}`,
      stableTaskId: `stable-${i}`,
      stableFamilyId: `family-${i}`,
      exposureDomain: "fixture",
      repositoryId: "repo",
      exposure: "sealed-unseen",
      baselineSha256: digest(`baseline-${i}`),
      publicPacketSha256: digest(`public-${i}`),
      oracleSha256: digest(`oracle-${i}`),
      referenceRepairSha256: null,
      category: "worker",
      stateFormatVersion: "worker-v1",
      risk: "low",
      allowedOutputPaths: ["source.ts"],
      curatorId: "fixture-curator",
    })),
    assignments: [],
  };
  plan.assignments = plan.tasks.flatMap((task, index) =>
    (["baseline", "candidate"] as const).map((arm, offset) => ({
      assignmentId: `${task.taskId}-${arm}`,
      taskId: task.taskId,
      arm,
      ordinal: index * 2 + offset,
    })),
  );
  const planSha256 = hashJson(plan);
  const inspection: CohortInspection = {
    plan,
    planSha256,
    registry,
    assignments: [],
    events: [],
    closure: null,
    promotionEligible: false,
  };
  inspection.assignments = plan.assignments.map((assignment) => {
    const task = plan.tasks.find((task) => task.taskId === assignment.taskId)!,
      record = assignment.assignmentId;
    const reservation = {
      version: "1.0.0" as const,
      kind: "sealed-attempt-reservation" as const,
      reservationId: record,
      collectionId: plan.collectionId,
      assignmentId: record,
      taskId: task.taskId,
      stableTaskId: task.stableTaskId,
      stableFamilyId: task.stableFamilyId,
      exposureDomain: task.exposureDomain,
      arm: assignment.arm,
      ordinal: assignment.ordinal,
      attemptOrdinal: 1 as const,
      planSha256,
      configurationSha256: hashJson(plan.configurations[assignment.arm]),
      taskSha256: hashJson(task),
      reservedAt: date,
    };
    const callReservation = {
      version: "1.0.0" as const,
      kind: "sealed-call-reservation" as const,
      callId: `call-${record}`,
      reservationId: record,
      ordinal: 0,
      providerId: "jev-worker",
      requestedModel: "decision-snapshot",
      requestSha256: digest(`request-${record}`),
      reservedCostUsd: 1000,
      reservedAt: date,
    };
    const cost = assignment.arm === "baseline" ? 2 : 1;
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      costUsd: cost,
      reportedCostUsd: cost,
      chargedCostUsd: 1000,
      basis: "provider-reported" as const,
      pricingSha256: null,
    };
    const callReceipt = {
      version: "1.0.0" as const,
      kind: "sealed-call-receipt" as const,
      callId: callReservation.callId,
      reservationSha256: hashJson(callReservation),
      status: "completed" as const,
      responseSha256: digest(`response-${record}`),
      reportedModel: "decision-snapshot",
      usage,
      finishedAt: date,
    };
    const receipt = {
      version: "1.0.0" as const,
      kind: "sealed-attempt-receipt" as const,
      reservationId: record,
      reservationSha256: hashJson(reservation),
      status: "completed" as const,
      finishedAt: date,
      publicRequestSha256: task.publicPacketSha256,
      proposalSha256: digest(`proposal-${record}`),
      resultSourceSha256: digest(`result-${record}`),
      observations:
        assignment.arm === "baseline"
          ? []
          : Array.from({ length: 4 }, (_, i) => ({
              recordId: `observation-${record}-${i}`,
              caseId: `case-${task.taskId}-${i}`,
              category: "worker",
              providerId: "jev-worker",
              model: "decision-snapshot",
              stateFormatVersion: "worker-v1",
              stateHash: digest(`state-${task.taskId}-${i}`),
              candidates: ["local", "frontier"],
              selected: "local",
              confidence: 1,
              observedAt: date,
              callId: callReservation.callId,
            })),
      callReceiptSha256s: [hashJson(callReceipt)],
      outcome: {
        success: true,
        policyViolation: false,
        verificationSha256: digest(`verification-${record}`),
        runtimeSha256: digest("runtime"),
      },
      usage: { ...usage, basis: "aggregate" as const },
      limitations,
    };
    return {
      assignment,
      reservation,
      receipt,
      calls: [{ reservation: callReservation, receipt: callReceipt }],
    };
  });
  chain(inspection);
  const pins = {
    planSha256,
    registrySha256: hashJson(registry),
    baselineConfigurationSha256: hashJson(plan.configurations.baseline),
    candidateConfigurationSha256: hashJson(plan.configurations.candidate),
  };
  const labels = () =>
    inspection.assignments
      .filter((item) => item.assignment.arm === "candidate")
      .flatMap(
        (item) =>
          item.receipt?.observations.map((observation) => ({
            recordId: observation.recordId,
            observationSha256: hashJson(observation),
            expected: "local",
            reviewerId: "fixture-reviewer",
            reviewedAt: date,
            evidenceSha256s: [digest("review")],
          })) ?? [],
      );
  const evaluate = () =>
    evaluateFullCohort({
      inspection,
      pins,
      calibration: data,
      thresholds,
      labels: labels(),
    });
  return { inspection, pins, data, thresholds, labels, evaluate };
}
function repinConfiguration(fixture: ReturnType<typeof makeFixture>) {
  const { inspection, pins } = fixture;
  inspection.planSha256 = pins.planSha256 = hashJson(inspection.plan);
  for (const arm of ["baseline", "candidate"] as const)
    pins[`${arm}ConfigurationSha256`] = hashJson(
      inspection.plan.configurations[arm],
    );
  for (const item of inspection.assignments)
    if (item.reservation) {
      item.reservation.planSha256 = inspection.planSha256;
      item.reservation.configurationSha256 = hashJson(
        inspection.plan.configurations[item.assignment.arm],
      );
      if (item.receipt)
        item.receipt.reservationSha256 = hashJson(item.reservation);
    }
  chain(inspection);
}

describe("full preassigned cohort evaluation", () => {
  test("240 decisions on 60 tasks count each batched call once and never issue authority", () => {
    const fixture = makeFixture(),
      result = fixture.evaluate();
    expect(result.metricsEligible).toBe(true);
    expect(result.promotionEligible).toBe(false);
    expect(result.authorityStatus).toBe("unsigned-analysis-only");
    expect(result.accounting).toMatchObject({
      taskCount: 60,
      assignmentCount: 120,
      additionalFailures: 0,
    });
    expect(result.accounting.baseline).toMatchObject({
      callCount: 60,
      measuredApiCostUsd: 120,
      chargedCostUsd: 60000,
    });
    expect(result.accounting.candidate).toMatchObject({
      callCount: 60,
      measuredApiCostUsd: 60,
      chargedCostUsd: 60000,
    });
    expect(result.reports[0]).toMatchObject({
      calibrationCount: 50,
      heldOutCount: 240,
      taskCount: 60,
      calibrationError: 0,
    });
    expect(Object.isFrozen(result.accounting.candidate)).toBe(true);
  });
  test.each(["null-confidence", "no-observations"])(
    "an expensive failing %s task never disappears from denominators",
    (mode) => {
      const fixture = makeFixture(61),
        item = fixture.inspection.assignments.at(-1)!;
      item.receipt!.outcome.success = false;
      if (mode === "no-observations") item.receipt!.observations = [];
      else
        for (const observation of item.receipt!.observations)
          observation.confidence = null;
      item.calls[0].receipt!.usage.costUsd =
        item.calls[0].receipt!.usage.reportedCostUsd = 100;
      refresh(item);
      chain(fixture.inspection);
      const result = fixture.evaluate();
      expect(result.reports[0]).toMatchObject({
        heldOutCount: 240,
        taskCount: 60,
        decisionMetricsSatisfied: true,
      });
      expect(result.accounting).toMatchObject({
        taskCount: 61,
        additionalFailures: 1,
        candidate: { measuredApiCostUsd: 160 },
      });
      expect(result.blockers).toContain("additional-end-to-end-failures");
      expect(result.blockers).toContain("no-measured-api-cost-reduction");
      expect(result.metricsEligible).toBe(false);
    },
  );
  test("measured zero, known-confidence abstentions and unknown confidence remain distinct", () => {
    const fixture = makeFixture(61),
      observations =
        fixture.inspection.assignments.at(-1)!.receipt!.observations;
    observations[0].confidence = 0;
    observations[1].selected = null;
    observations[2].selected = null;
    observations[2].confidence = 0;
    observations[3].confidence = null;
    chain(fixture.inspection);
    const result = fixture.evaluate();
    expect(result.observations).toMatchObject({
      count: 244,
      unknownConfidenceCount: 1,
      abstentionCount: 2,
    });
    expect(result.reports[0]).toMatchObject({
      scorableCount: 243,
      heldOutCount: 240,
      taskCount: 60,
    });
    expect(result.accounting.candidate.measuredApiCostUsd).toBe(61);
    expect(result.metricsEligible).toBe(true);
  });
  test.each(["unknown", "reviewed-rate-card"] as const)(
    "%s call usage stays visible and cannot claim measured savings",
    (basis) => {
      const fixture = makeFixture(),
        item = fixture.inspection.assignments.at(-1)!,
        usage = item.calls[0].receipt!.usage;
      usage.basis = basis;
      usage.reportedCostUsd = null;
      usage.costUsd = basis === "unknown" ? null : 0.01;
      usage.pricingSha256 =
        basis === "reviewed-rate-card" ? digest("prices") : null;
      refresh(item);
      chain(fixture.inspection);
      const result = fixture.evaluate();
      expect(result.accounting.candidate.measuredApiCostUsd).toBeNull();
      expect(result.accounting.candidate.chargedCostUsd).toBe(60000);
      expect(result.accounting.candidate.accountedApiCostUsd).toBe(
        basis === "unknown" ? null : 59.01,
      );
      expect(result.blockers).toContain("unknown-or-estimated-cohort-cost");
    },
  );
  test("crashes and unattempted assignments survive a complete inventory", () => {
    const fixture = makeFixture(),
      crash = fixture.inspection.assignments.at(-4)!,
      missing = fixture.inspection.assignments.at(-1)!;
    crash.receipt!.status = "collector-crashed";
    crash.receipt!.outcome.success = null;
    crash.receipt!.observations = [];
    missing.reservation = null;
    missing.receipt = null;
    missing.calls = [];
    chain(fixture.inspection);
    const result = fixture.evaluate();
    expect(result.accounting.assignmentCount).toBe(120);
    expect(result.accounting.unknownOutcomePairs).toBe(2);
    expect(result.accounting.candidate.measuredApiCostUsd).toBeNull();
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "unattempted-assignment",
        "incomplete-or-failed-execution",
        "unknown-task-outcomes",
      ]),
    );
    expect(result.metricsEligible).toBe(false);
  });
  test("hard-policy violation on an unscorable task blocks eligibility", () => {
    const fixture = makeFixture(61),
      item = fixture.inspection.assignments.at(-1)!;
    item.receipt!.observations = [];
    item.receipt!.outcome.policyViolation = true;
    chain(fixture.inspection);
    expect(fixture.evaluate().blockers).toContain("hard-policy-violations");
  });
  test("frozen configuration pins cannot be swapped even with self-consistent rehashing", () => {
    const fixture = makeFixture();
    fixture.pins.candidateConfigurationSha256 = digest("other-configuration");
    expect(() => fixture.evaluate()).toThrow(/configuration digest/);
  });
  test("threshold hash and calibration-only fit cannot change after the plan", () => {
    const fixture = makeFixture();
    const thresholds = structuredClone(fixture.thresholds);
    thresholds.routes[0].minimumConfidence = 0.9;
    expect(() =>
      evaluateFullCohort({
        inspection: fixture.inspection,
        pins: fixture.pins,
        calibration: fixture.data,
        thresholds,
        labels: fixture.labels(),
      }),
    ).toThrow(/threshold commitments/);
  });
  test("threshold fitting uses existing exact calibration rules", () => {
    const data = calibration();
    for (const row of data.rows) row.confidence = 0.75;
    data.rows.push({
      ...data.rows[0],
      caseId: "wrong-cal-case",
      taskId: "wrong-cal-task",
      selected: "frontier",
      confidence: 0.4,
    });
    const threshold = freezeCohortCalibration(data).routes[0],
      existing = evaluateDecisions(data).reports[0];
    expect(threshold).toMatchObject({
      minimumConfidence: existing.minimumConfidence,
      calibrationCount: existing.calibrationCount,
    });
    expect(() =>
      freezeCohortCalibration({
        ...data,
        rows: [{ ...data.rows[0], split: "held-out" }],
      }),
    ).toThrow(/calibration-only/);
  });
  test.each([
    "skipped-assignment",
    "reversed-assignments",
    "overlapping-assignments",
  ])("rejects %s despite an otherwise self-consistent event chain", (mode) => {
    const fixture = makeFixture(1),
      [baseline, candidate] = fixture.inspection.assignments;
    if (mode === "skipped-assignment") {
      baseline.reservation = null;
      baseline.receipt = null;
      baseline.calls = [];
      chain(fixture.inspection);
    } else {
      const events = fixture.inspection.events;
      if (mode === "reversed-assignments")
        events.splice(1, 8, ...events.slice(5, 9), ...events.slice(1, 5));
      else events.splice(2, 0, events.splice(5, 1)[0]);
      resealEvents(fixture.inspection);
    }
    expect(candidate.reservation).not.toBeNull();
    expect(() => fixture.evaluate()).toThrow(
      /frozen assignment|frozen sequential/,
    );
  });
  test("frozen ordinals, not the order of the serialized inventory, govern execution", () => {
    const fixture = makeFixture(1);
    fixture.inspection.plan.assignments.reverse();
    fixture.inspection.assignments.reverse();
    repinConfiguration(fixture);
    expect(() =>
      validateFullCohortLedger(fixture.inspection, fixture.pins),
    ).not.toThrow();
  });
  test("call reservation ordinals are enforced while concurrent calls remain valid", () => {
    const fixture = makeFixture(1),
      item = fixture.inspection.assignments[0];
    additionalCall(item);
    chain(fixture.inspection);
    const events = fixture.inspection.events;
    // Move ordinal 1 reservation before ordinal 0 settlement, but not reservation.
    events.splice(3, 0, events.splice(4, 1)[0]);
    resealEvents(fixture.inspection);
    expect(() =>
      validateFullCohortLedger(fixture.inspection, fixture.pins),
    ).not.toThrow();
    [events[2], events[3]] = [events[3], events[2]];
    resealEvents(fixture.inspection);
    expect(() =>
      validateFullCohortLedger(fixture.inspection, fixture.pins),
    ).toThrow(/call reservation event order/);
  });
  test("a settled overrun forbids later calls but retains calls reserved before the overrun was known", () => {
    const fixture = makeFixture(1),
      item = fixture.inspection.assignments[0],
      first = item.calls[0];
    first.reservation.reservedCostUsd = 1;
    first.receipt!.reservationSha256 = hashJson(first.reservation);
    item.receipt!.outcome.policyViolation = true;
    additionalCall(item);
    chain(fixture.inspection);
    expect(() => fixture.evaluate()).toThrow(
      /after a known settled budget overrun/,
    );
    const events = fixture.inspection.events;
    events.splice(3, 0, events.splice(4, 1)[0]);
    resealEvents(fixture.inspection);
    expect(fixture.evaluate().blockers).toContain("hard-policy-violations");
  });
  test.each([
    "candidate-rejected",
    "policy-blocked",
    "provider-error",
    "timeout",
    "collector-crashed",
    "infrastructure-error",
  ] as const)("%s cannot claim a known successful outcome", (status) => {
    const fixture = makeFixture(1);
    fixture.inspection.assignments[1].receipt!.status = status;
    chain(fixture.inspection);
    expect(() => fixture.evaluate()).toThrow(/noncompleted attempt/);
  });
  test.each(["local", "laya"] as const)(
    "remote %s provider cannot claim local zero-charge evidence",
    (kind) => {
      const fixture = makeFixture(1),
        { inspection, pins } = fixture;
      const config = inspection.plan.configurations.baseline;
      config.providers[0].kind = kind;
      repinConfiguration(fixture);
      const item = inspection.assignments[0];
      item.calls[0].receipt!.usage.basis = "local-no-api-charge";
      item.calls[0].receipt!.usage.costUsd = 0;
      item.calls[0].receipt!.usage.reportedCostUsd = null;
      refresh(item);
      chain(inspection);
      expect(() => validateFullCohortLedger(inspection, pins)).toThrow(
        /hosted provider claims local/,
      );
      config.providers[0].endpointOrigin = "http://127.0.0.1:9000";
      repinConfiguration(fixture);
      expect(() => validateFullCohortLedger(inspection, pins)).not.toThrow();
    },
  );
  test.each(["expected-label", "task-identity"])(
    "a shared case cannot change %s across routes",
    (mode) => {
      const fixture = makeFixture(2),
        { inspection } = fixture;
      const original = inspection.assignments[1].receipt!.observations[0];
      const item = inspection.assignments[mode === "task-identity" ? 3 : 1];
      const config = inspection.plan.configurations.candidate;
      config.providers.push({
        ...structuredClone(config.providers[0]),
        providerId: "laya-worker",
        kind: "laya",
      });
      const call = additionalCall(item);
      call.reservation.providerId = "laya-worker";
      call.receipt!.reservationSha256 = hashJson(call.reservation);
      item.receipt!.observations.push({
        ...structuredClone(original),
        recordId: "comparison-observation",
        providerId: "laya-worker",
        callId: call.reservation.callId,
      });
      refresh(item);
      repinConfiguration(fixture);
      const labels = fixture.labels();
      if (mode === "expected-label")
        labels.find(
          (label) => label.recordId === "comparison-observation",
        )!.expected = "frontier";
      expect(() =>
        evaluateFullCohort({
          inspection,
          pins: fixture.pins,
          calibration: fixture.data,
          thresholds: fixture.thresholds,
          labels,
        }),
      ).toThrow(
        /inconsistent expected labels|inconsistent held-out task identity/,
      );
      if (mode === "expected-label") {
        labels.find(
          (label) => label.recordId === "comparison-observation",
        )!.expected = "local";
        expect(() =>
          evaluateFullCohort({
            inspection,
            pins: fixture.pins,
            calibration: fixture.data,
            thresholds: fixture.thresholds,
            labels,
          }),
        ).not.toThrow();
      }
    },
  );
  test.each([
    "missing-assignment",
    "missing-call-event",
    "duplicate-call",
    "wrong-aggregate",
    "wrong-state",
    "extra-label",
    "missing-label",
  ])("rejects or blocks %s evidence manipulation", (mode) => {
    const fixture = makeFixture(),
      item = fixture.inspection.assignments[1],
      labels = fixture.labels();
    if (mode === "missing-assignment") fixture.inspection.assignments.pop();
    if (mode === "missing-call-event") fixture.inspection.events.splice(2, 1);
    if (mode === "duplicate-call") {
      item.calls[0].reservation.callId =
        fixture.inspection.assignments[0].calls[0].reservation.callId;
      chain(fixture.inspection);
    }
    if (mode === "wrong-aggregate") {
      item.receipt!.usage.costUsd = 0;
      chain(fixture.inspection);
    }
    if (mode === "wrong-state") {
      item.receipt!.observations[0].stateHash = digest("changed-state");
      chain(fixture.inspection);
    }
    if (mode === "extra-label")
      labels.push({ ...labels[0], recordId: "invented-record" });
    if (mode === "missing-label") labels.pop();
    const run = () =>
      evaluateFullCohort({
        inspection: fixture.inspection,
        pins: fixture.pins,
        calibration: fixture.data,
        thresholds: fixture.thresholds,
        labels,
      });
    if (mode === "missing-label")
      expect(run().blockers).toContain("missing-original-observation-labels");
    else expect(run).toThrow();
  });
  test("malformed JSON, duplicate decoded keys, accessors and nonfinite numbers fail before accounting", () => {
    const fixture = makeFixture(1);
    const raw = JSON.stringify(fixture.inspection).replace(
      '"promotionEligible":false',
      '"promotionEligible":false,"promotionEligible":false',
    );
    expect(() => validateFullCohortLedger(raw, fixture.pins)).toThrow(
      /Duplicate/,
    );
    let read = false;
    expect(() =>
      validateFullCohortLedger(
        {
          get plan() {
            read = true;
            return fixture.inspection.plan;
          },
        },
        fixture.pins,
      ),
    ).toThrow(/accessors/);
    expect(read).toBe(false);
    fixture.inspection.assignments[0].calls[0].receipt!.usage.costUsd = NaN;
    expect(() => fixture.evaluate()).toThrow(/finite JSON/);
  });
});

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
test("the real sealed store inspection is accepted without a competing collector contract", async () => {
  const { SealedStore } = await import("../../../evaluation/sealed/store.mjs");
  const { fixture, callInput, settledCall, settledAttempt } =
    await import("../../../evaluation/sealed/tests/helpers.mjs");
  const data = fixture(),
    directory = await mkdtemp(path.join(os.tmpdir(), "graph-full-cohort-"));
  directories.push(directory);
  await chmod(directory, 0o700);
  const store = new SealedStore({ directory });
  try {
    store.registerPlan(data.plan, data.registry, {
      expectedRegistrySha256: hashJson(data.registry),
    });
    for (const assignment of data.plan.assignments) {
      const reservation = store.reserveAttempt(
          data.plan.collectionId,
          assignment.assignmentId,
        ),
        call = store.reserveCall(
          reservation.reservationId,
          callInput(`call-${assignment.arm}`),
        );
      const receipt = store.completeCall(settledCall(call));
      store.completeAttempt(settledAttempt(reservation, [receipt]));
    }
    store.closeCollection(data.plan.collectionId);
    const inspection = store.inspectCollection(data.plan.collectionId);
    expect(
      validateFullCohortLedger(inspection, {
        planSha256: hashJson(data.plan),
        registrySha256: hashJson(data.registry),
        baselineConfigurationSha256: hashJson(
          data.plan.configurations.baseline,
        ),
        candidateConfigurationSha256: hashJson(
          data.plan.configurations.candidate,
        ),
      }).assignments,
    ).toHaveLength(2);
  } finally {
    store.close();
  }
});
