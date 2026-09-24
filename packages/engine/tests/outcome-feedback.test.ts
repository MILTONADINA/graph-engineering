import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunRecord } from "@graph-engineering/contracts";
import type { DualConsultEvidence } from "../src/decision-dual.js";
import { outcomeFeedbackSchema, summarizeOutcomes } from "../src/outcome-feedback.js";
import { RunStore } from "../src/store.js";

it("retains one exact reviewed outcome and reports observations without promotion", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "graph-outcome-"));
  const store = new RunStore(directory, "project-a");
  try {
    const binding = { taskId: "GRAPH-42", sourceSha256: "a".repeat(64) };
    const meta = { projectId: "project-a", ownerId: "GRAPH-42/handoff/1", binding,
      policyVersion: "p".repeat(64), requestHash: "q".repeat(64) };
    expect(store.beginDualConsultAttempt(meta)).toBeNull();
    const observation = (provider: "laya" | "jev") => {
      const callId = `${provider}-call`;
      const usage = { callId, provider, model: `${provider}-v1`, questionCount: 1,
        inputTokens: 10, outputTokens: 2, reportedCostUsd: provider === "jev" ? 0.1 : 0,
        estimatedCostUsd: provider === "jev" ? 0.1 : 0,
        chargedUsd: provider === "jev" ? 0.1 : 0, reservedUsd: provider === "jev" ? 0.1 : 0,
        priceVersion: "price-v1", costUnknown: false, outcome: "completed" as const };
      store.reserveCall(meta.ownerId, callId, provider, usage.reservedUsd, null);
      store.settleCall(meta.ownerId, callId, provider, { inputTokens: 10, outputTokens: 2,
        cachedTokens: 0, costUsd: usage.chargedUsd, estimated: false });
      return { provider, requestEndpoint: provider === "laya" ? "http://127.0.0.1:7337/v1/decide" :
        "https://api.typesafe.ai/v1/systemone", configuredModel: `${provider}-v1`,
        observedModel: `${provider}-v1`, callId, choices: { dispatch: "proceed" },
        records: [{ version: "1.0.0" as const, id: `${provider}-decision`, projectId: "project-a",
          category: "worker", candidates: ["proceed", "pause"], selected: "proceed", baseline: "pause",
          provider, modelVersion: `${provider}-v1`, policyVersion: meta.policyVersion, confidence: 0.9,
          mode: "shadow" as const, createdAt: "2026-09-23T00:00:00.000Z",
          evidence: { callId, questionId: "dispatch", stateHash: "state" } }],
        usage, valid: true, failure: null };
    };
    const dual: DualConsultEvidence = { version: "1.0.0", projectId: "project-a", ownerId: meta.ownerId,
      binding, policyVersion: meta.policyVersion, requestHash: meta.requestHash, ready: true,
      observations: { laya: observation("laya"), jev: observation("jev") } };
    store.finishDualConsultAttempt(dual);
    const run = { id: "run-42", status: "succeeded", completion: { automatedChecksPassed: true,
      humanAcceptance: "pending", reviewScope: "normal" } } as RunRecord;
    store.saveRun(run);
    const bytes = Buffer.from(JSON.stringify(dual));
    const feedback = { schema_version: 1, task: binding.taskId, task_kind: "engineering",
      context: { write_path_count: 1, acceptance_count: 1, source_dirty: false,
        text_only_coverage: false },
      handoff: "handoff", dispatch_id: meta.ownerId,
      source_before_sha256: binding.sourceSha256, candidate_sha256: "b".repeat(64),
      run_id: run.id, scope_id: "scope-42", scope_request_sha256: "c".repeat(64),
      completion_proof_sha256: "d".repeat(64), dual_consultation_sha256:
        createHash("sha256").update(bytes).digest("hex"),
      outcome: { kind: "BRIGHTPATH_COMPLETION_REVIEW", state: "CURRENT_ENGINEERING_COMPLETION",
        request_sha256: "e".repeat(64), review_sha256: "f".repeat(64),
        current_source_sha256: "1".repeat(64) },
      decision_ids: ["laya-decision", "jev-decision"],
      decision_usage: { laya: dual.observations.laya.usage, jev: dual.observations.jev.usage },
      memory_accepted: false, routing_promoted: false };
    const first = store.recordOutcomeFeedback(feedback, bytes);
    expect(store.recordOutcomeFeedback(feedback, bytes).id).toBe(first.id);
    expect(() => store.recordOutcomeFeedback({ ...feedback, candidate_sha256: "2".repeat(64) }, bytes))
      .toThrow("different reviewed outcome");
    expect(() => store.recordOutcomeFeedback({ ...feedback, dual_consultation_sha256: "3".repeat(64) }, bytes))
      .toThrow("bytes changed");
    expect(store.outcomeSummary()).toMatchObject({ reviewedTasks: 1, promotionEligible: false,
      completionAuthority: false, groups: [
        { provider: "jev", reviewed: 1, completed: 1 },
        { provider: "laya", reviewed: 1, completed: 1 },
      ] });
    const rejected = outcomeFeedbackSchema.parse({ ...feedback, outcome: { ...feedback.outcome,
      state: "REVIEW_REJECTED" } });
    expect(summarizeOutcomes([rejected], [dual]).groups[0]?.rejected).toBe(1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
