import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import * as promotionAuthority from "../src/promotion-authority.js";
import { inspectPromotionImportPreflight } from "../src/promotion-authority.js";
import {
  MAX_GRANT_LIFETIME_MS,
  STRICT_POLICY_HASH,
  promotionGrantRequestSchema,
} from "../src/promotion-grant-request.js";
import {
  checkCalibrationDisjoint,
  checkEnrollment,
  checkMeasuredCost,
  checkPolicyAndCohort,
  compareFrozenDigests,
  preparePromotionGrantRequest,
  readPromotionBundle,
  requireDistinctSigners,
  requireDistinctUsedKeys,
  requireReadinessInputs,
  type SignerClaim,
} from "../src/promotion-importer.js";
import { PromotionImportRefusalError } from "../src/promotion-refusal-codes.js";
import {
  buildLivePromotionRoute,
  grantedPromotionRouteSchema,
} from "../src/promotion-route.js";
import {
  PROMOTION_TRUST_ANCHOR_PATHS,
  inspectPromotionTrustAnchorFile,
  promotionTrustAnchorPath,
  promotionTrustAnchorSchema,
  readPromotionTrustAnchor,
} from "../src/promotion-trust-anchor.js";
import { canonicalJson, hashJson } from "../src/sealed-collection-schema.js";
import * as sealedReadiness from "../src/sealed-evidence-readiness.js";
import * as signedApproval from "../src/signed-promotion-approval.js";
import {
  SIGNED_PROMOTION_APPROVAL_DOMAIN,
  inspectSignedPromotionApproval,
} from "../src/signed-promotion-approval.js";
import { hash } from "../src/util.js";
import {
  declaredSelectionAggregateFixture,
  nowMs,
} from "./sealed-aggregate-fixture.js";

const execute = promisify(execFile);
const STEP_ONE = [
  "trust-anchor-platform-unsupported",
  "trust-anchor-absent",
  "trust-anchor-unprotected",
  "trust-anchor-invalid",
  "controller-not-selected",
];
const unix = process.platform === "darwin" || process.platform === "linux";
const directories: string[] = [];
const temporary = async (label: string) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), `graph-${label}-`));
  directories.push(directory);
  return directory;
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const refusal = async (run: () => unknown): Promise<string> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof PromotionImportRefusalError) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
};
const snapshot = async (directory: string) => {
  const files: Record<string, string> = {};
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else
        files[path.relative(directory, full)] = createHash("sha256")
          .update(await readFile(full))
          .digest("hex");
    }
  };
  await walk(directory);
  return files;
};

/**
 * A synthetic bundle built from the fully signed aggregate fixture: signed
 * held-out row reviews, signed aggregate provenance, original bytes, and an
 * operator approval signed with a throwaway key. It is never real evidence.
 */
