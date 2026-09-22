import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  promotionEvidenceSchema,
  type PromotionEvidence,
} from "./decisions.js";
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
