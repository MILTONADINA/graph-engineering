// Drives the verify-only importer past step 1. The anchor, controllers and
// expensive audits are replaced ONLY by vitest spies in this test file; src
// has no parameter, option, variable or file that can select them. Every
// path either refuses or emits an unsigned request, which is never authority.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DecisionProvider } from "../src/decisions.js";
import * as promotionAuthority from "../src/promotion-authority.js";
import {
  authorizesPromotionFromBinding,
  inspectPromotionImportPreflight,
  loadPromotionAuthority,
} from "../src/promotion-authority.js";
import * as promotionControllers from "../src/promotion-controllers.js";
import type {
  PromotionControllers,
  PublicKeyPin,
} from "../src/promotion-controllers.js";
import { promotionGrantRequestSchema } from "../src/promotion-grant-request.js";
import {
  bundleTrustDigests,
  checkWitnessCheckpointReply,
  checkWitnessGrantStatusReply,
  collectSignerClaims,
  preparePromotionGrantRequest,
  readPromotionBundle,
  recomputeRepositoryIdentity,
  type PromotionBundle,
} from "../src/promotion-importer.js";
import { PromotionImportRefusalError } from "../src/promotion-refusal-codes.js";
import {
  buildLivePromotionRoute,
  grantedPromotionRouteSchema,
} from "../src/promotion-route.js";
import * as trustAnchor from "../src/promotion-trust-anchor.js";
import {
  PROJECT_FILE,
  initializeProject,
  projectDataDir,
} from "../src/project.js";
import { hashJson } from "../src/sealed-collection-schema.js";
import * as identityReader from "../src/sealed-identity-file-reader.js";
import * as signedApproval from "../src/signed-promotion-approval.js";
import { checked, hash, writeJson } from "../src/util.js";
import { declaredSelectionAggregateFixture } from "./sealed-aggregate-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const temporary = async (label: string) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), `graph-${label}-`));
  directories.push(directory);
  return directory;
};
const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof PromotionImportRefusalError) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
};
const keyPin = () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  return {
    publicKeyPem,
    publicKeySha256: createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
  };
};
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const DAY = 24 * 60 * 60 * 1000;

