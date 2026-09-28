// The owner's trust-anchor tooling (PR-4): anchor-prepare, anchor-verify,
// the Rekor config builder and local enrollment. Every key here is freshly
// generated in a temporary directory; nothing reads the owner's keys, writes
// the compiled anchor path or runs sudo. The installed-anchor checks reach a
// temporary file only through vitest spies on the anchor module's exports,
// the same seam the importer-steps tests use; nothing in src takes an anchor
// path, and there is no environment override.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DEFAULT_POLICY,
  SCHEMA_VERSION,
  type ProjectConfig,
} from "@graph-engineering/contracts";
import { ContextEngine } from "../src/context/index.js";
import { backupProject } from "../src/operations.js";
import { initializeProject, projectDataDir } from "../src/project.js";
import {
  anchorInstallCommands,
  buildPromotionTrustAnchor,
  canonicalAnchorBytes,
  enrollPromotionTrustAnchor,
  preparePromotionTrustAnchor,
  promotionEnrollmentPath,
  readOwnerPublicKeys,
  rekorWitnessOptionsFromAnchor,
  SIGSTORE_REKOR_V1,
  verifyInstalledPromotionTrustAnchor,
} from "../src/promotion-anchor-enrollment.js";
import {
  promotionControllersFor,
  WITNESS_CONTROLLERS,
} from "../src/promotion-controllers.js";
import { preparePromotionGrantRequest } from "../src/promotion-importer.js";
import * as localPaths from "../src/promotion-local-paths.js";
import {
  PROMOTION_ANCHOR_REFUSAL_CODES,
  PromotionAnchorRefusalError,
} from "../src/promotion-refusal-codes.js";
import * as rekorWitness from "../src/promotion-rekor-witness.js";
import {
  createRekorWitness,
  defaultRekorStateDir,
  RekorWitnessError,
} from "../src/promotion-rekor-witness.js";
import * as trustAnchor from "../src/promotion-trust-anchor.js";
import {
  PROMOTION_TRUST_ANCHOR_PATHS,
  promotionTrustAnchorSchema,
} from "../src/promotion-trust-anchor.js";
import { RunStore } from "../src/store.js";

const execute = promisify(execFile);
const unix = process.platform === "darwin" || process.platform === "linux";
const ROLES = ["approver", "issuer", "labeler"] as const;
const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

const directories: string[] = [];
const cleanups: (() => unknown)[] = [];
const temporary = async (label: string) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), `graph-${label}-`));
  directories.push(directory);
  return directory;
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const anchorPathExisted = () =>
  Object.values(PROMOTION_TRUST_ANCHOR_PATHS).map((file) => existsSync(file));

/** Fresh test keys, written the way the owner's key tool writes them. */
async function testKeyDir(): Promise<string> {
  const keyDir = path.join(await temporary("anchor-keys"), "keys");
  await mkdir(keyDir, { mode: 0o700 });
  for (const role of ROLES) {
    const { publicKey } = generateKeyPairSync("ed25519");
    await writeFile(
      path.join(keyDir, `${role}.pub.pem`),
      publicKey.export({ type: "spki", format: "pem" }).toString(),
      { mode: 0o600 },
    );
  }
  return keyDir;
}

/** A temporary git repository with a graph project file. */
async function testProject(): Promise<string> {
  const project = await temporary("anchor-project");
  const git = (...args: string[]) =>
    execute(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: project },
    );
  await git("init", "-q");
  await writeFile(path.join(project, "README.md"), "fixture\n");
  await git("add", "README.md");
  await git("commit", "-q", "-m", "root");
  await initializeProject(project, "anchor-fixture");
  return project;
}

const refusalOf = async (run: () => unknown): Promise<string> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof PromotionAnchorRefusalError) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
};

/** Point the user data dir at a temporary base. */
async function temporaryUserDataDir(): Promise<string> {
  const base = path.join(await temporary("anchor-data"), "graph-engineering");
  vi.spyOn(localPaths, "promotionUserDataDir").mockReturnValue(base);
  return base;
}

function anchorFor(keyDir: string, projectId = "fixture-project") {
  return buildPromotionTrustAnchor({
    projects: [{ projectId, repositoryIdentitySha256: "1".repeat(64) }],
    keys: readOwnerPublicKeys(keyDir),
  });
}

