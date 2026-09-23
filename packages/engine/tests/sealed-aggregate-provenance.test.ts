import { expect, it } from "vitest";
import {
  inspectPrivateSealedAggregateFromManifest,
  inspectPrivateSealedAggregateProvenance,
} from "../src/sealed-aggregate-provenance.js";
import { hashJson } from "../src/sealed-collection-schema.js";
import {
  aggregateReviewerAt,
  collectorAt,
  fixture,
  nowMs,
} from "./sealed-aggregate-fixture.js";

it("checks every synthetic original byte and purpose-separated signature without authority", async () => {
  const { input } = await fixture();
  const receipt = await inspectPrivateSealedAggregateProvenance(input, {
    nowMs,
  });
  expect(receipt).toMatchObject({
    assignmentCount: 2,
    callCount: 2,
    verifiedRowReviewCount: 1,
    originalArtifactCount: input.originalArtifacts.length,
    signatureVerificationPerformed: true,
    originalByteHashesChecked: true,
    identityOnlyBytesAudited: false,
    rowSignaturesVerified: true,
    operatorApprovalVerified: false,
    antiRollbackVerified: false,
    protectedExecutionVerified: false,
    populationIndependenceVerified: false,
    artifactSourceAuthenticated: false,
    promotionEligible: false,
    authorityStatus: "signed-aggregate-inspection-only",
  });
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(
    input.originalArtifacts.every(
      (item) =>
        !item.role.startsWith("configuration/") &&
        !item.role.startsWith("provider/") &&
        !item.role.startsWith("label/"),
    ),
  ).toBe(true);
  expect(JSON.stringify(receipt)).not.toContain(
    "synthetic-original:private-oracle",
  );
});

it("binds a nonterminal call-bound oracle claim and private verdict bytes without treating them as success", async () => {
  const { input } = await fixture(true);
  const receipt = await inspectPrivateSealedAggregateProvenance(input, {
    nowMs,
  });
  expect(receipt.promotionEligible).toBe(false);
  expect(receipt.protectedExecutionVerified).toBe(false);
  expect(
    input.cohort.inspection.assignments[1]!.receipt!.outcome.success,
  ).toBeNull();
  expect(
    input.originalArtifacts.some(
      (item) => item.role === "oracle/v1/candidate/private-verdict",
    ),
  ).toBe(true);
  const tampered = structuredClone(input);
  tampered.originalArtifacts.find(
    (item) => item.role === "oracle/v1/candidate/private-verdict",
  )!.bytesBase64 = Buffer.from("fail").toString("base64");
  await expect(
    inspectPrivateSealedAggregateProvenance(tampered, { nowMs }),
  ).rejects.toThrow(/content differs/);
});

it("rejects a response-to-proposal mismatch even when the ledger and aggregate are freshly signed", async () => {
  const { input } = await fixture(true, true);
  await expect(
    inspectPrivateSealedAggregateProvenance(input, { nowMs }),
  ).rejects.toThrow(/proposal differs from retained model response/);
});

it("rejects signed call-bound rows with an unrelated packet or model request", async () => {
  const wrongRequest = await fixture(true, false, false, false, true);
  await expect(
    inspectPrivateSealedAggregateProvenance(wrongRequest.input, { nowMs }),
  ).rejects.toThrow(/request differs from frozen public packet/);
  const wrongPacket = await fixture(true, false, false, false, false, true);
  await expect(
    inspectPrivateSealedAggregateProvenance(wrongPacket.input, { nowMs }),
  ).rejects.toThrow(/public packet differs from frozen task identity/);
});

it("rejects a malformed private digest verdict with internally consistent hashes and signatures", async () => {
  const { input } = await fixture(true, false, true);
  await expect(
    inspectPrivateSealedAggregateProvenance(input, { nowMs }),
  ).rejects.toThrow(/private digest-oracle verdict/i);
});

it("rejects aggregate signatures collected before the final closed event", async () => {
  const { input } = await fixture(false, false, false, true);
  await expect(
    inspectPrivateSealedAggregateProvenance(input, { nowMs }),
  ).rejects.toThrow(/chronology/);
});

