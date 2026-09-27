// The UNSIGNED grant request the verify-only importer may emit
// (docs/promotion-trust-boundary.md, "Runtime grant"). It is a request for
// the independent issuer (D5), never a grant: the engine never signs it and
// the runtime never reads it. The numeric gates and the owner's decisions of
// 2026-09-27 (specs/decisions/promotion-custody.md) are schema constraints,
// so a request below any gate or beyond any limit cannot be parsed.
import { z } from "zod";
import { grantedPromotionRouteSchema } from "./promotion-route.js";
import { digestSchema } from "./sealed-collection-schema.js";

export const PROMOTION_RUNTIME_GRANT_PURPOSE =
  "graph-engineering/promotion-runtime-grant/v1";
/** Owner decision: the strict, key-order-sensitive `util.hash(policy)`. */
export const STRICT_POLICY_HASH = "graph-engineering/util-hash-strict/v1";
const DAY_MS = 24 * 60 * 60 * 1_000;
/** Owner decision: a grant lives at most 7 days. */
export const MAX_GRANT_LIFETIME_MS = 7 * DAY_MS;
/** Matches the signed approval's own limit (signed-promotion-approval.ts). */
export const MAX_APPROVAL_LIFETIME_MS = 30 * DAY_MS;
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const time = z.string().datetime();
const cost = z.number().finite().nonnegative().max(1e12);

export const promotionGrantRequestSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("unsigned-promotion-grant-request"),
    purpose: z.literal(PROMOTION_RUNTIME_GRANT_PURPOSE),
    signed: z.literal(false),
    grantId: digestSchema,
    // One route and one report per grant, never a batch or a wildcard.
    route: grantedPromotionRouteSchema,
    policyIdentity: z
      .object({
        algorithm: z.literal(STRICT_POLICY_HASH),
        policyVersion: digestSchema,
      })
      .strict(),
    evidence: z
      .object({
        collectionId: name,
        planSha256: digestSchema,
        trustPolicySha256: digestSchema,
        evaluationArtifactSha256: digestSchema,
        reportSha256: digestSchema,
        preflightSha256: digestSchema,
        readinessSha256: digestSchema,
      })
      .strict(),
    routeMetrics: z
      .object({
        calibrationCount: z.number().int().min(50),
        // Decision accuracy on calibration rows at or above the fitted threshold.
        calibrationAccuracy: z.number().finite().min(0.95).max(1),
        heldOutCount: z.number().int().min(200),
        taskCount: z.number().int().min(60),
        calibrationError: z.number().finite().min(0).max(0.05),
        minimumConfidence: z.number().finite().min(0.5).max(1),
      })
      .strict(),
    wholeCohort: z
      .object({
        baselineMeasuredApiCostUsd: cost,
        candidateMeasuredApiCostUsd: cost,
        candidatePolicyViolationAssignments: z.literal(0),
        additionalFailureTasks: z.literal(0),
      })
      .strict()
      .refine(
        (value) =>
          value.candidateMeasuredApiCostUsd < value.baselineMeasuredApiCostUsd,
        "Measured candidate cost must be strictly lower",
      ),
    approval: z
      .object({
        approvalId: name,
        operatorId: name,
        approvalClaimSha256: digestSchema,
        approverKeySha256: digestSchema,
        approvedAt: time,
        expiresAt: time,
      })
      .strict(),
    lease: z.object({ notBefore: time, notAfter: time }).strict(),
    witness: z
      .object({
        witnessId: name,
        openingCheckpointSha256: digestSchema,
        closingCheckpointSha256: digestSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((request, context) => {
    const fail = (message: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, message });
    if (request.policyIdentity.policyVersion !== request.route.policyVersion)
      fail("Policy identity differs from the route's policy version");
    const approvedAt = Date.parse(request.approval.approvedAt);
    const approvalExpiresAt = Date.parse(request.approval.expiresAt);
    const notBefore = Date.parse(request.lease.notBefore);
    const notAfter = Date.parse(request.lease.notAfter);
    if (
      !(approvalExpiresAt > approvedAt) ||
      approvalExpiresAt - approvedAt > MAX_APPROVAL_LIFETIME_MS
    )
      fail("Approval lifetime must be positive and at most 30 days");
    if (!(notAfter > notBefore) || notAfter - notBefore > MAX_GRANT_LIFETIME_MS)
      fail("Grant lifetime must be positive and at most 7 days");
    if (notBefore < approvedAt || notAfter > approvalExpiresAt)
      fail("Grant lease must lie within the approval's lifetime");
  });
export type PromotionGrantRequest = z.infer<typeof promotionGrantRequestSchema>;
