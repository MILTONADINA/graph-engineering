import { describe, expect, it } from "vitest";
import {
  assertGeneratorRegistration,
  assertProjectConfig,
  DEFAULT_POLICY,
  sameGeneratorRegistration,
  type GeneratorRegistration,
  type ProjectConfig,
} from "@graph-engineering/contracts";

const image = `sha256:${"a".repeat(64)}`;
const registration = (): GeneratorRegistration => ({
  id: "toy-client",
  revision: "revision-1",
  image,
  argv: ["generate", "--output", "src/generated"],
  outputs: ["src/generated"],
  reads: ["api/**/*.yaml", "!api/private/**"],
});
const project = (): ProjectConfig => ({
  version: "1.0.0",
  projectId: "toyproject",
  name: "Toy project",
  policy: structuredClone(DEFAULT_POLICY),
  verification: [],
  generators: [registration()],
});

describe("generator registration", () => {
  it("requires a digest-pinned image, exact safe output roots, and bounded limits", () => {
    expect(() => assertGeneratorRegistration(registration())).not.toThrow();
    const refused: unknown[] = [
      { ...registration(), image: "node:latest" },
      { ...registration(), argv: [] },
      { ...registration(), outputs: [".graph/project.json"] },
      { ...registration(), outputs: ["src/../private"] },
      { ...registration(), outputs: ["node_modules/client"] },
      { ...registration(), outputs: ["src/.env"] },
      { ...registration(), outputs: ["src/.ssh/id_rsa"] },
      { ...registration(), outputs: [".npmrc"] },
      { ...registration(), outputs: [".netrc"] },
      { ...registration(), outputs: [".pypirc"] },
      { ...registration(), outputs: ["src/**"] },
      { ...registration(), outputs: ["src/generated", "src/generated/client"] },
      { ...registration(), reads: ["../private/**"] },
      { ...registration(), limits: { maxFiles: 51 } },
      { ...registration(), limits: { maxFileBytes: 1_048_577 } },
      { ...registration(), limits: { maxTotalBytes: 8_388_609 } },
      { ...registration(), extra: "unreviewed" },
    ];
    for (const value of refused)
      expect(() => assertGeneratorRegistration(value)).toThrow(
        "Invalid generator registration",
      );
  });

  it("requires distinct IDs and a timeout no greater than policy", () => {
    expect(() => assertProjectConfig(project())).not.toThrow();
    const duplicate = project();
    duplicate.generators!.push({ ...registration(), revision: "revision-2" });
    expect(() => assertProjectConfig(duplicate)).toThrow(
      "generator toy-client is declared twice",
    );
    const timeout = project();
    timeout.generators![0]!.limits = { timeoutSeconds: 601 };
    expect(() => assertProjectConfig(timeout)).toThrow(
      "timeout exceeds policy.timeoutSeconds",
    );
  });

  it("compares every frozen field independently of JSON object key order", () => {
    const original = registration();
    const reordered = {
      outputs: ["src/generated"],
      argv: ["generate", "--output", "src/generated"],
      reads: ["api/**/*.yaml", "!api/private/**"],
      image,
      revision: "revision-1",
      id: "toy-client",
    };
    expect(sameGeneratorRegistration(original, reordered)).toBe(true);
    expect(
      sameGeneratorRegistration(original, {
        ...original,
        revision: "revision-2",
      }),
    ).toBe(false);
    expect(
      sameGeneratorRegistration(original, {
        ...original,
        argv: ["generate", "--output", "other"],
      }),
    ).toBe(false);
    expect(
      sameGeneratorRegistration(original, { ...original, outputs: ["other"] }),
    ).toBe(false);
    const { reads: _reads, ...withoutReads } = original;
    expect(sameGeneratorRegistration(original, withoutReads)).toBe(false);
  });
});
