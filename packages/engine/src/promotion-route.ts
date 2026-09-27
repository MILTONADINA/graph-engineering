// Live route identity and the per-route promotion check
// (docs/promotion-trust-boundary.md, "Runtime loader and per-route check").
// The runtime recomputes a route's identity from its own dispatch inputs; no
// caller, file or option supplies it. This build has no verified grant issuer
// and no admission point, so every checked route refuses with
// "no-verified-issuer" and keeps its baseline. The comparison a future grant
// must pass is `checkGrantedRoute`, a pure function over two identities.
import type { ProjectPolicy } from "@graph-engineering/contracts";
import { z } from "zod";
import type { DecisionProvider } from "./decisions.js";
import type { PromotionRouteRefusal } from "./promotion-refusal-codes.js";
import { digestSchema, hashJson } from "./sealed-collection-schema.js";
import { hash } from "./util.js";

/** Version tag of the decision implementation bound into every route. */
export const DECISION_IMPLEMENTATION_VERSION =
  "graph-engineering/decision-batch/v1";
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const category = z.string().regex(/^[A-Za-z0-9_.:+/-]{1,100}$/);
const model = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const origin = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      return new URL(value).origin === value;
    } catch {
      return false;
    }
  }, "Expected a URL origin");

/**
 * What the runtime can recompute at dispatch. Fields it cannot establish yet
 * are null and refuse with their own codes: repository identity needs the
 * enrolled anchor (PR-4), and model identity needs runtime attestation, which
 * the owner requires and no attestor provides today.
 */
export const livePromotionRouteSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("promotion-route-identity"),
    projectId: name,
    repositoryIdentitySha256: digestSchema.nullable(),
    policyVersion: digestSchema,
    category,
    stateFormatVersion: name.nullable(),
    providerId: z.enum(["laya", "jev"]),
    providerKind: z.enum(["laya", "jev"]),
    endpointOrigin: origin,
    requestedModel: model,
    expectedModel: model.nullable(),
    modelIdentitySha256: digestSchema.nullable(),
    modelIdentityEvidence: z.literal("runtime-attestation").nullable(),
    pricingSha256: digestSchema,
    providerOrderSha256: digestSchema,
    decisionImplementationSha256: digestSchema,
    candidateConfigurationSha256: digestSchema.nullable(),
  })
  .strict();
export type LivePromotionRoute = z.infer<typeof livePromotionRouteSchema>;

/** A route as a grant binds it: every identity is present and attested. */
export const grantedPromotionRouteSchema = livePromotionRouteSchema
  .extend({
    repositoryIdentitySha256: digestSchema,
    stateFormatVersion: name,
    expectedModel: model,
    modelIdentitySha256: digestSchema,
    // Owner decision: runtime attestation of the exact model, nothing weaker.
    modelIdentityEvidence: z.literal("runtime-attestation"),
    candidateConfigurationSha256: digestSchema,
  })
  .strict();
export type GrantedPromotionRoute = z.infer<typeof grantedPromotionRouteSchema>;

export interface LiveRouteInput {
  projectId: string;
  policy: ProjectPolicy;
  category: string;
  provider: DecisionProvider;
  providers: readonly DecisionProvider[];
}

/** Recompute a route's identity from the dispatch inputs; throws on invalid input. */
export function buildLivePromotionRoute(
  input: LiveRouteInput,
): LivePromotionRoute {
  const endpointOrigin = (endpoint: string) => new URL(endpoint).origin;
  return livePromotionRouteSchema.parse({
    version: "1.0.0",
    kind: "promotion-route-identity",
    projectId: input.projectId,
    repositoryIdentitySha256: null,
    // The same strict key-order-sensitive hash the decision records carry.
    policyVersion: hash(input.policy),
    category: input.category,
    stateFormatVersion: null,
    providerId: input.provider.id,
    providerKind: input.provider.id,
    endpointOrigin: endpointOrigin(input.provider.endpoint),
    requestedModel: input.provider.model,
    expectedModel: null,
    modelIdentitySha256: null,
    modelIdentityEvidence: null,
    pricingSha256: hashJson(input.provider.pricing ?? null),
    providerOrderSha256: hashJson(
      input.providers.map((item) => ({
        id: item.id,
        endpointOrigin: endpointOrigin(item.endpoint),
        model: item.model,
      })),
    ),
    decisionImplementationSha256: hashJson(DECISION_IMPLEMENTATION_VERSION),
    candidateConfigurationSha256: null,
  });
}

export type PromotionRoutePhase = "before-dispatch" | "after-response";
export interface PromotionRouteVerdict {
  phase: PromotionRoutePhase;
  admitted: boolean;
  refusal: PromotionRouteRefusal | null;
  routeSha256: string | null;
}

/**
 * The per-route check in the decision path. It never throws and performs no
 * trust, grant or witness I/O. Callers run it only for a promoted category
 * under decisionMode "promoted"; shadow mode never reaches it.
 */
