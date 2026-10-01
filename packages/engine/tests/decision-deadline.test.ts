import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertProjectPolicy,
  DEFAULT_POLICY,
} from "@graph-engineering/contracts";
import {
  decideBatch,
  type DecisionBatchOptions,
  type DecisionBatchResult,
} from "../src/decision-batch.js";
import type { DecisionProvider, PromotionEvidence } from "../src/decisions.js";
import { hash } from "../src/util.js";
import * as promotionAuthority from "../src/promotion-authority.js";
import * as promotionRoute from "../src/promotion-route.js";
import {
  installedWorkerTimeoutMs,
  workerTimeoutMs,
} from "../src/workers/deadline.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const model = "toy-decision-deadline";
const local = (): DecisionProvider => ({
  id: "laya",
  model,
  endpoint: "http://127.0.0.1:7337/v1/decide",
  maxStateChars: 1200,
});
const hosted = (): DecisionProvider => ({
  id: "jev",
  model,
  endpoint: "https://api.example.test/decide",
  maxStateChars: 1200,
  pricing: {
    unit: "input-token",
    usdPerMillionInputTokens: 0.042,
    inputTokenReserve: 65_536,
    version: "toy-reviewed-price",
  },
});
const reservation = (0.042 * 65_536) / 1_000_000;
function options(deadline?: number | null): DecisionBatchOptions {
  return {
    projectId: "toy-deadline-project",
    state: { files: 2 },
    cloudState: { files: 2 },
    questions: [
      {
        id: "workflow",
        category: "workflow",
        candidates: { safe: "Baseline", alternative: "Alternative" },
        baseline: "safe",
        exportable: true,
      },
    ],
    policy: {
      ...DEFAULT_POLICY,
      inference: "allowlisted",
      network: "allowlisted",
      allowedHosts: ["api.example.test"],
      providers: ["laya", "jev"],
      maxCostUsd: 0.01,
      ...(deadline === undefined ? {} : { decisionTimeoutSeconds: deadline }),
    },
    providers: [local()],
  };
}
const responseText = () =>
  JSON.stringify({
    model,
    answers: { workflow: { choice: "alternative", confidence: 0.99 } },
    usage: { input_tokens: 128, output_tokens: 4 },
  });
const response = () => new Response(responseText());
function paidOptions() {
  const input = options(null);
  input.providers = [hosted(), local()];
  const reserve = vi.fn(async () => {});
  const settle = vi.fn(async () => {});
  input.budget = { reserve, settle };
  return { input, reserve, settle };
}
function expectBaseline(result: DecisionBatchResult) {
  expect(result.selections).toEqual({ workflow: "safe" });
  expect(result.records.every((record) => record.selected === null)).toBe(true);
  expect(result.records.every((record) => record.mode === "shadow")).toBe(true);
}
function timeoutFactory() {
  // Native AbortSignal.timeout uses real time. Seal it to this test's fake
  // clock rather than waiting for or altering any production timeout.
  return vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("Toy deadline", "TimeoutError")),
      milliseconds,
    );
    return controller.signal;
  });
}
function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });
}

