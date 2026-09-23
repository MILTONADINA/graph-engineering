import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  inspectPrivateRepositorySnapshotClosure,
  inspectPrivateSealedAggregateFromManifest,
  inspectPrivateSealedAggregateProvenance,
} from "../src/sealed-aggregate-provenance.js";
import { validateFullCohortLedger } from "../src/full-cohort-ledger.js";
import { canonicalJson, hashJson } from "../src/sealed-collection-schema.js";
import {
  aggregateReviewerAt,
  collectorAt,
  engineeringFixture,
  fixture,
  moduleGraphFixture,
  nowMs,
  repositoryClaimFixture,
  repositorySnapshotFixture,
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

it("re-derives a protected engineering proposal, result and private case verdict without authority", async () => {
  const { input } = await engineeringFixture();
  const receipt = await inspectPrivateSealedAggregateProvenance(input, {
    nowMs,
  });
  expect(receipt.callBoundProposalJoinsChecked).toBe(1);
  expect(receipt.protectedExecutionVerified).toBe(false);
  expect(receipt.promotionEligible).toBe(false);
  expect(
    input.cohort.inspection.assignments[1]!.receipt!.outcome.success,
  ).toBeNull();
  expect(
    input.originalArtifacts
      .filter((item) =>
        item.role.startsWith("oracle/engineering-v1/candidate/"),
      )
      .map((item) => item.role),
  ).toEqual([
    "oracle/engineering-v1/candidate/derived-proposal",
    "oracle/engineering-v1/candidate/result-source",
    "oracle/engineering-v1/candidate/private-verdict",
  ]);
  const missing = structuredClone(input);
  missing.originalArtifacts = missing.originalArtifacts.filter(
    (item) => item.role !== "oracle/engineering-v1/candidate/result-source",
  );
  await expect(
    inspectPrivateSealedAggregateProvenance(missing, { nowMs }),
  ).rejects.toThrow(/inventory is incomplete/);
  for (const role of [
    "task/held-task/baseline",
    "task/held-task/private-oracle",
    "oracle/engineering-v1/candidate/derived-proposal",
    "oracle/engineering-v1/candidate/result-source",
    "oracle/engineering-v1/candidate/private-verdict",
  ]) {
    const changed = structuredClone(input);
    changed.originalArtifacts.find((item) => item.role === role)!.bytesBase64 =
      Buffer.from(`forged ${role}`).toString("base64");
    await expect(
      inspectPrivateSealedAggregateProvenance(changed, { nowMs }),
    ).rejects.toThrow(/content differs/);
  }
});

it("rejects engineering result or verdict bytes that disagree with freshly signed history", async () => {
  const wrongResult = await engineeringFixture({ wrongResult: true });
  await expect(
    inspectPrivateSealedAggregateProvenance(wrongResult.input, { nowMs }),
  ).rejects.toThrow(/Engineering result source differs/);
  const malformedVerdict = await engineeringFixture({
    malformedVerdict: true,
  });
  await expect(
    inspectPrivateSealedAggregateProvenance(malformedVerdict.input, { nowMs }),
  ).rejects.toThrow();
  const wrongCounts = await engineeringFixture({ wrongCounts: true });
  await expect(
    inspectPrivateSealedAggregateProvenance(wrongCounts.input, { nowMs }),
  ).rejects.toThrow(/verdict counts differ/);
  const wrongStatus = await engineeringFixture({ wrongStatus: true });
  await expect(
    inspectPrivateSealedAggregateProvenance(wrongStatus.input, { nowMs }),
  ).rejects.toThrow(/verdict counts differ/);
  const reorderedCases = await engineeringFixture({ reverseCases: true });
  await expect(
    inspectPrivateSealedAggregateProvenance(reorderedCases.input, { nowMs }),
  ).rejects.toThrow(/case result differs/);
  const wrongClaim = await engineeringFixture({ wrongVerdictClaim: true });
  await expect(
    inspectPrivateSealedAggregateProvenance(wrongClaim.input, { nowMs }),
  ).rejects.toThrow(/verdict differs from frozen claim/);
  const missingVerdict = await engineeringFixture({ omitVerdict: true });
  await expect(
    inspectPrivateSealedAggregateProvenance(missingVerdict.input, { nowMs }),
  ).rejects.toThrow(/Engineering private verdict is missing/);
});

it("rejects imported engineering claims with altered scope or measured-success authority", async () => {
  const { input } = await engineeringFixture();
  const changedBaseline = structuredClone(input.cohort.inspection);
  const baselineClaim = changedBaseline.assignments[1]!.oracleInvocation;
  if (baselineClaim?.kind !== "sealed-call-bound-engineering-invocation-claim")
    throw new Error("Expected engineering fixture claim");
  baselineClaim.baselineSha256 =
    changedBaseline.plan.tasks[0]!.publicPacketSha256;
  expect(() =>
    validateFullCohortLedger(changedBaseline, input.cohort.pins),
  ).toThrow();
  const reusedResult = structuredClone(input.cohort.inspection);
  const resultClaim = reusedResult.assignments[1]!.oracleInvocation;
  if (resultClaim?.kind !== "sealed-call-bound-engineering-invocation-claim")
    throw new Error("Expected engineering fixture claim");
  resultClaim.resultSourceSha256 = reusedResult.plan.tasks[0]!.baselineSha256;
  expect(() =>
    validateFullCohortLedger(reusedResult, input.cohort.pins),
  ).toThrow();
  const promoted = structuredClone(input.cohort.inspection);
  promoted.assignments[1]!.receipt!.status = "completed";
  promoted.assignments[1]!.receipt!.outcome.success = true;
  expect(() => validateFullCohortLedger(promoted, input.cohort.pins)).toThrow(
    /cannot authorize measured attempt success/,
  );
});

it("re-derives a bounded module graph and private verdict without authorizing success", async () => {
  const { input } = await moduleGraphFixture();
  const receipt = await inspectPrivateSealedAggregateProvenance(input, {
    nowMs,
  });
  expect(receipt.callBoundProposalJoinsChecked).toBe(1);
  expect(receipt.protectedExecutionVerified).toBe(false);
  expect(receipt.promotionEligible).toBe(false);
  expect(
    input.cohort.inspection.assignments[1]!.receipt!.outcome.success,
  ).toBeNull();
  expect(
    input.originalArtifacts
      .filter((item) =>
        item.role.startsWith("oracle/module-graph-v1/candidate/"),
      )
      .map((item) => item.role),
  ).toEqual([
    "oracle/module-graph-v1/candidate/derived-proposal",
    "oracle/module-graph-v1/candidate/result-source",
    "oracle/module-graph-v1/candidate/private-verdict",
  ]);
});

it("rejects freshly signed module-graph originals, manifest, path, and verdict inconsistencies", async () => {
  for (const [options, pattern] of [
    [{ wrongResult: true }, /Module graph result source differs/],
    [{ wrongBefore: true }, /full frozen source edit/],
    [{ badManifest: true }, /public manifest differs/],
    [{ badPath: true }, /Invalid input|module graph path|Module graph paths/i],
    [{ wrongInputSha: true }, /case result differs/],
    [{ repeatedChallenge: true }, /case result differs/],
    [{ wrongCounts: true }, /verdict counts differ/],
    [{ wrongCaseCount: true }, /verdict differs from frozen claim/],
    [{ wrongStatus: true }, /verdict counts differ/],
    [{ wrongVerdictResult: true }, /verdict differs from frozen claim/],
    [{ wrongVerdictClaim: true }, /verdict differs from frozen claim/],
    [{ reverseCases: true }, /case result differs/],
    [{ omitVerdict: true }, /private verdict is missing/],
  ] as const) {
    const { input } = await moduleGraphFixture(options);
    await expect(
      inspectPrivateSealedAggregateProvenance(input, { nowMs }),
    ).rejects.toThrow(pattern);
  }
  const { input } = await moduleGraphFixture();
  const missing = structuredClone(input);
  missing.originalArtifacts = missing.originalArtifacts.filter(
    (item) => item.role !== "oracle/module-graph-v1/candidate/result-source",
  );
  await expect(
    inspectPrivateSealedAggregateProvenance(missing, { nowMs }),
  ).rejects.toThrow(/inventory is incomplete/);
  for (const role of [
    "task/held-task/baseline",
    "task/held-task/private-oracle",
    "oracle/module-graph-v1/candidate/derived-proposal",
    "oracle/module-graph-v1/candidate/result-source",
    "oracle/module-graph-v1/candidate/private-verdict",
  ]) {
    const tampered = structuredClone(input);
    tampered.originalArtifacts.find((item) => item.role === role)!.bytesBase64 =
      Buffer.from(`tampered ${role}`).toString("base64");
    await expect(
      inspectPrivateSealedAggregateProvenance(tampered, { nowMs }),
    ).rejects.toThrow(/content differs/);
  }
});

it("refuses imported module-graph measured success and altered claim scope", async () => {
  const { input } = await moduleGraphFixture();
  const changedBaseline = structuredClone(input.cohort.inspection);
  const claim = changedBaseline.assignments[1]!.oracleInvocation;
  if (claim?.kind !== "sealed-call-bound-module-graph-invocation-claim")
    throw new Error("Expected module graph fixture claim");
  claim.baselineSha256 = changedBaseline.plan.tasks[0]!.publicPacketSha256;
  expect(() =>
    validateFullCohortLedger(changedBaseline, input.cohort.pins),
  ).toThrow();
  const promoted = structuredClone(input.cohort.inspection);
  promoted.assignments[1]!.receipt!.status = "completed";
  promoted.assignments[1]!.receipt!.outcome.success = true;
  expect(() => validateFullCohortLedger(promoted, input.cohort.pins)).toThrow(
    /cannot authorize measured attempt success/,
  );
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

function repositorySnapshotSource(
  repeatEntryPage = false,
  sourceText = "const value = 1;\n",
) {
  const blobs = new Map<string, Buffer>();
  const retain = (bytes: Buffer) => {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    blobs.set(sha256, Buffer.from(bytes));
    return { sha256, bytes: bytes.length };
  };
  const retainJson = (value: unknown) =>
    retain(Buffer.from(canonicalJson(value)));
  const source = Buffer.from(sourceText);
  const chunk = retain(source);
  const chunks = retainJson({
    kind: "sealed-repository-chunk-page",
    version: "1.0.0",
    level: 0,
    chunks: [chunk],
  });
  const entries = retainJson({
    kind: "sealed-repository-entry-page",
    version: "1.0.0",
    level: 0,
    entries: [
      { path: ".git", type: "excluded", reason: "operator-scope" },
      {
        path: "source.ts",
        type: "file",
        mode: 0o644,
        bytes: source.length,
        sha256: chunk.sha256,
        chunks,
      },
    ],
  });
  const tree = repeatEntryPage
    ? retainJson({
        kind: "sealed-repository-entry-page",
        version: "1.0.0",
        level: 1,
        children: Array.from({ length: 128 }, () => ({
          firstPath: ".git",
          lastPath: "source.ts",
          ref: entries,
        })),
      })
    : entries;
  const rootReference = retainJson({
    kind: "sealed-repository-snapshot",
    version: "1.0.0",
    scope: {
      kind: "sealed-repository-scope",
      version: "1.0.0",
      excludePrefixes: [".git"],
      maxEntries: 10,
      maxFiles: 5,
      maxFileBytes: 1000,
      maxTotalBytes: 1000,
      maxDepth: 3,
    },
    source: {
      headOid: "a".repeat(40),
      stagedEntriesSha256: "b".repeat(64),
    },
    inventory: {
      entryCount: 2,
      fileCount: 1,
      excludedCount: 1,
      totalBytes: source.length,
    },
    tree,
  });
  return { blobs, chunk, chunks, rootReference };
}

it("audits a signed repository root through every descendant while keeping original roles root-only", async () => {
  const snapshot = repositorySnapshotSource();
  const { input } = await repositorySnapshotFixture(
    snapshot.blobs.get(snapshot.rootReference.sha256)!,
  );
  const source = manifestSource(input);
  const reader = async (reference: {
    role: string;
    sha256: string;
    bytes: number;
  }) => {
    const blob =
      snapshot.blobs.get(reference.sha256) ??
      (source.originals.has(reference.role)
        ? Buffer.from(source.originals.get(reference.role)!, "base64")
        : undefined);
    if (!blob) throw new Error("Missing synthetic snapshot blob");
    return new Uint8Array(blob);
  };
  const receipt = await inspectPrivateSealedAggregateFromManifest(
    source.detached,
    source.manifest,
    hashJson(source.manifest),
    reader,
    { nowMs },
  );
  expect(
    source.manifest.entries.filter(
      (entry) => entry.role === "task/held-task/baseline",
    ),
  ).toHaveLength(1);
  expect(
    source.manifest.entries.some((entry) => entry.role.startsWith("snapshot/")),
  ).toBe(false);
  expect(receipt.repositorySnapshotCount).toBe(1);
  expect(receipt.repositorySnapshotBytesVerified).toBe(
    Buffer.byteLength("const value = 1;\n"),
  );
  expect(receipt.repositorySnapshotBlobsVerified).toBe(4);
  expect(receipt.artifactSourceAuthenticated).toBe(false);
  expect(receipt.protectedExecutionVerified).toBe(false);
  expect(receipt.promotionEligible).toBe(false);
  await expect(
    inspectPrivateSealedAggregateProvenance(input, { nowMs }),
  ).rejects.toThrow(/vault-backed full-closure reader/);
});

async function inspectRepositoryClaimFixture(
  options: {
    wrongResponse?: boolean;
    wrongResultTree?: boolean;
    wrongObservationBundle?: boolean;
    wrongCounters?: boolean;
    missingObservationBundle?: boolean;
  } = {},
) {
  const snapshot = repositorySnapshotSource(false, "const value = 1;");
  const fixture = await repositoryClaimFixture(
    snapshot.blobs.get(snapshot.rootReference.sha256)!,
    options,
  );
  const source = manifestSource(fixture.input);
  const verdictBase64 = source.originals.get(
    "oracle/repository-v1/candidate/private-verdict",
  );
  if (!verdictBase64)
    throw new Error("Synthetic repository verdict role is missing");
  const observationSha256 = JSON.parse(
    Buffer.from(verdictBase64, "base64").toString("utf8"),
  ).observationBundle.sha256 as string;
  return inspectPrivateSealedAggregateFromManifest(
    source.detached,
    source.manifest,
    hashJson(source.manifest),
    async (reference) => {
      if (
        options.missingObservationBundle &&
        reference.sha256 === observationSha256
      )
        throw new Error("Missing synthetic observation bundle");
      const blob =
        snapshot.blobs.get(reference.sha256) ??
        (fixture.retainedBlobs.has(reference.sha256)
          ? Buffer.from(fixture.retainedBlobs.get(reference.sha256)!, "base64")
          : undefined);
      if (!blob) throw new Error("Missing synthetic repository claim blob");
      return new Uint8Array(blob);
    },
    { nowMs },
  );
}

it("joins a signed repository claim to the retained response, candidate tree, observation bundle and private cases", async () => {
  const receipt = await inspectRepositoryClaimFixture();
  expect(receipt.callBoundProposalJoinsChecked).toBe(1);
  expect(receipt.repositorySnapshotCount).toBe(1);
  expect(receipt.repositorySnapshotBytesVerified).toBe(
    Buffer.byteLength("const value = 1;"),
  );
  expect(receipt.protectedExecutionVerified).toBe(false);
  expect(receipt.artifactSourceAuthenticated).toBe(false);
  expect(receipt.promotionEligible).toBe(false);
});

it("rejects repository response, candidate tree, observation and verdict counter tampering despite signed fixture joins", async () => {
  await expect(
    inspectRepositoryClaimFixture({ wrongResponse: true }),
  ).rejects.toThrow(/Repository proposal differs from model response/);
  await expect(
    inspectRepositoryClaimFixture({ wrongResultTree: true }),
  ).rejects.toThrow(/Repository candidate tree differs from original proposal/);
  await expect(
    inspectRepositoryClaimFixture({ wrongObservationBundle: true }),
  ).rejects.toThrow(/Repository guest observation case binding differs/);
  await expect(
    inspectRepositoryClaimFixture({ wrongCounters: true }),
  ).rejects.toThrow(/Repository verdict counters differ from private cases/);
  await expect(
    inspectRepositoryClaimFixture({ missingObservationBundle: true }),
  ).rejects.toThrow(/Missing synthetic observation bundle/);
});

it("rejects missing and corrupt repository descendants under a signed root", async () => {
  const snapshot = repositorySnapshotSource();
  const { input } = await repositorySnapshotFixture(
    snapshot.blobs.get(snapshot.rootReference.sha256)!,
  );
  const source = manifestSource(input);
  const inspect = (blobs: Map<string, Buffer>) =>
    inspectPrivateSealedAggregateFromManifest(
      source.detached,
      source.manifest,
      hashJson(source.manifest),
      async (reference) => {
        const blob =
          blobs.get(reference.sha256) ??
          (source.originals.has(reference.role)
            ? Buffer.from(source.originals.get(reference.role)!, "base64")
            : undefined);
        if (!blob) throw new Error("Missing synthetic snapshot blob");
        return new Uint8Array(blob);
      },
      { nowMs },
    );
  const missing = new Map(snapshot.blobs);
  missing.delete(snapshot.chunk.sha256);
  await expect(inspect(missing)).rejects.toThrow(
    /Missing synthetic snapshot blob/,
  );
  const corrupted = new Map(snapshot.blobs);
  corrupted.set(snapshot.chunk.sha256, Buffer.from("forged"));
  await expect(inspect(corrupted)).rejects.toThrow(
    /pinned byte bounds|differs from commitment/,
  );
});

it("bounds hostile repeated repository pages before aggregate expansion", async () => {
  const snapshot = repositorySnapshotSource(true);
  await expect(
    inspectPrivateRepositorySnapshotClosure(
      snapshot.rootReference,
      async (reference) => {
        const blob = snapshot.blobs.get(reference.sha256);
        if (!blob) throw new Error("Missing synthetic snapshot blob");
        return new Uint8Array(blob);
      },
    ),
  ).rejects.toThrow(/repeated or cyclic|inventory bound/);
});

it("keeps the inline original-byte cap while vault-reading a larger module-graph cohort", async () => {
  const { input } = await moduleGraphFixture({ largeArtifacts: true });
  await expect(
    inspectPrivateSealedAggregateProvenance(input, { nowMs }),
  ).rejects.toThrow(/byte bounds|private input bound/);
  const source = manifestSource(input);
  const total = source.manifest.entries.reduce(
    (sum, entry) => sum + entry.bytes,
    0,
  );
  expect(total).toBeGreaterThan(1_500_000);
  const receipt = await inspectPrivateSealedAggregateFromManifest(
    source.detached,
    source.manifest,
    hashJson(source.manifest),
    source.reader,
    { nowMs },
  );
  expect(receipt.originalArtifactBytes).toBe(total);
  expect(receipt.callBoundProposalJoinsChecked).toBe(1);
  expect(receipt.promotionEligible).toBe(false);
});

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