export function checkPromotionRoute(
  phase: PromotionRoutePhase,
  input: LiveRouteInput,
  // The model the response reported; compared with a grant after the response.
  _reportedModel?: string | null,
): PromotionRouteVerdict {
  let route: LivePromotionRoute;
  try {
    route = buildLivePromotionRoute(input);
  } catch {
    return {
      phase,
      admitted: false,
      refusal: "route-identity-invalid",
      routeSha256: null,
    };
  }
  // No verified grant issuer exists, so no grant can bind this route. The
  // single admission point arrives only with the externally governed issuer
  // and witness (delivery PR-5).
  return {
    phase,
    admitted: false,
    refusal: "no-verified-issuer",
    routeSha256: hashJson(route),
  };
}

export interface GrantedRouteCheck {
  phase: PromotionRoutePhase;
  granted: unknown;
  live: unknown;
  /** The model the provider's response reported, checked after the response. */
  reportedModel?: string | null;
  policy: Pick<ProjectPolicy, "maxCostUsd">;
  lease: { notBeforeMs: number; notAfterMs: number };
  clocks: {
    wallMs: number;
    witnessMs: number;
    /** Wall time and monotonic reading when the grant was admitted. */
    admittedWallMs: number;
    admittedMonotonicMs: number;
    monotonicMs: number;
  };
}

/**
 * Compare a granted route with the live one and return the first refusal, or
 * null. Pure: it verifies no signature and admits nothing, and no runtime
 * code path calls it until a verified grant exists.
 */
export function checkGrantedRoute(
  check: GrantedRouteCheck,
): PromotionRouteRefusal | null {
  const granted = grantedPromotionRouteSchema.safeParse(check.granted);
  const parsed = livePromotionRouteSchema.safeParse(check.live);
  if (!granted.success || !parsed.success) return "route-identity-invalid";
  const g = granted.data;
  const l = parsed.data;
  if (l.projectId !== g.projectId) return "project-drift";
  if (l.repositoryIdentitySha256 === null)
    return "repository-identity-unavailable";
  if (l.repositoryIdentitySha256 !== g.repositoryIdentitySha256)
    return "repository-drift";
  if (l.policyVersion !== g.policyVersion) return "policy-drift";
  if (l.category !== g.category) return "category-drift";
  if (l.stateFormatVersion === null) return "state-format-unavailable";
  if (l.stateFormatVersion !== g.stateFormatVersion)
    return "state-format-drift";
  if (l.providerId !== g.providerId || l.providerKind !== g.providerKind)
    return "provider-drift";
  if (l.endpointOrigin !== g.endpointOrigin) return "endpoint-drift";
  if (l.requestedModel !== g.requestedModel) return "model-drift";
  if (
    l.modelIdentitySha256 === null ||
    l.modelIdentityEvidence !== "runtime-attestation"
  )
    return "model-identity-unattested";
  if (l.modelIdentitySha256 !== g.modelIdentitySha256)
    return "model-identity-drift";
  if (l.expectedModel !== g.expectedModel) return "model-drift";
  if (
    check.phase === "after-response" &&
    check.reportedModel !== g.expectedModel
  )
    return "reported-model-drift";
  if (l.pricingSha256 !== g.pricingSha256) return "pricing-drift";
  if (l.providerOrderSha256 !== g.providerOrderSha256)
    return "provider-order-drift";
  if (l.decisionImplementationSha256 !== g.decisionImplementationSha256)
    return "implementation-drift";
  if (l.candidateConfigurationSha256 === null)
    return "candidate-configuration-unavailable";
  if (l.candidateConfigurationSha256 !== g.candidateConfigurationSha256)
    return "candidate-configuration-drift";
  const cap = check.policy.maxCostUsd;
  if (
    g.providerKind === "jev" &&
    (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0)
  )
    return "jev-spending-cap-required";
  const { lease, clocks } = check;
  const times = [
    lease.notBeforeMs,
    lease.notAfterMs,
    clocks.wallMs,
    clocks.witnessMs,
    clocks.admittedWallMs,
    clocks.admittedMonotonicMs,
    clocks.monotonicMs,
  ];
  if (times.some((value) => !Number.isFinite(value)))
    return "route-identity-invalid";
  const monotonicElapsed = clocks.monotonicMs - clocks.admittedMonotonicMs;
  if (monotonicElapsed < 0 || clocks.wallMs < clocks.admittedWallMs)
    return "clock-rollback";
  if (clocks.wallMs < lease.notBeforeMs || clocks.witnessMs < lease.notBeforeMs)
    return "grant-not-yet-valid";
  // Expiry must hold under the wall clock, the monotonic clock and the
  // witness-signed time together.
  if (
    clocks.wallMs >= lease.notAfterMs ||
    clocks.witnessMs >= lease.notAfterMs ||
    clocks.admittedWallMs + monotonicElapsed >= lease.notAfterMs
  )
    return "grant-expired";
  return null;
}
