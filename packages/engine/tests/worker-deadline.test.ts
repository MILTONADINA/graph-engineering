import { describe, expect, it } from "vitest";
import {
  assertProjectConfig,
  DEFAULT_POLICY,
  type ProjectPolicy,
  type ProviderKind,
} from "@graph-engineering/contracts";
import { hash } from "../src/util.js";
import {
  installedWorkerTimeoutMs,
  workerTimeoutMs,
} from "../src/workers/deadline.js";

describe("installed worker deadline policy", () => {
  const config = (policy: unknown) => ({
    version: "1.0.0",
    projectId: "deadline-fixture",
    name: "Deadline fixture",
    policy,
    verification: [],
  });

  it("accepts only explicit null or bounded integer overrides without changing defaults", () => {
    expect(DEFAULT_POLICY).not.toHaveProperty("installedWorkerTimeoutSeconds");
    expect(() => assertProjectConfig(config(DEFAULT_POLICY))).not.toThrow();
    for (const value of [null, 1, 600, 86400])
      expect(() =>
        assertProjectConfig(
          config({ ...DEFAULT_POLICY, installedWorkerTimeoutSeconds: value }),
        ),
      ).not.toThrow();
    for (const value of [0, -1, 0.5, 86401, "none", true])
      expect(() =>
        assertProjectConfig(
          config({ ...DEFAULT_POLICY, installedWorkerTimeoutSeconds: value }),
        ),
      ).toThrow("Invalid project configuration");
  });

  it("inherits the ordinary deadline only when the override is absent", () => {
    const policy = { ...DEFAULT_POLICY, timeoutSeconds: 5 };
    expect(installedWorkerTimeoutMs(policy)).toBe(5000);
    expect(
      installedWorkerTimeoutMs({
        ...policy,
        installedWorkerTimeoutSeconds: null,
      }),
    ).toBeNull();
    expect(
      installedWorkerTimeoutMs({
        ...policy,
        installedWorkerTimeoutSeconds: 20,
      }),
    ).toBe(20000);
    expect(policy).not.toHaveProperty("installedWorkerTimeoutSeconds");
  });

  it("limits completion-driven mode to installed coding worker kinds", () => {
    const policy: ProjectPolicy = {
      ...DEFAULT_POLICY,
      installedWorkerTimeoutSeconds: null,
    };
    for (const kind of ["claude", "codex", "cursor"] as const)
      expect(workerTimeoutMs(policy, kind)).toBeNull();
    for (const kind of ["local", "openai", "anthropic", undefined] as (
      ProviderKind | undefined
    )[])
      expect(workerTimeoutMs(policy, kind)).toBe(
        DEFAULT_POLICY.timeoutSeconds * 1000,
      );
  });

  it("binds explicit deadline changes into the policy hash", () => {
    const policies = [
      DEFAULT_POLICY,
      { ...DEFAULT_POLICY, installedWorkerTimeoutSeconds: null },
      {
        ...DEFAULT_POLICY,
        installedWorkerTimeoutSeconds: DEFAULT_POLICY.timeoutSeconds,
      },
      { ...DEFAULT_POLICY, installedWorkerTimeoutSeconds: 1 },
    ];
    expect(new Set(policies.map(hash)).size).toBe(policies.length);
  });
});
