import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { FullCohortEvaluationInput } from "./full-cohort-evaluation.js";
import { cohortInspectionSchema } from "./full-cohort-ledger.js";
import {
  promotionEvidenceSchema,
  type PromotionEvidence,
} from "./decisions.js";
import {
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
}
interface VerifiedClaims extends PromotionScope {
  reportHashes: ReadonlySet<string>;
  trustDigest: string;
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
  // Dynamic import avoids making the decision-routing module initialize the
  // full evaluator on every ordinary engine startup.
  const { evaluateFullCohort } = await import("./full-cohort-evaluation.js");
  const evaluation = evaluateFullCohort(input);
  const detached = decodeJson(input.evaluation);
  if (
    hashJson(detached) !== hashJson(evaluation) ||
    hashJson(detached) !== pins.evaluationArtifactSha256
  )
    throw new Error(
      "Promotion preflight evaluation differs from recomputed full-cohort accounting or its separate pin",
    );
  const inspection = cohortInspectionSchema.parse(decodeJson(input.inspection));
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
 * trust, policy and artifact identities before granting runtime authority.
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
  return (
    !!claims &&
    claims.projectId === scope.projectId &&
    claims.policyVersion === scope.policyVersion &&
    /^[a-f0-9]{64}$/.test(claims.trustDigest) &&
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