async function signedSyntheticBundle() {
  const template = await declaredSelectionAggregateFixture();
  const { originalArtifacts, ...aggregateInput } = template.input;
  const { cohort, preflightPins: target } = aggregateInput;
  const preflight = await inspectPromotionImportPreflight(cohort, target);
  const keys = generateKeyPairSync("ed25519");
  const pin = {
    version: "1.0.0" as const,
    kind: "promotion-approval-key-pin" as const,
    projectId: target.projectId,
    policyVersion: target.policyVersion,
    collectionId: target.collectionId,
    operatorId: "fixture-operator",
    keyId: "fixture-approval-key",
    publicKeyPem: keys.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    publicKeySha256: createHash("sha256")
      .update(keys.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
  };
  const unsigned = {
    version: "1.0.0" as const,
    kind: "signed-promotion-approval" as const,
    keyId: pin.keyId,
    payload: {
      version: "1.0.0" as const,
      kind: "promotion-approval-claim" as const,
      approvalId: "fixture-approval",
      operatorId: pin.operatorId,
      target,
      preflightSha256: hashJson(preflight),
      reportSha256: preflight.reportSha256!,
      approvedAt: "2026-01-02T04:00:00.000Z",
      expiresAt: "2026-01-04T00:00:00.000Z",
    },
  };
  const envelope = {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(SIGNED_PROMOTION_APPROVAL_DOMAIN + canonicalJson(unsigned)),
      keys.privateKey,
    ).toString("base64"),
  };
  // The approval signature is genuinely valid against its throwaway pin.
  const verified = await inspectSignedPromotionApproval(
    cohort,
    target,
    pin,
    envelope,
    { nowMs },
  );
  expect(verified.signatureVerifiedAgainstCallerPin).toBe(true);
  expect(verified.promotionEligible).toBe(false);

  const bundle = await temporary("promotion-bundle");
  const write = async (name: string, value: unknown) => {
    await mkdir(path.dirname(path.join(bundle, name)), { recursive: true });
    await writeFile(path.join(bundle, name), JSON.stringify(value));
  };
  const manifest = {
    version: "1.0.0",
    kind: "sealed-original-byte-manifest",
    collectionId: target.collectionId,
    planSha256: target.planSha256,
    entries: originalArtifacts
      .map(({ role, sha256, bytesBase64 }) => ({
        role,
        sha256,
        bytes: Buffer.from(bytesBase64, "base64").length,
      }))
      .sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0)),
  };
  await mkdir(path.join(bundle, "originals"));
  for (const { sha256, bytesBase64 } of originalArtifacts)
    await writeFile(
      path.join(bundle, "originals", sha256),
      Buffer.from(bytesBase64, "base64"),
    );
  await write("aggregate.json", aggregateInput);
  await write("aggregate-manifest.json", manifest);
  await write("pins.json", target);
  await write("approval/target.json", target);
  await write("approval/pin.json", pin);
  await write("approval/envelope.json", envelope);
  await write("policy.json", { ...DEFAULT_POLICY, decisionMode: "promoted" });
  await write("route.json", {
    note: "requested route; step 10 would recompute it",
  });
  await write("bundle.json", {
    version: "1.0.0",
    kind: "promotion-grant-bundle",
    projectId: target.projectId,
    collectionId: target.collectionId,
    readiness: {
      population: {
        input: "population/input.json",
        trust: "population/trust.json",
        pins: "population/pins.json",
      },
      aggregate: {
        input: "aggregate.json",
        manifest: "aggregate-manifest.json",
        manifestSha256: hashJson(manifest),
      },
    },
    originalsDirectory: "originals",
    candidatePolicy: "policy.json",
    routes: [
      {
        category: target.category,
        preflightPins: "pins.json",
        requestedRoute: "route.json",
        approval: {
          target: "approval/target.json",
          pin: "approval/pin.json",
          envelope: "approval/envelope.json",
        },
        lease: {
          notBefore: "2026-01-02T05:00:00.000Z",
          notAfter: "2026-01-03T05:00:00.000Z",
        },
      },
    ],
  });
  return bundle;
}

