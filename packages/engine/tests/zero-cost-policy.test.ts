import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  assertProjectConfig,
  type ProjectConfig,
} from "@graph-engineering/contracts";

describe("zero-cost policy", () => {
  it("accepts a zero external-API-spend ceiling", () => {
    const config: ProjectConfig = {
      version: "1.0.0",
      projectId: "zero-cost-policy-tests",
      name: "Zero cost",
      policy: structuredClone(DEFAULT_POLICY),
      verification: [],
    };
    config.policy.maxCostUsd = 0;
    expect(() => assertProjectConfig(config)).not.toThrow();
  });

  it("rejects a negative ceiling", () => {
    const config: ProjectConfig = {
      version: "1.0.0",
      projectId: "zero-cost-policy-tests",
      name: "Zero cost",
      policy: structuredClone(DEFAULT_POLICY),
      verification: [],
    };
    config.policy.maxCostUsd = -1;
    expect(() => assertProjectConfig(config)).toThrow();
  });
});