/** A synthetic project, bundle and planted audit results; never real evidence. */
async function harness() {
  const data = await temporary("promotion-steps-data");
  vi.stubEnv("GRAPH_ENGINE_DATA_DIR", data);
  const root = await temporary("promotion-steps-project");
  await checked("git", ["init", "-b", "dev"], { cwd: root });
  await checked("git", ["config", "user.name", "Graph Test"], { cwd: root });
  await checked("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  const template = await declaredSelectionAggregateFixture();
  const { originalArtifacts: _originals, ...aggregateInput } = template.input;
  const real = await inspectPromotionImportPreflight(
    aggregateInput.cohort,
    aggregateInput.preflightPins,
  );
  const config = await initializeProject(root);
  config.policy.decisionMode = "promoted";
  config.policy.promotedCategories = [real.category];
  await writeJson(path.join(root, PROJECT_FILE), config);
  await checked("git", ["add", "."], { cwd: root });
  await checked("git", ["commit", "-m", "test: fixture"], { cwd: root });
  const provider: DecisionProvider = {
    id: "laya",
    endpoint: "http://127.0.0.1:7337/v1/decide",
    model: real.requestedModel,
    maxStateChars: 20000,
  };
  await mkdir(projectDataDir(config.projectId), { recursive: true });
  await writeJson(
    path.join(projectDataDir(config.projectId), "decisions.json"),
    [provider],
  );
  const repositoryIdentitySha256 = await recomputeRepositoryIdentity(root);
  const evaluationArtifactSha256 = "e".repeat(64);
  // Planted audit results: the gates are met so later steps are reached.
  const preflight = {
    ...real,
    projectId: config.projectId,
    policyVersion: hash(config.policy),
    providerId: "laya",
    providerKind: "laya" as const,
    evaluationArtifactSha256,
    blockers: [],
    accountingMetricsSatisfied: true,
    advisoryCohortProjection: {
      evaluationArtifactSha256,
      targetRoute: {
        category: real.category,
        providerId: "laya",
        providerKind: "laya" as const,
        model: real.expectedModel,
      },
      routeDecisionMetrics: {
        calibrationCount: 60,
        heldOutCount: 240,
        taskCount: 60,
        calibrationError: 0.01,
        minimumConfidence: real.minimumConfidence,
      },
      wholeCohortAccounting: {
        baselineMeasuredApiCostUsd: 60,
        candidateMeasuredApiCostUsd: 30,
        baselinePolicyViolationAssignments: 0,
        candidatePolicyViolationAssignments: 0,
        additionalFailureTasks: 0,
      },
      origin: "unverified" as const,
      promotionEligible: false as const,
    },
  };
  const approver = keyPin();
  const approvalPin = {
    operatorId: "fixture-operator",
    keyId: "fixture-approval-key",
    ...approver,
  };
  const approval = {
    reportSha256: preflight.reportSha256,
    keyFingerprintSha256: approver.publicKeySha256,
    approvalId: "fixture-approval",
    operatorId: "fixture-operator",
    approvalClaimSha256: "b".repeat(64),
    preflightSha256: "c".repeat(64),
    approvedAt: iso(-60 * 60 * 1000),
    expiresAt: iso(10 * DAY),
  };
  const selector = keyPin();
  const auditor = keyPin();
  const bundle = await temporary("promotion-steps-bundle");
  const write = async (name: string, value: unknown) => {
    await mkdir(path.dirname(path.join(bundle, name)), { recursive: true });
    await writeFile(path.join(bundle, name), JSON.stringify(value));
  };
  await write("population/input.json", { synthetic: true });
  await write("population/pins.json", { synthetic: true });
  await write("population/trust.json", {
    keys: [
      {
        keyId: "selector-key",
        actorId: "selector",
        roles: ["selector"],
        publicKeyPem: selector.publicKeyPem,
      },
      {
        keyId: "auditor-key",
        actorId: "auditor",
        roles: ["auditor"],
        publicKeyPem: auditor.publicKeyPem,
      },
    ],
    revokedKeyIds: [],
  });
  await write("aggregate.json", aggregateInput);
  await write("aggregate-manifest.json", { synthetic: true });
  await write("identity-manifest.json", { entries: [] });
  await write("workers.json", [
    { pin: { workerId: "worker", keyId: "worker-key", ...keyPin() } },
  ]);
  await write("oracles.json", [
    {
      pin: { oracleExecutorId: "oracle", keyId: "oracle-key", ...keyPin() },
    },
  ]);
  await write("source-pin.json", {
    sourceAuthorityId: "source",
    keyId: "source-key",
    ...keyPin(),
  });
  for (const name of ["worker", "source", "oracle"])
    await write(`${name}-registry.json`, { synthetic: name });
  await write("source-envelope.json", { synthetic: true });
  await write("pins.json", aggregateInput.preflightPins);
  await write("approval/target.json", aggregateInput.preflightPins);
  await write("approval/pin.json", approvalPin);
  await write("approval/envelope.json", { synthetic: true });
  await write("policy.json", config.policy);
  const route = grantedPromotionRouteSchema.parse({
    ...buildLivePromotionRoute({
      projectId: config.projectId,
      policy: config.policy,
      category: real.category,
      provider,
      providers: [provider],
    }),
    repositoryIdentitySha256,
    stateFormatVersion: preflight.stateFormatVersion,
    expectedModel: preflight.expectedModel,
    modelIdentitySha256: preflight.modelIdentitySha256,
    modelIdentityEvidence: "runtime-attestation",
    candidateConfigurationSha256: preflight.candidateConfigurationSha256,
  });
  await write("route.json", route);
  const manifest = {
    version: "1.0.0",
    kind: "promotion-grant-bundle",
    projectId: config.projectId,
    collectionId: real.collectionId,
    readiness: {
      population: {
        input: "population/input.json",
        trust: "population/trust.json",
        pins: "population/pins.json",
      },
      aggregate: {
        input: "aggregate.json",
        manifest: "aggregate-manifest.json",
        manifestSha256: "a".repeat(64),
      },
      identityBytes: {
        manifest: "identity-manifest.json",
        manifestSha256: "d".repeat(64),
      },
      workerDeliveries: "workers.json",
      workerKeyFingerprintRegistry: "worker-registry.json",
      sourceAttestation: {
        pin: "source-pin.json",
        envelope: "source-envelope.json",
      },
      sourceKeyFingerprintRegistry: "source-registry.json",
      oracleExecutions: "oracles.json",
      oracleKeyFingerprintRegistry: "oracle-registry.json",
    },
    originalsDirectory: "originals",
    identityDirectory: "identity",
    candidatePolicy: "policy.json",
    routes: [
      {
        category: real.category,
        preflightPins: "pins.json",
        requestedRoute: "route.json",
        approval: {
          target: "approval/target.json",
          pin: "approval/pin.json",
          envelope: "approval/envelope.json",
        },
        lease: { notBefore: iso(0), notAfter: iso(7 * DAY - 60_000) },
      },
    ],
  };
  await write("bundle.json", manifest);
  const loaded = await readPromotionBundle(bundle);
  const frozenDigests = bundleTrustDigests(loaded);
  const custody = new Map<string, PublicKeyPin>(
    collectSignerClaims(loaded).map((claim) => [
      `${claim.role}/${claim.keyId}`,
      { ...claim },
    ]),
  );
  const anchor = {
    version: "1.0.0" as const,
    kind: "graph-engineering-promotion-trust-anchor" as const,
    enrolledProjects: [
      { projectId: config.projectId, repositoryIdentitySha256 },
    ],
    approverKeys: [
      {
        operatorId: "fixture-operator",
        keyId: "fixture-approval-key",
        publicKeySha256: approver.publicKeySha256,
      },
    ],
    issuerKeys: [
      { issuerId: "issuer", keyId: "issuer", publicKeySha256: "f".repeat(64) },
    ],
    witnessId: "test-witness",
    controllers: {
      witness: "none" as const,
      custody: "none" as const,
      modelIdentity: "none" as const,
    },
  };
  const calls: string[] = [];
  const checkpoint = (query: {
    witnessId: string;
    projectId: string;
    collectionId: string;
    challenge: string;
  }) => ({
    ...query,
    issuedAt: iso(0),
    expiresAt: iso(30_000),
    checkpointSha256: "9".repeat(64),
    frozenDigests,
  });
  const controllers = {
    witness: {
      kind: "test-fake",
      readCollectionCheckpoint: async (
        query: Parameters<typeof checkpoint>[0],
      ) => {
        calls.push("checkpoint");
        return checkpoint(query);
      },
      readGrantStatus: async (query: {
        witnessId: string;
        projectId: string;
        grantId: string;
        challenge: string;
      }) => {
        calls.push("status");
        return {
          ...query,
          status: "unregistered",
          issuedAt: iso(0),
          expiresAt: iso(30_000),
        };
      },
    },
    custody: {
      kind: "test-fake",
      resolveVerificationKey: async (role: string, keyId: string) => {
        calls.push(`custody:${role}`);
        return custody.get(`${role}/${keyId}`);
      },
    },
    attestor: {
      kind: "test-fake",
      attest: async () => {
        calls.push("attest");
        return {
          evidence: "runtime-attestation" as const,
          modelIdentitySha256: preflight.modelIdentitySha256,
        };
      },
    },
  };
  // Test-only replacements, all through vitest spies.
  vi.spyOn(trustAnchor, "readPromotionTrustAnchor").mockResolvedValue(anchor);
  vi.spyOn(promotionControllers, "promotionControllersFor").mockReturnValue(
    controllers as unknown as PromotionControllers,
  );
  vi.spyOn(
    identityReader,
    "withPrivateSealedIdentityFileReader",
  ).mockResolvedValue({
    evaluationArtifactSha256,
    accountingMetricsSatisfied: true,
    promotionEligible: false,
  } as never);
  vi.spyOn(
    promotionAuthority,
    "inspectPromotionImportPreflight",
  ).mockResolvedValue(preflight as never);
  vi.spyOn(signedApproval, "inspectSignedPromotionApproval").mockResolvedValue(
    approval as never,
  );
  const run = () => preparePromotionGrantRequest(root, bundle);
  return {
    root,
    data,
    bundle,
    run,
    calls,
    controllers,
    custody,
    loaded,
    config,
    preflight,
  };
}

const snapshot = async (directory: string) => {
  const files: Record<string, string> = {};
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else
        files[path.relative(directory, full)] = hashJson(
          (await readFile(full)).toString("base64"),
        );
    }
  };
  await walk(directory);
  return files;
};