describe("verify-only importer", () => {
  it("refuses a synthetic cohort with signed reviews, aggregate and approval at step 1 because no controller is selected", async () => {
    const bundle = await signedSyntheticBundle();
    const project = await temporary("promotion-project");
    const before = await snapshot(bundle);
    const anchorPath = unix ? promotionTrustAnchorPath() : undefined;
    const anchorExisted = anchorPath ? existsSync(anchorPath) : false;
    const audits = [
      vi.spyOn(sealedReadiness, "inspectSealedEvidenceReadiness"),
      vi.spyOn(promotionAuthority, "inspectPromotionImportPreflight"),
      vi.spyOn(signedApproval, "inspectSignedPromotionApproval"),
    ];
    const result = await preparePromotionGrantRequest(project, bundle);
    expect(result).toMatchObject({
      kind: "promotion-grant-preparation",
      outcome: "refused",
      step: 1,
      signed: false,
      promotionEligible: false,
    });
    expect(result).not.toHaveProperty("requests");
    if (result.outcome !== "refused") throw new Error("unreachable");
    expect(STEP_ONE).toContain(result.refusal);
    if (!unix) expect(result.refusal).toBe("trust-anchor-platform-unsupported");
    else if (!anchorExisted) expect(result.refusal).toBe("trust-anchor-absent");
    // Nothing past step 1 ran, and nothing was written or created.
    for (const audit of audits) expect(audit).not.toHaveBeenCalled();
    expect(await snapshot(bundle)).toEqual(before);
    expect(await readdir(project)).toEqual([]);
    if (anchorPath) expect(existsSync(anchorPath)).toBe(anchorExisted);
  }, 60000);

  it("CLI promotion prepare-grant exits 1 with the step 1 refusal and writes nothing", async () => {
    const bundle = await signedSyntheticBundle();
    const project = await temporary("promotion-cli");
    await writeFile(path.join(project, "sentinel"), "unchanged");
    const before = await snapshot(bundle);
    const result = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
        "-C",
        project,
        "promotion",
        "prepare-grant",
        bundle,
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        timeout: 30000,
        maxBuffer: 1_000_000,
        windowsHide: true,
      },
    ).then(
      () => {
        throw new Error("prepare-grant unexpectedly succeeded");
      },
      (error) => error,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const refused = JSON.parse(result.stderr);
    expect(refused).toMatchObject({
      outcome: "refused",
      step: 1,
      signed: false,
      promotionEligible: false,
    });
    expect(STEP_ONE).toContain(refused.refusal);
    expect(await snapshot(bundle)).toEqual(before);
    expect(await readdir(project)).toEqual(["sentinel"]);
  }, 60000);
});

describe("D3 trust anchor reader (read-only)", () => {
  it("compiles one anchor path per supported platform and refuses others", async () => {
    expect(promotionTrustAnchorPath("darwin")).toBe(
      "/Library/Application Support/GraphEngineering/promotion-trust-anchor.json",
    );
    expect(promotionTrustAnchorPath("linux")).toBe(
      "/etc/graph-engineering/promotion-trust-anchor.json",
    );
    expect(Object.isFrozen(PROMOTION_TRUST_ANCHOR_PATHS)).toBe(true);
    for (const platform of ["win32", "freebsd", "aix"] as const) {
      expect(await refusal(() => promotionTrustAnchorPath(platform))).toBe(
        "trust-anchor-platform-unsupported",
      );
      expect(
        await refusal(() =>
          inspectPromotionTrustAnchorFile("/etc/anchor.json", platform),
        ),
      ).toBe("trust-anchor-platform-unsupported");
    }
    const anchorPath = unix ? promotionTrustAnchorPath() : undefined;
    const existed = anchorPath ? existsSync(anchorPath) : false;
    expect(STEP_ONE).toContain(await refusal(() => readPromotionTrustAnchor()));
    if (anchorPath) expect(existsSync(anchorPath)).toBe(existed);
  });

  it.runIf(unix)(
    "refuses an absent, user-owned, symlinked or non-canonical anchor",
    async () => {
      const directory = await temporary("promotion-anchor");
      const valid = {
        version: "1.0.0",
        kind: "graph-engineering-promotion-trust-anchor",
        enrolledProjects: [
          { projectId: "fixture", repositoryIdentitySha256: "1".repeat(64) },
        ],
        approverKeys: [
          {
            operatorId: "owner",
            keyId: "approver",
            publicKeySha256: "2".repeat(64),
          },
        ],
        issuerKeys: [
          {
            issuerId: "issuer",
            keyId: "issuer",
            publicKeySha256: "3".repeat(64),
          },
        ],
        witnessId: "witness",
        controllers: {
          witness: "none",
          custody: "none",
          modelIdentity: "none",
        },
      };
      const file = path.join(directory, "anchor.json");
      await writeFile(file, JSON.stringify(valid), { mode: 0o644 });
      expect(
        await refusal(() =>
          inspectPromotionTrustAnchorFile(path.join(directory, "missing.json")),
        ),
      ).toBe("trust-anchor-absent");
      // Owned by this user (or under a world-writable temp directory).
      expect(await refusal(() => inspectPromotionTrustAnchorFile(file))).toBe(
        "trust-anchor-unprotected",
      );
      const link = path.join(directory, "link.json");
      await symlink(file, link);
      expect(await refusal(() => inspectPromotionTrustAnchorFile(link))).toBe(
        "trust-anchor-unprotected",
      );
      expect(
        await refusal(() => inspectPromotionTrustAnchorFile("anchor.json")),
      ).toBe("trust-anchor-invalid");
      expect(
        await refusal(() =>
          inspectPromotionTrustAnchorFile(`${directory}/../anchor.json`),
        ),
      ).toBe("trust-anchor-invalid");
      expect(await readdir(directory)).toEqual(["anchor.json", "link.json"]);
    },
  );

  it("accepts only none controllers from the closed registries in the anchor schema", () => {
    const anchor = {
      version: "1.0.0",
      kind: "graph-engineering-promotion-trust-anchor",
      enrolledProjects: [
        { projectId: "fixture", repositoryIdentitySha256: "1".repeat(64) },
      ],
      approverKeys: [
        { operatorId: "owner", keyId: "a", publicKeySha256: "2".repeat(64) },
      ],
      issuerKeys: [
        { issuerId: "kevin", keyId: "i", publicKeySha256: "3".repeat(64) },
      ],
      witnessId: "witness",
      controllers: { witness: "none", custody: "none", modelIdentity: "none" },
    };
    expect(promotionTrustAnchorSchema.safeParse(anchor).success).toBe(true);
    for (const controllers of [
      { witness: "reference", custody: "none", modelIdentity: "none" },
      { witness: "none", custody: "local-keys", modelIdentity: "none" },
      { witness: "none", custody: "none", modelIdentity: "self-report" },
      { witness: "none", custody: "none", modelIdentity: "toString" },
      { witness: "none", custody: "none" },
    ])
      expect(
        promotionTrustAnchorSchema.safeParse({ ...anchor, controllers })
          .success,
      ).toBe(false);
    expect(
      promotionTrustAnchorSchema.safeParse({ ...anchor, verified: true })
        .success,
    ).toBe(false);
  });
});

