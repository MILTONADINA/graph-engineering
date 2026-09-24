import { createHash, createPublicKey, verify } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";
import { z } from "zod";
import type { FullCohortEvaluationInput } from "./full-cohort-evaluation.js";
import {
  cohortInspectionSchema,
  type CohortInspection,
} from "./full-cohort-ledger.js";
import {
  promotionEvidenceSchema,
  type PromotionEvidence,
} from "./decisions.js";
import {
  canonicalJson,
  decodeJson,
  digestSchema,
  freezeJson,
  hashJson,
} from "./sealed-collection-schema.js";
import { hash } from "./util.js";

declare const verifiedPromotionBrand: unique symbol;
/** Runtime identity, never a serialized flag or a caller-created class instance. */
export interface VerifiedPromotionAuthority {
  readonly [verifiedPromotionBrand]: true;
}
export interface PromotionScope {
  projectId: string;
  policyVersion: string;
  /** Recomputed by a trusted runtime, never copied from the evidence file. */
  currentIdentity?: PromotionRuntimeIdentity;
}
interface VerifiedClaims {
  projectId: string;
  policyVersion: string;
  reportHashes: ReadonlySet<string>;
  trustDigest: string;
  identitySha256: string;
  expiresAt: number;
}
const verified = new WeakMap<object, VerifiedClaims>();

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
/** These are separately selected comparison values, not evidence of approval. */
export const promotionPreflightPinsSchema = z
  .object({
    projectId: name,
    policyVersion: digestSchema,
    collectionId: name,
    planSha256: digestSchema,
    candidateConfigurationSha256: digestSchema,
    trustPolicySha256: digestSchema,
    evaluationArtifactSha256: digestSchema,
    category: name,
    stateFormatVersion: name,
    providerId: name,
    providerKind: z.enum(["laya", "jev"]),
    requestedModel: z.string().min(1).max(256),
    modelIdentitySha256: digestSchema,
  })
  .strict();
export type PromotionPreflightPins = z.infer<
  typeof promotionPreflightPinsSchema
>;
export type PromotionRuntimeIdentity = PromotionPreflightPins;

const promotionPreflightReceiptSchema = promotionPreflightPinsSchema
  .extend({
    kind: z.literal("promotion-import-preflight"),
    minimumConfidence: z.number().finite().min(0.5).max(1),
    accountingMetricsSatisfied: z.boolean(),
    blockers: z.array(z.string()).max(100),
    promotionEligible: z.literal(false),
    authorityStatus: z.literal("unsigned-preflight-only"),
    unverifiedEvidence: z.array(z.string()).max(20),
  })
  .strict();

function detachedCohortInput(
  input: FullCohortEvaluationInput & { evaluation: unknown },
) {
  const names = [
    "inspection",
    "pins",
    "calibration",
    "thresholds",
    "labels",
    "evaluation",
  ] as const;
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== names.length
  )
    throw new Error("Promotion cohort input must be plain data");
  const value = {} as Record<(typeof names)[number], unknown>;
  for (const name of names) {
    const field = Object.getOwnPropertyDescriptor(input, name);
    if (!field?.enumerable || !Object.hasOwn(field, "value"))
      throw new Error("Promotion cohort input refuses accessors");
    value[name] = decodeJson(field.value);
  }
  return value;
}

/**
 * Compare a reviewed preflight target with identities freshly obtained by the
 * runtime. Both inputs are still caller-supplied: this does not authenticate
 * current trust, artifact bytes, collection provenance, or issue authority.
 */
export function inspectPromotionRuntimeIdentity(
  preflightInput: unknown,
  currentInput: unknown,
) {
  const preflight = promotionPreflightReceiptSchema.parse(
    decodeJson(preflightInput),
  );
  const current = promotionPreflightPinsSchema.parse(decodeJson(currentInput));
  const differences = Object.keys(current).filter(
    (key) =>
      preflight[key as keyof PromotionPreflightPins] !==
      current[key as keyof PromotionPreflightPins],
  );
  return freezeJson({
    kind: "promotion-runtime-identity-inspection" as const,
    preflightSha256: hashJson(preflight),
    currentIdentitySha256: hashJson(current),
    identityMatches: differences.length === 0,
    differences,
    promotionEligible: false as const,
    authorityStatus: "unsigned-identity-check-only" as const,
  });
}