describe("importer past step 1 (test-only anchor and controllers)", () => {
  it("runs the steps in order and emits only an unsigned request that confers no authority", async () => {
    const h = await harness();
    const before = await snapshot(h.bundle);
    const result = await h.run();
    if (result.outcome !== "unsigned-requests")
      throw new Error(`refused: ${JSON.stringify(result)}`);
    expect(result).toMatchObject({ signed: false, promotionEligible: false });
    expect(result.requests).toHaveLength(1);
    const request = result.requests[0]!;
    expect(promotionGrantRequestSchema.parse(request)).toEqual(request);
    expect(request.signed).toBe(false);
    expect(request).not.toHaveProperty("promotionEligible");
    expect(request.routeMetrics.calibrationAccuracy).toBeGreaterThanOrEqual(
      0.95,
    );
    // Witness (4), custody (8), attestation (10), witness and status (11).
    const order = h.calls.map((call) => call.split(":")[0]);
    expect(order[0]).toBe("checkpoint");
    expect(order.indexOf("custody")).toBeGreaterThan(0);
    expect(order.indexOf("attest")).toBeGreaterThan(
      order.lastIndexOf("custody"),
    );
    expect(order.slice(-2)).toEqual(["checkpoint", "status"]);
    // Nothing was written, and the runtime still grants nothing.
    expect(await snapshot(h.bundle)).toEqual(before);
    const scope = {
      projectId: h.config.projectId,
      policyVersion: hash(h.config.policy),
    };
    const loaded = await loadPromotionAuthority(
      projectDataDir(h.config.projectId),
      scope,
    );
    expect(loaded.status).toBe("absent");
    expect(
      await authorizesPromotionFromBinding(
        loaded.binding,
        {
          version: "a".repeat(64),
          category: request.route.category,
          provider: "laya",
          model: request.route.requestedModel,
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
          datasetId: "synthetic",
        },
        scope,
      ),
    ).toBe(false);
    expect(
      (await readdir(projectDataDir(h.config.projectId))).filter((name) =>
        /promotion|grant|trust|witness/.test(name),
      ),
    ).toEqual([]);
  }, 60000);

  it("refuses replayed, redirected or stale witness replies at steps 4 and 11", async () => {
    const h = await harness();
    const witness = h.controllers.witness;
    const original = witness.readCollectionCheckpoint;
    type Query = Parameters<typeof original>[0];
    const cases: [string, (query: Query) => Promise<unknown>, number][] = [
      [
        "replayed challenge",
        async (query) => ({
          ...(await original(query)),
          challenge: "0".repeat(64),
        }),
        4,
      ],
      [
        "other collection",
        async (query) => ({
          ...(await original(query)),
          collectionId: "other-collection",
        }),
        4,
      ],
      [
        "other witness",
        async (query) => ({ ...(await original(query)), witnessId: "other" }),
        4,
      ],
      [
        "stale",
        async (query) => ({
          ...(await original(query)),
          issuedAt: iso(-120_000),
          expiresAt: iso(-60_000),
        }),
        4,
      ],
    ];
    for (const [label, reply, stepNumber] of cases) {
      witness.readCollectionCheckpoint = reply as typeof original;
      expect(await h.run(), label).toMatchObject({
        outcome: "refused",
        step: stepNumber,
        refusal: "witness-reply-invalid",
      });
    }
    // The closing checkpoint replays the opening reply.
    let first: unknown;
    witness.readCollectionCheckpoint = (async (query: Query) =>
      (first ??= await original(query))) as typeof original;
    expect(await h.run()).toMatchObject({
      outcome: "refused",
      step: 11,
      refusal: "witness-reply-invalid",
    });
    witness.readCollectionCheckpoint = original;
    const status = witness.readGrantStatus;
    witness.readGrantStatus = (async (query) => ({
      ...(await status(query)),
      grantId: "0".repeat(64),
    })) as typeof status;
    expect(await h.run()).toMatchObject({
      step: 11,
      refusal: "witness-reply-invalid",
    });
    witness.readGrantStatus = (async (query) => ({
      ...(await status(query)),
      status: "active",
    })) as typeof status;
    expect(await h.run()).toMatchObject({
      step: 11,
      refusal: "grant-already-registered",
    });
  }, 60000);

  it("refuses a custody key that differs from the bundle's, and stops at the earliest failing step", async () => {
    const h = await harness();
    const [key, pin] = [...h.custody.entries()].find(([name]) =>
      name.startsWith("worker/"),
    )!;
    h.custody.set(key, { ...pin, publicKeySha256: "0".repeat(64) });
    // Step 10 would also refuse, but step 8 comes first.
    h.controllers.attestor.attest = async () => undefined as never;
    expect(await h.run()).toMatchObject({
      outcome: "refused",
      step: 8,
      refusal: "signer-key-mismatch",
    });
    h.custody.set(key, pin);
    expect(await h.run()).toMatchObject({
      step: 10,
      refusal: "model-identity-unattested",
    });
  }, 60000);

  it("refuses at the final schema parse when the lease exceeds 7 days", async () => {
    const h = await harness();
    const manifest = JSON.parse(
      await readFile(path.join(h.bundle, "bundle.json"), "utf8"),
    );
    manifest.routes[0].lease.notAfter = iso(7 * DAY + 60_000);
    await writeFile(
      path.join(h.bundle, "bundle.json"),
      JSON.stringify(manifest),
    );
    expect(await h.run()).toMatchObject({
      outcome: "refused",
      step: 11,
      refusal: "grant-request-invalid",
    });
  }, 60000);
});

