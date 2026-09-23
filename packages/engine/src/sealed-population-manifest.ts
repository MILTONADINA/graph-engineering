// Analysis-only inspection of a separately signed population/split precommit.
// Signatures bind declared inventory; they do not authenticate its origin,
// prove that tasks were unseen, prevent backdating, or issue promotion authority.
import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import {
  cohortPinsSchema,
  validateFullCohortLedger,
} from "./full-cohort-ledger.js";
import {
  canonicalJson,
  decodeJson,
  digestSchema,
  freezeJson,
  hashJson,
} from "./sealed-collection-schema.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const timestamp = z.string().datetime();
const version = z.literal("1.0.0");
const signature = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);

export const sealedSourceInventorySchema = z
  .object({
    version,
    kind: z.literal("sealed-source-population-inventory"),
    sourceInventoryId: id,
    sourceAuthorityId: id,
    declaredAt: timestamp,
    entries: z
      .array(
        z
          .object({
            stableTaskId: id,
            stableFamilyId: id,
            exposureDomain: id,
            repositoryId: id,
            taskSha256: digestSchema,
            sourceArtifactSha256: digestSchema,
            stratum: id,
            eligibility: z.enum([
              "declared-unseen",
              "known-history",
              "previously-replayed",
              "previously-disclosed",
              "other-exclusion",
            ]),
            producerIds: z.array(id).min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
  })
  .strict();

export const sealedPopulationManifestTrustSchema = z
  .object({
    version,
    kind: z.literal("sealed-population-manifest-trust"),
    keys: z
      .array(
        z
          .object({
            keyId: id,
            actorId: id,
            roles: z
              .array(z.enum(["selector", "auditor"]))
              .min(1)
              .max(2),
            publicKeyPem: z.string().min(32).max(16_000),
          })
          .strict(),
      )
      .min(2)
      .max(100),
    revokedKeyIds: z.array(id).max(100),
  })
  .strict();

export const sealedPopulationManifestPayloadSchema = z
  .object({
    version,
    kind: z.literal("sealed-population-split-manifest"),
    projectId: id,
    collectionId: id,
    planSha256: digestSchema,
    registrySha256: digestSchema,
    sourceInventorySha256: digestSchema,
    taskInventorySha256: digestSchema,
    assignmentInventorySha256: digestSchema,
    populationDeclarationSha256: digestSchema,
    samplingRuleSha256: digestSchema,
    calibrationDatasetSha256: digestSchema,
    selectedStableTaskIds: z.array(id).min(1).max(1000),
    eligibleSourceCount: z.number().int().nonnegative().max(10_000),
    excludedSourceCount: z.number().int().nonnegative().max(10_000),
  })
  .strict();

const attestationSchema = z
  .object({
    keyId: id,
    role: z.enum(["selector", "auditor"]),
    signedAt: timestamp,
    payloadSha256: digestSchema,
    signature,
  })
  .strict();

export const sealedPopulationManifestBundleSchema = z
  .object({
    payload: sealedPopulationManifestPayloadSchema,
    attestations: z.array(attestationSchema).length(2),
  })
  .strict();

export const sealedPopulationManifestPinsSchema = z
  .object({
    expectedPlanSha256: digestSchema,
    expectedRegistrySha256: digestSchema,
    expectedSourceInventorySha256: digestSchema,
    expectedTrustSha256: digestSchema,
  })
  .strict();

const inputSchema = z
  .object({
    inspection: z.unknown(),
    cohortPins: cohortPinsSchema,
    sourceInventory: sealedSourceInventorySchema,
    bundle: sealedPopulationManifestBundleSchema,
  })
  .strict();

const require = (condition: unknown, message: string): void => {
  if (!condition)
    throw new Error(`Invalid sealed population manifest: ${message}`);
};

/**
 * Verify an original, purpose-separated pair of selector/auditor signatures
 * against a separately pinned public trust and full frozen cohort inventory.
 * The source inventory, actor identities, claimed times, and pins remain
 * caller-selected; even a valid result is analysis-only.
 */
export function inspectSealedPopulationSplitManifest(
  input: unknown,
  trustInput: unknown,
  pinInput: unknown,
  options: { nowMs?: number } = {},
) {
  const value = inputSchema.parse(decodeJson(input));
  const trust = sealedPopulationManifestTrustSchema.parse(
    decodeJson(trustInput),
  );
  const pins = sealedPopulationManifestPinsSchema.parse(decodeJson(pinInput));
  const parsedOptions = z
    .object({ nowMs: z.number().finite().optional() })
    .strict()
    .parse(decodeJson(options));
  const nowMs = parsedOptions.nowMs ?? Date.now();
  require(nowMs >= 0 &&
    nowMs <= 8_640_000_000_000_000, "invalid verification time");
  const inspection = validateFullCohortLedger(
    value.inspection,
    value.cohortPins,
  );
  const { plan, registry } = inspection;
  const source = value.sourceInventory;
  const payload = value.bundle.payload;
  const planSha256 = hashJson(plan);
  const registrySha256 = hashJson(registry);
  const sourceInventorySha256 = hashJson(source);
  const trustSha256 = hashJson(trust);
  require(pins.expectedPlanSha256 === planSha256 &&
    pins.expectedRegistrySha256 === registrySha256 &&
    pins.expectedSourceInventorySha256 === sourceInventorySha256 &&
    pins.expectedTrustSha256 ===
      trustSha256, "separately selected plan, registry, source inventory, or trust pin differs");
  require(Date.parse(registry.createdAt) <= Date.parse(plan.createdAt) &&
    Date.parse(source.declaredAt) <=
      Date.parse(
        plan.createdAt,
      ), "declared source or exposure registry postdates the frozen plan");
  const sourceByTask = new Map<string, (typeof source.entries)[number]>();
  const sourceDigests = new Set<string>();
  const sourceArtifacts = new Set<string>();
  const sourceFamilies = new Set<string>();
  const knownTasks = new Set(registry.entries.map((item) => item.stableTaskId));
  const knownFamilies = new Set(
    registry.entries.map((item) => item.stableFamilyId),
  );
  const knownDigests = new Set(
    registry.entries.flatMap((item) => [
      item.evidenceSha256,
      ...item.artifactSha256s,
    ]),
  );
  for (const entry of source.entries) {
    require(!sourceByTask.has(entry.stableTaskId) &&
      !sourceDigests.has(entry.taskSha256) &&
      !sourceArtifacts.has(entry.sourceArtifactSha256) &&
      !sourceFamilies.has(entry.stableFamilyId) &&
      new Set(entry.producerIds).size ===
        entry.producerIds
          .length, "ambiguous source task identity, family, artifact, content, or producer inventory");
    sourceByTask.set(entry.stableTaskId, entry);
    sourceDigests.add(entry.taskSha256);
    sourceArtifacts.add(entry.sourceArtifactSha256);
    sourceFamilies.add(entry.stableFamilyId);
    const known =
      knownTasks.has(entry.stableTaskId) ||
      knownFamilies.has(entry.stableFamilyId) ||
      knownDigests.has(entry.sourceArtifactSha256) ||
      knownDigests.has(entry.taskSha256);
    require(!known ||
      entry.eligibility !==
        "declared-unseen", "source inventory labels a known exposure as unseen");
  }
  const selectedFamilies = new Set<string>();
  for (const task of plan.tasks) {
    const entry = sourceByTask.get(task.stableTaskId);
    require(entry?.eligibility === "declared-unseen" &&
      entry.stableFamilyId === task.stableFamilyId &&
      entry.exposureDomain === task.exposureDomain &&
      entry.repositoryId === task.repositoryId &&
      entry.taskSha256 === hashJson(task) &&
      !selectedFamilies.has(
        task.stableFamilyId,
      ), "selected task is absent, exposed, changed, or repeats a selected family");
    selectedFamilies.add(task.stableFamilyId);
  }
  const eligibleSourceCount = source.entries.filter(
    (entry) => entry.eligibility === "declared-unseen",
  ).length;
  const expectedPayload = sealedPopulationManifestPayloadSchema.parse({
    version: "1.0.0",
    kind: "sealed-population-split-manifest",
    projectId: plan.projectId,
    collectionId: plan.collectionId,
    planSha256,
    registrySha256,
    sourceInventorySha256,
    taskInventorySha256: hashJson(plan.tasks),
    assignmentInventorySha256: hashJson(plan.assignments),
    populationDeclarationSha256: hashJson(plan.population),
    samplingRuleSha256: hashJson(plan.samplingRule),
    calibrationDatasetSha256: plan.calibrationDatasetSha256,
    selectedStableTaskIds: plan.tasks.map((task) => task.stableTaskId),
    eligibleSourceCount,
    excludedSourceCount: source.entries.length - eligibleSourceCount,
  });
  require(hashJson(payload) ===
    hashJson(
      expectedPayload,
    ), "signed population/split payload differs from frozen cohort inventory");
  const keyIds = new Set<string>();
  const fingerprints = new Set<string>();
  const keys = new Map<
    string,
    {
      actorId: string;
      roles: ("selector" | "auditor")[];
      publicKey: ReturnType<typeof createPublicKey>;
    }
  >();
  for (const key of trust.keys) {
    require(!keyIds.has(key.keyId) &&
      new Set(key.roles).size === key.roles.length &&
      key.publicKeyPem.startsWith(
        "-----BEGIN PUBLIC KEY-----",
      ), "duplicate key identity or non-public trust material");
    keyIds.add(key.keyId);
    const publicKey = createPublicKey(key.publicKeyPem);
    require(publicKey.asymmetricKeyType === "ed25519" &&
      key.publicKeyPem ===
        publicKey
          .export({ type: "spki", format: "pem" })
          .toString(), "manifest trust requires canonical Ed25519 public keys");
    const fingerprint = publicKey
      .export({ type: "spki", format: "der" })
      .toString("hex");
    require(!fingerprints.has(
      fingerprint,
    ), "one public key is reused by distinct identities");
    fingerprints.add(fingerprint);
    keys.set(key.keyId, { actorId: key.actorId, roles: key.roles, publicKey });
  }
  require(new Set(trust.revokedKeyIds).size === trust.revokedKeyIds.length &&
    trust.revokedKeyIds.every((keyId) =>
      keyIds.has(keyId),
    ), "manifest trust has ambiguous revocations");
  const disallowedSignerActors = new Set([
    source.sourceAuthorityId,
    ...plan.producerIds,
    ...plan.tasks.map((task) => task.curatorId),
    ...source.entries.flatMap((entry) => entry.producerIds),
  ]);
  const payloadSha256 = hashJson(payload);
  const earliestReservation = Math.min(
    ...inspection.assignments
      .filter((item) => item.reservation)
      .map((item) => Date.parse(item.reservation!.reservedAt)),
  );
  const signedActors: string[] = [];
  let previousTime = Date.parse(plan.createdAt);
  for (const [index, attestation] of value.bundle.attestations.entries()) {
    const role = index === 0 ? "selector" : "auditor";
    const key = keys.get(attestation.keyId);
    const signedAt = Date.parse(attestation.signedAt);
    const { signature: signatureBase64, ...envelope } = attestation;
    const signatureBytes = Buffer.from(signatureBase64, "base64");
    require(attestation.role === role &&
      key?.roles.includes(role) &&
      !trust.revokedKeyIds.includes(attestation.keyId) &&
      !disallowedSignerActors.has(key.actorId) &&
      attestation.payloadSha256 === payloadSha256 &&
      signedAt >= previousTime &&
      signedAt < Date.parse(plan.notBefore) &&
      signedAt < earliestReservation &&
      signedAt <= nowMs + 60_000 &&
      signatureBytes.length === 64 &&
      signatureBytes.toString("base64") === signatureBase64 &&
      verify(
        null,
        Buffer.from(
          `graph-engineering/sealed-population-split/v1\n${canonicalJson(envelope)}`,
        ),
        key.publicKey,
        signatureBytes,
      ), "original manifest signature, signer, or claimed pre-run time mismatch");
    previousTime = signedAt;
    signedActors.push(key!.actorId);
  }
  require(signedActors[0] !==
    signedActors[1], "selector and auditor must be distinct non-source actors");
  return freezeJson({
    kind: "sealed-population-split-signatures-only" as const,
    projectId: plan.projectId,
    collectionId: plan.collectionId,
    planSha256,
    registrySha256,
    sourceInventorySha256,
    taskInventorySha256: expectedPayload.taskInventorySha256,
    assignmentInventorySha256: expectedPayload.assignmentInventorySha256,
    signedManifestSha256: hashJson(value.bundle),
    manifestPayloadSha256: payloadSha256,
    trustSha256,
    signatureInventorySha256: hashJson(value.bundle.attestations),
    selectedTaskCount: plan.tasks.length,
    eligibleSourceCount,
    excludedSourceCount: source.entries.length - eligibleSourceCount,
    signatureVerificationPerformed: true as const,
    sourceEligibilityAuthenticated: false as const,
    samplingRuleSatisfiedVerified: false as const,
    precommitChronologyAuthenticated: false as const,
    operatorApprovalVerified: false as const,
    antiRollbackVerified: false as const,
    populationIndependenceVerified: false as const,
    promotionEligible: false as const,
    authorityStatus: "population-manifest-signatures-only" as const,
    limitations: [
      "Signed timestamps cannot prove non-backdating without an independently controlled append-only witness.",
      "Source eligibility, actor identity, population completeness, and sampling-rule truth remain operator claims.",
      "Exact exposure-registry matches are rejected, but undisclosed or semantic exposure cannot be detected.",
    ],
  });
}