/**
 * Install `bytes` as the anchor for the verifier: the compiled path is
 * replaced by a temporary file, and the inspection reports the owner and
 * mode given, since a test cannot make a root-owned file.
 */
async function installForTest(
  bytes: Buffer | string,
  stat: { uid: number; mode: number } = { uid: 0, mode: 0o644 },
): Promise<string> {
  const file = path.join(await temporary("anchor-installed"), "anchor.json");
  await writeFile(file, bytes, { mode: 0o644 });
  vi.spyOn(trustAnchor, "promotionTrustAnchorPath").mockReturnValue(file);
  vi.spyOn(
    trustAnchor,
    "inspectPromotionTrustAnchorInstall",
  ).mockImplementation(async (target) => {
    const text = readFileSync(target, "utf8");
    return {
      anchor: promotionTrustAnchorSchema.parse(JSON.parse(text)),
      text,
      ...stat,
    };
  });
  return file;
}

describe("promotion anchor-prepare", () => {
  it.runIf(unix)(
    "writes a canonical, schema-valid anchor from the public keys and never the root path",
    async () => {
      const before = anchorPathExisted();
      const base = await temporaryUserDataDir();
      const keyDir = await testKeyDir();
      const project = await testProject();
      const prepared = await preparePromotionTrustAnchor({
        projectRoot: project,
        keyDir,
      });
      expect(prepared.file).toBe(
        path.join(base, "promotion-trust-anchor.prepared.json"),
      );
      const bytes = await readFile(prepared.file);
      const parsed = promotionTrustAnchorSchema.parse(
        JSON.parse(bytes.toString("utf8")),
      );
      expect(bytes.equals(canonicalAnchorBytes(parsed))).toBe(true);
      expect(prepared.anchorSha256).toBe(sha256(bytes));
      expect(statSync(prepared.file).mode & 0o777).toBe(0o600);
      expect(parsed).toMatchObject({
        version: "1.1.0",
        witnessId: "rekor-sigstore-v1",
        controllers: {
          witness: "none",
          custody: "none",
          modelIdentity: "none",
        },
        rekor: {
          baseUrl: SIGSTORE_REKOR_V1.baseUrl,
          logId: SIGSTORE_REKOR_V1.logId,
          logPublicKeyPem: SIGSTORE_REKOR_V1.logPublicKeyPem,
        },
      });
      const keys = readOwnerPublicKeys(keyDir);
      if (parsed.version !== "1.1.0") throw new Error("unreachable");
      expect(parsed.approverKeys[0]!.publicKeySha256).toBe(
        keys.approver.publicKeySha256,
      );
      expect(parsed.issuerKeys[0]!.publicKeySha256).toBe(
        keys.issuer.publicKeySha256,
      );
      expect(parsed.labelerKeys[0]!.publicKeySha256).toBe(
        keys.labeler.publicKeySha256,
      );
      expect(parsed.rekor.issuerPublicKeyPem).toBe(keys.issuer.pem);
      expect(prepared.installCommands).toEqual(
        anchorInstallCommands(prepared.file),
      );
      // It refuses to overwrite, and refuses any root-owned anchor location.
      expect(
        await refusalOf(() =>
          preparePromotionTrustAnchor({ projectRoot: project, keyDir }),
        ),
      ).toBe("anchor-output-exists");
      expect(await readFile(prepared.file)).toEqual(bytes);
      for (const out of [
        ...Object.values(PROMOTION_TRUST_ANCHOR_PATHS),
        path.join(path.dirname(PROMOTION_TRUST_ANCHOR_PATHS.linux), "x.json"),
      ])
        expect(
          await refusalOf(() =>
            preparePromotionTrustAnchor({ projectRoot: project, keyDir, out }),
          ),
        ).toBe("anchor-output-invalid");
      expect(anchorPathExisted()).toEqual(before);
    },
    60000,
  );

  it("prints sudo install commands per platform and never runs them", () => {
    const file = "/Users/owner/Library/Application Support/x's anchor.json";
    expect(anchorInstallCommands(file, "darwin")).toEqual([
      `sudo install -d -o root -g wheel -m 0755 '/Library/Application Support/GraphEngineering'`,
      `sudo install -o root -g wheel -m 0644 '/Users/owner/Library/Application Support/x'\\''s anchor.json' '/Library/Application Support/GraphEngineering/promotion-trust-anchor.json'`,
      `shasum -a 256 '/Library/Application Support/GraphEngineering/promotion-trust-anchor.json'`,
    ]);
    expect(anchorInstallCommands("/home/o/a.json", "linux")).toEqual([
      `sudo install -d -o root -g root -m 0755 '/etc/graph-engineering'`,
      `sudo install -o root -g root -m 0644 '/home/o/a.json' '/etc/graph-engineering/promotion-trust-anchor.json'`,
      `sha256sum '/etc/graph-engineering/promotion-trust-anchor.json'`,
    ]);
  });

  it.runIf(unix)(
    "refuses a missing, invalid or shared public key and reads only .pub.pem files",
    async () => {
      const base = await temporaryUserDataDir();
      const project = await testProject();
      const keyDir = await testKeyDir();
      // An encrypted key file nobody may read: reading it would throw EACCES.
      await writeFile(path.join(keyDir, "issuer.key.json"), "{}", {
        mode: 0o000,
      });
      expect(readOwnerPublicKeys(keyDir).issuer.keyId).toMatch(
        /^issuer-[a-f0-9]{16}$/,
      );
      await unlink(path.join(keyDir, "labeler.pub.pem"));
      const missing = await preparePromotionTrustAnchor({
        projectRoot: project,
        keyDir,
      }).catch((error: unknown) => error);
      expect(missing).toBeInstanceOf(PromotionAnchorRefusalError);
      expect((missing as PromotionAnchorRefusalError).code).toBe(
        "owner-public-key-missing",
      );
      expect((missing as Error).message).toContain(
        "run npm run promotion-key -- setup first",
      );
      expect(
        await refusalOf(() =>
          preparePromotionTrustAnchor({
            projectRoot: project,
            keyDir: path.join(keyDir, "absent"),
          }),
        ),
      ).toBe("owner-public-key-missing");
      await writeFile(
        path.join(keyDir, "labeler.pub.pem"),
        await readFile(path.join(keyDir, "approver.pub.pem")),
      );
      expect(await refusalOf(() => readOwnerPublicKeys(keyDir))).toBe(
        "owner-public-keys-not-distinct",
      );
      const { publicKey } = generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
      });
      await writeFile(
        path.join(keyDir, "labeler.pub.pem"),
        publicKey.export({ type: "spki", format: "pem" }).toString(),
      );
      expect(await refusalOf(() => readOwnerPublicKeys(keyDir))).toBe(
        "owner-public-key-invalid",
      );
      await writeFile(path.join(keyDir, "labeler.pub.pem"), "not a key");
      expect(await refusalOf(() => readOwnerPublicKeys(keyDir))).toBe(
        "owner-public-key-invalid",
      );
      expect(existsSync(base)).toBe(false);
    },
    60000,
  );

  it.runIf(unix)(
    "CLI anchor-prepare writes only the chosen file and prints the install commands",
    async () => {
      const before = anchorPathExisted();
      const keyDir = await testKeyDir();
      const project = await testProject();
      const out = path.join(await temporary("anchor-out"), "anchor.json");
      const { stdout } = await execute(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
          "-C",
          project,
          "promotion",
          "anchor-prepare",
          "--key-dir",
          keyDir,
          "--out",
          out,
        ],
        {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          timeout: 30000,
          maxBuffer: 1_000_000,
          windowsHide: true,
        },
      );
      const digest = sha256(await readFile(out));
      expect(stdout).toContain(`Anchor SHA-256: ${digest}`);
      for (const command of anchorInstallCommands(out))
        expect(stdout).toContain(command);
      expect(readdirSync(path.dirname(out))).toEqual(["anchor.json"]);
      expect(anchorPathExisted()).toEqual(before);
    },
    60000,
  );
});