describe("decision HTTP deadline policy", () => {
  it("rejects invalid direct batch policy overrides before reservation or HTTP dispatch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const deadline of [
      0,
      -1,
      0.5,
      86401,
      "1",
      false,
      [],
      {},
      NaN,
      Infinity,
    ]) {
      const { input, reserve, settle } = paidOptions();
      Object.assign(input.policy, { decisionTimeoutSeconds: deadline });
      await expect(decideBatch(input)).rejects.toThrow(/policy/i);
      expect(reserve).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps default policy bytes and binds explicit decision deadlines without changing worker settings", () => {
    expect(DEFAULT_POLICY).not.toHaveProperty("decisionTimeoutSeconds");
    for (const deadline of [undefined, null, 1, 86400]) {
      const policy = options(deadline).policy;
      const before = structuredClone(policy);
      expect(() => assertProjectPolicy(policy)).not.toThrow();
      expect(policy).toEqual(before);
      expect(Object.hasOwn(policy, "decisionTimeoutSeconds")).toBe(
        deadline !== undefined,
      );
    }
    const variants = [
      DEFAULT_POLICY,
      { ...DEFAULT_POLICY, decisionTimeoutSeconds: null },
      { ...DEFAULT_POLICY, decisionTimeoutSeconds: 10 },
      { ...DEFAULT_POLICY, decisionTimeoutSeconds: 1 },
    ];
    expect(new Set(variants.map(hash)).size).toBe(variants.length);
    const removed = { ...variants[1] };
    delete removed.decisionTimeoutSeconds;
    expect(hash(removed)).toBe(hash(DEFAULT_POLICY));
    const policy = {
      ...DEFAULT_POLICY,
      timeoutSeconds: 7,
      installedWorkerTimeoutSeconds: 19,
      verificationTimeoutSeconds: 23,
      decisionTimeoutSeconds: null,
    };
    expect(installedWorkerTimeoutMs(policy)).toBe(19000);
    expect(workerTimeoutMs(policy, "claude")).toBe(19000);
    expect(workerTimeoutMs(policy, "openai")).toBe(7000);
    expect(policy.verificationTimeoutSeconds).toBe(23);
  });

  it.each([
    { deadline: undefined, milliseconds: 10_000 },
    { deadline: 4, milliseconds: 4000 },
  ])(
    "uses $milliseconds ms for decision requests independently of other deadlines",
    async ({ deadline, milliseconds }) => {
      vi.useFakeTimers();
      const timeout = timeoutFactory();
      const input = options(deadline);
      input.policy.timeoutSeconds = 1;
      input.policy.installedWorkerTimeoutSeconds = null;
      input.policy.verificationTimeoutSeconds = 27;
      const before = structuredClone(input.policy);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url, init) => waitForAbort(init.signal)),
      );
      let finished = false;
      const pending = decideBatch(input).then((result) => {
        finished = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(milliseconds - 1);
      expect(finished).toBe(false);
      expect(timeout).toHaveBeenCalledExactlyOnceWith(milliseconds);
      await vi.advanceTimersByTimeAsync(1);
      expectBaseline(await pending);
      expect(input.policy).toEqual(before);
    },
  );

  it("null waits past the old deadline for both headers and terminal body without granting promotion", async () => {
    vi.useFakeTimers();
    const timeout = timeoutFactory();
    const input = options(null);
    input.policy.timeoutSeconds = 1;
    const fetch = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => {
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                setTimeout(() => {
                  controller.enqueue(new TextEncoder().encode(responseText()));
                  controller.close();
                }, 20_000);
              },
            });
            resolve(new Response(body));
          }, 20_000);
        }),
    );
    vi.stubGlobal("fetch", fetch);
    let finished = false;
    const pending = decideBatch(input).then((result) => {
      finished = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;
    expect(timeout).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.records[0]).toMatchObject({
      selected: "alternative",
      mode: "shadow",
      evidence: { promotionAuthority: "unverified" },
    });
    expect(result.selections).toEqual({ workflow: "safe" });
  });

  it("a finite HTTP deadline interrupts a stalled body and retains its unknown billed reservation", async () => {
    vi.useFakeTimers();
    const timeout = timeoutFactory();
    const { input, reserve, settle } = paidOptions();
    input.providers = [hosted()];
    input.policy.decisionTimeoutSeconds = 2;
    const caller = new AbortController();
    input.signal = caller.signal;
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cleanup = vi.fn(() => new Promise<void>(() => {}));
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            { pull: entered, cancel: cleanup },
            { highWaterMark: 0 },
          ),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    let finished = false;
    const pending = decideBatch(input).then((result) => {
      finished = true;
      return result;
    });
    await reading;
    await vi.advanceTimersByTimeAsync(1999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(timeout).toHaveBeenCalledExactlyOnceWith(2000);
    expect(caller.signal.aborted).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
    expectBaseline(result);
    expect(result.usage[0]).toMatchObject({
      outcome: "failed",
      chargedUsd: reservation,
      reservedUsd: reservation,
      costUnknown: true,
      inputTokens: null,
    });
  });

  it("a successful HTTP response stays usable when settlement outlasts its HTTP deadline", async () => {
    vi.useFakeTimers();
    const timeout = timeoutFactory();
    const { input, reserve, settle } = paidOptions();
    input.providers = [hosted()];
    input.policy.decisionTimeoutSeconds = 1;
    const caller = new AbortController();
    input.signal = caller.signal;
    let entered!: () => void;
    const settling = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const holdSettlement = new Promise<void>((resolve) => {
      release = resolve;
    });
    settle.mockImplementation(async () => {
      entered();
      await holdSettlement;
    });
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url, init) => {
      requestSignal = init.signal;
      return response();
    });
    vi.stubGlobal("fetch", fetch);
    let finished = false;
    const pending = decideBatch(input).then((result) => {
      finished = true;
      return result;
    });
    await settling;
    await vi.advanceTimersByTimeAsync(1500);
    expect(finished).toBe(false);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(1000);
    expect(requestSignal?.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    release();
    const result = await pending;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(result.records[0]).toMatchObject({
      selected: "alternative",
      mode: "shadow",
    });
    expect(result.records[0]?.evidence.failure).toBeUndefined();
    expect(result.usage[0]).toMatchObject({
      outcome: "completed",
      inputTokens: 128,
      chargedUsd: (0.042 * 128) / 1_000_000,
      reservedUsd: reservation,
      costUnknown: false,
    });
  });

  it.each(["before call", "during reservation"] as const)(
    "a null deadline preserves cancellation %s without dispatch or cascading",
    async (when) => {
      const { input, reserve, settle } = paidOptions();
      const controller = new AbortController();
      input.signal = controller.signal;
      if (when === "before call") controller.abort();
      else reserve.mockImplementation(async () => controller.abort());
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const result = await decideBatch(input);
      expect(fetch).not.toHaveBeenCalled();
      expect(reserve).toHaveBeenCalledTimes(when === "before call" ? 0 : 1);
      expect(settle).not.toHaveBeenCalled();
      expect(result.usage).toEqual([]);
      expectBaseline(result);
    },
  );

  it.each(["headers", "body", "late response"] as const)(
    "explicit abort during %s rejects answers and preserves unknown billed reservations",
    async (when) => {
      const { input, reserve, settle } = paidOptions();
      const controller = new AbortController();
      input.signal = controller.signal;
      let entered!: () => void;
      const awaitingResponse = new Promise<void>((resolve) => {
        entered = resolve;
      });
      // Source cleanup deliberately never settles. Explicit abort must not
      // wait for that best-effort cleanup before returning the baseline.
      const cancelledBody = vi.fn(() => new Promise<void>(() => {}));
      const fetch = vi.fn(async (_url, init) => {
        if (when === "late response") {
          controller.abort();
          // A transport mock ignores cancellation and still returns success.
          return response();
        }
        if (when === "headers") {
          entered();
          return waitForAbort(init.signal);
        }
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull() {
                entered();
                // No terminal body; only explicit cancellation releases it.
              },
              cancel: cancelledBody,
            },
            // Do not signal test readiness until the engine actually reads.
            { highWaterMark: 0 },
          ),
        );
      });
      vi.stubGlobal("fetch", fetch);
      const pending = decideBatch(input);
      if (when !== "late response") {
        await awaitingResponse;
        controller.abort();
      }
      const result = await pending;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(settle).toHaveBeenCalledTimes(1);
      expectBaseline(result);
      expect(result.usage).toHaveLength(1);
      expect(result.usage[0]).toMatchObject({
        outcome: "failed",
        chargedUsd: reservation,
        reservedUsd: reservation,
        costUnknown: true,
        inputTokens: null,
        reportedCostUsd: null,
      });
      if (when === "body") expect(cancelledBody).toHaveBeenCalledTimes(1);
    },
  );

  it("an abort during settlement withholds parsed answers and stops the next provider", async () => {
    const { input, reserve, settle } = paidOptions();
    const controller = new AbortController();
    input.signal = controller.signal;
    settle.mockImplementation(async () => controller.abort());
    const fetch = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetch);
    const result = await decideBatch(input);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
    expectBaseline(result);
    expect(result.usage[0]).toMatchObject({
      inputTokens: 128,
      chargedUsd: (0.042 * 128) / 1_000_000,
      reservedUsd: reservation,
      costUnknown: false,
    });
  });

  it("late cancellation during synthetic promotion authority revokes earlier answers and stops cascading", async () => {
    const input = options(null);
    const controller = new AbortController();
    input.signal = controller.signal;
    input.providers.push(hosted());
    input.policy.decisionMode = "promoted";
    input.policy.promotedCategories = ["workflow", "effort"];
    input.questions.push({
      id: "effort",
      category: "effort",
      candidates: { low: "Small effort", high: "Baseline effort" },
      baseline: "high",
      exportable: true,
    });
    // Synthetic stand-ins isolate rollback AFTER the two authority gates.
    // Nothing is persisted, signed, or claimed as actual promotion evidence.
    input.evidence = ["workflow", "effort"].map(
      (category): PromotionEvidence => ({
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
        datasetId: "synthetic-deadline-unit-fixture",
      }),
    );
    vi.spyOn(promotionRoute, "checkPromotionRoute").mockImplementation(
      (phase) => ({
        phase,
        admitted: true,
        refusal: null,
        routeSha256: "0".repeat(64),
      }),
    );
    const authority = vi
      .spyOn(promotionAuthority, "authorizesPromotionFromBinding")
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => {
        controller.abort();
        return true;
      });
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model,
            answers: {
              workflow: { choice: "alternative", confidence: 0.99 },
              effort: { choice: "low", confidence: 0.99 },
            },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await decideBatch(input);
    expect(authority).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.selections).toEqual({ workflow: "safe", effort: "high" });
    expect(result.records).toHaveLength(2);
    for (const record of result.records)
      expect(record).toMatchObject({
        selected: null,
        mode: "shadow",
        evidence: { promotionAuthority: "unverified" },
      });
  });

  it("null does not remove request or response byte limits", async () => {
    const input = options(null);
    input.providers[0]!.maxStateChars = 100_000;
    input.state = { description: "x".repeat(66_000) };
    const fetch = vi.fn(async () => new Response(new Uint8Array(1_000_001)));
    vi.stubGlobal("fetch", fetch);
    const oversizedRequest = await decideBatch(input);
    expect(fetch).not.toHaveBeenCalled();
    expect(oversizedRequest.records[0]?.evidence.failure).toContain(
      "byte limit",
    );
    expectBaseline(oversizedRequest);
    input.state = { files: 2 };
    const oversizedResponse = await decideBatch(input);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(oversizedResponse.records[0]?.evidence.failure).toContain(
      "size limit",
    );
    expectBaseline(oversizedResponse);
  });

  it("null retains both the configured cost ceiling and atomic budget exhaustion", async () => {
    const { input, reserve, settle } = paidOptions();
    input.providers = [hosted()];
    input.policy.maxCostUsd = 0;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const capped = await decideBatch(input);
    expect(capped.records[0]?.evidence.failure).toContain("cost ceiling");
    expect(reserve).not.toHaveBeenCalled();
    input.policy.maxCostUsd = 0.01;
    reserve.mockImplementation(async () => {
      throw new Error("Toy budget exhausted");
    });
    const exhausted = await decideBatch(input);
    expect(exhausted.records[0]?.evidence.failure).toContain(
      "budget exhausted",
    );
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expectBaseline(capped);
    expectBaseline(exhausted);
  });

  it.each(["reservation", "settlement"] as const)(
    "changing the decision timeout during %s keeps the frozen policy and stops dispatch or cascading",
    async (when) => {
      const { input, reserve, settle } = paidOptions();
      const policyVersion = hash(input.policy);
      const change = async () => {
        input.policy.decisionTimeoutSeconds = 5;
      };
      if (when === "reservation") reserve.mockImplementation(change);
      else settle.mockImplementation(change);
      const fetch = vi.fn(async () => response());
      vi.stubGlobal("fetch", fetch);
      const result = await decideBatch(input);
      expect(fetch).toHaveBeenCalledTimes(when === "reservation" ? 0 : 1);
      expect(result.records[0]?.policyVersion).toBe(policyVersion);
      expect(result.records[0]?.evidence.failure).toContain("policy changed");
      expectBaseline(result);
    },
  );
});
