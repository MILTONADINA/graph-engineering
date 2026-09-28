import { describe, expect, it } from "vitest";
import { containsSecret, redact, redactTail } from "../src/policy.js";
import { displayFinding } from "../src/security/scan.js";

// Built by concatenation so the source itself holds no credential shape.
const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

describe("security output shown to a person", () => {
  it("redacts a finding's free text but keeps the fields the engine compares", () => {
    const finding = {
      tool: "gitleaks",
      rule: "github-pat",
      path: "src/config.ts",
      line: 3,
      message: `GitHub token found: ${token}`,
      resource: `https://api.example.test/?t=${token}`,
      fingerprint: "f".repeat(64),
      risk: "high",
    };
    const shown = displayFinding(finding);
    expect(containsSecret(shown.message)).toBe(false);
    expect(shown.message).not.toContain(token);
    expect(shown.resource).not.toContain(token);
    expect({
      tool: shown.tool,
      rule: shown.rule,
      path: shown.path,
      line: shown.line,
      fingerprint: shown.fingerprint,
      risk: shown.risk,
    }).toEqual({
      tool: finding.tool,
      rule: finding.rule,
      path: finding.path,
      line: finding.line,
      fingerprint: finding.fingerprint,
      risk: finding.risk,
    });
    // The recorded finding itself is left unchanged.
    expect(finding.message).toContain(token);
  });

  it("redacts output before cutting it, so a secret cut in half cannot leak", () => {
    const key =
      "-----BEGIN " +
      "PRIVATE KEY-----\n" +
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC".repeat(20) +
      "\n-----END " +
      "PRIVATE KEY-----";
    const output = `starting\n${key}\ndone`;
    // Cutting first keeps only the key's tail, which alone looks harmless.
    const cutFirst = redact(output.slice(-300));
    expect(cutFirst).toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
    const tail = redactTail(output, 300);
    expect(tail).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
    expect(tail.endsWith("done")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(300);
  });
});