const baseRoute = () =>
  grantedPromotionRouteSchema.parse({
    ...buildLivePromotionRoute({
      projectId: "fixture",
      policy: { ...DEFAULT_POLICY, decisionMode: "promoted" },
      category: "worker",
      provider: {
        id: "laya",
        endpoint: "http://127.0.0.1:7337/v1/decide",
        model: "fixture-only",
        maxStateChars: 20000,
      },
      providers: [
        {
          id: "laya",
          endpoint: "http://127.0.0.1:7337/v1/decide",
          model: "fixture-only",
          maxStateChars: 20000,
        },
      ],
    }),
    repositoryIdentitySha256: "1".repeat(64),
    stateFormatVersion: "decision-state-v1",
    expectedModel: "fixture-only",
    modelIdentitySha256: "2".repeat(64),
    modelIdentityEvidence: "runtime-attestation",
    candidateConfigurationSha256: "3".repeat(64),
  });
// An unsigned request shape for schema tests; it is never a grant.
const request = () => {
  const route = baseRoute();
  return {
    version: "1.0.0",
    kind: "unsigned-promotion-grant-request",
    purpose: "graph-engineering/promotion-runtime-grant/v1",
    signed: false,
    grantId: "4".repeat(64),
    route,
    policyIdentity: {
      algorithm: STRICT_POLICY_HASH,
      policyVersion: route.policyVersion,
    },
    evidence: {
      collectionId: "fixture-collection",
      planSha256: "5".repeat(64),
      trustPolicySha256: "6".repeat(64),
      evaluationArtifactSha256: "7".repeat(64),
      reportSha256: "8".repeat(64),
      preflightSha256: "9".repeat(64),
      readinessSha256: "a".repeat(64),
    },
    routeMetrics: {
      calibrationCount: 50,
      calibrationAccuracy: 0.95,
      heldOutCount: 200,
      taskCount: 60,
      calibrationError: 0.05,
      minimumConfidence: 0.9,
    },
    wholeCohort: {
      baselineMeasuredApiCostUsd: 10,
      candidateMeasuredApiCostUsd: 9,
      candidatePolicyViolationAssignments: 0,
      additionalFailureTasks: 0,
    },
    approval: {
      approvalId: "approval",
      operatorId: "owner",
      approvalClaimSha256: "b".repeat(64),
      approverKeySha256: "c".repeat(64),
      approvedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-31T00:00:00.000Z",
    },
    lease: {
      notBefore: "2026-01-01T00:00:00.000Z",
      notAfter: "2026-01-08T00:00:00.000Z",
    },
    witness: {
      witnessId: "witness",
      openingCheckpointSha256: "d".repeat(64),
      closingCheckpointSha256: "d".repeat(64),
    },
  };
};