describe("promotion anchor-verify (installed anchor, read-only)", () => {
  it.runIf(unix)(
    "refuses a user-owned anchor at the injected path through the real inspection",
    async () => {
      const keyDir = await testKeyDir();
      const file = path.join(await temporary("anchor-user"), "anchor.json");
      await writeFile(file, canonicalAnchorBytes(anchorFor(keyDir)), {
        mode: 0o644,
      });
      vi.spyOn(trustAnchor, "promotionTrustAnchorPath").mockReturnValue(file);
      expect(
        await verifyInstalledPromotionTrustAnchor({ keyDir }),
      ).toMatchObject({
        outcome: "refused",
        refusal: "trust-anchor-unprotected",
      });
      vi.spyOn(trustAnchor, "promotionTrustAnchorPath").mockReturnValue(
        path.join(path.dirname(file), "missing.json"),
      );
      expect(
        await verifyInstalledPromotionTrustAnchor({ keyDir }),
      ).toMatchObject({ outcome: "refused", refusal: "trust-anchor-absent" });
    },
  );

  it("accepts the canonical anchor that matches the local public keys", async () => {
    const keyDir = await testKeyDir();
    const bytes = canonicalAnchorBytes(anchorFor(keyDir));
    const file = await installForTest(bytes);
    const result = await verifyInstalledPromotionTrustAnchor({ keyDir });
    expect(result).toMatchObject({
      outcome: "ok",
      path: file,
      anchorSha256: sha256(bytes),
    });
  });

  it("refuses a wrong owner or mode, another version, non-canonical bytes, another log or other keys", async () => {
    const keyDir = await testKeyDir();
    const anchor = anchorFor(keyDir);
    const bytes = canonicalAnchorBytes(anchor);
    const cases: [Buffer | string, { uid: number; mode: number }, string][] = [
      [bytes, { uid: 501, mode: 0o644 }, "anchor-owner-mismatch"],
      [bytes, { uid: 0, mode: 0o600 }, "anchor-mode-mismatch"],
      [bytes, { uid: 0, mode: 0o640 }, "anchor-mode-mismatch"],
      [
        `${JSON.stringify(anchor, null, 2)}\n`,
        { uid: 0, mode: 0o644 },
        "anchor-not-canonical",
      ],
      [bytes.subarray(0, -1), { uid: 0, mode: 0o644 }, "anchor-not-canonical"],
    ];
    const { version: _, rekor: __, labelerKeys: ___, ...v1 } = anchor;
    cases.push([
      canonicalAnchorBytes({ ...v1, version: "1.0.0" }),
      { uid: 0, mode: 0o644 },
      "anchor-version-unsupported",
    ]);
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const otherPem = other.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    cases.push([
      canonicalAnchorBytes({
        ...anchor,
        rekor: {
          ...anchor.rekor,
          logPublicKeyPem: otherPem,
          logId: sha256(
            other.publicKey.export({ type: "spki", format: "der" }),
          ),
        },
      }),
      { uid: 0, mode: 0o644 },
      "anchor-rekor-pin-mismatch",
    ]);
    cases.push([
      canonicalAnchorBytes(anchorFor(await testKeyDir())),
      { uid: 0, mode: 0o644 },
      "anchor-key-mismatch",
    ]);
    for (const [content, stat, code] of cases) {
      await installForTest(content, stat);
      expect(
        await verifyInstalledPromotionTrustAnchor({ keyDir }),
      ).toMatchObject({ outcome: "refused", refusal: code });
      vi.restoreAllMocks();
    }
    // A missing local key refuses with the setup hint.
    await installForTest(bytes);
    await unlink(path.join(keyDir, "issuer.pub.pem"));
    const missing = await verifyInstalledPromotionTrustAnchor({ keyDir });
    expect(missing).toMatchObject({
      outcome: "refused",
      refusal: "owner-public-key-missing",
    });
    if (missing.outcome !== "refused") throw new Error("unreachable");
    expect(missing.detail).toContain(
      "run npm run promotion-key -- setup first",
    );
    expect(new Set(PROMOTION_ANCHOR_REFUSAL_CODES).size).toBe(
      PROMOTION_ANCHOR_REFUSAL_CODES.length,
    );
  });

  it.runIf(unix)(
    "CLI anchor-verify reads the compiled path and prints a closed refusal when none is installed",
    async () => {
      const anchorPath = trustAnchor.promotionTrustAnchorPath();
      if (existsSync(anchorPath)) return;
      const keyDir = await testKeyDir();
      const failure = await execute(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
          "promotion",
          "anchor-verify",
          "--key-dir",
          keyDir,
        ],
        {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          timeout: 30000,
          maxBuffer: 1_000_000,
          windowsHide: true,
        },
      ).then(
        () => {
          throw new Error("anchor-verify unexpectedly succeeded");
        },
        (error) => error,
      );
      expect(failure.code).toBe(1);
      expect(failure.stdout).toBe("");
      expect(failure.stderr.split("\n")[0]).toBe("trust-anchor-absent");
      expect(existsSync(anchorPath)).toBe(false);
    },
    60000,
  );
});

