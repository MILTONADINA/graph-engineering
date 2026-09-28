// Verify-only promotion importer: `graph-engine promotion prepare-grant`
// (docs/promotion-trust-boundary.md, "Importer (verify-only)"). It runs the
// eleven steps in order and stops at the first refusal with a closed code.
// It NEVER signs, NEVER writes a grant or any other file, NEVER touches the
// private authority map, and NEVER sets promotionEligible. When every step
// passes it returns UNSIGNED grant requests, one per route and report, for
// the independent issuer. Promotion is all-or-nothing: the whole cohort is
// verified once, then every requested route against it, and any failure
// refuses every route.
//
// The only entry point takes a project root and a bundle directory. The D3
// anchor comes from its compiled path and selects controllers from closed
// registries that hold only "none", so every run stops at step 1 today.
// Behind step 1, steps 4, 8, 10 and 11 would also refuse through the "none"
// witness, custody and attestor.
import { createHash, createPublicKey, randomBytes } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { ProjectPolicy } from "@graph-engineering/contracts";
import { z } from "zod";
import { decisionProviders } from "./decisions.js";
import {
  freezeCohortCalibration,
  type FullCohortEvaluationInput,
} from "./full-cohort-evaluation.js";
import { inspectPromotionImportPreflight } from "./promotion-authority.js";
import {
  anyControllerUnselected,
  promotionControllersFor,
  WitnessNotSelectedError,
  type EvidenceSignerRole,
  type PromotionControllers,
  type PublicKeyPin,
  type SignedCollectionCheckpoint,
  type SignedGrantStatus,
} from "./promotion-controllers.js";
import {
  PROMOTION_RUNTIME_GRANT_PURPOSE,
  STRICT_POLICY_HASH,
  promotionGrantRequestSchema,
  type PromotionGrantRequest,
} from "./promotion-grant-request.js";
import {
  PromotionImportRefusalError,
  type PromotionImportRefusal,
} from "./promotion-refusal-codes.js";
import {
  buildLivePromotionRoute,
  grantedPromotionRouteSchema,
  type GrantedPromotionRoute,
} from "./promotion-route.js";
import {
  readPromotionTrustAnchor,
  type PromotionTrustAnchor,
} from "./promotion-trust-anchor.js";
import { projectDataDir, loadProject } from "./project.js";
import {
  LIMITS,
  decodeJson,
  digestSchema,
  hashJson,
  parseBoundedJson,
} from "./sealed-collection-schema.js";
import { inspectSealedEvidenceReadiness } from "./sealed-evidence-readiness.js";
import { withPrivateSealedIdentityFileReader } from "./sealed-identity-file-reader.js";
import { inspectSignedPromotionApproval } from "./signed-promotion-approval.js";
import { checked, hash } from "./util.js";

const refuse = (code: PromotionImportRefusal, detail?: string): never => {
  throw new PromotionImportRefusalError(code, detail);
};
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const relative = z
  .string()
  .min(1)
  .max(400)
  .refine(
    (value) =>
      !/[\\:\x00-\x1f]/.test(value) &&
      value.split("/").every((part) => part && part !== "." && part !== ".."),
    "Expected a bundle-relative path",
  );
const time = z.string().datetime();