describe("witness reply and signer checks", () => {
  const query = {
    witnessId: "witness",
    projectId: "project",
    collectionId: "collection",
    challenge: "1".repeat(64),
  };
  const now = Date.parse("2026-09-27T12:00:00.000Z");
  const reply = (change: object = {}) => ({
    ...query,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString(),
    checkpointSha256: "2".repeat(64),
    frozenDigests: { rowTrustSha256: "3".repeat(64) },
    ...change,
  });
  it("accepts only a fresh reply to the exact request", () => {
    expect(checkWitnessCheckpointReply(reply(), query, now).challenge).toBe(
      query.challenge,
    );
    for (const change of [
      { challenge: "4".repeat(64) },
      { witnessId: "other" },
      { projectId: "other" },
      { collectionId: "other" },
      { issuedAt: new Date(now - 61_000).toISOString() },
      { issuedAt: new Date(now + 6_000).toISOString() },
      { expiresAt: new Date(now).toISOString() },
      { expiresAt: new Date(now + 61_000).toISOString() },
      { extra: true },
    ])
      expect(
        refusal(() => checkWitnessCheckpointReply(reply(change), query, now)),
        JSON.stringify(change),
      ).toBe("witness-reply-invalid");
    const statusQuery = {
      witnessId: "witness",
      projectId: "project",
      grantId: "5".repeat(64),
      challenge: "1".repeat(64),
    };
    const status = (change: object = {}) => ({
      ...statusQuery,
      status: "unregistered",
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 30_000).toISOString(),
      ...change,
    });
    expect(
      checkWitnessGrantStatusReply(status(), statusQuery, now).status,
    ).toBe("unregistered");
    for (const change of [
      { grantId: "6".repeat(64) },
      { challenge: "7".repeat(64) },
      { issuedAt: new Date(now - 120_000).toISOString() },
      { status: "maybe" },
    ])
      expect(
        refusal(() =>
          checkWitnessGrantStatusReply(status(change), statusQuery, now),
        ),
      ).toBe("witness-reply-invalid");
  });

  it("resolves every registry key and refuses a key with no role or an unknown role", async () => {
    const h = await harness();
    const claims = collectSignerClaims(h.loaded);
    const roles = new Set(claims.map((claim) => claim.role));
    for (const role of [
      "selector",
      "auditor",
      "labeler",
      "reviewer",
      "collector",
      "aggregate-reviewer",
      "source",
      "worker",
      "oracle",
      "approver",
    ])
      expect(roles, role).toContain(role);
    for (const claim of claims)
      expect(claim.publicKeySha256).toMatch(/^[a-f0-9]{64}$/);
    const withTrust = (trust: unknown): PromotionBundle => ({
      ...h.loaded,
      documents: new Map([
        ...h.loaded.documents,
        ["population/trust.json", trust],
      ]),
    });
    const population = JSON.parse(
      await readFile(path.join(h.bundle, "population/trust.json"), "utf8"),
    );
    for (const roles of [[], ["curator"], ["selector", "labeler"]]) {
      const changed = structuredClone(population);
      changed.keys[0].roles = roles;
      expect(
        refusal(() => collectSignerClaims(withTrust(changed))),
        JSON.stringify(roles),
      ).toBe("signer-role-unknown");
    }
    const mismatched = new Map(h.loaded.documents);
    mismatched.set("source-pin.json", {
      ...(h.loaded.documents.get("source-pin.json") as object),
      publicKeySha256: "0".repeat(64),
    });
    expect(
      refusal(() =>
        collectSignerClaims({ ...h.loaded, documents: mismatched }),
      ),
    ).toBe("signer-key-mismatch");
  }, 60000);
});