/**
 * Validate current public review-trust bytes against two separately selected
 * commitments. The registry is not itself an approval, signature, or
 * anti-rollback witness. In particular, a caller may not use this receipt to
 * issue a promotion grant or convert historical review into held-out review.
 */
export async function inspectPromotionTrustSnapshot(
  preflightInput: unknown,
  trustInput: unknown,
  pinInput: unknown,
) {
  const preflight = promotionPreflightReceiptSchema.parse(
    decodeJson(preflightInput),
  );
  const trustJson = decodeJson(trustInput);
  const pins = z
    .object({ expectedTrustSha256: digestSchema })
    .strict()
    .parse(decodeJson(pinInput));
  const { reviewTrustSchema } = await import("./evaluation-attestations.js");
  const trust = reviewTrustSchema.parse(trustJson);
  const trustSha256 = hashJson(trust);
  if (
    trustSha256 !== pins.expectedTrustSha256 ||
    trustSha256 !== preflight.trustPolicySha256
  )
    throw new Error(
      "Current public trust differs from the separately selected and frozen digests",
    );
  const ids = new Set<string>();
  const fingerprints = new Set<string>();
  const active = new Map<"labeler" | "reviewer", Set<string>>([
    ["labeler", new Set()],
    ["reviewer", new Set()],
  ]);
  for (const key of trust.keys) {
    if (ids.has(key.keyId) || new Set(key.roles).size !== key.roles.length)
      throw new Error("Duplicate public review key identity or role");
    ids.add(key.keyId);
    if (!key.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----"))
      throw new Error("Promotion trust accepts public review keys only");
    const publicKey = createPublicKey(key.publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519")
      throw new Error("Promotion trust requires Ed25519 review keys");
    if (
      key.publicKeyPem !==
      publicKey.export({ type: "spki", format: "pem" }).toString()
    )
      throw new Error("Promotion trust requires one canonical public key PEM");
    const fingerprint = createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex");
    if (fingerprints.has(fingerprint))
      throw new Error(
        "One public key cannot impersonate independent reviewers",
      );
    fingerprints.add(fingerprint);
    if (!trust.revokedKeyIds.includes(key.keyId))
      for (const role of key.roles) active.get(role)!.add(key.actorId);
  }
  if (
    new Set(trust.revokedKeyIds).size !== trust.revokedKeyIds.length ||
    trust.revokedKeyIds.some((id) => !ids.has(id))
  )
    throw new Error("Promotion trust has ambiguous revocations");
  const independentPair = [...active.get("labeler")!].some((labeler) =>
    [...active.get("reviewer")!].some((reviewer) => reviewer !== labeler),
  );
  if (!independentPair)
    throw new Error(
      "Promotion trust lacks distinct active labeler and reviewer actors",
    );
  return freezeJson({
    kind: "promotion-public-trust-inspection" as const,
    preflightSha256: hashJson(preflight),
    trustSha256,
    activeLabelerActors: active.get("labeler")!.size,
    activeReviewerActors: active.get("reviewer")!.size,
    signatureVerificationPerformed: false as const,
    operatorApprovalVerified: false as const,
    antiRollbackVerified: false as const,
    promotionEligible: false as const,
    authorityStatus: "pinned-public-trust-only" as const,
  });
}

/**
 * Verify purpose-separated signatures on every original candidate label. This
 * authenticates only signatures and their join to the unsigned full cohort;
 * population, protected execution, artifact bytes, approval and rollback
 * remain unverified, so the receipt can never populate the authority map.
 */
export async function inspectSealedHeldOutReviewSignatures(
  input: FullCohortEvaluationInput & { evaluation: unknown },
  pinInput: unknown,
  trustInput: unknown,
  trustPinInput: unknown,
  bundleInput: unknown,
  options: { nowMs?: number } = {},
) {
  const detachedPins = decodeJson(pinInput);
  const detachedInput = detachedCohortInput(input);
  const detachedTrust = decodeJson(trustInput);
  const detachedTrustPins = decodeJson(trustPinInput);
  const detachedBundles = decodeJson(bundleInput);
  const parsedOptions = z
    .object({ nowMs: z.number().finite().optional() })
    .strict()
    .parse(decodeJson(options));
  const nowMs = parsedOptions.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > 8_640_000_000_000_000)
    throw new Error("Invalid held-out review verification time");
  const preflight = await inspectPromotionImportPreflight(
    detachedInput,
    detachedPins,
  );
  const trustInspection = await inspectPromotionTrustSnapshot(
    preflight,
    detachedTrust,
    detachedTrustPins,
  );
  const [{ reviewTrustSchema }, { cohortLabelSchema }] = await Promise.all([
    import("./evaluation-attestations.js"),
    import("./full-cohort-evaluation.js"),
  ]);
  const trust = reviewTrustSchema.parse(detachedTrust);
  const inspection = cohortInspectionSchema.parse(detachedInput.inspection);
  const labels = z
    .array(cohortLabelSchema)
    .max(100_000)
    .parse(detachedInput.labels);
  const payloadSchema = z
    .object({
      version: z.literal("1.0.0"),
      kind: z.literal("sealed-held-out-label-review"),
      projectId: name,
      collectionId: name,
      planSha256: digestSchema,
      assignmentId: name,
      taskId: name,
      labelerId: z.string().min(1).max(200),
      producerIds: z.array(name).min(1).max(20),
      label: cohortLabelSchema,
    })
    .strict();
  const signatureSchema = z
    .object({
      keyId: name,
      role: z.enum(["labeler", "reviewer"]),
      signedAt: z.string().datetime(),
      payloadSha256: digestSchema,
      signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
    })
    .strict();
  const bundles = z
    .array(
      z
        .object({
          payload: payloadSchema,
          attestations: z.array(signatureSchema).length(2),
        })
        .strict(),
    )
    .max(10_000)
    .parse(detachedBundles);
  const observations = new Map<
    string,
    {
      observation: NonNullable<
        CohortInspection["assignments"][number]["receipt"]
      >["observations"][number];
      assignmentId: string;
      taskId: string;
    }
  >();
  for (const item of inspection.assignments) {
    if (item.assignment.arm !== "candidate") continue;
    for (const observation of item.receipt?.observations ?? []) {
      if (observations.has(observation.recordId))
        throw new Error("Repeated held-out observation record ID");
      observations.set(observation.recordId, {
        observation,
        assignmentId: item.assignment.assignmentId,
        taskId: item.assignment.taskId,
      });
    }
  }
  if (
    observations.size === 0 ||
    bundles.length !== labels.length ||
    labels.length !== observations.size
  )
    throw new Error("Signed held-out review inventory is incomplete");
  const labelMap = new Map(labels.map((label) => [label.recordId, label]));
  const keys = new Map(trust.keys.map((key) => [key.keyId, key]));
  const consumed = new Set<string>();
  for (const bundle of bundles) {
    const { payload, attestations } = bundle;
    const label = labelMap.get(payload.label.recordId);
    const original = observations.get(payload.label.recordId);
    const task = inspection.plan.tasks.find(
      (item) => item.taskId === original?.taskId,
    );
    if (
      consumed.has(payload.label.recordId) ||
      !label ||
      !original ||
      !task ||
      payload.projectId !== preflight.projectId ||
      payload.collectionId !== preflight.collectionId ||
      payload.planSha256 !== preflight.planSha256 ||
      payload.assignmentId !== original.assignmentId ||
      payload.taskId !== original.taskId ||
      hashJson(payload.label) !== hashJson(label) ||
      payload.label.observationSha256 !== hashJson(original.observation) ||
      hashJson(payload.producerIds) !== hashJson(inspection.plan.producerIds)
    )
      throw new Error(
        "Signed held-out review differs from original cohort data",
      );
    consumed.add(payload.label.recordId);
    const actors: string[] = [];
    const payloadSha256 = hashJson(payload);
    let previousTime = Date.parse(original.observation.observedAt);
    for (const [index, attestation] of attestations.entries()) {
      const role = index === 0 ? "labeler" : "reviewer";
      const key = keys.get(attestation.keyId);
      const signedAt = Date.parse(attestation.signedAt);
      const { signature, ...envelope } = attestation;
      const signatureBytes = Buffer.from(signature, "base64");
      if (
        attestation.role !== role ||
        !key ||
        !key.roles.includes(role) ||
        trust.revokedKeyIds.includes(key.keyId) ||
        inspection.plan.producerIds.includes(key.actorId) ||
        key.actorId === task.curatorId ||
        attestation.payloadSha256 !== payloadSha256 ||
        signedAt < previousTime ||
        signedAt > nowMs + 60_000 ||
        signatureBytes.toString("base64") !== signature ||
        !verify(
          null,
          Buffer.from(
            `graph-engineering/sealed-held-out-review/v1\n${canonicalJson(envelope)}`,
          ),
          createPublicKey(key.publicKeyPem),
          signatureBytes,
        )
      )
        throw new Error(
          "Original held-out review signature or signer mismatch",
        );
      previousTime = signedAt;
      actors.push(key.actorId);
    }
    if (
      actors[0] === actors[1] ||
      actors[0] !== payload.labelerId ||
      actors[1] !== payload.label.reviewerId ||
      Date.parse(payload.label.reviewedAt) <
        Date.parse(attestations[0]!.signedAt) ||
      Date.parse(payload.label.reviewedAt) > previousTime
    )
      throw new Error(
        "Held-out labeler/reviewer independence or time mismatch",
      );
  }
  if (consumed.size !== observations.size)
    throw new Error("Signed held-out review inventory is incomplete");
  return freezeJson({
    kind: "sealed-held-out-review-signatures-only" as const,
    projectId: preflight.projectId,
    collectionId: preflight.collectionId,
    planSha256: preflight.planSha256,
    evaluationArtifactSha256: preflight.evaluationArtifactSha256,
    trustSha256: trustInspection.trustSha256,
    reviewInventorySha256: hashJson(
      [...bundles].sort((a, b) =>
        a.payload.label.recordId < b.payload.label.recordId
          ? -1
          : a.payload.label.recordId > b.payload.label.recordId
            ? 1
            : 0,
      ),
    ),
    verifiedReviewCount: consumed.size,
    signatureVerificationPerformed: true as const,
    operatorApprovalVerified: false as const,
    protectedExecutionVerified: false as const,
    antiRollbackVerified: false as const,
    promotionEligible: false as const,
    authorityStatus: "held-out-row-signatures-only" as const,
  });
}

/**
 * Recompute unsigned full-cohort accounting from detached originals and bind
 * its exact target to separately selected pins. This is useful before review,
 * but neither the pins nor the local ledger authenticate their own origin.
 * In particular, this NEVER inserts claims into `verified` or writes a file.
 */
export async function inspectPromotionImportPreflight(
  input: FullCohortEvaluationInput & { evaluation: unknown },
  pinInput: unknown,
) {
  const pins = promotionPreflightPinsSchema.parse(decodeJson(pinInput));
  const detachedInput = detachedCohortInput(input);
  // Dynamic import avoids making the decision-routing module initialize the
  // full evaluator on every ordinary engine startup.
  const { evaluateFullCohort } = await import("./full-cohort-evaluation.js");
  const evaluation = evaluateFullCohort(detachedInput);
  const detached = detachedInput.evaluation;
  if (
    hashJson(detached) !== hashJson(evaluation) ||
    hashJson(detached) !== pins.evaluationArtifactSha256
  )
    throw new Error(
      "Promotion preflight evaluation differs from recomputed full-cohort accounting or its separate pin",
    );
  const inspection = cohortInspectionSchema.parse(detachedInput.inspection);
  const { plan } = inspection;
  if (
    plan.projectId !== pins.projectId ||
    plan.collectionId !== pins.collectionId ||
    evaluation.projectId !== pins.projectId ||
    evaluation.collectionId !== pins.collectionId ||
    evaluation.planSha256 !== pins.planSha256 ||
    plan.trustPolicySha256 !== pins.trustPolicySha256 ||
    evaluation.candidateConfigurationSha256 !==
      pins.candidateConfigurationSha256 ||
    plan.configurations.candidate.policySha256 !== pins.policyVersion
  )
    throw new Error(
      "Promotion preflight project, policy, collection, trust or configuration pin differs",
    );
  const candidate = plan.configurations.candidate;
  if (
    !candidate.categoryStateVersions.some(
      (state) =>
        state.category === pins.category &&
        state.stateFormatVersion === pins.stateFormatVersion,
    )
  )
    throw new Error("Promotion preflight category/state identity differs");
  const provider = candidate.providers.find(
    (item) => item.providerId === pins.providerId,
  );
  if (
    !provider ||
    provider.kind !== pins.providerKind ||
    provider.requestedModel !== pins.requestedModel ||
    hashJson(provider.modelIdentity) !== pins.modelIdentitySha256 ||
    provider.modelIdentity.kind === "unversioned-alias"
  )
    throw new Error("Promotion preflight provider/model identity differs");
  const expectedModel =
    provider.modelIdentity.kind === "provider-snapshot"
      ? provider.modelIdentity.snapshotId
      : provider.requestedModel;
  const providerRoutes = candidate.providers.map((item) => ({
    providerId: item.providerId,
    kind: item.kind,
    model:
      item.modelIdentity.kind === "provider-snapshot"
        ? item.modelIdentity.snapshotId
        : item.requestedModel,
  }));
  if (
    providerRoutes.filter(
      (item) => item.kind === pins.providerKind && item.model === expectedModel,
    ).length !== 1
  )
    throw new Error(
      "Promotion preflight cannot pool indistinguishable provider routes",
    );
  const routeKey = (route: {
    category: string;
    provider: string;
    model: string;
  }) => JSON.stringify([route.category, route.provider, route.model]);
  const reportKeys = evaluation.reports.map(routeKey);
  if (new Set(reportKeys).size !== reportKeys.length)
    throw new Error("Promotion preflight contains repeated report routes");
  const report = evaluation.reports.find(
    (item) =>
      item.category === pins.category &&
      item.provider === pins.providerKind &&
      item.model === expectedModel,
  );
  if (!report)
    throw new Error("Promotion preflight has no exact frozen target route");
  for (const item of inspection.assignments) {
    if (item.assignment.arm !== "candidate") continue;
    for (const observation of item.receipt?.observations ?? []) {
      if (
        observation.category === pins.category &&
        observation.model === expectedModel
      ) {
        const observedProvider = candidate.providers.find(
          (candidateProvider) =>
            candidateProvider.providerId === observation.providerId,
        );
        if (
          observedProvider?.kind === pins.providerKind &&
          observation.providerId !== pins.providerId
        )
          throw new Error(
            "Promotion preflight target observations use another provider identity",
          );
      }
    }
  }
  return freezeJson({
    kind: "promotion-import-preflight" as const,
    projectId: pins.projectId,
    policyVersion: pins.policyVersion,
    collectionId: pins.collectionId,
    planSha256: pins.planSha256,
    trustPolicySha256: pins.trustPolicySha256,
    evaluationArtifactSha256: pins.evaluationArtifactSha256,
    candidateConfigurationSha256: pins.candidateConfigurationSha256,
    category: pins.category,
    stateFormatVersion: pins.stateFormatVersion,
    providerId: pins.providerId,
    providerKind: pins.providerKind,
    requestedModel: pins.requestedModel,
    modelIdentitySha256: pins.modelIdentitySha256,
    minimumConfidence: report.minimumConfidence,
    accountingMetricsSatisfied:
      evaluation.metricsEligible && report.decisionMetricsSatisfied,
    blockers: evaluation.blockers,
    promotionEligible: false as const,
    authorityStatus: "unsigned-preflight-only" as const,
    unverifiedEvidence: [
      "Original artifact bytes and protected worker/oracle dispatch receipts",
      "Independent signed calibration and held-out reviews",
      "Independent signed population/split manifest and aggregate outcome receipt",
      "Separately approved current signer trust and anti-rollback witness",
    ],
  });
}

/**
 * No issuer exists in phase one. A future issuer MUST verify original signed
 * row reviews AND a signed dataset/population/split manifest; bind immutable
 * drafts (including stateHash), artifact hashes, project/policy/category-state
 * versions and exact provider/model identities; verify independent non-revoked
 * actors and a genuinely sealed held-out collection receipt; recompute metrics;
 * then retain only frozen claims in this private map. It must revalidate current
 * trust, policy, provider, collection and artifact identities before granting
 * runtime authority. `currentIdentity` must come from trusted fresh state, not
 * a copied grant or caller-selected JSON file.
 *
 * Current signed historical intake explicitly rejects held-out review. Neither
 * that guard nor sample thresholds may be relaxed to manufacture an issuer.
 * Serialized summaries/verification booleans can never populate this map.
 */
export function authorizesPromotion(
  authority: unknown,
  evidence: PromotionEvidence,
  scope: PromotionScope,
): boolean {
  if (!authority || typeof authority !== "object") return false;
  const claims = verified.get(authority);
  if (!claims || !scope.currentIdentity) return false;
  let current: PromotionRuntimeIdentity;
  try {
    current = promotionPreflightPinsSchema.parse(
      decodeJson(scope.currentIdentity),
    );
  } catch {
    return false;
  }
  return (
    claims.projectId === scope.projectId &&
    claims.policyVersion === scope.policyVersion &&
    /^[a-f0-9]{64}$/.test(claims.trustDigest) &&
    /^[a-f0-9]{64}$/.test(claims.identitySha256) &&
    current.projectId === scope.projectId &&
    current.policyVersion === scope.policyVersion &&
    current.trustPolicySha256 === claims.trustDigest &&
    hashJson(current) === claims.identitySha256 &&
    Number.isFinite(claims.expiresAt) &&
    claims.expiresAt > Date.now() &&
    claims.reportHashes.has(hash(evidence))
  );
}

export const PROMOTION_IMPORT_BLOCKED =
  "Unsigned evaluation is analysis-only. Promotion requires original signed reviews, operator-approved trust, and a verified sealed held-out collection workflow; the promotion-bound importer is not implemented. No promotion file was written.";

/** Existing files remain untouched and readable for analysis, never authority. */
export async function loadPromotionAuthority(
  dataDir: string,
  scope: PromotionScope,
): Promise<{
  evidence: PromotionEvidence[];
  authority: VerifiedPromotionAuthority | undefined;
  status: "absent" | "unverified";
}> {
  if (!scope.projectId || !/^[a-f0-9]{64}$/.test(scope.policyVersion))
    throw new Error(
      "Promotion loading requires the current project and policy identity",
    );
  const filename = path.join(dataDir, "promotions.json");
  let text: string;
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000)
      throw new Error("Promotion evidence must be a bounded regular file");
    text = await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { evidence: [], authority: undefined, status: "absent" };
    throw error;
  }
  if (Buffer.byteLength(text) > 2_000_000)
    throw new Error("Promotion evidence exceeds its byte limit");
  const evidence = z
    .array(promotionEvidenceSchema)
    .max(1000)
    .parse(JSON.parse(text));
  return { evidence, authority: undefined, status: "unverified" };
}