it("refuses missing, changed or extra private original bytes even with unchanged signatures", async () => {
  const { input } = await fixture();
  const missing = structuredClone(input);
  missing.originalArtifacts.pop();
  await expect(
    inspectPrivateSealedAggregateProvenance(missing, { nowMs }),
  ).rejects.toThrow(/inventory is incomplete/);
  const changed = structuredClone(input);
  changed.originalArtifacts[0]!.bytesBase64 =
    Buffer.from("changed").toString("base64");
  await expect(
    inspectPrivateSealedAggregateProvenance(changed, { nowMs }),
  ).rejects.toThrow(/content differs/);
  const extra = structuredClone(input);
  extra.originalArtifacts.push({
    ...extra.originalArtifacts[0]!,
    role: "task/extra/baseline",
  });
  await expect(
    inspectPrivateSealedAggregateProvenance(extra, { nowMs }),
  ).rejects.toThrow(/inventory is incomplete/);
  const noncanonical = structuredClone(input);
  noncanonical.originalArtifacts[0]!.bytesBase64 += "=";
  await expect(
    inspectPrivateSealedAggregateProvenance(noncanonical, { nowMs }),
  ).rejects.toThrow(/content differs/);
  const duplicate = structuredClone(input);
  duplicate.originalArtifacts[1] = { ...duplicate.originalArtifacts[0]! };
  await expect(
    inspectPrivateSealedAggregateProvenance(duplicate, { nowMs }),
  ).rejects.toThrow(/role or digest mismatch/);
});

it("refuses changed outcome, aggregate inventory, wrong purpose, or unpinned trust", async () => {
  const { input, keys, signed } = await fixture();
  const changedOutcome = structuredClone(input);
  changedOutcome.cohort.inspection.assignments[1]!.receipt!.outcome.success = false;
  await expect(
    inspectPrivateSealedAggregateProvenance(changedOutcome, { nowMs }),
  ).rejects.toThrow();
  const changedInventory = structuredClone(input);
  changedInventory.bundle.payload.assignmentOutcomeInventorySha256 = hashJson({
    forged: true,
  });
  await expect(
    inspectPrivateSealedAggregateProvenance(changedInventory, { nowMs }),
  ).rejects.toThrow(/differs from original joined inventory/);
  const wrongPurpose = structuredClone(input);
  wrongPurpose.bundle.attestations[0] = signed(
    "aggregate-collector",
    "collector",
    collectorAt,
    hashJson(input.bundle.payload),
    "graph-engineering/calibration-review/v1",
    keys.collector.privateKey,
  );
  await expect(
    inspectPrivateSealedAggregateProvenance(wrongPurpose, { nowMs }),
  ).rejects.toThrow(/signature or signer mismatch/);
  const wrongPin = structuredClone(input);
  wrongPin.aggregateTrustPin.expectedAggregateTrustSha256 = hashJson({
    forged: true,
  });
  await expect(
    inspectPrivateSealedAggregateProvenance(wrongPin, { nowMs }),
  ).rejects.toThrow(/separate pin/);
});

