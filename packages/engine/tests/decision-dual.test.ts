import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import {
  consultBothDecisions,
  DualConsultUnavailable,
  type DualConsultOptions,
} from "../src/decision-dual.js";

const localModel = "laya-pinned-test-model";
const hostedModel = "jev-1.13.0";
const binding = {
  taskId: "GRAPH-42",
  sourceSha256: "a".repeat(64),
};
const options = (): DualConsultOptions => ({
  projectId: "dual-test-project",
  ownerId: "handoff-42",
  binding,
  state: { taskBinding: binding, complexity: 2 },
  cloudState: { taskBinding: binding, writePathCount: 2 },
  questions: [
    {
      id: "dispatch",
      category: "worker",
      candidates: {
        proceed: "Proceed with selected scoped task",
        pause: "Pause for more evidence",
      },
      baseline: "pause",
      exportable: true,
    },
  ],
  policy: {
    ...DEFAULT_POLICY,
    inference: "allowlisted",
    network: "allowlisted",
    allowedHosts: ["api.typesafe.ai"],
    providers: ["laya", "jev"],
    maxCostUsd: 1,
    decisionMode: "promoted",
    promotedCategories: ["worker"],
  },
  providers: {
    laya: {
      id: "laya",
      endpoint: "http://127.0.0.1:7337/v1/decide",
      model: localModel,
      maxStateChars: 1200,
    },
    jev: {
      id: "jev",
      endpoint: "https://api.typesafe.ai/v1/systemone",
      model: hostedModel,
      maxStateChars: 1200,
      pricing: {
        unit: "input-token",
        usdPerMillionInputTokens: 0.042,
        maxInputTokens: 64000,
        version: "jev-1.13.0-2026-09-23",
      },
    },
  },
  budget: { reserve: vi.fn(), settle: vi.fn() },
  attempt: { begin: vi.fn(() => null), finish: vi.fn(), fail: vi.fn() },
});
const answer = (model: string, extra: object = {}) =>
  new Response(
    JSON.stringify({
      model,
      answers: {
        dispatch: {
          ...(model === hostedModel ? { type: "choice" } : {}),
          choice: "proceed",
          confidence: 0.9,
          probabilities: { proceed: 0.9, pause: 0.1 },
        },
      },
      ...(model === hostedModel
        ? { usage: { input_tokens: 334, output_tokens: 31 } }
        : {}),
      ...extra,
    }),
  );
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mandatory independent decision consultation", () => {
  it("requires two observed models, two call IDs and typed choices without promotion authority", async () => {
    const fetch = vi.fn(async (url: string) =>
      answer(url.startsWith("http:") ? localModel : hostedModel),
    );
    vi.stubGlobal("fetch", fetch);
    const input = options();
    const evidence = await consultBothDecisions(input);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(evidence.ready).toBe(true);
    expect(evidence.ownerId).toBe("handoff-42");
    expect(evidence.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(input.attempt.finish).toHaveBeenCalledWith(evidence);
    expect(evidence.observations.laya.callId).toBeTruthy();
    expect(evidence.observations.jev.callId).toBeTruthy();
    expect(evidence.observations.laya.callId).not.toBe(
      evidence.observations.jev.callId,
    );
    expect(evidence.observations.laya.observedModel).toBe(localModel);
    expect(evidence.observations.jev.observedModel).toBe(hostedModel);
    expect(evidence.observations.jev.choices).toEqual({ dispatch: "proceed" });
    expect(
      Object.values(evidence.observations)
        .flatMap((item) => item.records)
        .every(
          (record) =>
            record.mode === "shadow" &&
            record.evidence.promotionAuthority === "unverified",
        ),
    ).toBe(true);
    const localBody = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
    const hostedBody = JSON.parse(String(fetch.mock.calls[1]![1]?.body));
    expect(JSON.parse(localBody.state).taskBinding).toEqual(binding);
    expect(JSON.parse(hostedBody.state).taskBinding).toEqual(binding);
    expect(
      fetch.mock.calls.every(([, init]) => init?.signal === undefined),
    ).toBe(true);
  });

  it("waits for both calls and carries partial evidence when one model identity is missing", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.startsWith("http:")
        ? new Response(
            JSON.stringify({
              answers: {
                dispatch: {
                  choice: "proceed",
                  confidence: 0.9,
                  probabilities: { proceed: 0.9, pause: 0.1 },
                },
              },
            }),
          )
        : answer(hostedModel),
    );
    vi.stubGlobal("fetch", fetch);
    const failure = await consultBothDecisions(options()).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DualConsultUnavailable);
    const evidence = (failure as DualConsultUnavailable).evidence;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(evidence.ready).toBe(false);
    expect(evidence.observations.laya.failure).toMatch(/model/);
    expect(evidence.observations.jev.valid).toBe(true);
    expect(evidence.observations.laya.usage?.model).toBe("unreported");
    expect(evidence.observations.laya.callId).toBeTruthy();
    expect(evidence.observations.jev.callId).toBeTruthy();
  });

  it("rejects an invalid choice, missing confidence, and an unavailable provider", async () => {
    for (const local of [
      answer(localModel, {
        answers: { dispatch: { choice: "invented", confidence: 1 } },
      }),
      answer(localModel, { answers: { dispatch: { choice: "proceed" } } }),
      answer(localModel, {
        answers: {
          dispatch: { choice: "proceed", confidence: 0.9 },
          unexpected: { choice: "proceed", confidence: 0.9 },
        },
      }),
      new Response("down", { status: 503 }),
    ]) {
      const fetch = vi.fn(async (url: string) =>
        url.startsWith("http:") ? local.clone() : answer(hostedModel),
      );
      vi.stubGlobal("fetch", fetch);
      const failure = await consultBothDecisions(options()).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(DualConsultUnavailable);
      expect(
        (failure as DualConsultUnavailable).evidence.observations.laya.valid,
      ).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(2);
      vi.unstubAllGlobals();
    }
  });

  it("rejects Jev answers without the documented choice type and probability map", async () => {
    for (const hosted of [
      answer(hostedModel, {
        answers: {
          dispatch: {
            type: "noul",
            choice: "proceed",
            confidence: 0.9,
            probabilities: { proceed: 0.9, pause: 0.1 },
          },
        },
      }),
      answer(hostedModel, {
        answers: {
          dispatch: {
            type: "choice",
            choice: "proceed",
            confidence: 0.9,
          },
        },
      }),
      answer(hostedModel, { usage: { input_tokens: 334 } }),
    ]) {
      const fetch = vi.fn(async (url: string) =>
        url.startsWith("http:") ? answer(localModel) : hosted.clone(),
      );
      vi.stubGlobal("fetch", fetch);
      const failure = await consultBothDecisions(options()).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(DualConsultUnavailable);
      expect(
        (failure as DualConsultUnavailable).evidence.observations.jev.valid,
      ).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(2);
      vi.unstubAllGlobals();
    }
  });

  it("does not echo arbitrary transport errors or malformed model text in evidence", async () => {
    const secret = "Authorization: Bearer SECRET_CANARY_12345678901234567890";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("http:")) throw new Error(secret);
        return answer(secret);
      }),
    );
    const failure = await consultBothDecisions(options()).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DualConsultUnavailable);
    const serialized = JSON.stringify(
      (failure as DualConsultUnavailable).evidence,
    );
    expect(serialized).not.toContain("SECRET_CANARY");
    expect(serialized).toContain("Decision provider failed");
    expect(
      (failure as DualConsultUnavailable).evidence.observations.jev
        .observedModel,
    ).toBe("mismatched");
  });

  it("rejects missing reviewed task binding or question export before any call", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const input = options();
    input.cloudState.taskBinding = { ...binding, sourceSha256: "b".repeat(64) };
    await expect(consultBothDecisions(input)).rejects.toThrow(
      /task\/source binding/,
    );
    input.cloudState.taskBinding = binding;
    input.questions[0]!.exportable = false;
    await expect(consultBothDecisions(input)).rejects.toThrow();
    input.questions[0]!.exportable = true;
    input.providers.jev.endpoint = "https://api.example.test/v1/systemone";
    await expect(consultBothDecisions(input)).rejects.toThrow(
      /direct TypeSafe/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires reviewed Jev token pricing even when the project has no cost ceiling", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const pricing of [
      undefined,
      { unit: "request" as const, usdPerUnit: 0.001, version: "old" },
    ]) {
      const input = options();
      input.policy.maxCostUsd = null;
      input.providers.jev.pricing = pricing;
      await expect(consultBothDecisions(input)).rejects.toThrow(
        /reviewed 1.13 input-token price/,
      );
      expect(input.attempt.begin).not.toHaveBeenCalled();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("closes the hosted state and question vocabulary before any attempt or call", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const withPath = options();
    withPath.cloudState.sourcePath = "src/private.ts";
    await expect(consultBothDecisions(withPath)).rejects.toThrow();
    expect(withPath.attempt.begin).not.toHaveBeenCalled();
    const withText = options();
    withText.questions[0]!.candidates.proceed = "Read src/private.ts";
    await expect(consultBothDecisions(withText)).rejects.toThrow();
    expect(withText.attempt.begin).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("replays retained completed evidence without another provider call", async () => {
    const fetch = vi.fn(async (url: string) =>
      answer(url.startsWith("http:") ? localModel : hostedModel),
    );
    vi.stubGlobal("fetch", fetch);
    const input = options();
    const original = await consultBothDecisions(input);
    input.attempt.begin = vi.fn(() => original);
    expect(await consultBothDecisions(input)).toEqual(original);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(input.attempt.finish).toHaveBeenCalledTimes(1);
  });
});
