import { describe, expect, it } from "vitest";
import {
  assertInstalledWorkerBinding,
  assertInstalledWorkerIdentity,
  assertProjectConfig,
  DEFAULT_POLICY,
} from "../src/index.js";

const digest = "a".repeat(64);
const identity = { realpath: "/opt/toy/bin/claude", sha256: digest };
const binding = {
  providerId: "toy-claude",
  providerProfileSha256: "b".repeat(64),
  identity,
};

describe("installed identity contracts", () => {
  it("keeps identity enforcement opt-in and rejects non-boolean policy values", () => {
    expect(DEFAULT_POLICY).not.toHaveProperty("requireInstalledWorkerIdentity");
    const project = (policy: unknown) => ({
      version: "1.0.0",
      projectId: "identity-toy-project",
      name: "Toy identity project",
      policy,
      verification: [],
    });
    expect(() => assertProjectConfig(project(DEFAULT_POLICY))).not.toThrow();
    for (const value of [true, false])
      expect(() =>
        assertProjectConfig(
          project({ ...DEFAULT_POLICY, requireInstalledWorkerIdentity: value }),
        ),
      ).not.toThrow();
    for (const value of [null, "true", 1, {}, []])
      expect(() =>
        assertProjectConfig(
          project({ ...DEFAULT_POLICY, requireInstalledWorkerIdentity: value }),
        ),
      ).toThrow("Invalid project configuration");
  });

  it("validates strict absolute-path identity objects without claiming filesystem canonicality", () => {
    for (const realpath of [
      "/opt/toy/bin/claude",
      "C:\\toy\\claude.exe",
      "C:/toy/claude.exe",
      "\\\\server\\share\\claude.exe",
    ])
      expect(() =>
        assertInstalledWorkerIdentity({ realpath, sha256: digest }),
      ).not.toThrow();
    for (const value of [
      null,
      [],
      {},
      { realpath: identity.realpath },
      { ...identity, realpath: "claude" },
      { ...identity, realpath: "./claude" },
      { ...identity, realpath: "C:claude.exe" },
      { ...identity, realpath: "\\claude.exe" },
      { ...identity, realpath: "/toy/claude\n" },
      { ...identity, realpath: "/toy/claude\0" },
      { ...identity, realpath: "\\\\server\n\\share\\claude.exe" },
      { ...identity, sha256: "A".repeat(64) },
      { ...identity, sha256: "a".repeat(63) },
      { ...identity, sha256: "a".repeat(64) + "\n" },
      { ...identity, version: "1.0" },
    ])
      expect(() => assertInstalledWorkerIdentity(value)).toThrow(
        "Invalid installed worker identity",
      );
  });

  it("validates complete frozen provider bindings and rejects unknown fields", () => {
    expect(() => assertInstalledWorkerBinding(binding)).not.toThrow();
    for (const value of [
      null,
      [],
      {},
      { identity },
      { ...binding, providerId: "" },
      { ...binding, providerId: "toy provider" },
      { ...binding, providerId: "toy\n" },
      { ...binding, providerProfileSha256: "not-a-digest" },
      { ...binding, identity: { ...identity, extra: true } },
      { ...binding, version: "1.0" },
    ])
      expect(() => assertInstalledWorkerBinding(value)).toThrow(
        "Invalid installed worker binding",
      );
  });
});
