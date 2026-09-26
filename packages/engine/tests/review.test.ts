import { describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import {
  invokeReviewWorker,
  REVIEW_INSTRUCTIONS,
  reviewOutcome,
  type WorkerReview,
} from "../src/workers/review.js";

const approve: WorkerReview = {
  verdict: "approve",
  summary: "Looks right",
  criteria: [{ criterion: "sum works", met: "yes", evidence: "a + b" }],
  findings: [{ severity: "advisory", path: null, line: null, message: "nit" }],
};

describe("review outcome", () => {
  it("passes only a clean approval", () => {
    expect(reviewOutcome(approve, ["sum works"])).toEqual({
      passed: true,
      feedback: "",
    });
    for (const review of [
      { ...approve, verdict: "request-changes" as const },
      {
        ...approve,
        criteria: [
          { criterion: "sum works", met: "unknown" as const, evidence: "" },
        ],
      },
      {
        ...approve,
        findings: [
          {
            severity: "blocking" as const,
            path: "a.ts",
            line: 3,
            message: "breaks",
          },
        ],
      },
    ])
      expect(reviewOutcome(review, ["sum works"]).passed).toBe(false);
    expect(
      reviewOutcome(
        {
          ...approve,
          criteria: [{ criterion: "sum works", met: "no", evidence: "a - b" }],
        },
        ["sum works"],
      ).feedback,
    ).toContain("Acceptance criterion not met: sum works (a - b)");
    // An approval that skips a criterion, or answers none, is not a pass.
    const empty = reviewOutcome({ ...approve, criteria: [] }, ["sum works"]);
    expect(empty.passed).toBe(false);
    expect(empty.feedback).toContain(
      "The review answered 0 of 1 acceptance criteria",
    );
    expect(reviewOutcome(approve, ["sum works", "tests added"]).passed).toBe(
      false,
    );
  });
});

describe("review worker", () => {
  const local = { id: "reviewer", kind: "local" as const, model: "m" };
  const input = (overrides = {}) => ({
    provider: local,
    policy: { ...DEFAULT_POLICY, providers: ["reviewer"] },
    objective: "Fix the sum",
    acceptance: ["sum works"],
    diff: "-a - b\n+a + b",
    checks: "test: exit 0",
    ...overrides,
  });

  it("asks for a structured review and parses it", async () => {
    let sent: Record<string, any> = {};
    const fetch = vi.fn(async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          model: "reviewer-model",
          choices: [{ message: { content: JSON.stringify(approve) } }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        }),
      );
    });
    const result = await invokeReviewWorker(input(), fetch);
    expect(result.review).toEqual(approve);
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 3 });
    expect(sent.messages[0].content).toBe(REVIEW_INSTRUCTIONS);
    expect(sent.response_format.json_schema.name).toBe("code_review");
    expect(JSON.parse(sent.messages[1].content)).toMatchObject({
      diff: "-a - b\n+a + b",
      checks: "test: exit 0",
    });
  });

  it("refuses secrets for cloud reviewers, oversized changes and installed agents", async () => {
    const fetch = vi.fn();
    const cloudPolicy = {
      ...DEFAULT_POLICY,
      providers: ["cloud"],
      inference: "allowlisted" as const,
      network: "allowlisted" as const,
      allowedHosts: ["api.openai.com"],
    };
    await expect(
      invokeReviewWorker(
        input({
          provider: { id: "cloud", kind: "openai", model: "m" },
          policy: cloudPolicy,
          diff: `+const serviceToken = "${"Zq7Lm2Xp" + "9Rt4Vb8Nc3Kd"}";`,
        }),
        fetch,
      ),
    ).rejects.toThrow("a cloud reviewer cannot receive it");
    await expect(
      invokeReviewWorker(input({ diff: "+x\n".repeat(20_000) }), fetch),
    ).rejects.toThrow("too large for the reviewer's context budget");
    await expect(
      invokeReviewWorker(
        input({
          provider: { id: "reviewer", kind: "claude", model: "m" },
        }),
        fetch,
      ),
    ).rejects.toThrow("installed agents cannot review yet");
    expect(fetch).not.toHaveBeenCalled();
  });
});