describe("unsigned grant-request schema (owner decisions as constraints)", () => {
  it("bounds grant lifetime to 7 days within the approval and the approval to 30 days", () => {
    // The boundary shape parses; an unsigned request is never a grant.
    expect(promotionGrantRequestSchema.safeParse(request()).success).toBe(true);
    expect(MAX_GRANT_LIFETIME_MS).toBe(7 * 24 * 60 * 60 * 1000);
    const bad = (change: (value: ReturnType<typeof request>) => void) => {
      const value = request();
      change(value);
      return promotionGrantRequestSchema.safeParse(value).success;
    };
    expect(
      bad((value) => (value.lease.notAfter = "2026-01-08T00:00:00.001Z")),
    ).toBe(false);
    expect(
      bad((value) => {
        value.approval.expiresAt = "2026-01-05T00:00:00.000Z";
      }),
    ).toBe(false);
    expect(
      bad((value) => (value.lease.notBefore = "2025-12-31T23:59:59.999Z")),
    ).toBe(false);
    expect(bad((value) => (value.lease.notAfter = value.lease.notBefore))).toBe(
      false,
    );
    expect(
      bad((value) => (value.approval.expiresAt = "2026-01-31T00:00:00.001Z")),
    ).toBe(false);
  });

  it("requires runtime attestation, the strict policy hash and every numeric gate", () => {
    const bad = (change: (value: any) => void) => {
      const value: any = request();
      change(value);
      return promotionGrantRequestSchema.safeParse(value).success;
    };
    for (const evidence of ["self-report", "provider-signature", null])
      expect(
        bad((value) => (value.route.modelIdentityEvidence = evidence)),
      ).toBe(false);
    for (const algorithm of ["canonical-json", "governed-subset"])
      expect(bad((value) => (value.policyIdentity.algorithm = algorithm))).toBe(
        false,
      );
    expect(
      bad((value) => (value.policyIdentity.policyVersion = "e".repeat(64))),
    ).toBe(false);
    for (const [field, number] of [
      ["calibrationCount", 49],
      ["heldOutCount", 199],
      ["taskCount", 59],
      ["calibrationError", 0.051],
      ["calibrationAccuracy", 0.949],
    ] as const)
      expect(bad((value) => (value.routeMetrics[field] = number))).toBe(false);
    expect(
      bad((value) => (value.wholeCohort.candidateMeasuredApiCostUsd = 10)),
    ).toBe(false);
    expect(
      bad(
        (value) => (value.wholeCohort.candidatePolicyViolationAssignments = 1),
      ),
    ).toBe(false);
    expect(bad((value) => (value.wholeCohort.additionalFailureTasks = 1))).toBe(
      false,
    );
    for (const extra of ["promotionEligible", "verified", "authority"])
      expect(bad((value) => (value[extra] = true))).toBe(false);
    expect(bad((value) => (value.signed = true))).toBe(false);
    expect(bad((value) => (value.route = [value.route, value.route]))).toBe(
      false,
    );
  });
});

