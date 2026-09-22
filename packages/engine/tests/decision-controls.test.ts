import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import {
  selectContext,
  routeScopes,
  controlRecovery,
  controlCompletion,
  controlMemoryWrite,
  type DecisionSession,
} from "../src/decision-controls.js";
import type { PromotionEvidence } from "../src/decisions.js";

const model = "test-checkpoint";
function session(categories: string[] = []): DecisionSession {
  const evidence: PromotionEvidence[] = categories.map((category) => ({
    version: "a".repeat(64),
    category,
    provider: "laya",
    model,
    calibrationCount: 60,
    heldOutCount: 240,
    taskCount: 60,
    policyViolations: 0,
    additionalFailures: 0,
    baselineCost: 60,
    candidateCost: 30,
    calibrationError: 0.01,
    minimumConfidence: 0.95,
    dataOrigin: "recorded",
    provenanceComplete: true,
    datasetId: "unit-logic-fixture-not-real-evidence",
  }));
  return {
    projectId: "test",
    state: { localized: true },
    policy: {
      ...DEFAULT_POLICY,
      providers: ["laya"],
      decisionMode: "promoted",
      promotedCategories: categories,
    },
    providers: [
      {
        id: "laya",
        endpoint: "http://127.0.0.1:7337/v1/decide",
        model,
        maxStateChars: 1200,
      },
    ],
    evidence,
  };
}
function answer(choices: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model,
            answers: Object.fromEntries(
              Object.entries(choices).map(([key, choice]) => [
                key,
                { choice, confidence: 0.99 },
              ]),
            ),
          }),
        ),
    ),
  );
}
afterEach(() => vi.unstubAllGlobals());

it("retains mandatory files/memories even if a promoted classifier tries to exclude them", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const questions = JSON.parse(String(init?.body)).questions;
      return new Response(
        JSON.stringify({
          model,
          answers: Object.fromEntries(
            Object.keys(questions).map((key) => [
              key,
              { choice: "exclude", confidence: 0.99 },
            ]),
          ),
        }),
      );
    }),
  );
  const result = await selectContext({
    ...session(["file-selection", "memory-selection"]),
    candidates: [
      {
        id: "required-file",
        kind: "file",
        label: "Required source",
        required: true,
      },
      {
        id: "required-memory",
        kind: "memory",
        label: "Security constraint",
        required: true,
      },
      { id: "optional-file", kind: "file", label: "Unrelated UI code" },
    ],
  });
  expect(result.selectedIds).toEqual(["required-file", "required-memory"]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("cannot lower configured verification/security floors or add unpermitted tools", async () => {
  answer({ tools: "focused", tests: "required", review: "normal" });
  const result = await routeScopes({
    ...session(["tool-scope", "test-scope", "review-scope"]),
    allowedTools: ["search", "tests"],
    focusedTools: ["search"],
    requiredTools: ["tests"],
    requiredChecks: ["unit", "security"],
    focusedChecks: ["unit"],
    availableChecks: ["unit", "security", "integration"],
    securityReviewRequired: true,
    architectureReviewRequired: false,
  });
  expect(result.tools).toEqual(["tests", "search"]);
  expect(result.checks).toEqual(["unit", "security"]);
  expect(result.review).toBe("security");
  await expect(
    routeScopes({
      ...session(),
      allowedTools: ["search"],
      focusedTools: ["shell"],
      requiredChecks: [],
      focusedChecks: [],
      availableChecks: [],
      securityReviewRequired: false,
      architectureReviewRequired: false,
    }),
  ).rejects.toThrow("permitted");
});

it("does not declare success while any deterministic acceptance gate is missing", async () => {
  answer({ completion: "complete" });
  const result = await controlCompletion({
    ...session(["stop"]),
    acceptanceSatisfied: true,
    requiredTestsPassed: false,
    requiredReviewsPassed: true,
    policyValid: true,
  });
  expect(result.action).toBe("continue");
});

it("defaults to full acceptance and does not infer human approval from passing tests", async () => {
  answer({ completion: "complete" });
  const result = await controlCompletion({
    ...session(["stop"]),
    acceptanceSatisfied: false,
    requiredTestsPassed: true,
    requiredReviewsPassed: false,
    policyValid: true,
  });
  expect(result.action).toBe("continue");
  expect(result.records[0]?.candidates).not.toContain("complete");
});

it("can stop an automated run without granting acceptance, review, or merge approval", async () => {
  answer({ completion: "complete" });
  const result = await controlCompletion({
    ...session(["stop"]),
    acceptanceSatisfied: false,
    requiredTestsPassed: true,
    requiredReviewsPassed: false,
    policyValid: true,
    completionScope: "automated-run",
  });
  expect(result.action).toBe("complete");
  const sent = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
  expect(JSON.stringify(sent)).toContain("human acceptance and review remain pending");
  expect(JSON.stringify(sent)).toContain("does not approve human acceptance");
  expect(result).not.toHaveProperty("humanAcceptance");
  expect(result).not.toHaveProperty("mergeApproved");
});

it.each([
  { requiredTestsPassed: false, policyValid: true, expected: "continue" },
  { requiredTestsPassed: true, policyValid: false, expected: "human" },
])("automated completion still enforces tests and policy: %j", async (gates) => {
  answer({ completion: "complete" });
  const result = await controlCompletion({
    ...session(["stop"]),
    acceptanceSatisfied: false,
    requiredReviewsPassed: false,
    completionScope: "automated-run",
    ...gates,
  });
  expect(result.action).toBe(gates.expected);
  expect(result.records[0]?.candidates).not.toContain("complete");
});

it("refuses retries beyond the attempt budget and cannot discard required audit evidence", async () => {
  answer({ recovery: "retry" });
  const recovery = await controlRecovery({
    ...session(["retry-escalation"]),
    attempt: 3,
    maxAttempts: 3,
    needsMoreContext: true,
    alternativeProviderAvailable: true,
    securityConcern: false,
    repeatedFailure: false,
  });
  expect(recovery.action).toBe("human");
  answer({ "memory-write": "discard" });
  expect(
    (
      await controlMemoryWrite({
        ...session(["memory-write"]),
        durable: true,
        requiredAuditRecord: true,
      })
    ).action,
  ).toBe("propose");
});