export const promotionBundleSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("promotion-grant-bundle"),
    projectId: name,
    collectionId: name,
    readiness: z
      .object({
        population: z
          .object({ input: relative, trust: relative, pins: relative })
          .strict(),
        aggregate: z
          .object({
            input: relative,
            manifest: relative,
            manifestSha256: digestSchema,
          })
          .strict(),
        identityBytes: z
          .object({ manifest: relative, manifestSha256: digestSchema })
          .strict()
          .optional(),
        workerDeliveries: relative.optional(),
        workerKeyFingerprintRegistry: relative.optional(),
        sourceAttestation: z
          .object({ pin: relative, envelope: relative })
          .strict()
          .optional(),
        sourceKeyFingerprintRegistry: relative.optional(),
        oracleExecutions: relative.optional(),
        oracleKeyFingerprintRegistry: relative.optional(),
      })
      .strict(),
    /** Original artifact bytes, one file per SHA-256. */
    originalsDirectory: relative,
    /** Identity-only bytes, one owner-only file per SHA-256. */
    identityDirectory: relative.optional(),
    /** The audited candidate policy, as the project will run it. */
    candidatePolicy: relative,
    routes: z
      .array(
        z
          .object({
            category: name,
            preflightPins: relative,
            requestedRoute: relative,
            approval: z
              .object({ target: relative, pin: relative, envelope: relative })
              .strict(),
            lease: z.object({ notBefore: time, notAfter: time }).strict(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
type BundleManifest = z.infer<typeof promotionBundleSchema>;

/** Bundle JSON loaded read-only; readers are built only by the importer. */
export interface PromotionBundle {
  root: string;
  manifest: BundleManifest;
  documents: Map<string, unknown>;
}

async function safeFile(root: string, relativePath: string, limit: number) {
  const filename = path.join(root, ...relativePath.split("/"));
  const info = await lstat(filename).catch(() =>
    refuse("bundle-invalid", `missing bundle file ${relativePath}`),
  );
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
    refuse("bundle-invalid", `unsafe bundle file ${relativePath}`);
  if ((await realpath(filename)) !== filename)
    refuse("bundle-invalid", `bundle file ${relativePath} leaves the bundle`);
  return { filename, info };
}

async function readSafe(
  root: string,
  relativePath: string,
  limit: number,
  expectedBytes?: number,
): Promise<Buffer> {
  const { filename, info } = await safeFile(root, relativePath, limit);
  if (expectedBytes !== undefined && info.size !== expectedBytes)
    refuse("bundle-invalid", `bundle file ${relativePath} has the wrong size`);
  const handle = await open(filename, "r");
  try {
    const opened = await handle.stat();
    if (opened.ino !== info.ino || opened.size !== info.size)
      refuse("bundle-invalid", `bundle file ${relativePath} changed`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Read the bundle manifest and every JSON document it names. Never writes. */
export async function readPromotionBundle(
  bundleDir: string,
): Promise<PromotionBundle> {
  const absolute = path.resolve(bundleDir);
  const root = await realpath(absolute).catch(() =>
    refuse("bundle-invalid", "bundle directory is missing"),
  );
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory())
    refuse("bundle-invalid", "bundle is not a directory");
  const parseJson = (bytes: Buffer, label: string) => {
    try {
      return parseBoundedJson(bytes.toString("utf8"));
    } catch {
      return refuse("bundle-invalid", `${label} is not bounded JSON`);
    }
  };
  const parsed = promotionBundleSchema.safeParse(
    parseJson(await readSafe(root, "bundle.json", LIMITS.bytes), "bundle.json"),
  );
  if (!parsed.success)
    return refuse("bundle-invalid", "bundle.json differs from its schema");
  const manifest = parsed.data;
  const { readiness } = manifest;
  const files = [
    readiness.population.input,
    readiness.population.trust,
    readiness.population.pins,
    readiness.aggregate.input,
    readiness.aggregate.manifest,
    readiness.identityBytes?.manifest,
    readiness.workerDeliveries,
    readiness.workerKeyFingerprintRegistry,
    readiness.sourceAttestation?.pin,
    readiness.sourceAttestation?.envelope,
    readiness.sourceKeyFingerprintRegistry,
    readiness.oracleExecutions,
    readiness.oracleKeyFingerprintRegistry,
    manifest.candidatePolicy,
    ...manifest.routes.flatMap((route) => [
      route.preflightPins,
      route.requestedRoute,
      route.approval.target,
      route.approval.pin,
      route.approval.envelope,
    ]),
  ].filter((file): file is string => file !== undefined);
  const documents = new Map<string, unknown>();
  for (const file of files)
    if (!documents.has(file))
      documents.set(
        file,
        parseJson(await readSafe(root, file, LIMITS.bytes), file),
      );
  return { root, manifest, documents };
}

const doc = (bundle: PromotionBundle, file: string) => {
  if (!bundle.documents.has(file))
    refuse("bundle-invalid", `bundle document ${file} was not loaded`);
  return bundle.documents.get(file);
};

/** Step 2: the project must be enrolled in the anchor with its repository. */
export function checkEnrollment(
  anchor: Pick<PromotionTrustAnchor, "enrolledProjects">,
  projectId: string,
  repositoryIdentitySha256: string,
): void {
  const enrolled = anchor.enrolledProjects.filter(
    (project) => project.projectId === projectId,
  );
  if (enrolled.length !== 1)
    refuse("project-not-enrolled", `${projectId} is not enrolled once`);
  if (enrolled[0]!.repositoryIdentitySha256 !== repositoryIdentitySha256)
    refuse(
      "repository-identity-mismatch",
      "the repository differs from its enrollment",
    );
}

/** Recompute the repository identity from its root commits. */
export async function recomputeRepositoryIdentity(
  projectRoot: string,
): Promise<string> {
  const output = await checked("git", ["rev-list", "--max-parents=0", "HEAD"], {
    cwd: projectRoot,
  });
  const roots = output
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!roots.length || roots.some((root) => !/^[a-f0-9]{40,64}$/.test(root)))
    refuse("project-not-enrolled", "repository has no root commit");
  return hashJson({ kind: "git-root-commits", roots });
}

/** Step 3: every readiness input and its registry must be present. */
export function requireReadinessInputs(manifest: BundleManifest): void {
  const { readiness } = manifest;
  const missing = Object.entries({
    identityBytes: readiness.identityBytes,
    identityDirectory: manifest.identityDirectory,
    workerDeliveries: readiness.workerDeliveries,
    workerKeyFingerprintRegistry: readiness.workerKeyFingerprintRegistry,
    sourceAttestation: readiness.sourceAttestation,
    sourceKeyFingerprintRegistry: readiness.sourceKeyFingerprintRegistry,
    oracleExecutions: readiness.oracleExecutions,
    oracleKeyFingerprintRegistry: readiness.oracleKeyFingerprintRegistry,
  })
    .filter(([, value]) => value === undefined)
    .map(([key]) => key);
  if (missing.length)
    refuse("readiness-input-missing", `missing ${missing.join(", ")}`);
  const categories = manifest.routes.map((route) => route.category);
  if (new Set(categories).size !== categories.length)
    refuse("bundle-invalid", "a category is requested more than once");
}

const aggregateInputSchema = z
  .object({
    cohort: z
      .object({
        inspection: z.unknown(),
        pins: z.unknown(),
        calibration: z.unknown(),
        thresholds: z.unknown(),
        labels: z.unknown(),
        evaluation: z.unknown(),
      })
      .strict(),
    preflightPins: z.unknown(),
    rowTrust: z.unknown(),
    rowReviewBundles: z.unknown(),
    aggregateTrust: z.unknown(),
    aggregateTrustPin: z.unknown(),
    bundle: z.unknown(),
  })
  .strict();

/** The trust and registry digests the witness must have frozen before collection. */
export function bundleTrustDigests(
  bundle: PromotionBundle,
): Record<string, string> {
  const { readiness } = bundle.manifest;
  const aggregate = aggregateInputSchema.parse(
    doc(bundle, readiness.aggregate.input),
  );
  const optional = (file: string | undefined) =>
    file === undefined ? refuse("readiness-input-missing") : doc(bundle, file);
  return {
    populationTrustSha256: hashJson(doc(bundle, readiness.population.trust)),
    rowTrustSha256: hashJson(aggregate.rowTrust),
    aggregateTrustSha256: hashJson(aggregate.aggregateTrust),
    originalByteManifestSha256: readiness.aggregate.manifestSha256,
    identityByteManifestSha256:
      readiness.identityBytes?.manifestSha256 ??
      refuse("readiness-input-missing"),
    workerKeyFingerprintRegistrySha256: hashJson(
      optional(readiness.workerKeyFingerprintRegistry),
    ),
    sourceKeyFingerprintRegistrySha256: hashJson(
      optional(readiness.sourceKeyFingerprintRegistry),
    ),
    oracleKeyFingerprintRegistrySha256: hashJson(
      optional(readiness.oracleKeyFingerprintRegistry),
    ),
  };
}

/** Step 4: every local trust and registry digest must equal the frozen one. */
export function compareFrozenDigests(
  frozen: Readonly<Record<string, string>>,
  local: Readonly<Record<string, string>>,
): void {
  const keys = Object.keys(local).sort();
  const frozenKeys = Object.keys(frozen).sort();
  if (
    keys.length !== frozenKeys.length ||
    keys.some((key, index) => key !== frozenKeys[index]) ||
    keys.some((key) => frozen[key] !== local[key])
  )
    refuse(
      "witness-freeze-mismatch",
      "trust or registry digests differ from the witness's pre-run freeze",
    );
}

/** Step 6: calibration rows must share no task or case with the held-out cohort. */
export function checkCalibrationDisjoint(
  calibration: unknown,
  inspection: unknown,
): void {
  const rows = z
    .object({
      rows: z.array(
        z.object({ taskId: z.string(), caseId: z.string() }).passthrough(),
      ),
    })
    .passthrough()
    .parse(decodeJson(calibration)).rows;
  const tasks = z
    .object({
      plan: z
        .object({
          tasks: z.array(
            z
              .object({
                taskId: z.string(),
                stableTaskId: z.string().optional(),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    })
    .passthrough()
    .parse(decodeJson(inspection)).plan.tasks;
  const heldOut = new Set(
    tasks.flatMap((task) =>
      task.stableTaskId ? [task.taskId, task.stableTaskId] : [task.taskId],
    ),
  );
  if (rows.some((row) => heldOut.has(row.taskId) || heldOut.has(row.caseId)))
    refuse(
      "calibration-held-out-overlap",
      "calibration and held-out tasks overlap",
    );
}

/**
 * Step 6: decision accuracy on the route's calibration rows at or above its
 * fitted threshold (0 when none qualify). The request schema requires 0.95.
 */
export function routeCalibrationAccuracy(
  calibration: unknown,
  route: {
    category: string;
    provider: string;
    model: string;
    minimumConfidence: number;
  },
): number {
  const rows = z
    .object({
      rows: z.array(
        z
          .object({
            category: z.string(),
            provider: z.string(),
            model: z.string(),
            selected: z.string().nullable(),
            expected: z.string(),
            confidence: z.number(),
          })
          .passthrough(),
      ),
    })
    .passthrough()
    .parse(decodeJson(calibration)).rows;
  const accepted = rows.filter(
    (row) =>
      row.category === route.category &&
      row.provider === route.provider &&
      row.model === route.model &&
      row.selected !== null &&
      row.confidence >= route.minimumConfidence,
  );
  return accepted.length
    ? accepted.filter((row) => row.selected === row.expected).length /
        accepted.length
    : 0;
}

/** Step 7: whole-cohort cost must be measured on both arms, candidate strictly lower. */
export function checkMeasuredCost(
  projection: {
    wholeCohortAccounting: {
      baselineMeasuredApiCostUsd: number;
      candidateMeasuredApiCostUsd: number;
    };
  } | null,
): void {
  if (!projection)
    refuse("cost-not-measured", "whole-cohort cost is unknown or estimated");
  const { baselineMeasuredApiCostUsd: baseline, candidateMeasuredApiCostUsd } =
    projection!.wholeCohortAccounting;
  if (
    !Number.isFinite(baseline) ||
    !Number.isFinite(candidateMeasuredApiCostUsd)
  )
    refuse("cost-not-measured", "measured cost is not finite");
  if (!(candidateMeasuredApiCostUsd < baseline))
    refuse("cost-not-lower", "measured candidate cost is not strictly lower");
}

export interface SignerClaim {
  role: EvidenceSignerRole;
  keyId: string;
  actorId: string;
  /** SHA-256 of the SPKI key the bundle's trust files verify this signer with. */
  publicKeySha256: string;
}

/** Keys and actors actually used by the bundle must be pairwise distinct across roles. */
export function requireDistinctUsedKeys(claims: readonly SignerClaim[]): void {
  const keyRole = new Map<string, EvidenceSignerRole>();
  const actorRole = new Map<string, EvidenceSignerRole>();
  for (const claim of claims)
    for (const [map, value] of [
      [keyRole, claim.publicKeySha256],
      [actorRole, claim.actorId],
    ] as const) {
      const role = map.get(value);
      if (role !== undefined && role !== claim.role)
        refuse(
          "signer-keys-not-distinct",
          "one key or actor holds more than one role",
        );
      map.set(value, claim.role);
    }
}

/**
 * Step 8: every custody pin must name the same role, key ID and actor as the
 * signer it resolves AND carry the exact key the bundle used to verify that
 * signer's signatures. A matching name with another key is refused.
 */
export function requireDistinctSigners(
  claims: readonly SignerClaim[],
  resolved: readonly (PublicKeyPin | undefined)[],
): void {
  if (resolved.length !== claims.length)
    refuse("signer-key-unresolved", "signer inventory is incomplete");
  requireDistinctUsedKeys(claims);
  for (const [index, claim] of claims.entries()) {
    const pin = resolved[index];
    if (!pin || pin.role !== claim.role || pin.keyId !== claim.keyId)
      refuse(
        "signer-key-unresolved",
        `${claim.role} key ${claim.keyId} is not held by the selected custody`,
      );
    if (
      pin!.publicKeySha256 !== claim.publicKeySha256 ||
      pin!.actorId !== claim.actorId
    )
      refuse(
        "signer-key-mismatch",
        `${claim.role} key ${claim.keyId} differs from the key custody holds`,
      );
  }
}

/** SHA-256 of a canonical Ed25519 SPKI public key, as the inspectors compute it. */
export function publicKeyFingerprint(publicKeyPem: string): string {
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return refuse("signer-key-mismatch", "a signer public key is malformed");
  }
  if (
    key.asymmetricKeyType !== "ed25519" ||
    key.export({ type: "spki", format: "pem" }).toString() !== publicKeyPem
  )
    refuse("signer-key-mismatch", "a signer key is not canonical Ed25519");
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
}

const registryKeysSchema = z
  .object({
    keys: z.array(
      z
        .object({
          keyId: z.string(),
          actorId: z.string(),
          roles: z.array(z.string()),
          publicKeyPem: z.string(),
        })
        .passthrough(),
    ),
    revokedKeyIds: z.array(z.string()),
  })
  .passthrough();
const pinSchema = z
  .object({
    keyId: z.string(),
    publicKeyPem: z.string(),
    publicKeySha256: digestSchema,
  })
  .passthrough();
const pinRowsSchema = z.array(z.object({ pin: pinSchema }).passthrough());
const actorOf = (pin: Record<string, unknown>, field: string) =>
  typeof pin[field] === "string"
    ? (pin[field] as string)
    : refuse("signer-role-unknown", `a signer pin lacks ${field}`);

/**
 * Every key the bundle's trust files use to verify a signature, by role, with
 * the fingerprint derived from its public key. A registry key with no role or
 * a role its registry does not define is refused.
 */
export function collectSignerClaims(bundle: PromotionBundle): SignerClaim[] {
  const { readiness } = bundle.manifest;
  const aggregate = aggregateInputSchema.parse(
    doc(bundle, readiness.aggregate.input),
  );
  const claims: SignerClaim[] = [];
  const add = (claim: SignerClaim) => {
    if (
      !claims.some(
        (item) => item.role === claim.role && item.keyId === claim.keyId,
      )
    )
      claims.push(claim);
  };
  const registry = (
    input: unknown,
    roles: Readonly<Record<string, EvidenceSignerRole>>,
    label: string,
  ) => {
    const parsed = registryKeysSchema.safeParse(input);
    if (!parsed.success)
      refuse("signer-role-unknown", `${label} trust is not a key registry`);
    for (const key of parsed.data!.keys) {
      if (
        !key.roles.length ||
        key.roles.some((role) => !Object.hasOwn(roles, role))
      )
        refuse(
          "signer-role-unknown",
          `${label} key ${key.keyId} has no role or an unknown role`,
        );
      if (parsed.data!.revokedKeyIds.includes(key.keyId)) continue;
      const publicKeySha256 = publicKeyFingerprint(key.publicKeyPem);
      for (const role of key.roles)
        add({
          role: roles[role]!,
          keyId: key.keyId,
          actorId: key.actorId,
          publicKeySha256,
        });
    }
  };
  const pinned = (
    role: EvidenceSignerRole,
    input: unknown,
    actorField: string,
  ) => {
    const parsed = pinSchema.safeParse(input);
    if (!parsed.success)
      refuse("signer-key-mismatch", `a ${role} pin is malformed`);
    const pin = parsed.data!;
    const publicKeySha256 = publicKeyFingerprint(pin.publicKeyPem);
    if (publicKeySha256 !== pin.publicKeySha256)
      refuse(
        "signer-key-mismatch",
        `${role} pin fingerprint differs from its key`,
      );
    add({
      role,
      keyId: pin.keyId,
      actorId: actorOf(pin, actorField),
      publicKeySha256,
    });
  };
  registry(
    doc(bundle, readiness.population.trust),
    { selector: "selector", auditor: "auditor" },
    "population",
  );
  registry(
    aggregate.rowTrust,
    { labeler: "labeler", reviewer: "reviewer" },
    "row",
  );
  registry(
    aggregate.aggregateTrust,
    { collector: "collector", reviewer: "aggregate-reviewer" },
    "aggregate",
  );
  const must = (file: string | undefined) =>
    doc(bundle, file ?? refuse("readiness-input-missing"));
  const source =
    readiness.sourceAttestation ?? refuse("readiness-input-missing");
  pinned("source", doc(bundle, source.pin), "sourceAuthorityId");
  const rows = (file: string | undefined, label: string) => {
    const parsed = pinRowsSchema.safeParse(must(file));
    if (!parsed.success)
      refuse("signer-key-mismatch", `${label} pins are malformed`);
    return parsed.data!;
  };
  for (const row of rows(readiness.workerDeliveries, "worker"))
    pinned("worker", row.pin, "workerId");
  for (const row of rows(readiness.oracleExecutions, "oracle"))
    pinned("oracle", row.pin, "oracleExecutorId");
  for (const route of bundle.manifest.routes)
    pinned("approver", doc(bundle, route.approval.pin), "operatorId");
  return claims;
}

/** Step 9: audited policy bytes are the policy that will run, over the whole cohort. */
export function checkPolicyAndCohort(
  candidatePolicy: unknown,
  projectPolicy: Pick<ProjectPolicy, "decisionMode" | "promotedCategories">,
  routes: readonly { category: string; policyVersion: string }[],
): void {
  // Owner decision: the strict, key-order-sensitive util.hash(policy).
  const running = hash(projectPolicy);
  if (hash(candidatePolicy) !== running)
    refuse(
      "policy-bytes-mismatch",
      "audited candidate policy is not the policy that will run",
    );
  if (routes.some((route) => route.policyVersion !== running))
    refuse("policy-bytes-mismatch", "a route pins another policy version");
  if (projectPolicy.decisionMode !== "promoted")
    refuse("category-not-promoted", 'decisionMode is not "promoted"');
  if (
    routes.some(
      (route) => !projectPolicy.promotedCategories.includes(route.category),
    )
  )
    refuse("category-not-promoted", "a requested category is not promoted");
  const requested = new Set(routes.map((route) => route.category));
  if (
    requested.size !== projectPolicy.promotedCategories.length ||
    projectPolicy.promotedCategories.some(
      (category) => !requested.has(category),
    )
  )
    refuse(
      "cohort-routes-incomplete",
      "promotion is all-or-nothing across promotedCategories",
    );
}

class StepRefusal extends Error {
  constructor(
    readonly step: number,
    readonly code: PromotionImportRefusal,
    detail: string,
  ) {
    super(detail);
  }
}

async function step<T>(
  number: number,
  fallback: PromotionImportRefusal,
  run: () => Promise<T> | T,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof StepRefusal) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof PromotionImportRefusalError)
      throw new StepRefusal(number, error.code, message);
    if (error instanceof WitnessNotSelectedError)
      throw new StepRefusal(number, "witness-not-selected", message);
    throw new StepRefusal(number, fallback, message);
  }
}

const challenge = () => randomBytes(32).toString("hex");
const challengeSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** Mirrors sealed-governance-witness.ts: a reply is fresh for at most 60 s. */
const WITNESS_MAX_AGE_MS = 60_000;
const WITNESS_MAX_SKEW_MS = 5_000;
const witnessReplyTimes = {
  issuedAt: time,
  expiresAt: time,
};
const checkpointReplySchema = z
  .object({
    witnessId: name,
    projectId: name,
    collectionId: name,
    challenge: challengeSchema,
    ...witnessReplyTimes,
    checkpointSha256: digestSchema,
    frozenDigests: z.record(name, digestSchema),
  })
  .strict();
const grantStatusReplySchema = z
  .object({
    witnessId: name,
    projectId: name,
    grantId: digestSchema,
    challenge: challengeSchema,
    status: z.enum(["unregistered", "active", "revoked"]),
    ...witnessReplyTimes,
  })
  .strict();

function freshWitnessReply(
  reply: { issuedAt: string; expiresAt: string },
  nowMs: number,
): boolean {
  const issuedAt = Date.parse(reply.issuedAt);
  const expiresAt = Date.parse(reply.expiresAt);
  return (
    issuedAt <= nowMs + WITNESS_MAX_SKEW_MS &&
    issuedAt >= nowMs - WITNESS_MAX_AGE_MS &&
    expiresAt > nowMs &&
    expiresAt > issuedAt &&
    expiresAt - issuedAt <= WITNESS_MAX_AGE_MS
  );
}

/**
 * Check a checkpoint reply against the exact request that asked for it: the
 * same fresh challenge, witness, project and collection, inside a bounded
 * freshness window. A replayed or redirected reply is refused.
 */
export function checkWitnessCheckpointReply(
  reply: unknown,
  query: Readonly<{
    witnessId: string;
    projectId: string;
    collectionId: string;
    challenge: string;
  }>,
  nowMs: number,
): SignedCollectionCheckpoint {
  let parsed;
  try {
    parsed = checkpointReplySchema.safeParse(decodeJson(reply));
  } catch {
    return refuse("witness-reply-invalid", "checkpoint reply is not JSON");
  }
  if (!parsed.success)
    return refuse("witness-reply-invalid", "checkpoint reply is malformed");
  const value = parsed.data;
  if (
    value.challenge !== query.challenge ||
    value.witnessId !== query.witnessId ||
    value.projectId !== query.projectId ||
    value.collectionId !== query.collectionId ||
    !freshWitnessReply(value, nowMs)
  )
    return refuse(
      "witness-reply-invalid",
      "checkpoint reply is stale or answers another request",
    );
  return value;
}

/** The same checks for a grant-status reply, bound to its grant ID. */
export function checkWitnessGrantStatusReply(
  reply: unknown,
  query: Readonly<{
    witnessId: string;
    projectId: string;
    grantId: string;
    challenge: string;
  }>,
  nowMs: number,
): SignedGrantStatus {
  let parsed;
  try {
    parsed = grantStatusReplySchema.safeParse(decodeJson(reply));
  } catch {
    return refuse("witness-reply-invalid", "grant status reply is not JSON");
  }
  if (!parsed.success)
    return refuse("witness-reply-invalid", "grant status reply is malformed");
  const value = parsed.data;
  if (
    value.challenge !== query.challenge ||
    value.witnessId !== query.witnessId ||
    value.projectId !== query.projectId ||
    value.grantId !== query.grantId ||
    !freshWitnessReply(value, nowMs)
  )
    return refuse(
      "witness-reply-invalid",
      "grant status reply is stale or answers another request",
    );
  return value;
}

async function readCheckpoint(
  witness: PromotionControllers["witness"],
  request: { witnessId: string; projectId: string; collectionId: string },
) {
  const query = Object.freeze({ ...request, challenge: challenge() });
  return checkWitnessCheckpointReply(
    await witness.readCollectionCheckpoint(query),
    query,
    Date.now(),
  );
}
const checkpointState = (checkpoint: SignedCollectionCheckpoint) => ({
  witnessId: checkpoint.witnessId,
  projectId: checkpoint.projectId,
  collectionId: checkpoint.collectionId,
  checkpointSha256: checkpoint.checkpointSha256,
  frozenDigests: checkpoint.frozenDigests,
});

export type PromotionGrantPreparation =
  | {
      kind: "promotion-grant-preparation";
      outcome: "refused";
      step: number;
      refusal: PromotionImportRefusal;
      detail: string;
      signed: false;
      promotionEligible: false;
    }
  | {
      kind: "promotion-grant-preparation";
      outcome: "unsigned-requests";
      requests: PromotionGrantRequest[];
      signed: false;
      promotionEligible: false;
    };

/**
 * Run the importer's eleven steps in order over one bundle. The result is a
 * refusal or unsigned requests; neither is authority, and nothing is written.
 */
export async function preparePromotionGrantRequest(
  projectRoot: string,
  bundleDir: string,
): Promise<PromotionGrantPreparation> {
  try {
    const requests = await runSteps(
      path.resolve(projectRoot),
      path.resolve(bundleDir),
    );
    return {
      kind: "promotion-grant-preparation",
      outcome: "unsigned-requests",
      requests,
      signed: false,
      promotionEligible: false,
    };
  } catch (error) {
    if (!(error instanceof StepRefusal)) throw error;
    return {
      kind: "promotion-grant-preparation",
      outcome: "refused",
      step: error.step,
      refusal: error.code,
      detail: error.message,
      signed: false,
      promotionEligible: false,
    };
  }
}

async function runSteps(
  projectRoot: string,
  bundleDir: string,
): Promise<PromotionGrantRequest[]> {
  // 1. The D3 anchor, and a selected controller for every role.
  const { anchor, controllers } = await step(
    1,
    "trust-anchor-invalid",
    async () => {
      const anchor = await readPromotionTrustAnchor();
      const controllers: PromotionControllers = promotionControllersFor(
        anchor.controllers,
      );
      if (anyControllerUnselected(controllers))
        refuse(
          "controller-not-selected",
          "a witness, signer-custody or model-identity controller is still none",
        );
      return { anchor, controllers };
    },
  );

  // 2. Enrollment, recomputing the repository identity.
  const { project, repositoryIdentitySha256 } = await step(
    2,
    "project-not-enrolled",
    async () => {
      const project = await loadProject(projectRoot);
      const repositoryIdentitySha256 =
        await recomputeRepositoryIdentity(projectRoot);
      checkEnrollment(anchor, project.projectId, repositoryIdentitySha256);
      return { project, repositoryIdentitySha256 };
    },
  );

  // 3. Every readiness input, each with its registry.
  const bundle = await step(3, "bundle-invalid", async () => {
    const bundle = await readPromotionBundle(bundleDir);
    requireReadinessInputs(bundle.manifest);
    if (bundle.manifest.projectId !== project.projectId)
      refuse("bundle-invalid", "bundle belongs to another project");
    return bundle;
  });
  const { manifest } = bundle;
  const witnessRequest = {
    witnessId: anchor.witnessId,
    projectId: manifest.projectId,
    collectionId: manifest.collectionId,
  };

  // 4. Trust and registry digests against the witness's pre-run freeze.
  const opening = await step(4, "witness-freeze-mismatch", async () => {
    const opening = await readCheckpoint(controllers.witness, witnessRequest);
    compareFrozenDigests(opening.frozenDigests, bundleTrustDigests(bundle));
    return opening;
  });

  // 5. The sealed readiness audit, through readers built here.
  const { aggregate, readiness } = await step(
    5,
    "readiness-audit-failed",
    async () => ({
      aggregate: aggregateInputSchema.parse(
        doc(bundle, manifest.readiness.aggregate.input),
      ),
      readiness: await runReadinessAudit(bundle, controllers, anchor.witnessId),
    }),
  );
  const cohort = aggregate.cohort as FullCohortEvaluationInput & {
    evaluation: unknown;
  };

  // 6. Preflight and report per route against the one cohort; calibration.
  const routes = await step(6, "preflight-recompute-failed", async () => {
    if (
      hashJson(freezeCohortCalibration(aggregate.cohort.calibration)) !==
      hashJson(decodeJson(aggregate.cohort.thresholds))
    )
      refuse("threshold-refit-mismatch", "calibration threshold refit differs");
    checkCalibrationDisjoint(
      aggregate.cohort.calibration,
      aggregate.cohort.inspection,
    );
    const results = [];
    for (const route of manifest.routes) {
      const pins = doc(bundle, route.preflightPins);
      const preflight = await inspectPromotionImportPreflight(cohort, pins);
      if (
        preflight.category !== route.category ||
        preflight.projectId !== manifest.projectId ||
        preflight.collectionId !== manifest.collectionId ||
        preflight.evaluationArtifactSha256 !==
          readiness.evaluationArtifactSha256
      )
        refuse("preflight-recompute-failed", "route differs from the cohort");
      if (
        preflight.blockers.length ||
        !preflight.accountingMetricsSatisfied ||
        !readiness.accountingMetricsSatisfied
      )
        refuse("cohort-blockers-remain", "cohort or route gates are not met");
      const approval = await inspectSignedPromotionApproval(
        cohort,
        doc(bundle, route.approval.target),
        doc(bundle, route.approval.pin),
        doc(bundle, route.approval.envelope),
      ).catch((error: unknown) =>
        refuse(
          "approval-invalid",
          error instanceof Error ? error.message : undefined,
        ),
      );
      if (approval.reportSha256 !== preflight.reportSha256)
        refuse("approval-invalid", "approval names another report");
      const calibrationAccuracy = routeCalibrationAccuracy(cohort.calibration, {
        category: preflight.category,
        provider: preflight.providerKind,
        model: preflight.expectedModel,
        minimumConfidence: preflight.minimumConfidence,
      });
      results.push({ route, preflight, approval, calibrationAccuracy });
    }
    return results;
  });

  // 7. Measured whole-task cost on both arms, candidate strictly lower.
  await step(7, "cost-not-measured", () => {
    for (const { preflight } of routes)
      checkMeasuredCost(preflight.advisoryCohortProjection ?? null);
  });

  // 8. Every signer key through the selected custody, pairwise distinct.
  await step(8, "signer-key-unresolved", async () => {
    const claims = collectSignerClaims(bundle);
    // The keys the bundle actually used must be distinct before custody is asked.
    requireDistinctUsedKeys(claims);
    const nowMs = Date.now();
    const resolved = [];
    for (const claim of claims) {
      const pin = await controllers.custody.resolveVerificationKey(
        claim.role,
        claim.keyId,
        nowMs,
      );
      if (!pin)
        refuse(
          "signer-key-unresolved",
          `${claim.role} key ${claim.keyId} is not held by the selected custody`,
        );
      resolved.push(pin);
    }
    requireDistinctSigners(claims, resolved);
    const approvers = new Set(
      anchor.approverKeys.map((key) => key.publicKeySha256),
    );
    for (const { approval } of routes)
      if (!approvers.has(approval.keyFingerprintSha256))
        refuse("signer-key-unresolved", "approval key is not pinned in D3");
  });

  // 9. The audited candidate policy is exactly the policy that will run.
  await step(9, "policy-bytes-mismatch", () =>
    checkPolicyAndCohort(
      doc(bundle, manifest.candidatePolicy),
      project.policy,
      routes.map(({ route, preflight }) => ({
        category: route.category,
        policyVersion: preflight.policyVersion,
      })),
    ),
  );

  // 10. The live route identity, with an attested model, matches the request.
  const granted = await step(10, "route-identity-mismatch", async () => {
    const providers = await decisionProviders(
      projectDataDir(project.projectId),
    );
    const results: GrantedPromotionRoute[] = [];
    for (const { route, preflight } of routes) {
      const provider = providers.find(
        (item) =>
          item.id === preflight.providerKind &&
          item.id === preflight.providerId &&
          item.model === preflight.requestedModel,
      );
      if (!provider)
        refuse("route-identity-mismatch", "no configured provider matches");
      const live = buildLivePromotionRoute({
        projectId: project.projectId,
        policy: project.policy,
        category: route.category,
        provider: provider!,
        providers,
      });
      const attested = await controllers.attestor.attest({
        providerKind: live.providerKind,
        endpointOrigin: live.endpointOrigin,
        requestedModel: live.requestedModel,
      });
      if (!attested || attested.evidence !== "runtime-attestation")
        refuse(
          "model-identity-unattested",
          "no runtime attestation of the exact model",
        );
      const expected = grantedPromotionRouteSchema.parse({
        ...live,
        repositoryIdentitySha256,
        stateFormatVersion: preflight.stateFormatVersion,
        expectedModel: preflight.expectedModel,
        modelIdentitySha256: attested!.modelIdentitySha256,
        modelIdentityEvidence: "runtime-attestation",
        candidateConfigurationSha256: preflight.candidateConfigurationSha256,
      });
      const requested = grantedPromotionRouteSchema.parse(
        doc(bundle, route.requestedRoute),
      );
      if (
        expected.modelIdentitySha256 !== preflight.modelIdentitySha256 ||
        hashJson(expected) !== hashJson(requested)
      )
        refuse(
          "route-identity-mismatch",
          "requested route differs from the live one",
        );
      results.push(expected);
    }
    return results;
  });

  const unsigned = routes.map(
    ({ route, preflight, approval, calibrationAccuracy }, index) => {
      const routeIdentity = granted[index]!;
      return {
        route,
        preflight,
        approval,
        calibrationAccuracy,
        routeIdentity,
        grantId: hashJson({
          purpose: PROMOTION_RUNTIME_GRANT_PURPOSE,
          route: routeIdentity,
          reportSha256: preflight.reportSha256,
          approvalClaimSha256: approval.approvalClaimSha256,
        }),
      };
    },
  );

  // 11. Two fresh checkpoints bracket the audit; no grant is registered yet.
  const closing = await step(11, "witness-checkpoint-changed", async () => {
    const closing = await readCheckpoint(controllers.witness, witnessRequest);
    if (
      hashJson(checkpointState(closing)) !== hashJson(checkpointState(opening))
    )
      refuse(
        "witness-checkpoint-changed",
        "the witness moved during the audit",
      );
    for (const item of unsigned) {
      const query = Object.freeze({
        witnessId: anchor.witnessId,
        projectId: manifest.projectId,
        grantId: item.grantId,
        challenge: challenge(),
      });
      const status = checkWitnessGrantStatusReply(
        await controllers.witness.readGrantStatus(query),
        query,
        Date.now(),
      );
      if (status.status !== "unregistered")
        refuse("grant-already-registered", "the grant is already registered");
    }
    return closing;
  });

  const readinessSha256 = hashJson(readiness);
  return step(11, "grant-request-invalid", () =>
    unsigned.map(
      ({
        route,
        preflight,
        approval,
        calibrationAccuracy,
        routeIdentity,
        grantId,
      }) => {
        const projection = preflight.advisoryCohortProjection!;
        const parsed = promotionGrantRequestSchema.safeParse({
          version: "1.0.0",
          kind: "unsigned-promotion-grant-request",
          purpose: PROMOTION_RUNTIME_GRANT_PURPOSE,
          signed: false,
          grantId,
          route: routeIdentity,
          policyIdentity: {
            algorithm: STRICT_POLICY_HASH,
            policyVersion: routeIdentity.policyVersion,
          },
          evidence: {
            collectionId: preflight.collectionId,
            planSha256: preflight.planSha256,
            trustPolicySha256: preflight.trustPolicySha256,
            evaluationArtifactSha256: preflight.evaluationArtifactSha256,
            reportSha256: preflight.reportSha256,
            preflightSha256: approval.preflightSha256,
            readinessSha256,
          },
          routeMetrics: {
            ...projection.routeDecisionMetrics,
            calibrationAccuracy,
          },
          wholeCohort: {
            baselineMeasuredApiCostUsd:
              projection.wholeCohortAccounting.baselineMeasuredApiCostUsd,
            candidateMeasuredApiCostUsd:
              projection.wholeCohortAccounting.candidateMeasuredApiCostUsd,
            candidatePolicyViolationAssignments:
              projection.wholeCohortAccounting
                .candidatePolicyViolationAssignments,
            additionalFailureTasks:
              projection.wholeCohortAccounting.additionalFailureTasks,
          },
          approval: {
            approvalId: approval.approvalId,
            operatorId: approval.operatorId,
            approvalClaimSha256: approval.approvalClaimSha256,
            approverKeySha256: approval.keyFingerprintSha256,
            approvedAt: approval.approvedAt,
            expiresAt: approval.expiresAt,
          },
          lease: route.lease,
          witness: {
            witnessId: anchor.witnessId,
            openingCheckpointSha256: hashJson(checkpointState(opening)),
            closingCheckpointSha256: hashJson(checkpointState(closing)),
          },
        });
        if (!parsed.success)
          refuse(
            "grant-request-invalid",
            "a request is below a gate or beyond a lifetime limit",
          );
        return parsed.data!;
      },
    ),
  );
}

async function runReadinessAudit(
  bundle: PromotionBundle,
  controllers: PromotionControllers,
  witnessId: string,
) {
  const { manifest, root } = bundle;
  const { readiness } = manifest;
  const identity =
    readiness.identityBytes ?? refuse("readiness-input-missing", "identity");
  const identityDirectory =
    manifest.identityDirectory ??
    refuse("readiness-input-missing", "identity directory");
  const identityManifest = z
    .object({
      entries: z.array(
        z.object({ role: z.string(), sha256: digestSchema }).passthrough(),
      ),
    })
    .passthrough()
    .parse(doc(bundle, identity.manifest));
  // Identity bytes: one owner-only file per SHA-256 inside the bundle.
  const bindings = [];
  for (const entry of identityManifest.entries) {
    const file = `${identityDirectory}/${entry.sha256}`;
    const { filename } = await safeFile(root, file, Number.MAX_SAFE_INTEGER);
    bindings.push({ role: entry.role, path: filename });
  }
  // Original artifact bytes: one file per SHA-256 inside the bundle.
  const reader = async (reference: {
    role: string;
    sha256: string;
    bytes: number;
  }): Promise<Uint8Array> => {
    if (!digestSchema.safeParse(reference.sha256).success)
      refuse("bundle-invalid", "original reference is not a digest");
    return readSafe(
      root,
      `${manifest.originalsDirectory}/${reference.sha256}`,
      LIMITS.bytes,
      reference.bytes,
    );
  };
  // Step 3 already required every input; a gap here still refuses.
  const must = (file: string | undefined) =>
    doc(bundle, file ?? refuse("readiness-input-missing"));
  const source =
    readiness.sourceAttestation ?? refuse("readiness-input-missing");
  return withPrivateSealedIdentityFileReader(
    doc(bundle, identity.manifest),
    identity.manifestSha256,
    bindings,
    (readChunk) =>
      inspectSealedEvidenceReadiness({
        population: {
          input: doc(bundle, readiness.population.input),
          trust: doc(bundle, readiness.population.trust),
          pins: doc(bundle, readiness.population.pins),
        },
        aggregate: {
          input: doc(bundle, readiness.aggregate.input),
          manifest: doc(bundle, readiness.aggregate.manifest),
          manifestSha256: readiness.aggregate.manifestSha256,
          reader,
        },
        witness: {
          witnessId,
          // The audit parses the governance checkpoint, not the collection
          // checkpoint steps 4 and 11 compare.
          readCurrent: (query) =>
            controllers.witness.readGovernanceCheckpoint(query),
        },
        identityBytes: {
          manifest: doc(bundle, identity.manifest),
          manifestSha256: identity.manifestSha256,
          readChunk,
        },
        workerDeliveries: must(readiness.workerDeliveries),
        workerKeyFingerprintRegistry: must(
          readiness.workerKeyFingerprintRegistry,
        ),
        sourceAttestation: {
          pin: doc(bundle, source.pin),
          envelope: doc(bundle, source.envelope),
        },
        sourceKeyFingerprintRegistry: must(
          readiness.sourceKeyFingerprintRegistry,
        ),
        oracleExecutions: must(readiness.oracleExecutions),
        oracleKeyFingerprintRegistry: must(
          readiness.oracleKeyFingerprintRegistry,
        ),
      }),
  );
}
