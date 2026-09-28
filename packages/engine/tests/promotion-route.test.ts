import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { decideBatch } from "../src/decision-batch.js";
import type { DecisionProvider, PromotionEvidence } from "../src/decisions.js";
import * as promotionAuthority from "../src/promotion-authority.js";
import { loadPromotionAuthority } from "../src/promotion-authority.js";
import {
  MODEL_IDENTITY_ATTESTORS,
  SIGNER_CUSTODIES,
  WITNESS_CONTROLLERS,
  anyControllerUnselected,
  promotionControllersFor,
  type EvidenceSignerRole,
} from "../src/promotion-controllers.js";
import {
  PROMOTION_IMPORT_REFUSAL_CODES,
  PROMOTION_ROUTE_REFUSAL_CODES,
  promotionImportRefusalSchema,
  promotionRouteRefusalSchema,
} from "../src/promotion-refusal-codes.js";
import * as promotionRoute from "../src/promotion-route.js";
import {
  buildLivePromotionRoute,
  checkGrantedRoute,
  checkPromotionRoute,
  grantedPromotionRouteSchema,
  type GrantedRouteCheck,
} from "../src/promotion-route.js";
import { hashJson } from "../src/sealed-collection-schema.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LAYA = "http://127.0.0.1:7337/v1/decide";
const model = "fixture-only";
const laya: DecisionProvider = {
  id: "laya",
  endpoint: LAYA,
  model,
  maxStateChars: 20000,
};
// Ideal-looking planted numbers; not real evidence.
const proof = (category: string): PromotionEvidence => ({
  version: "a".repeat(64),
  category,
  provider: "laya",
  model,
  calibrationCount: 60,
  heldOutCount: 240,
  taskCount: 60,
  policyViolations: 0,
  additionalFailures: 0,
  baselineCost: 60,
  candidateCost: 30,
  calibrationError: 0.01,
  minimumConfidence: 0.5,
  dataOrigin: "recorded",
  provenanceComplete: true,
  datasetId: "forged-fixture-not-real-evidence",
});
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const confidentProvider = () => {
  const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const questions = JSON.parse(String(init?.body)).questions as Record<
      string,
      unknown
    >;
    return new Response(
      JSON.stringify({
        model,
        answers: Object.fromEntries(
          Object.keys(questions).map((id) => [
            id,
            { choice: "alternative", confidence: 1 },
          ]),
        ),
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
};
const batch = async (
  policy: Partial<typeof DEFAULT_POLICY>,
  categories = ["worker", "effort"],
) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graph-route-"));
  directories.push(directory);
  const scope = { projectId: "route-project", policyVersion: "b".repeat(64) };
  const loaded = await loadPromotionAuthority(directory, scope);
  return decideBatch({
    projectId: scope.projectId,
    state: { fixture: true },
    policy: { ...DEFAULT_POLICY, providers: ["laya"], ...policy },
    providers: [laya],
    evidence: categories.map(proof),
    promotionBinding: loaded.binding,
    questions: categories.map((category) => ({
      id: category,
      category,
      candidates: { safe: "Baseline", alternative: "Alternative" },
      baseline: "safe",
    })),
  });
};
const grantedRoute = () =>
  grantedPromotionRouteSchema.parse({
    ...buildLivePromotionRoute({
      projectId: "route-project",
      policy: DEFAULT_POLICY,
      category: "worker",
      provider: laya,
      providers: [laya],
    }),
    repositoryIdentitySha256: "1".repeat(64),
    stateFormatVersion: "decision-state-v1",
    expectedModel: model,
    modelIdentitySha256: "2".repeat(64),
    modelIdentityEvidence: "runtime-attestation",
    candidateConfigurationSha256: "3".repeat(64),
  });
const check = (
  change: Partial<GrantedRouteCheck> & { liveChange?: object } = {},
) => {
  const granted = grantedRoute();
  const { liveChange, ...rest } = change;
  return checkGrantedRoute({
    phase: "before-dispatch",
    granted,
    live: { ...granted, ...liveChange },
    policy: { maxCostUsd: 0 },
    lease: { notBeforeMs: 1_000, notAfterMs: 10_000 },
    clocks: {
      wallMs: 5_000,
      witnessMs: 5_000,
      admittedWallMs: 2_000,
      admittedMonotonicMs: 100,
      monotonicMs: 3_100,
    },
    ...rest,
  });
};

describe("per-route promotion check in the decision path", () => {
  it("refuses every promoted route with no-verified-issuer and keeps the baseline even when authority is mocked", async () => {
    // Even a planted authority result cannot promote: the route check refuses
    // first and the binding is never consulted as a weaker fallback.
    const authority = vi
      .spyOn(promotionAuthority, "authorizesPromotionFromBinding")
      .mockResolvedValue(true);
    const fetch = confidentProvider();
    const result = await batch({
      decisionMode: "promoted",
      promotedCategories: ["worker", "effort"],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(authority).not.toHaveBeenCalled();
    expect(result.selections).toEqual({ worker: "safe", effort: "safe" });
    expect(result.records).toHaveLength(2);
    for (const record of result.records)
      expect(record).toMatchObject({
        mode: "shadow",
        selected: "alternative",
        baseline: "safe",
        evidence: {
          promotionAuthority: "unverified",
          promotionRefusal: "no-verified-issuer",
          promotionRefusalPhase: "before-dispatch",
        },
      });
  });

  it("keeps the baseline when a route admitted before dispatch is refused after the response", async () => {
    // Planted admission before dispatch isolates the after-response check.
    vi.spyOn(
      promotionAuthority,
      "authorizesPromotionFromBinding",
    ).mockResolvedValue(true);
    const route = vi
      .spyOn(promotionRoute, "checkPromotionRoute")
      .mockImplementation((phase) =>
        phase === "before-dispatch"
          ? { phase, admitted: true, refusal: null, routeSha256: null }
          : {
              phase,
              admitted: false,
              refusal: "reported-model-drift",
              routeSha256: null,
            },
      );
    confidentProvider();
    const result = await batch(
      { decisionMode: "promoted", promotedCategories: ["worker"] },
      ["worker"],
    );
    expect(route.mock.calls.map((call) => call[0])).toEqual([
      "before-dispatch",
      "after-response",
    ]);
    // The response's reported model is passed to the after-response check.
    expect(route.mock.calls[1]![2]).toBe(model);
    expect(result.selections).toEqual({ worker: "safe" });
    expect(result.records[0]).toMatchObject({
      mode: "shadow",
      selected: "alternative",
      evidence: {
        promotionAuthority: "unverified",
        promotionRefusal: "reported-model-drift",
        promotionRefusalPhase: "after-response",
      },
    });
  });

  it("never evaluates the per-route check in shadow mode or for an unlisted category", async () => {
    const route = vi.spyOn(promotionRoute, "checkPromotionRoute");
    confidentProvider();
    const shadow = await batch({
      decisionMode: "shadow",
      promotedCategories: ["worker", "effort"],
    });
    expect(route).not.toHaveBeenCalled();
    for (const record of shadow.records) {
      expect(record.mode).toBe("shadow");
      expect(record.evidence).not.toHaveProperty("promotionRefusal");
    }
    const partial = await batch({
      decisionMode: "promoted",
      promotedCategories: ["worker"],
    });
    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0]![1].category).toBe("worker");
    const byCategory = Object.fromEntries(
      partial.records.map((record) => [record.category, record]),
    );
    expect(byCategory.worker!.evidence.promotionRefusal).toBe(
      "no-verified-issuer",
    );
    expect(byCategory.effort!.evidence).not.toHaveProperty("promotionRefusal");
    expect(partial.selections).toEqual({ worker: "safe", effort: "safe" });
  });

  it("recomputes the live route identity and refuses an invalid one", () => {
    const input = {
      projectId: "route-project",
      policy: DEFAULT_POLICY,
      category: "worker",
      provider: laya,
      providers: [laya],
    };
    const live = buildLivePromotionRoute(input);
    expect(live).toMatchObject({
      endpointOrigin: "http://127.0.0.1:7337",
      providerKind: "laya",
      requestedModel: model,
      repositoryIdentitySha256: null,
      modelIdentitySha256: null,
      modelIdentityEvidence: null,
    });
    expect(checkPromotionRoute("before-dispatch", input)).toEqual({
      phase: "before-dispatch",
      admitted: false,
      refusal: "no-verified-issuer",
      routeSha256: hashJson(live),
    });
    expect(
      checkPromotionRoute("after-response", {
        ...input,
        category: "not a category",
      }),
    ).toMatchObject({ admitted: false, refusal: "route-identity-invalid" });
    // A policy edit changes the strict policy hash bound into the route.
    expect(
      buildLivePromotionRoute({
        ...input,
        policy: { ...DEFAULT_POLICY, maxWorkers: 3 },
      }).policyVersion,
    ).not.toBe(live.policyVersion);
  });
});

describe("granted-route comparison (pure; admits nothing)", () => {
  it("returns the first drift code for every route identity field", () => {
    // No drift is only the absence of a refusal; the runtime check still
    // refuses the same route because no verified issuer exists.
    expect(check()).toBeNull();
    const cases: [object, string][] = [
      [{ projectId: "other-project" }, "project-drift"],
      [{ repositoryIdentitySha256: null }, "repository-identity-unavailable"],
      [{ repositoryIdentitySha256: "4".repeat(64) }, "repository-drift"],
      [{ policyVersion: "4".repeat(64) }, "policy-drift"],
      [{ category: "effort" }, "category-drift"],
      [{ stateFormatVersion: null }, "state-format-unavailable"],
      [{ stateFormatVersion: "decision-state-v2" }, "state-format-drift"],
      [{ providerId: "jev" }, "provider-drift"],
      [{ endpointOrigin: "http://127.0.0.1:7338" }, "endpoint-drift"],
      [{ requestedModel: "other-model" }, "model-drift"],
      [{ modelIdentitySha256: null }, "model-identity-unattested"],
      [{ modelIdentityEvidence: null }, "model-identity-unattested"],
      [{ modelIdentitySha256: "4".repeat(64) }, "model-identity-drift"],
      [{ expectedModel: "other-snapshot" }, "model-drift"],
      [{ pricingSha256: "4".repeat(64) }, "pricing-drift"],
      [{ providerOrderSha256: "4".repeat(64) }, "provider-order-drift"],
      [
        { decisionImplementationSha256: "4".repeat(64) },
        "implementation-drift",
      ],
      [
        { candidateConfigurationSha256: null },
        "candidate-configuration-unavailable",
      ],
      [
        { candidateConfigurationSha256: "4".repeat(64) },
        "candidate-configuration-drift",
      ],
      [{ extra: true }, "route-identity-invalid"],
    ];
    for (const [liveChange, code] of cases)
      expect(check({ liveChange }), JSON.stringify(liveChange)).toBe(code);
    expect(
      check({ phase: "after-response", reportedModel: "swapped-model" }),
    ).toBe("reported-model-drift");
    expect(check({ phase: "after-response", reportedModel: null })).toBe(
      "reported-model-drift",
    );
  });

  it("requires runtime attestation in a granted route and a numeric cap for Jev", () => {
    const granted = grantedRoute();
    for (const weaker of [
      { modelIdentityEvidence: "self-report" },
      { modelIdentityEvidence: "provider-signature" },
      { modelIdentityEvidence: null },
      { modelIdentitySha256: null },
      { repositoryIdentitySha256: null },
      { promotionEligible: true },
    ])
      expect(
        grantedPromotionRouteSchema.safeParse({ ...granted, ...weaker })
          .success,
      ).toBe(false);
    const jev = { ...granted, providerId: "jev", providerKind: "jev" };
    expect(
      checkGrantedRoute({
        phase: "before-dispatch",
        granted: jev,
        live: jev,
        policy: { maxCostUsd: null },
        lease: { notBeforeMs: 1_000, notAfterMs: 10_000 },
        clocks: {
          wallMs: 5_000,
          witnessMs: 5_000,
          admittedWallMs: 2_000,
          admittedMonotonicMs: 100,
          monotonicMs: 3_100,
        },
      }),
    ).toBe("jev-spending-cap-required");
  });

  it("holds expiry under the wall, monotonic and witness clocks and refuses a rollback", () => {
    const clocks = {
      wallMs: 5_000,
      witnessMs: 5_000,
      admittedWallMs: 2_000,
      admittedMonotonicMs: 100,
      monotonicMs: 3_100,
    };
    expect(check({ clocks: { ...clocks, wallMs: 10_000 } })).toBe(
      "grant-expired",
    );
    expect(check({ clocks: { ...clocks, witnessMs: 10_000 } })).toBe(
      "grant-expired",
    );
    // The wall clock was set back, but the monotonic clock ran past expiry.
    expect(check({ clocks: { ...clocks, monotonicMs: 8_100 } })).toBe(
      "grant-expired",
    );
    expect(check({ clocks: { ...clocks, wallMs: 1_500 } })).toBe(
      "clock-rollback",
    );
    expect(check({ clocks: { ...clocks, monotonicMs: 50 } })).toBe(
      "clock-rollback",
    );
    expect(check({ lease: { notBeforeMs: 6_000, notAfterMs: 10_000 } })).toBe(
      "grant-not-yet-valid",
    );
    expect(check({ clocks: { ...clocks, witnessMs: Number.NaN } })).toBe(
      "route-identity-invalid",
    );
  });
});

describe("controllers and refusal codes", () => {
  it("offers only none controllers, each of which refuses", async () => {
    expect(Object.keys(WITNESS_CONTROLLERS)).toEqual(["none"]);
    expect(Object.keys(SIGNER_CUSTODIES)).toEqual(["none"]);
    expect(Object.keys(MODEL_IDENTITY_ATTESTORS)).toEqual(["none"]);
    const controllers = promotionControllersFor({
      witness: "none",
      custody: "none",
      modelIdentity: "none",
    });
    expect(anyControllerUnselected(controllers)).toBe(true);
    const request = {
      witnessId: "witness",
      projectId: "route-project",
      challenge: "c".repeat(64),
    };
    await expect(
      controllers.witness.readCollectionCheckpoint({
        ...request,
        collectionId: "collection",
      }),
    ).rejects.toThrow("witness-not-selected");
    await expect(
      controllers.witness.readGovernanceCheckpoint({
        ...request,
        collectionId: "collection",
      }),
    ).rejects.toThrow("witness-not-selected");
    await expect(
      controllers.witness.readGrantStatus({ ...request, grantId: "grant" }),
    ).rejects.toThrow("witness-not-selected");
    const roles: EvidenceSignerRole[] = [
      "curator",
      "source",
      "labeler",
      "reviewer",
      "worker",
      "oracle",
      "approver",
      "issuer",
    ];
    for (const role of roles)
      expect(
        await controllers.custody.resolveVerificationKey(role, "key", 0),
      ).toBeUndefined();
    expect(
      await controllers.attestor.attest({
        providerKind: "laya",
        endpointOrigin: "http://127.0.0.1:7337",
        requestedModel: model,
      }),
    ).toBeUndefined();
    for (const name of ["reference", "constructor", "__proto__", "toString"])
      expect(() =>
        promotionControllersFor({
          witness: name as "none",
          custody: "none",
          modelIdentity: "none",
        }),
      ).toThrow("closed registry");
    expect(Object.isFrozen(WITNESS_CONTROLLERS)).toBe(true);
    expect(Object.isFrozen(controllers.witness)).toBe(true);
  });

  it("keeps the refusal codes closed and unique", () => {
    for (const codes of [
      PROMOTION_ROUTE_REFUSAL_CODES,
      PROMOTION_IMPORT_REFUSAL_CODES,
    ])
      expect(new Set(codes).size).toBe(codes.length);
    expect(promotionRouteRefusalSchema.safeParse("admitted").success).toBe(
      false,
    );
    expect(promotionImportRefusalSchema.safeParse("verified").success).toBe(
      false,
    );
    expect(promotionRouteRefusalSchema.parse("no-verified-issuer")).toBe(
      "no-verified-issuer",
    );
  });
});
