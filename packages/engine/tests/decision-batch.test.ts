import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import {
  decideBatch,
  type DecisionBatchOptions,
  type DecisionQuestion,
} from "../src/decision-batch.js";
import type { PromotionEvidence } from "../src/decisions.js";
import { routePlan } from "../src/planning.js";
import { hash } from "../src/util.js";
import * as promotionAuthority from "../src/promotion-authority.js";

const model = "unit-pinned-model";
// Synthetic stand-in configuration tests gates only; this is not saved evidence.
const proof = (category: string, provider = "laya"): PromotionEvidence => ({
  version: "a".repeat(64),
  category,
  provider,
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
  datasetId: "unit-fixture",
});
const questions: DecisionQuestion[] = [
  {
    id: "workflow",
    category: "workflow",
    candidates: { safe: "Baseline", alternative: "Alternative" },
    baseline: "safe",
    exportable: true,
  },
  {
    id: "effort",
    category: "effort",
    candidates: { low: "Small effort", high: "Deep reasoning" },
    baseline: "high",
    exportable: true,
  },
];
const options = (): DecisionBatchOptions => ({
  projectId: "unit-project",
  state: { files: 2 },
  cloudState: { files: 2 },
  questions,
  policy: {
    ...DEFAULT_POLICY,
    inference: "allowlisted",
    network: "allowlisted",
    allowedHosts: ["api.example.test"],
    providers: ["laya", "jev"],
    decisionMode: "promoted",
    promotedCategories: ["workflow", "effort"],
  },
  providers: [
    {
      id: "laya",
      model,
      endpoint: "http://127.0.0.1:7337/v1/decide",
      maxStateChars: 1200,
    },
  ],
  evidence: [proof("workflow"), proof("effort")],
});
const hosted = () => ({
  id: "jev" as const,
  model,
  endpoint: "https://api.example.test/decide",
  maxStateChars: 1200,
  pricing: {
    unit: "question" as const,
    usdPerUnit: 0.002,
    version: "test-reviewed-rate",
  },
});
const response = (answers: object, extra: object = {}) =>
  new Response(JSON.stringify({ model, answers, ...extra }));
