import { describe, expect, it } from "vitest";
import {
  assertProjectConfig,
  DEFAULT_POLICY,
} from "@graph-engineering/contracts";
import { hash } from "../src/util.js";
import {
  installedWorkerTimeoutMs,
  workerTimeoutMs,
} from "../src/workers/deadline.js";

describe("verification deadline policy", () => {
  const config = (policy: unknown) => ({
    version: "1.0.0",
    projectId: "verification-deadline-toy",
    name: "Toy verification deadline",
    policy,
    verification: [],
  });

  it("accepts absent null or bounded integer verification deadlines without changing defaults", () => {
    expect(DEFAULT_POLICY).not.toHaveProperty("verificationTimeoutSeconds");
    expect(() => assertProjectConfig(config(DEFAULT_POLICY))).not.toThrow();
    for (const verificationTimeoutSeconds of [null, 1, 600, 86400])
      expect(() =>
        assertProjectConfig(
          config({ ...DEFAULT_POLICY, verificationTimeoutSeconds }),
        ),
      ).not.toThrow();
    for (const verificationTimeoutSeconds of [
      0,
      -1,
      0.5,
      86401,
      "none",
      true,
      false,
      [],
      {},
      Infinity,
      NaN,
    ])
      expect(() =>
        assertProjectConfig(
          config({ ...DEFAULT_POLICY, verificationTimeoutSeconds }),
        ),
      ).toThrow("Invalid project configuration");
  });

  it("binds adding changing and removing the verification deadline through the existing policy hash", () => {
    const variants = [
      DEFAULT_POLICY,
      { ...DEFAULT_POLICY, verificationTimeoutSeconds: null },
      {
        ...DEFAULT_POLICY,
        verificationTimeoutSeconds: DEFAULT_POLICY.timeoutSeconds,
      },
      { ...DEFAULT_POLICY, verificationTimeoutSeconds: 1 },
    ];
    expect(new Set(variants.map(hash)).size).toBe(variants.length);
    const removed = { ...variants[1] };
    delete removed.verificationTimeoutSeconds;
    expect(hash(removed)).toBe(hash(DEFAULT_POLICY));
  });

  it("does not change installed worker or API deadlines when verification alone is completion-driven", () => {
    const policy = {
      ...DEFAULT_POLICY,
      timeoutSeconds: 7,
      verificationTimeoutSeconds: null,
    };
    expect(installedWorkerTimeoutMs(policy)).toBe(7000);
    for (const kind of [
      "claude",
      "codex",
      "cursor",
      "local",
      "openai",
      "anthropic",
    ] as const)
      expect(workerTimeoutMs(policy, kind)).toBe(7000);
    expect(
      installedWorkerTimeoutMs({
        ...policy,
        installedWorkerTimeoutSeconds: 19,
      }),
    ).toBe(19000);
  });
});