describe("Rekor witness config from the anchor", () => {
  it("builds a validated config whose allowlist is the anchor's host, and registers nothing", async () => {
    const keys = readOwnerPublicKeys(await testKeyDir());
    const anchor = buildPromotionTrustAnchor({
      projects: [{ projectId: "p", repositoryIdentitySha256: "1".repeat(64) }],
      keys,
    });
    const options = rekorWitnessOptionsFromAnchor(anchor);
    expect(options).toEqual({
      witnessId: "rekor-sigstore-v1",
      baseUrl: "https://rekor.sigstore.dev",
      origin: "rekor.sigstore.dev",
      logPublicKeyPem: SIGSTORE_REKOR_V1.logPublicKeyPem,
      issuerPublicKeyPem: keys.issuer.pem,
      allowedHosts: ["rekor.sigstore.dev"],
    });
    const witness = createRekorWitness({
      ...options,
      stateDir: path.join(os.tmpdir(), "never-created-rekor-state"),
    });
    expect(witness.pinnedLogId).toBe(SIGSTORE_REKOR_V1.logId);
    expect(sha256(SIGSTORE_REKOR_V1.logPublicKeyPem)).toBe(
      SIGSTORE_REKOR_V1.pemSha256,
    );
    // Not in the closed registry; selecting it by name is refused.
    expect(Object.keys(WITNESS_CONTROLLERS)).toEqual(["none"]);
    expect(() =>
      promotionControllersFor({
        witness: "rekor-v1" as "none",
        custody: "none",
        modelIdentity: "none",
      }),
    ).toThrow("closed registry");
    // A 1.0.0 anchor pins no witness; a tampered anchor does not parse.
    const { version: _, rekor, labelerKeys: __, ...v1 } = anchor;
    const invalid = (value: unknown) => {
      try {
        rekorWitnessOptionsFromAnchor(value);
      } catch (error) {
        return error instanceof RekorWitnessError ? error.code : error;
      }
      return "accepted";
    };
    expect(invalid({ ...v1, version: "1.0.0" })).toBe("rekor-config-invalid");
    for (const tampered of [
      { ...rekor, logId: "0".repeat(64) },
      { ...rekor, baseUrl: "https://evil.example" },
      { ...rekor, issuerPublicKeyPem: keys.approver.pem },
      { ...rekor, issuerKeyId: keys.approver.keyId },
      { ...rekor, logPublicKeyPem: keys.labeler.pem },
      { ...rekor, apiVersion: "v2" },
      { ...rekor, extra: true },
    ])
      expect(invalid({ ...anchor, rekor: tampered })).toBe(
        "rekor-config-invalid",
      );
    expect(
      invalid({
        ...anchor,
        controllers: { ...anchor.controllers, witness: "rekor-v1" },
      }),
    ).toBe("rekor-config-invalid");
  });

  it("still refuses the importer at step 1 with an installed 1.1.0 anchor, and with none", async () => {
    const keyDir = await testKeyDir();
    const project = await temporary("anchor-importer");
    vi.spyOn(trustAnchor, "readPromotionTrustAnchor").mockResolvedValue(
      anchorFor(keyDir),
    );
    expect(
      await preparePromotionGrantRequest(project, path.join(project, "bundle")),
    ).toMatchObject({
      outcome: "refused",
      step: 1,
      refusal: "controller-not-selected",
      promotionEligible: false,
    });
    vi.restoreAllMocks();
    const absent = await preparePromotionGrantRequest(
      project,
      path.join(project, "bundle"),
    );
    expect(absent).toMatchObject({ outcome: "refused", step: 1 });
    if (unix && !existsSync(trustAnchor.promotionTrustAnchorPath()))
      expect(absent).toMatchObject({ refusal: "trust-anchor-absent" });
  });
});