it("refuses revoked, self-reviewing, stale and incomplete aggregate provenance", async () => {
  const { input, keys, signed } = await fixture();
  const resign = (changed: typeof input) => {
    changed.aggregateTrustPin.expectedAggregateTrustSha256 = hashJson(
      changed.aggregateTrust,
    );
    changed.bundle.payload.aggregateTrustSha256 = hashJson(
      changed.aggregateTrust,
    );
    const payloadSha256 = hashJson(changed.bundle.payload);
    changed.bundle.attestations = [
      signed(
        "aggregate-collector",
        "collector",
        collectorAt,
        payloadSha256,
        "graph-engineering/sealed-aggregate-provenance/v1",
        keys.collector.privateKey,
      ),
      signed(
        "aggregate-reviewer",
        "reviewer",
        aggregateReviewerAt,
        payloadSha256,
        "graph-engineering/sealed-aggregate-provenance/v1",
        keys.aggregateReviewer.privateKey,
      ),
    ];
  };
  const revoked = structuredClone(input);
  revoked.aggregateTrust.revokedKeyIds.push("aggregate-reviewer");
  resign(revoked);
  await expect(
    inspectPrivateSealedAggregateProvenance(revoked, { nowMs }),
  ).rejects.toThrow(/signature or signer mismatch/);
  const sameActor = structuredClone(input);
  sameActor.aggregateTrust.keys[1]!.actorId =
    sameActor.aggregateTrust.keys[0]!.actorId;
  resign(sameActor);
  await expect(
    inspectPrivateSealedAggregateProvenance(sameActor, { nowMs }),
  ).rejects.toThrow(/independent actors/);
  const producer = structuredClone(input);
  producer.aggregateTrust.keys[0]!.actorId = "fixture-producer";
  resign(producer);
  await expect(
    inspectPrivateSealedAggregateProvenance(producer, { nowMs }),
  ).rejects.toThrow(/signature or signer mismatch/);
  const rowActor = structuredClone(input);
  rowActor.aggregateTrust.keys[0]!.actorId = "row-labeler";
  resign(rowActor);
  await expect(
    inspectPrivateSealedAggregateProvenance(rowActor, { nowMs }),
  ).rejects.toThrow(/signature or signer mismatch/);
  const rowKey = structuredClone(input);
  rowKey.aggregateTrust.keys[0]!.publicKeyPem =
    rowKey.rowTrust.keys[0]!.publicKeyPem;
  resign(rowKey);
  await expect(
    inspectPrivateSealedAggregateProvenance(rowKey, { nowMs }),
  ).rejects.toThrow(/reuse held-out review keys/);
  const stale = structuredClone(input);
  await expect(
    inspectPrivateSealedAggregateProvenance(stale, {
      nowMs: Date.parse("2026-01-02T00:00:00.000Z"),
    }),
  ).rejects.toThrow();
  const incomplete = structuredClone(input);
  incomplete.cohort.inspection.closure!.complete = false;
  await expect(
    inspectPrivateSealedAggregateProvenance(incomplete, { nowMs }),
  ).rejects.toThrow();
});

it("refuses hostile accessors and proxies before inspecting private material", async () => {
  const { input } = await fixture();
  let invoked = false;
  const accessor = { ...input };
  Object.defineProperty(accessor, "originalArtifacts", {
    enumerable: true,
    get() {
      invoked = true;
      return input.originalArtifacts;
    },
  });
  await expect(
    inspectPrivateSealedAggregateProvenance(accessor, { nowMs }),
  ).rejects.toThrow(/accessors/);
  expect(invoked).toBe(false);
  await expect(
    inspectPrivateSealedAggregateProvenance(new Proxy(input, {}), { nowMs }),
  ).rejects.toThrow(/plain finite JSON/);
});

function manifestSource(input: Awaited<ReturnType<typeof fixture>>["input"]) {
  const { originalArtifacts, ...detached } = input;
  const manifest = {
    version: "1.0.0",
    kind: "sealed-original-byte-manifest",
    collectionId: input.cohort.inspection.plan.collectionId,
    planSha256: input.cohort.inspection.planSha256,
    entries: originalArtifacts
      .map(({ role, sha256, bytesBase64 }) => ({
        role,
        sha256,
        bytes: Buffer.from(bytesBase64, "base64").length,
      }))
      .sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0)),
  };
  const originals = new Map(
    originalArtifacts.map(({ role, bytesBase64 }) => [role, bytesBase64]),
  );
  const supplied: Uint8Array[] = [];
  const reader = async ({ role }: { role: string }) => {
    const encoded = originals.get(role);
    if (encoded === undefined) throw new Error("Missing synthetic blob");
    const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
    supplied.push(bytes);
    return bytes;
  };
  return { detached, manifest, originals, reader, supplied };
}

