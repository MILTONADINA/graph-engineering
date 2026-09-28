import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Every docker call is answered here instead of run, so a scanner can be
// made to fail with chosen stderr.
const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../src/util.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/util.js")>()),
  command: mocks.command,
}));
import {
  OSV_DATABASE_HOST,
  parseSemgrep,
  parseSemgrepUnscanned,
  runSecurityScan,
  updateOsvDatabase,
} from "../src/security/scan.js";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
// Built by concatenation so the source itself holds no credential shape.
const KEY_BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC";
const key =
  "-----BEGIN " +
  "PRIVATE KEY-----\n" +
  KEY_BODY.repeat(20) +
  "\n-----END " +
  "PRIVATE KEY-----";
// The key's BEGIN line lies outside the last 300 characters, so cutting the
// output first would leave a key body nothing recognises.
const stderr = `starting\n${key}\ndone`;

const directories: string[] = [];
const directory = async () => {
  const created = await mkdtemp(path.join(os.tmpdir(), "graph-scan-redact-"));
  directories.push(created);
  return created;
};
afterEach(async () => {
  mocks.command.mockReset();
  for (const created of directories.splice(0))
    await rm(created, { recursive: true, force: true });
});

// OSV-Scanner fails with `code` and the stderr above; every other docker
// call succeeds.
function osvFails(code: number) {
  mocks.command.mockImplementation(async (_executable, argv: string[]) => {
    if (argv[0] === "image")
      return { code: 0, stdout: `${IMAGE_ID}\n`, stderr: "" };
    if (argv[0] === "run" && argv[argv.indexOf(IMAGE_ID) + 1] === "osv-scanner")
      return { code, stdout: "", stderr };
    return { code: 0, stdout: "", stderr: "" };
  });
}

describe("a failing scanner's stderr", () => {
  it("is redacted before security-scan cuts it into a scan error", async () => {
    const root = await directory();
    const database = await directory();
    await writeFile(path.join(root, "package-lock.json"), "{}\n");
    osvFails(127);
    const scan = await runSecurityScan({
      root,
      image: "graph-security:local",
      profile: {
        files: ["package-lock.json"],
        authorizedTargets: [],
        configuredTools: [],
      },
      osvDatabase: database,
    });
    const error = scan.errors.find((line) => line.startsWith("osv-scanner:"));
    expect(error).toContain("osv-scanner exited 127");
    expect(error).toContain("[REDACTED PRIVATE KEY]");
    expect(error).not.toContain(KEY_BODY);
    expect(error!.endsWith("done")).toBe(true);
  });

  it("is redacted before security-db-update cuts it into its error", async () => {
    const root = await directory();
    const dataDir = await directory();
    await writeFile(path.join(root, "package-lock.json"), "{}\n");
    osvFails(2);
    const failure = await updateOsvDatabase({
      root,
      dataDir,
      image: "graph-security:local",
      files: ["package-lock.json"],
      policy: { network: "allowlisted", allowedHosts: [OSV_DATABASE_HOST] },
    }).then(
      () => undefined,
      (error: Error) => error.message,
    );
    expect(failure).toContain("osv-scanner could not download its database");
    expect(failure).toContain("[REDACTED PRIVATE KEY]");
    expect(failure).not.toContain(KEY_BODY);
  });
});

describe("Semgrep's error messages", () => {
  // A named credential; the name is split so the source holds no such shape.
  const VALUE = "Q7vRk2mZ9pLx4TnW8sYb3HcJ";
  const assignment = `pass${"word"}=${VALUE}`;

  it("are redacted before a fatal one is cut into the scan error", () => {
    // The cut at 200 characters would leave only the value's first ten
    // characters, too few for redaction to recognise.
    const message = `${"x".repeat(180)} ${assignment}`;
    const failure = (() => {
      try {
        parseSemgrep(
          JSON.stringify({
            results: [],
            errors: [{ level: "error", message }],
          }),
        );
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(failure).toContain("semgrep reported 1 error(s)");
    expect(failure).toContain(`pass${"word"}=[REDACTED]`);
    expect(failure).not.toContain(VALUE.slice(0, 5));
  });

  it("are redacted before a non-fatal one is cut into an unscanned file's reason", () => {
    // After the reason's "semgrep warn: " prefix, the value starts at
    // character 190, so the cut at 200 characters would leave only its first
    // ten, too few for redaction to recognise. Redacted first, the reason is
    // exactly 200 characters and keeps the whole redaction marker.
    const message = `${"x".repeat(166)} ${assignment}`;
    const unscanned = parseSemgrepUnscanned(
      JSON.stringify({
        results: [],
        errors: [{ level: "warn", path: "/scan/src/config.js", message }],
      }),
    );
    expect(unscanned).toHaveLength(1);
    expect(unscanned[0]!.reason).toContain(`pass${"word"}=[REDACTED]`);
    expect(unscanned[0]!.reason).not.toContain(VALUE.slice(0, 5));
  });
});