describe("promotion enroll", () => {
  function fakeWitness(treeSize = 42n) {
    const verifyTreeHead = vi.fn(async () => ({
      treeId: "1193050959916656506",
      treeSize,
      rootHash: "a".repeat(64),
    }));
    const spy = vi
      .spyOn(rekorWitness, "createRekorWitness")
      .mockImplementation(
        () =>
          ({ verifyTreeHead }) as unknown as ReturnType<
            typeof createRekorWitness
          >,
      );
    return { spy, verifyTreeHead };
  }

  it.runIf(unix)(
    "records the witness and signer fingerprints once, 0600, and is idempotent",
    async () => {
      const base = await temporaryUserDataDir();
      const keyDir = await testKeyDir();
      const anchor = anchorFor(keyDir);
      const bytes = canonicalAnchorBytes(anchor);
      await installForTest(bytes);
      const { spy, verifyTreeHead } = fakeWitness();
      const first = await enrollPromotionTrustAnchor({ keyDir });
      expect(first).toMatchObject({
        outcome: "enrolled",
        file: path.join(base, "promotion-enrollment", "enrollment.json"),
        witnessHighWater: {
          logId: SIGSTORE_REKOR_V1.logId,
          treeId: "1193050959916656506",
          treeSize: "42",
        },
      });
      if (first.outcome === "refused") throw new Error("unreachable");
      // The witness is built only from the anchor, with its default state dir.
      expect(spy).toHaveBeenCalledWith(rekorWitnessOptionsFromAnchor(anchor));
      const file = promotionEnrollmentPath();
      const record = JSON.parse(await readFile(file, "utf8"));
      const keys = readOwnerPublicKeys(keyDir);
      expect(record).toEqual({
        version: 1,
        kind: "graph-engineering-promotion-enrollment",
        anchorSha256: sha256(bytes),
        witness: {
          witnessId: "rekor-sigstore-v1",
          kind: "rekor-v1",
          baseUrl: SIGSTORE_REKOR_V1.baseUrl,
          logId: SIGSTORE_REKOR_V1.logId,
        },
        signers: Object.fromEntries(
          ROLES.map((role) => [
            role,
            {
              keyId: keys[role].keyId,
              publicKeySha256: keys[role].publicKeySha256,
            },
          ]),
        ),
        enrolledProjects: anchor.enrolledProjects,
      });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      const recorded = await readFile(file);
      const second = await enrollPromotionTrustAnchor({ keyDir });
      expect(second).toMatchObject({ outcome: "already-enrolled" });
      expect(await readFile(file)).toEqual(recorded);
      expect(verifyTreeHead).toHaveBeenCalledTimes(2);
      expect(readdirSync(path.dirname(file))).toEqual(["enrollment.json"]);
    },
  );

  it.runIf(unix)(
    "refuses a conflicting re-enrollment, an unsafe record and a failed witness read",
    async () => {
      await temporaryUserDataDir();
      const keyDir = await testKeyDir();
      await installForTest(canonicalAnchorBytes(anchorFor(keyDir)));
      const { verifyTreeHead } = fakeWitness();
      expect(await enrollPromotionTrustAnchor({ keyDir })).toMatchObject({
        outcome: "enrolled",
      });
      const file = promotionEnrollmentPath();
      const recorded = await readFile(file);
      // Another anchor (another project) conflicts before any witness read.
      await installForTest(
        canonicalAnchorBytes(anchorFor(keyDir, "another-project")),
      );
      const calls = verifyTreeHead.mock.calls.length;
      expect(await enrollPromotionTrustAnchor({ keyDir })).toMatchObject({
        outcome: "refused",
        refusal: "enrollment-conflict",
      });
      expect(verifyTreeHead.mock.calls.length).toBe(calls);
      expect(await readFile(file)).toEqual(recorded);
      // A record others can read is refused, not repaired.
      await chmod(file, 0o644);
      expect(await enrollPromotionTrustAnchor({ keyDir })).toMatchObject({
        outcome: "refused",
        refusal: "enrollment-invalid",
      });
      await rm(file);
      // A failed tree-head read writes no record.
      vi.spyOn(rekorWitness, "createRekorWitness").mockImplementation(
        () =>
          ({
            verifyTreeHead: async () => {
              throw new RekorWitnessError("rekor-rollback", "planted");
            },
          }) as unknown as ReturnType<typeof createRekorWitness>,
      );
      expect(await enrollPromotionTrustAnchor({ keyDir })).toMatchObject({
        outcome: "refused",
        refusal: "witness-state-init-failed",
      });
      expect(existsSync(file)).toBe(false);
      // No verified anchor, no enrollment.
      vi.restoreAllMocks();
      await temporaryUserDataDir();
      vi.spyOn(trustAnchor, "promotionTrustAnchorPath").mockReturnValue(
        path.join(await temporary("anchor-none"), "missing.json"),
      );
      expect(await enrollPromotionTrustAnchor({ keyDir })).toMatchObject({
        outcome: "refused",
        refusal: "trust-anchor-absent",
      });
      expect(existsSync(promotionEnrollmentPath())).toBe(false);
    },
  );

  it.runIf(unix)(
    "keeps the enrollment record and witness state out of the repository, project backups and MCP exports",
    async () => {
      const directory = await temporary("anchor-backup");
      const home = path.join(directory, "home");
      const base = localPaths.promotionUserDataDir(process.platform, {}, home);
      // The Rekor state dir and the enrollment dir share the per-user base.
      for (const platform of ["darwin", "linux"] as const)
        expect(defaultRekorStateDir(platform, {}, home)).toBe(
          path.join(
            localPaths.promotionUserDataDir(platform, {}, home),
            "rekor-witness",
          ),
        );
      vi.spyOn(localPaths, "promotionUserDataDir").mockReturnValue(base);
      const enrollment = promotionEnrollmentPath();
      const witnessState = path.join(
        defaultRekorStateDir(process.platform, {}, home),
        `${SIGSTORE_REKOR_V1.logId}.json`,
      );
      await mkdir(path.dirname(enrollment), { recursive: true, mode: 0o700 });
      await mkdir(path.dirname(witnessState), { recursive: true, mode: 0o700 });
      await writeFile(enrollment, "ENROLLMENT-MARKER", { mode: 0o600 });
      await writeFile(witnessState, "WITNESS-MARKER", { mode: 0o600 });
      // A project checked out beside them, with its data dir under the base.
      const root = path.join(directory, "repo");
      await mkdir(root);
      await writeFile(path.join(root, "main.ts"), "export const x = 1;\n");
      const projectId = "anchor-backup-project";
      const dataDir = path.join(base, "projects", projectId);
      await mkdir(dataDir, { recursive: true });
      for (const file of [enrollment, witnessState]) {
        expect(path.relative(root, file).startsWith("..")).toBe(true);
        expect(path.relative(dataDir, file).startsWith("..")).toBe(true);
        expect(
          path.relative(projectDataDir(projectId), file).startsWith(".."),
        ).toBe(true);
      }
      const config: ProjectConfig = {
        version: SCHEMA_VERSION,
        projectId,
        name: "Anchor backup",
        policy: structuredClone(DEFAULT_POLICY),
        verification: [],
      };
      const context = new ContextEngine({
        projectId,
        root,
        dataDir,
        policy: config.policy,
      });
      const store = new RunStore(dataDir, projectId);
      cleanups.push(
        () => context.close().catch(() => {}),
        () => {
          try {
            store.close();
          } catch {}
        },
      );
      const snapshot = await context.index();
      store.savePlan({
        id: "plan-1",
        projectId,
        snapshotId: snapshot.id,
      } as never);
      const destination = path.join(directory, "backup");
      const manifest = await backupProject({
        context,
        store,
        dataDir,
        projectId,
        destination,
        config,
      });
      const names = manifest.files.map((file) => file.path);
      expect(
        names.filter((name) => /enrollment|rekor|witness|trust/.test(name)),
      ).toEqual([]);
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory()
            ? walk(path.join(dir, entry.name))
            : [path.join(dir, entry.name)],
        );
      for (const file of walk(destination)) {
        const content = readFileSync(file);
        expect(content.includes("ENROLLMENT-MARKER")).toBe(false);
        expect(content.includes("WITNESS-MARKER")).toBe(false);
      }
      // The MCP server serves only the context index of the project root,
      // and nothing indexed there comes from the per-user base.
      expect(snapshot.fileCount).toBe(1);
    },
    60000,
  );
});