it("audits more than 2 MB of aggregate originals through bounded manifest reads", async () => {
  const { input } = await fixture(
    false,
    false,
    false,
    false,
    false,
    false,
    true,
  );
  const source = manifestSource(input);
  const total = source.manifest.entries.reduce(
    (sum, entry) => sum + entry.bytes,
    0,
  );
  expect(total).toBeGreaterThan(2_000_000);
  const receipt = await inspectPrivateSealedAggregateFromManifest(
    source.detached,
    source.manifest,
    hashJson(source.manifest),
    source.reader,
    { nowMs },
  );
  expect(receipt.originalArtifactBytes).toBe(total);
  expect(receipt.promotionEligible).toBe(false);
  expect(receipt.artifactSourceAuthenticated).toBe(false);
  expect(source.supplied.length).toBe(source.manifest.entries.length);
  expect(
    source.supplied.every((bytes) => bytes.every((value) => value === 0)),
  ).toBe(true);
  const privateOracle = Buffer.from(
    source.originals.get("task/held-task/private-oracle")!,
    "base64",
  ).toString("utf8");
  expect(JSON.stringify(receipt)).not.toContain(privateOracle);
});

it("rechecks call-bound proposal and private verdict through manifest reads", async () => {
  const { input } = await fixture(true);
  const source = manifestSource(input);
  const receipt = await inspectPrivateSealedAggregateFromManifest(
    source.detached,
    source.manifest,
    hashJson(source.manifest),
    source.reader,
    { nowMs },
  );
  expect(receipt.callBoundProposalJoinsChecked).toBe(1);
  expect(receipt.promotionEligible).toBe(false);
  expect(
    source.supplied.every((bytes) => bytes.every((value) => value === 0)),
  ).toBe(true);
});

it("rejects missing, extra, corrupt and unpinned manifest originals", async () => {
  const { input } = await fixture();
  const source = manifestSource(input);
  const pinned = hashJson(source.manifest);
  const inspect = (
    manifest: typeof source.manifest,
    pin: string,
    reader = source.reader,
  ) =>
    inspectPrivateSealedAggregateFromManifest(
      source.detached,
      manifest,
      pin,
      reader,
      { nowMs },
    );
  const missing = structuredClone(source.manifest);
  missing.entries.pop();
  await expect(inspect(missing, hashJson(missing))).rejects.toThrow(
    /inventory is incomplete/,
  );
  const extra = structuredClone(source.manifest);
  extra.entries.push({
    role: "task/extra/private-oracle",
    sha256: hashJson({ extra: true }),
    bytes: 1,
  });
  await expect(inspect(extra, hashJson(extra))).rejects.toThrow(
    /inventory is incomplete/,
  );
  await expect(
    inspect(source.manifest, hashJson({ wrong: true })),
  ).rejects.toThrow(/separate pin/);
  const wrongLength = structuredClone(source.manifest);
  wrongLength.entries[0]!.bytes++;
  await expect(inspect(wrongLength, hashJson(wrongLength))).rejects.toThrow(
    /pinned byte bounds/,
  );
  await expect(
    inspect(source.manifest, pinned, async (reference) => {
      const bytes = await source.reader(reference);
      if (reference.role === source.manifest.entries[0]!.role) bytes[0]! ^= 1;
      return bytes;
    }),
  ).rejects.toThrow(/differs from commitment/);
});

it("refuses oversized or shared reader arrays before copying and ignores custom accessors", async () => {
  const { input } = await fixture();
  const source = manifestSource(input);
  const inspect = (
    reader: Parameters<typeof inspectPrivateSealedAggregateFromManifest>[3],
  ) =>
    inspectPrivateSealedAggregateFromManifest(
      source.detached,
      source.manifest,
      hashJson(source.manifest),
      reader,
      { nowMs },
    );
  await expect(inspect(async () => new Uint8Array(2_000_001))).rejects.toThrow(
    /pinned byte bounds/,
  );
  await expect(
    inspect(async ({ bytes }) => new Uint8Array(new SharedArrayBuffer(bytes))),
  ).rejects.toThrow(/shared bytes/);
  let accessorInvoked = false;
  await expect(
    inspect(async (reference) => {
      const bytes = await source.reader(reference);
      Object.defineProperty(bytes, "fill", {
        get() {
          accessorInvoked = true;
          throw new Error("reader accessor invoked");
        },
      });
      return bytes;
    }),
  ).resolves.toMatchObject({ promotionEligible: false });
  expect(accessorInvoked).toBe(false);
});
