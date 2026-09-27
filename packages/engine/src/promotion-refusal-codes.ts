import { z } from "zod";

// The closed set of reasons promotion refuses a route or a grant request
// (docs/promotion-trust-boundary.md). A refusal returns the route to its
// baseline and is recorded; nothing is retried under weaker checks. Adding a
// code is a reviewed source change, never a data or configuration change.

/** Per-route refusals, recorded on a decision whose route was checked. */
export const PROMOTION_ROUTE_REFUSAL_CODES = [
  // No grant can be verified: this build has no admission point.
  "no-verified-issuer",
  "route-identity-invalid",
  "project-drift",
  "repository-identity-unavailable",
  "repository-drift",
  "policy-drift",
  "category-drift",
  "state-format-unavailable",
  "state-format-drift",
  "provider-drift",
  "endpoint-drift",
  "model-drift",
  "reported-model-drift",
  "model-identity-unattested",
  "model-identity-drift",
  "pricing-drift",
  "provider-order-drift",
  "implementation-drift",
  "candidate-configuration-unavailable",
  "candidate-configuration-drift",
  "jev-spending-cap-required",
  "grant-not-yet-valid",
  "grant-expired",
  "clock-rollback",
] as const;

/** Importer refusals, grouped by the importer step that raises them. */
export const PROMOTION_IMPORT_REFUSAL_CODES = [
  // Step 1: D3 anchor and controller selection.
  "trust-anchor-platform-unsupported",
  "trust-anchor-absent",
  "trust-anchor-unprotected",
  "trust-anchor-invalid",
  "controller-not-selected",
  // Step 2: enrollment.
  "project-not-enrolled",
  "repository-identity-mismatch",
  // Step 3: readiness inputs and the bundle itself.
  "bundle-invalid",
  "readiness-input-missing",
  // Step 4 and step 11: the witness.
  "witness-not-selected",
  "witness-freeze-mismatch",
  "witness-checkpoint-changed",
  "grant-already-registered",
  // Step 5: sealed readiness audit.
  "readiness-audit-failed",
  // Step 6: preflight, report and calibration.
  "preflight-recompute-failed",
  "threshold-refit-mismatch",
  "calibration-held-out-overlap",
  "cohort-blockers-remain",
  "approval-invalid",
  // Step 7: measured cost.
  "cost-not-measured",
  "cost-not-lower",
  // Step 8: signer custody.
  "signer-key-unresolved",
  "signer-keys-not-distinct",
  // Step 9: policy bytes and the promoted cohort.
  "policy-bytes-mismatch",
  "category-not-promoted",
  "cohort-routes-incomplete",
  // Step 10: live route identity.
  "model-identity-unattested",
  "route-identity-mismatch",
  // Schema constraints on the unsigned grant request.
  "grant-request-invalid",
] as const;

export const promotionRouteRefusalSchema = z.enum(
  PROMOTION_ROUTE_REFUSAL_CODES,
);
export const promotionImportRefusalSchema = z.enum(
  PROMOTION_IMPORT_REFUSAL_CODES,
);
export type PromotionRouteRefusal =
  (typeof PROMOTION_ROUTE_REFUSAL_CODES)[number];
export type PromotionImportRefusal =
  (typeof PROMOTION_IMPORT_REFUSAL_CODES)[number];

/** A refusal raised inside the importer; its code is always from the closed set. */
export class PromotionImportRefusalError extends Error {
  constructor(
    readonly code: PromotionImportRefusal,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "PromotionImportRefusalError";
  }
}