// These synthetic routing tests isolate behavior AFTER authority verification.
// Unmocked forgery/JSON-boundary tests live in promotion-authority.test.ts.
beforeEach(() =>
  vi
    .spyOn(promotionAuthority, "authorizesPromotionFromBinding")
    .mockResolvedValue(true),
);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("independent question batching", () => {
  it("retains the dispatch policy and stops promotion/cascading when that policy changes in flight", async () => {
    const input = options();
    const dispatchPolicy = hash(input.policy);
    input.providers.push(hosted());
    const fetch = vi.fn(async () => {
      input.policy.network = "deny";
      return response({
        workflow: { choice: "alternative", confidence: 0.99 },
        effort: { choice: "low", confidence: 0.99 },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const result = await decideBatch(input);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.selections).toEqual({ workflow: "safe", effort: "high" });
    expect(
      result.records.every((record) => record.policyVersion === dispatchPolicy),
    ).toBe(true);
    expect(
      result.records.every((record) =>
        String(record.evidence.failure).includes("policy changed"),
      ),
    ).toBe(true);
    expect(result.usage).toHaveLength(1);
  });
  it("keeps baselines and stops escalation when policy changes while identity resolution awaits", async () => {
    const input = options();
    input.providers.push(hosted());
    let entered!: () => void;
    let release!: () => void;
    const resolving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(
      promotionAuthority.authorizesPromotionFromBinding,
    ).mockImplementation(async () => {
      entered();
      await held;
      return true;
    });
    const fetch = vi.fn(async () =>
      response({
        workflow: { choice: "alternative", confidence: 0.99 },
        effort: { choice: "low", confidence: 0.99 },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const pending = decideBatch(input);
    await resolving;
    input.policy.network = "deny";
    release();
    const result = await pending;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.selections).toEqual({ workflow: "safe", effort: "high" });
    expect(result.records).toHaveLength(2);
    expect(
      result.records.every(
        (record) =>
          record.mode === "shadow" &&
          String(record.evidence.failure).includes("policy changed"),
      ),
    ).toBe(true);
    expect(
      promotionAuthority.authorizesPromotionFromBinding,
    ).toHaveBeenCalledTimes(1);
  });
  it("revokes an earlier promoted question if a later identity check observes policy drift", async () => {
    const input = options();
    let entered!: () => void;
    let release!: () => void;
    const resolving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(promotionAuthority.authorizesPromotionFromBinding)
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => {
        entered();
        await held;
        return true;
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          workflow: { choice: "alternative", confidence: 0.99 },
          effort: { choice: "low", confidence: 0.99 },
        }),
      ),
    );
    const pending = decideBatch(input);
    await resolving;
    input.policy.network = "deny";
    release();
    const result = await pending;
    expect(result.selections).toEqual({ workflow: "safe", effort: "high" });
    expect(result.records.every((record) => record.mode === "shadow")).toBe(
      true,
    );
    expect(
      result.records.every((record) =>
        String(record.evidence.failure).includes("policy changed"),
      ),
    ).toBe(true);
  });
  it("does not dispatch hosted inference if policy changes during the reservation await", async () => {
    const input = options();
    input.providers = [hosted()];
    input.budget = {
      reserve: async () => {
        input.policy.network = "deny";
      },
      settle: vi.fn(),
    };
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = await decideBatch(input);
    expect(fetch).not.toHaveBeenCalled();
    expect(input.budget.settle).not.toHaveBeenCalled();
    expect(result.records[0]?.evidence.failure).toContain("policy changed");
  });
  it("sends two categories in one request with independent promotion gates", async () => {
    const fetch = vi.fn(async () =>
      response({
        workflow: { choice: "alternative", confidence: 0.99 },
        effort: { choice: "low", confidence: 0.6 },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await decideBatch(options());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      Object.keys(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).questions),
    ).toEqual(["workflow", "effort"]);
    expect(result.selections).toEqual({
      workflow: "alternative",
      effort: "high",
    });
    expect(result.records).toHaveLength(2);
    expect(result.usage).toHaveLength(1);
    expect(
      result.records.filter((record) => record.evidence.usage),
    ).toHaveLength(1);
  });
  it("resolves promotion separately for each evidence report with the current policy scope", async () => {
    const input = options();
    const binding = Object.freeze({}) as typeof input.promotionBinding;
    input.promotionBinding = binding;
    vi.mocked(
      promotionAuthority.authorizesPromotionFromBinding,
    ).mockResolvedValue(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          workflow: { choice: "alternative", confidence: 0.99 },
          effort: { choice: "low", confidence: 0.99 },
        }),
      ),
    );
    const result = await decideBatch(input);
    expect(result.selections).toEqual({ workflow: "safe", effort: "high" });
    const checks = vi.mocked(promotionAuthority.authorizesPromotionFromBinding)
      .mock.calls;
    expect(checks).toHaveLength(2);
    expect(checks.map(([, evidence]) => evidence.category)).toEqual([
      "workflow",
      "effort",
    ]);
    expect(checks.every(([received]) => received === binding)).toBe(true);
    expect(
      checks.every(
        ([, , scope]) =>
          scope.projectId === input.projectId &&
          scope.policyVersion === hash(input.policy),
      ),
    ).toBe(true);
  });
  it("escalates only unresolved questions, never all questions once one succeeds", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          workflow: { choice: "alternative", confidence: 0.99 },
          effort: { choice: "low", confidence: 0.5 },
        }),
      )
      .mockResolvedValueOnce(
        response({ effort: { choice: "low", confidence: 0.99 } }),
      );
    vi.stubGlobal("fetch", fetch);
    const input = options();
    const binding = Object.freeze({}) as typeof input.promotionBinding;
    input.promotionBinding = binding;
    input.providers.push(hosted());
    input.evidence!.push(proof("effort", "jev"));
    const result = await decideBatch(input);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      Object.keys(JSON.parse(String(fetch.mock.calls[1]![1]?.body)).questions),
    ).toEqual(["effort"]);
    expect(result.selections).toEqual({
      workflow: "alternative",
      effort: "low",
    });
    const checkedRoutes = vi.mocked(
      promotionAuthority.authorizesPromotionFromBinding,
    ).mock.calls;
    expect(
      checkedRoutes.map(([, evidence]) => [
        evidence.provider,
        evidence.category,
      ]),
    ).toEqual([
      ["laya", "workflow"],
      ["laya", "effort"],
      ["jev", "effort"],
    ]);
    expect(checkedRoutes.every(([received]) => received === binding)).toBe(
      true,
    );
  });
  it("batches planning workflow, budget, and effort instead of Promise.all requests", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return response(
          Object.fromEntries(
            Object.keys(body.questions).map((key) => [
              key,
              {
                choice: Object.keys(body.questions[key].criteria)[0],
                confidence: 0.8,
              },
            ]),
          ),
        );
      });
    vi.stubGlobal("fetch", fetch);
    const input = options();
    await routePlan({
      projectId: input.projectId,
      objective: "Fix a failing test",
      provider: {
        id: "local",
        kind: "local",
        model: "worker",
        efforts: ["low", "high"],
      },
      policy: input.policy,
      providers: input.providers,
      evidence: [],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      Object.keys(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).questions),
    ).toEqual(["workflow", "context-budget", "effort"]);
  });
  it("retains baselines for invalid answers and never exports unapproved state/questions", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        response({ workflow: { choice: "malicious", confidence: 1 } }),
      );
    vi.stubGlobal("fetch", fetch);
    expect((await decideBatch(options())).selections).toEqual({
      workflow: "safe",
      effort: "high",
    });
    fetch.mockClear();
    const input = options();
    input.providers = [hosted()];
    delete input.cloudState;
    expect((await decideBatch(input)).records[0]?.evidence.failure).toContain(
      "exportable",
    );
    expect(fetch).not.toHaveBeenCalled();
    input.cloudState = { files: 2 };
    input.questions = questions.map((question) => ({
      ...question,
      exportable: false,
    }));
    await decideBatch(input);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("detects secrets in nested raw state and candidate text before dispatch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const input = options();
    input.state = {
      nested: {
        signature: 'function login(password = "SECRET_CANARY_1234567890123")',
      },
    };
    const result = await decideBatch(input);
    expect(result.records[0]?.evidence.failure).toContain("potential secret");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("decision accounting reservations", () => {
  const tokenPriced = () => ({
    ...hosted(),
    pricing: {
      unit: "input-token" as const,
      usdPerMillionInputTokens: 0.042,
      maxInputTokens: 64000 as const,
      version: "jev-1.13.0-2026-09-23",
    },
  });
  it("reserves the full reviewed Jev envelope, then debits reported input tokens", async () => {
    const reserve = vi.fn(),
      settle = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          {
            workflow: { choice: "safe", confidence: 0.7 },
            effort: { choice: "high", confidence: 0.7 },
          },
          { usage: { input_tokens: 334, output_tokens: 31 } },
        ),
      ),
    );
    const input = options();
    input.providers = [tokenPriced()];
    input.budget = { reserve, settle };
    const result = await decideBatch(input);
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "jev",
        amountUsd: (64000 * 0.042) / 1_000_000,
      }),
    );
    expect(result.usage[0]).toMatchObject({
      inputTokens: 334,
      outputTokens: 31,
      reservedUsd: (64000 * 0.042) / 1_000_000,
      chargedUsd: (334 * 0.042) / 1_000_000,
      reportedCostUsd: null,
      outcome: "completed",
    });
    expect(settle).toHaveBeenCalledWith(result.usage[0]);
  });
  it("keeps token-priced reservations open when usage is absent or dispatch fails", async () => {
    const reserve = vi.fn(),
      settle = vi.fn();
    const fetch = vi.fn(async () =>
      response({
        workflow: { choice: "safe", confidence: 0.7 },
        effort: { choice: "high", confidence: 0.7 },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const input = options();
    input.providers = [tokenPriced()];
    input.budget = { reserve, settle };
    const noUsage = await decideBatch(input);
    expect(noUsage.usage[0]).toMatchObject({
      reservedUsd: (64000 * 0.042) / 1_000_000,
      chargedUsd: (64000 * 0.042) / 1_000_000,
      costUnknown: true,
      outcome: "failed",
    });
    expect(noUsage.records[0]?.evidence.failure).toContain(
      "reservation retained",
    );
    expect(settle).not.toHaveBeenCalled();
    fetch.mockImplementation(async () => {
      throw new Error("Connection reset");
    });
    const uncertain = await decideBatch(input);
    expect(uncertain.usage[0]?.outcome).toBe("failed");
    expect(settle).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenCalledTimes(2);
  });
  it("debits a separately reported charge above the token reservation even without token usage", async () => {
    const settle = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          {
            workflow: { choice: "safe", confidence: 0.7 },
            effort: { choice: "high", confidence: 0.7 },
          },
          { usage: { cost_usd: 0.1 } },
        ),
      ),
    );
    const input = options();
    input.providers = [tokenPriced()];
    input.budget = { reserve: vi.fn(), settle };
    const result = await decideBatch(input);
    expect(result.usage[0]).toMatchObject({
      inputTokens: null,
      reportedCostUsd: 0.1,
      chargedUsd: 0.1,
      outcome: "failed",
    });
    expect(result.records[0]?.evidence.failure).toMatch(/exceeded/);
    expect(settle).toHaveBeenCalledWith(result.usage[0]);
  });
  it("rejects under-reserved token envelopes and usage above the reviewed maximum", async () => {
    const fetch = vi.fn(async () =>
      response(
        {
          workflow: { choice: "safe", confidence: 0.7 },
          effort: { choice: "high", confidence: 0.7 },
        },
        { usage: { input_tokens: 64001 } },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const input = options();
    input.providers = [
      {
        ...tokenPriced(),
        pricing: { ...tokenPriced().pricing, maxInputTokens: 1000 as 64000 },
      },
    ];
    await expect(decideBatch(input)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    input.providers = [tokenPriced()];
    input.budget = { reserve: vi.fn(), settle: vi.fn() };
    const result = await decideBatch(input);
    expect(result.records[0]?.evidence.failure).toMatch(/exceeded/);
    expect(result.usage[0]!.chargedUsd).toBeGreaterThan(
      result.usage[0]!.reservedUsd!,
    );
  });
  it("reserves a reviewed per-question price once before fetching and records missing hosted usage as unknown tokens", async () => {
    const order: string[] = [],
      reserve = vi.fn(async () => {
        order.push("reserve");
      }),
      settle = vi.fn(async () => {
        order.push("settle");
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        order.push("fetch");
        return response({
          workflow: { choice: "safe", confidence: 0.7 },
          effort: { choice: "high", confidence: 0.7 },
        });
      }),
    );
    const input = options();
    input.providers = [hosted()];
    input.policy.maxCostUsd = 0.01;
    input.budget = { reserve, settle };
    const result = await decideBatch(input);
    expect(order).toEqual(["reserve", "fetch", "settle"]);
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({ amountUsd: 0.004 }),
    );
    expect(result.usage[0]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      reportedCostUsd: null,
      estimatedCostUsd: 0.004,
      chargedUsd: 0.004,
      costUnknown: false,
    });
  });
  it("blocks unknown priced capped calls and atomic ledger exhaustion before any spend", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const input = options();
    input.providers = [{ ...hosted(), pricing: undefined }];
    input.policy.maxCostUsd = 1;
    await decideBatch(input);
    expect(fetch).not.toHaveBeenCalled();
    input.providers = [hosted()];
    input.budget = {
      reserve: vi.fn(async () => {
        throw new Error("Budget exhausted");
      }),
      settle: vi.fn(),
    };
    await decideBatch(input);
    expect(fetch).not.toHaveBeenCalled();
    expect(input.budget.settle).not.toHaveBeenCalled();
  });
  it("retains a reservation after ambiguous billed failures rather than refunding unconfirmed costs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Connection reset after send");
      }),
    );
    const input = options();
    input.providers = [hosted()];
    input.policy.maxCostUsd = 1;
    input.budget = { reserve: vi.fn(), settle: vi.fn() };
    const result = await decideBatch(input);
    expect(result.usage[0]).toMatchObject({
      outcome: "failed",
      chargedUsd: 0.004,
      reservedUsd: 0.004,
      reportedCostUsd: null,
    });
    expect(input.budget.settle).toHaveBeenCalledTimes(1);
  });
  it("does not make up zero costs or tokens when unrestricted Jev has no pricing/usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          workflow: { choice: "safe", confidence: 0.7 },
          effort: { choice: "high", confidence: 0.7 },
        }),
      ),
    );
    const input = options();
    input.providers = [{ ...hosted(), pricing: undefined }];
    expect((await decideBatch(input)).usage[0]).toMatchObject({
      chargedUsd: null,
      estimatedCostUsd: null,
      inputTokens: null,
      costUnknown: true,
    });
  });
  it("withholds a decision and prevents further cascading when accounting cannot be recorded", async () => {
    const fetch = vi.fn(async () =>
      response({
        workflow: { choice: "alternative", confidence: 0.99 },
        effort: { choice: "low", confidence: 0.99 },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const input = options();
    input.providers = [hosted(), ...input.providers];
    input.evidence!.push(proof("workflow", "jev"), proof("effort", "jev"));
    input.budget = {
      reserve: vi.fn(),
      settle: vi.fn(async () => {
        throw new Error("Disk unavailable");
      }),
    };
    const result = await decideBatch(input);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.selections).toEqual({ workflow: "safe", effort: "high" });
    expect(result.records[0]?.evidence.failure).toContain("accounting");
  });
  it("detects charges above reservation and never silently accepts the excess", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          {
            workflow: { choice: "alternative", confidence: 0.99 },
            effort: { choice: "low", confidence: 0.99 },
          },
          { usage: { input_tokens: 12, output_tokens: 0, cost_usd: 0.5 } },
        ),
      ),
    );
    const input = options();
    input.providers = [hosted()];
    input.evidence!.push(proof("workflow", "jev"), proof("effort", "jev"));
    input.budget = { reserve: vi.fn(), settle: vi.fn() };
    input.policy.maxCostUsd = 0.01;
    const result = await decideBatch(input);
    expect(result.selections).toEqual({ workflow: "safe", effort: "high" });
    expect(result.usage[0]).toMatchObject({
      chargedUsd: 0.5,
      reportedCostUsd: 0.5,
      reservedUsd: 0.004,
    });
    expect(result.records[0]?.evidence.failure).toContain("exceeded");
  });
});