describe("importer step checks refuse with closed codes", () => {
  it("step 2 refuses an unenrolled project or a different repository", async () => {
    const anchor = {
      enrolledProjects: [
        { projectId: "fixture", repositoryIdentitySha256: "1".repeat(64) },
      ],
    };
    expect(
      await refusal(() => checkEnrollment(anchor, "other", "1".repeat(64))),
    ).toBe("project-not-enrolled");
    expect(
      await refusal(() => checkEnrollment(anchor, "fixture", "2".repeat(64))),
    ).toBe("repository-identity-mismatch");
    expect(
      await refusal(() =>
        checkEnrollment(
          {
            enrolledProjects: [
              ...anchor.enrolledProjects,
              ...anchor.enrolledProjects,
            ],
          },
          "fixture",
          "1".repeat(64),
        ),
      ),
    ).toBe("project-not-enrolled");
  });

  it("step 3 refuses a bundle missing any readiness input or escaping its directory", async () => {
    const bundle = await signedSyntheticBundle();
    const loaded = await refusal(() => readPromotionBundle(bundle));
    // The synthetic bundle names population files it does not carry.
    expect(loaded).toBe("bundle-invalid");
    const manifest = JSON.parse(
      await readFile(path.join(bundle, "bundle.json"), "utf8"),
    );
    expect(await refusal(() => requireReadinessInputs(manifest))).toBe(
      "readiness-input-missing",
    );
    for (const escape of ["../outside.json", "/etc/passwd", "a\\b.json"]) {
      await writeFile(
        path.join(bundle, "bundle.json"),
        JSON.stringify({ ...manifest, candidatePolicy: escape }),
      );
      expect(await refusal(() => readPromotionBundle(bundle))).toBe(
        "bundle-invalid",
      );
    }
    if (unix) {
      await mkdir(path.join(bundle, "population"));
      for (const name of ["input", "trust", "pins"])
        await writeFile(path.join(bundle, "population", `${name}.json`), "{}");
      await rm(path.join(bundle, "policy.json"));
      await symlink(
        path.join(bundle, "pins.json"),
        path.join(bundle, "policy.json"),
      );
      await writeFile(
        path.join(bundle, "bundle.json"),
        JSON.stringify(manifest),
      );
      expect(await refusal(() => readPromotionBundle(bundle))).toBe(
        "bundle-invalid",
      );
    }
  }, 60000);

  it("step 4 refuses digests that differ from the witness's pre-run freeze", async () => {
    const local = {
      rowTrustSha256: "1".repeat(64),
      planSha256: "2".repeat(64),
    };
    expect(compareFrozenDigests({ ...local }, local)).toBeUndefined();
    for (const frozen of [
      { ...local, rowTrustSha256: "3".repeat(64) },
      { rowTrustSha256: "1".repeat(64) },
      { ...local, extraSha256: "4".repeat(64) },
    ])
      expect(await refusal(() => compareFrozenDigests(frozen, local))).toBe(
        "witness-freeze-mismatch",
      );
  });

  it("step 6 refuses calibration rows that overlap the held-out cohort", async () => {
    const inspection = {
      plan: { tasks: [{ taskId: "held-1", stableTaskId: "stable-1" }] },
    };
    for (const row of [
      { taskId: "held-1", caseId: "case-1" },
      { taskId: "calibration-1", caseId: "stable-1" },
    ])
      expect(
        await refusal(() =>
          checkCalibrationDisjoint({ rows: [row] }, inspection),
        ),
      ).toBe("calibration-held-out-overlap");
    expect(
      checkCalibrationDisjoint(
        { rows: [{ taskId: "calibration-1", caseId: "case-1" }] },
        inspection,
      ),
    ).toBeUndefined();
  });

  it("step 7 refuses unmeasured, equal or higher candidate cost", async () => {
    const projection = (baseline: number, candidate: number) => ({
      wholeCohortAccounting: {
        baselineMeasuredApiCostUsd: baseline,
        candidateMeasuredApiCostUsd: candidate,
      },
    });
    expect(await refusal(() => checkMeasuredCost(null))).toBe(
      "cost-not-measured",
    );
    expect(await refusal(() => checkMeasuredCost(projection(1, 1)))).toBe(
      "cost-not-lower",
    );
    expect(await refusal(() => checkMeasuredCost(projection(1, 2)))).toBe(
      "cost-not-lower",
    );
    expect(await refusal(() => checkMeasuredCost(projection(NaN, 0)))).toBe(
      "cost-not-measured",
    );
  });

  it("step 8 refuses a custody pin whose key differs from the key the bundle used", async () => {
    const claim = (
      role: SignerClaim["role"],
      keyId: string,
      key: string,
      actor: string,
    ): SignerClaim => ({
      role,
      keyId,
      actorId: actor,
      publicKeySha256: key.repeat(64),
    });
    const claims = [
      claim("labeler", "l", "1", "a"),
      claim("reviewer", "r", "2", "b"),
    ];
    expect(requireDistinctSigners(claims, claims)).toBeUndefined();
    expect(
      await refusal(() =>
        requireDistinctSigners(claims, [undefined, undefined]),
      ),
    ).toBe("signer-key-unresolved");
    expect(
      await refusal(() =>
        requireDistinctSigners(claims, [
          claim("reviewer", "l", "1", "a"),
          claims[1]!,
        ]),
      ),
    ).toBe("signer-key-unresolved");
    // Same role and key ID, another key: the name matches, the key does not.
    expect(
      await refusal(() =>
        requireDistinctSigners(claims, [
          claim("labeler", "l", "9", "a"),
          claims[1]!,
        ]),
      ),
    ).toBe("signer-key-mismatch");
    expect(
      await refusal(() =>
        requireDistinctSigners(claims, [
          claim("labeler", "l", "1", "someone-else"),
          claims[1]!,
        ]),
      ),
    ).toBe("signer-key-mismatch");
  });

  it("step 8 refuses one used key or actor across two roles", async () => {
    const used = (role: SignerClaim["role"], key: string, actor: string) => ({
      role,
      keyId: `${role}-key`,
      actorId: actor,
      publicKeySha256: key.repeat(64),
    });
    expect(
      await refusal(() =>
        requireDistinctUsedKeys([
          used("worker", "1", "w"),
          used("oracle", "1", "o"),
        ]),
      ),
    ).toBe("signer-keys-not-distinct");
    expect(
      await refusal(() =>
        requireDistinctUsedKeys([
          used("worker", "1", "same"),
          used("oracle", "2", "same"),
        ]),
      ),
    ).toBe("signer-keys-not-distinct");
    // Custody cannot hide reuse: matching pins still refuse.
    const claims = [used("labeler", "1", "a"), used("reviewer", "1", "b")];
    expect(await refusal(() => requireDistinctSigners(claims, claims))).toBe(
      "signer-keys-not-distinct",
    );
  });

  it("step 9 refuses other policy bytes, shadow mode, unlisted categories and a partial cohort", async () => {
    const policy = {
      ...DEFAULT_POLICY,
      decisionMode: "promoted" as const,
      promotedCategories: ["worker", "effort"],
    };
    const version = hash(policy);
    const routes = [
      { category: "worker", policyVersion: version },
      { category: "effort", policyVersion: version },
    ];
    expect(checkPolicyAndCohort(policy, policy, routes)).toBeUndefined();
    // Strict hash: the same fields in another key order are other bytes.
    const reordered = Object.fromEntries(Object.entries(policy).reverse());
    expect(
      await refusal(() => checkPolicyAndCohort(reordered, policy, routes)),
    ).toBe("policy-bytes-mismatch");
    expect(
      await refusal(() =>
        checkPolicyAndCohort(policy, policy, [
          routes[0]!,
          { category: "effort", policyVersion: "0".repeat(64) },
        ]),
      ),
    ).toBe("policy-bytes-mismatch");
    const shadow = { ...policy, decisionMode: "shadow" as const };
    expect(
      await refusal(() =>
        checkPolicyAndCohort(shadow, shadow, [
          { category: "worker", policyVersion: hash(shadow) },
          { category: "effort", policyVersion: hash(shadow) },
        ]),
      ),
    ).toBe("category-not-promoted");
    expect(
      await refusal(() =>
        checkPolicyAndCohort(policy, policy, [
          ...routes,
          { category: "stop", policyVersion: version },
        ]),
      ),
    ).toBe("category-not-promoted");
    expect(
      await refusal(() => checkPolicyAndCohort(policy, policy, [routes[0]!])),
    ).toBe("cohort-routes-incomplete");
  });
});
