import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkWitnessCheckpointReply,
  checkWitnessGrantStatusReply,
} from "../src/promotion-importer.js";
import {
  OWNER_STATEMENT_PAYLOAD_TYPE,
  RekorWitnessError,
  createRekorWitness,
  defaultRekorStateDir,
  dssePae,
  ownerStatementPayload,
  ownerStatementSubjectDigest,
  rekorLeafHash,
  verifyConsistency,
  verifyInclusion,
  verifyRekorCheckpoint,
  type OwnerStatementPredicate,
  type RekorFetch,
  type RekorWitnessOptions,
} from "../src/promotion-rekor-witness.js";
import { SIGSTORE_REKOR_V1 } from "../src/promotion-anchor-enrollment.js";
import { inspectPrivateSealedAggregateProvenance } from "../src/sealed-aggregate-provenance.js";
import { canonicalJson, hashJson } from "../src/sealed-collection-schema.js";
import { inspectSealedCurrentGovernance } from "../src/sealed-governance-witness.js";
import { fixture, nowMs } from "./sealed-aggregate-fixture.js";

// ---------------------------------------------------------------------------
// An RFC 6962 Merkle tree and a fake Rekor v1 built on it, with a test log key.

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();
const node = (left: Buffer, right: Buffer) =>
  sha(Buffer.concat([Buffer.from([1]), left, right]));
const split = (n: number) => {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
};
function mth(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) return sha(Buffer.alloc(0));
  if (leaves.length === 1) return leaves[0]!;
  const k = split(leaves.length);
  return node(mth(leaves.slice(0, k)), mth(leaves.slice(k)));
}
function inclusionPath(m: number, leaves: Buffer[]): Buffer[] {
  if (leaves.length <= 1) return [];
  const k = split(leaves.length);
  return m < k
    ? [...inclusionPath(m, leaves.slice(0, k)), mth(leaves.slice(k))]
    : [...inclusionPath(m - k, leaves.slice(k)), mth(leaves.slice(0, k))];
}
function subproof(m: number, leaves: Buffer[], complete: boolean): Buffer[] {
  if (m === leaves.length) return complete ? [] : [mth(leaves)];
  const k = split(leaves.length);
  return m <= k
    ? [...subproof(m, leaves.slice(0, k), complete), mth(leaves.slice(k))]
    : [...subproof(m - k, leaves.slice(k), false), mth(leaves.slice(0, k))];
}
const hex = (items: Buffer[]) => items.map((item) => item.toString("hex"));

const ORIGIN = "rekor.test.invalid";
const HOST = "rekor.test.invalid";
const TREE_ID = "4242424242";
const TREE_HEX = BigInt(TREE_ID).toString(16).padStart(16, "0");

interface Tamper {
  sthSignature?: boolean;
  consistency?: boolean;
  inclusion?: boolean;
  /** Serve this tree size instead of the current one. */
  servedSize?: number;
  /** Prove entries against a head of this size instead of the current one. */
  entrySize?: number;
  /** Serve a forked log whose leaves differ from the real ones. */
  fork?: boolean;
}

class FakeRekor {
  readonly logKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
  readonly logPem = this.logKey.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  readonly logId = sha(
    this.logKey.publicKey.export({ type: "spki", format: "der" }),
  ).toString("hex");
  private readonly leaves: { body: Buffer; attestation?: string }[] = [];
  private readonly index = new Map<string, string[]>();
  readonly payloads = new Map<string, Buffer>();
  readonly requests: { method: string; url: string }[] = [];
  tamper: Tamper = {};

  private hashes(size: number): Buffer[] {
    const leaves = this.leaves
      .slice(0, size)
      .map((leaf) => Buffer.from(rekorLeafHash(leaf.body), "hex"));
    if (this.tamper.fork && leaves.length > 1)
      leaves[0] = sha(Buffer.from("forked"));
    return leaves;
  }

  get size() {
    return this.leaves.length;
  }

  note(size: number, key: KeyObject = this.logKey.privateKey): string {
    const root = mth(this.hashes(size)).toString("base64");
    const body = `${ORIGIN} - ${TREE_ID}\n${size}\n${root}\n`;
    let signature = sign("sha256", Buffer.from(body), {
      key,
      dsaEncoding: "der",
    });
    if (this.tamper.sthSignature)
      signature = sign("sha256", Buffer.from(`${body}x`), key);
    const raw = Buffer.concat([
      Buffer.from(this.logId, "hex").subarray(0, 4),
      signature,
    ]);
    return `${body}\n— ${ORIGIN} ${raw.toString("base64")}\n`;
  }

  append(body: Buffer, subjects: string[] = [], attestation?: Buffer) {
    this.leaves.push({
      body,
      ...(attestation ? { attestation: attestation.toString("base64") } : {}),
    });
    const uuid = `${TREE_HEX}${rekorLeafHash(body)}`;
    for (const subject of subjects)
      this.index.set(subject, [...(this.index.get(subject) ?? []), uuid]);
    return this.leaves.length - 1;
  }

  filler(count = 1) {
    for (let i = 0; i < count; i++)
      this.append(
        Buffer.from(
          canonicalJson({
            apiVersion: "0.0.1",
            kind: "hashedrekord",
            spec: { data: { hash: randomBytes(32).toString("hex") } },
          }),
        ),
      );
  }

  /** Log an owner statement as a DSSE (or intoto) entry signed by `key`. */
  publish(
    predicate: OwnerStatementPredicate,
    key: { privateKey: KeyObject; publicKey: KeyObject },
    options: { kind?: "dsse" | "intoto"; badSignature?: boolean } = {},
  ) {
    const payload = ownerStatementPayload(predicate);
    const payloadSha256 = sha(payload).toString("hex");
    let signature = sign(
      null,
      dssePae(OWNER_STATEMENT_PAYLOAD_TYPE, payload),
      key.privateKey,
    );
    if (options.badSignature)
      signature = sign(null, Buffer.from("something else"), key.privateKey);
    const verifier = Buffer.from(
      key.publicKey.export({ type: "spki", format: "pem" }).toString(),
    ).toString("base64");
    const body =
      options.kind === "intoto"
        ? {
            apiVersion: "0.0.2",
            kind: "intoto",
            spec: {
              content: {
                envelope: {
                  payloadType: OWNER_STATEMENT_PAYLOAD_TYPE,
                  signatures: [
                    {
                      sig: Buffer.from(signature.toString("base64")).toString(
                        "base64",
                      ),
                      publicKey: verifier,
                    },
                  ],
                },
                hash: { algorithm: "sha256", value: "0".repeat(64) },
                payloadHash: { algorithm: "sha256", value: payloadSha256 },
              },
            },
          }
        : {
            apiVersion: "0.0.1",
            kind: "dsse",
            spec: {
              envelopeHash: { algorithm: "sha256", value: "0".repeat(64) },
              payloadHash: { algorithm: "sha256", value: payloadSha256 },
              signatures: [
                { signature: signature.toString("base64"), verifier },
              ],
            },
          };
    if (options.kind !== "intoto") this.payloads.set(payloadSha256, payload);
    const subject = JSON.parse(payload.toString()).subject[0].digest.sha256;
    return this.append(
      Buffer.from(canonicalJson(body)),
      [subject],
      options.kind === "intoto" ? payload : undefined,
    );
  }

  fetch: RekorFetch = async (url, init) => {
    const parsed = new URL(url);
    this.requests.push({ method: init.method, url });
    const size = this.tamper.servedSize ?? this.size;
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200 });
    if (init.method === "GET" && parsed.pathname === "/api/v1/log")
      return json({
        rootHash: mth(this.hashes(size)).toString("hex"),
        signedTreeHead: this.note(size),
        treeID: TREE_ID,
        treeSize: size,
      });
    if (init.method === "GET" && parsed.pathname === "/api/v1/log/proof") {
      const first = Number(parsed.searchParams.get("firstSize"));
      const last = Number(parsed.searchParams.get("lastSize"));
      const leaves = this.hashes(last);
      const hashes = hex(subproof(first, leaves, true));
      if (this.tamper.consistency && hashes.length) hashes[0] = "f".repeat(64);
      return json({ hashes, rootHash: mth(leaves).toString("hex") });
    }
    if (
      init.method === "POST" &&
      parsed.pathname === "/api/v1/index/retrieve"
    ) {
      const { hash } = JSON.parse(init.body!) as { hash: string };
      return json(this.index.get(hash.replace(/^sha256:/, "")) ?? []);
    }
    const entry = /^\/api\/v1\/log\/entries\/([a-f0-9]{80})$/.exec(
      parsed.pathname,
    );
    if (init.method === "GET" && entry) {
      const position = this.leaves.findIndex(
        (leaf) => `${TREE_HEX}${rekorLeafHash(leaf.body)}` === entry[1],
      );
      if (position < 0) return new Response("{}", { status: 404 });
      const proofSize = Math.max(
        this.tamper.entrySize ?? this.size,
        position + 1,
      );
      const leaves = this.hashes(proofSize);
      const hashes = hex(inclusionPath(position, leaves));
      if (this.tamper.inclusion && hashes.length) hashes[0] = "e".repeat(64);
      const leaf = this.leaves[position]!;
      return json({
        [entry[1]!]: {
          body: leaf.body.toString("base64"),
          integratedTime: 1_790_000_000,
          logID: this.logId,
          logIndex: position + 1_000_000,
          verification: {
            inclusionProof: {
              checkpoint: this.note(proofSize),
              hashes,
              logIndex: position,
              rootHash: mth(leaves).toString("hex"),
              treeSize: proofSize,
            },
            signedEntryTimestamp: "",
          },
          ...(leaf.attestation
            ? { attestation: { data: leaf.attestation } }
            : {}),
        },
      });
    }
    return new Response("{}", { status: 404 });
  };
}

const issuer = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const pem = (key: KeyObject) =>
  key.export({ type: "spki", format: "pem" }).toString();
const tempDir = () =>
  mkdtempSync(path.join(os.tmpdir(), "graph-rekor-witness-"));
const challenge = () => randomBytes(32).toString("hex");
const d = (seed: string) => createHash("sha256").update(seed).digest("hex");

function witness(log: FakeRekor, overrides: Partial<RekorWitnessOptions> = {}) {
  return createRekorWitness({
    witnessId: "rekor-d6",
    baseUrl: `https://${HOST}`,
    origin: ORIGIN,
    logPublicKeyPem: log.logPem,
    issuerPublicKeyPem: pem(issuer.publicKey),
    allowedHosts: [HOST],
    stateDir: path.join(tempDir(), "rekor-witness"),
    fetch: log.fetch,
    readPayload: async (digest) => log.payloads.get(digest),
    ...overrides,
  });
}

const projectId = "project-a";
const collectionId = "collection-a";
const frozenDigests = { "trust.json": d("trust"), "registry.json": d("reg") };
const collectionQuery = () => ({
  witnessId: "rekor-d6",
  projectId,
  collectionId,
  challenge: challenge(),
});
const grantQuery = (grantId: string) => ({
  witnessId: "rekor-d6",
  projectId,
  grantId,
  challenge: challenge(),
});
const freeze: OwnerStatementPredicate = {
  version: "1.0.0",
  kind: "freeze",
  projectId,
  collectionId,
  frozenDigests,
};
const state = (reply: Record<string, unknown>) => {
  const {
    challenge: _challenge,
    issuedAt: _issuedAt,
    expiresAt: _expiresAt,
    ...rest
  } = reply;
  return rest;
};

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(RekorWitnessError);
  return (error as RekorWitnessError).code;
}

// ---------------------------------------------------------------------------

describe("Merkle proofs", () => {
  it("verifies RFC 6962 inclusion and consistency proofs and rejects altered ones", () => {
    const leaves = Array.from({ length: 19 }, (_, i) =>
      sha(Buffer.from(`leaf ${i}`)),
    );
    for (let n = 1; n <= leaves.length; n++) {
      const tree = leaves.slice(0, n);
      const root = mth(tree).toString("hex");
      for (let m = 0; m < n; m++) {
        const proof = hex(inclusionPath(m, tree));
        expect(
          verifyInclusion(
            BigInt(m),
            BigInt(n),
            tree[m]!.toString("hex"),
            proof,
            root,
          ),
        ).toBe(true);
        if (proof.length) {
          const bad = [...proof];
          bad[0] = "0".repeat(64);
          expect(
            verifyInclusion(
              BigInt(m),
              BigInt(n),
              tree[m]!.toString("hex"),
              bad,
              root,
            ),
          ).toBe(false);
        }
      }
      for (let m = 1; m <= n; m++) {
        const old = mth(leaves.slice(0, m)).toString("hex");
        const proof = hex(subproof(m, tree, true));
        expect(verifyConsistency(BigInt(m), BigInt(n), old, root, proof)).toBe(
          true,
        );
        if (m < n)
          expect(
            verifyConsistency(BigInt(m), BigInt(n), d("other"), root, proof),
          ).toBe(false);
      }
    }
  });
});

describe("Rekor witness translation", () => {
  it("translates a verified freeze into a checkpoint reply that step 4 and step 11 accept", async () => {
    const log = new FakeRekor();
    log.filler(3);
    log.publish(freeze, issuer);
    log.filler(2);
    const adapter = witness(log);
    const opening = collectionQuery();
    const first = checkWitnessCheckpointReply(
      await adapter.readCollectionCheckpoint(opening),
      opening,
      Date.now(),
    );
    expect(first.frozenDigests).toEqual(frozenDigests);
    // The log keeps growing; the checkpoint is from the owner's entry, so the
    // closing read compares equal.
    log.filler(7);
    const closing = collectionQuery();
    const second = checkWitnessCheckpointReply(
      await adapter.readCollectionCheckpoint(closing),
      closing,
      Date.now(),
    );
    expect(hashJson(state({ ...second }))).toBe(hashJson(state({ ...first })));
    expect(second.challenge).toBe(closing.challenge);
    // Reads only: GETs and the one index search POST, never an upload.
    for (const request of log.requests)
      expect(
        request.method === "GET" ||
          new URL(request.url).pathname === "/api/v1/index/retrieve",
      ).toBe(true);
  });

  it("reads an intoto entry whose payload the log stores, without a payload source", async () => {
    const log = new FakeRekor();
    log.filler();
    log.publish(freeze, issuer, { kind: "intoto" });
    const adapter = witness(log, { readPayload: undefined });
    const query = collectionQuery();
    const reply = checkWitnessCheckpointReply(
      await adapter.readCollectionCheckpoint(query),
      query,
      Date.now(),
    );
    expect(reply.frozenDigests).toEqual(frozenDigests);
  });

  it("maps grant statements to unregistered, active and revoked replies", async () => {
    const log = new FakeRekor();
    const grantId = d("grant");
    log.filler();
    const adapter = witness(log);
    const status = async () => {
      const query = grantQuery(grantId);
      return checkWitnessGrantStatusReply(
        await adapter.readGrantStatus(query),
        query,
        Date.now(),
      ).status;
    };
    expect(await status()).toBe("unregistered");
    log.publish(
      { version: "1.0.0", kind: "grant-registration", projectId, grantId },
      issuer,
    );
    log.filler();
    expect(await status()).toBe("active");
    log.publish(
      { version: "1.0.0", kind: "grant-revocation", projectId, grantId },
      issuer,
    );
    expect(await status()).toBe("revoked");
  });

  it("translates owner governance statements into v1 and v2 checkpoints the governance parser accepts", async () => {
    const { input } = await fixture();
    const receipt = await inspectPrivateSealedAggregateProvenance(input, {
      nowMs,
    });
    const inspection = input.cohort.inspection;
    const request = {
      inspection,
      pins: input.cohort.pins,
      aggregatePayload: input.bundle.payload,
      rowTrust: input.rowTrust,
      aggregateTrust: input.aggregateTrust,
    };
    const ids = {
      projectId: input.bundle.payload.projectId,
      collectionId: input.bundle.payload.collectionId,
    };
    const base = {
      version: "1.0.0" as const,
      kind: "governance-checkpoint" as const,
      ...ids,
    };
    const log = new FakeRekor();
    log.filler(2);
    log.publish(
      {
        ...base,
        section: "registration",
        planSha256: inspection.planSha256,
        registrySha256: hashJson(inspection.registry),
        firstEventSha256: inspection.events[0]!.sha256,
      },
      issuer,
    );
    log.filler();
    log.publish(
      {
        ...base,
        section: "current-trust",
        rowTrustSha256: hashJson(input.rowTrust),
        aggregateTrustSha256: hashJson(input.aggregateTrust),
      },
      issuer,
    );
    log.filler(3);
    log.publish(
      {
        ...base,
        section: "head",
        eventCount: inspection.events.length,
        eventHeadSha256: inspection.events.at(-1)!.sha256,
        closureSha256: hashJson(inspection.closure),
      },
      issuer,
    );
    const adapter = witness(log);
    const reader = async (
      query: Parameters<typeof adapter.readGovernanceCheckpoint>[0],
    ) => {
      const reply = await adapter.readGovernanceCheckpoint(query);
      log.filler(2); // the log moves between the two reads
      return reply;
    };
    const result = await inspectSealedCurrentGovernance(
      request,
      "rekor-d6",
      reader,
      async () => receipt,
    );
    expect(result).toMatchObject({
      populationPrecommitCompared: false,
      promotionEligible: false,
    });
    const v1 = (await adapter.readGovernanceCheckpoint({
      witnessId: "rekor-d6",
      ...ids,
      challenge: challenge(),
    })) as Record<string, { revision: number }> & {
      checkpointRevision: number;
    };
    // Revisions are the statements' leaf indices + 1.
    expect(v1.registration.revision).toBe(3);
    expect(v1.currentTrust.revision).toBe(5);
    expect(v1.head.revision).toBe(9);
    expect(v1.checkpointRevision).toBe(9);

    // v2: a population precommit and first attempt, published in order.
    const firstAttempt = inspection.events.find(
      (entry) => entry.event.type === "attempt-reserved",
    )!.sha256;
    const population = {
      sourceInventorySha256: d("inventory"),
      signedManifestSha256: d("manifest"),
      populationTrustSha256: d("population-trust"),
    };
    const v2log = new FakeRekor();
    v2log.publish(
      {
        ...base,
        section: "registration",
        planSha256: inspection.planSha256,
        registrySha256: hashJson(inspection.registry),
        firstEventSha256: inspection.events[0]!.sha256,
      },
      issuer,
    );
    v2log.publish({ ...base, section: "population", ...population }, issuer);
    v2log.publish(
      { ...base, section: "first-attempt", eventSha256: firstAttempt },
      issuer,
    );
    v2log.filler(2);
    v2log.publish(
      {
        ...base,
        section: "head",
        eventCount: inspection.events.length,
        eventHeadSha256: inspection.events.at(-1)!.sha256,
        closureSha256: hashJson(inspection.closure),
      },
      issuer,
    );
    v2log.publish(
      {
        ...base,
        section: "current-trust",
        rowTrustSha256: hashJson(input.rowTrust),
        aggregateTrustSha256: hashJson(input.aggregateTrust),
      },
      issuer,
    );
    const v2adapter = witness(v2log);
    const v2 = await inspectSealedCurrentGovernance(
      { ...request, population },
      "rekor-d6",
      (query) => v2adapter.readGovernanceCheckpoint(query),
      async () => receipt,
    );
    expect(v2).toMatchObject({
      populationPrecommitCompared: true,
      firstAttemptEventSha256: firstAttempt,
      promotionEligible: false,
    });
  });

  it("proves entries whose checkpoint is older or newer than the verified head", async () => {
    const log = new FakeRekor();
    log.filler(3);
    log.publish(freeze, issuer);
    log.filler(9);
    // Older: the entry is proven against a head of 5 while the head is 13.
    log.tamper = { entrySize: 5 };
    const query = collectionQuery();
    const older = checkWitnessCheckpointReply(
      await witness(log).readCollectionCheckpoint(query),
      query,
      Date.now(),
    );
    // Newer: the head served is 6 while the entry's proof head is 13.
    log.tamper = { servedSize: 6 };
    const again = collectionQuery();
    const newer = checkWitnessCheckpointReply(
      await witness(log).readCollectionCheckpoint(again),
      again,
      Date.now(),
    );
    expect(newer.checkpointSha256).toBe(older.checkpointSha256);
    // Either direction still needs a valid consistency proof.
    log.tamper = { entrySize: 5, consistency: true };
    expect(
      await refusal(witness(log).readCollectionCheckpoint(collectionQuery())),
    ).toBe("rekor-consistency-invalid");
    log.tamper = { servedSize: 6, consistency: true };
    expect(
      await refusal(witness(log).readCollectionCheckpoint(collectionQuery())),
    ).toBe("rekor-consistency-invalid");
  });

  it("finds the owner statement under a flood of third-party entries", async () => {
    const log = new FakeRekor();
    const subject = ownerStatementSubjectDigest({
      kind: "freeze",
      projectId,
      collectionId,
    });
    const junk = () =>
      log.append(
        Buffer.from(
          canonicalJson({
            kind: "hashedrekord",
            junk: randomBytes(8).toString("hex"),
          }),
        ),
        [subject],
      );
    for (let i = 0; i < 30; i++) junk();
    log.publish(freeze, issuer);
    for (let i = 0; i < 30; i++) junk();
    log.publish({ ...freeze, frozenDigests: { x: d("x") } }, stranger);
    const query = collectionQuery();
    const reply = checkWitnessCheckpointReply(
      await witness(log).readCollectionCheckpoint(query),
      query,
      Date.now(),
    );
    expect(reply.frozenDigests).toEqual(frozenDigests);
    // Each of the 62 hits costs one entry read; nothing else refuses.
    expect(
      log.requests.filter((request) => request.url.includes("/log/entries/")),
    ).toHaveLength(62);
  });

  it("counts a re-logged owner payload once, at its lowest index, and refuses two different payloads", async () => {
    const log = new FakeRekor();
    log.filler(2);
    log.publish(freeze, issuer);
    const query = collectionQuery();
    const first = checkWitnessCheckpointReply(
      await witness(log).readCollectionCheckpoint(query),
      query,
      Date.now(),
    );
    // Anyone can log the owner's public signature and payload again.
    log.filler();
    log.publish(freeze, issuer, { kind: "intoto" });
    log.publish(freeze, issuer);
    const again = collectionQuery();
    const second = checkWitnessCheckpointReply(
      await witness(log).readCollectionCheckpoint(again),
      again,
      Date.now(),
    );
    expect(second.checkpointSha256).toBe(first.checkpointSha256);
    log.publish({ ...freeze, frozenDigests: { x: d("x") } }, issuer);
    expect(
      await refusal(witness(log).readCollectionCheckpoint(collectionQuery())),
    ).toBe("rekor-statement-ambiguous");
  });

  it("refuses population published before registration", async () => {
    const log = new FakeRekor();
    const base = {
      version: "1.0.0" as const,
      kind: "governance-checkpoint" as const,
      projectId,
      collectionId,
    };
    log.publish(
      {
        ...base,
        section: "population",
        sourceInventorySha256: d("s"),
        signedManifestSha256: d("m"),
        populationTrustSha256: d("t"),
      },
      issuer,
    );
    log.publish(
      {
        ...base,
        section: "registration",
        planSha256: d("p"),
        registrySha256: d("r"),
        firstEventSha256: d("f"),
      },
      issuer,
    );
    log.publish(
      { ...base, section: "first-attempt", eventSha256: d("a") },
      issuer,
    );
    log.publish(
      {
        ...base,
        section: "head",
        eventCount: 3,
        eventHeadSha256: d("h"),
        closureSha256: d("c"),
      },
      issuer,
    );
    log.publish(
      {
        ...base,
        section: "current-trust",
        rowTrustSha256: d("rt"),
        aggregateTrustSha256: d("at"),
      },
      issuer,
    );
    expect(
      await refusal(witness(log).readGovernanceCheckpoint(collectionQuery())),
    ).toBe("rekor-statement-order-invalid");
  });

  it("refuses a head published before its registration", async () => {
    const log = new FakeRekor();
    const base = {
      version: "1.0.0" as const,
      kind: "governance-checkpoint" as const,
      projectId,
      collectionId,
    };
    log.publish(
      {
        ...base,
        section: "head",
        eventCount: 2,
        eventHeadSha256: d("h"),
        closureSha256: d("c"),
      },
      issuer,
    );
    log.publish(
      {
        ...base,
        section: "registration",
        planSha256: d("p"),
        registrySha256: d("r"),
        firstEventSha256: d("f"),
      },
      issuer,
    );
    log.publish(
      {
        ...base,
        section: "current-trust",
        rowTrustSha256: d("rt"),
        aggregateTrustSha256: d("at"),
      },
      issuer,
    );
    expect(
      await refusal(witness(log).readGovernanceCheckpoint(collectionQuery())),
    ).toBe("rekor-statement-order-invalid");
  });
});

describe("Rekor witness refusals", () => {
  const logged = () => {
    const log = new FakeRekor();
    log.filler(4);
    log.publish(freeze, issuer);
    log.filler(3);
    return log;
  };

  it("refuses a signed tree head that does not verify with the pinned log key", async () => {
    const log = logged();
    log.tamper.sthSignature = true;
    expect(
      await refusal(witness(log).readCollectionCheckpoint(collectionQuery())),
    ).toBe("rekor-tree-head-invalid");
    // A head signed by another key is refused the same way.
    const other = logged();
    expect(
      await refusal(
        witness(other, {
          logPublicKeyPem: new FakeRekor().logPem,
        }).readCollectionCheckpoint(collectionQuery()),
      ),
    ).toBe("rekor-tree-head-invalid");
  });

  it("refuses a bad consistency proof and a forked log", async () => {
    const log = logged();
    const stateDir = path.join(tempDir(), "rekor-witness");
    await witness(log, { stateDir }).verifyTreeHead();
    log.filler(5);
    log.tamper.consistency = true;
    expect(await refusal(witness(log, { stateDir }).verifyTreeHead())).toBe(
      "rekor-consistency-invalid",
    );
    log.tamper = { fork: true };
    expect(await refusal(witness(log, { stateDir }).verifyTreeHead())).toBe(
      "rekor-consistency-invalid",
    );
    log.tamper = {};
    await witness(log, { stateDir }).verifyTreeHead();
  });

  it("refuses a bad inclusion proof", async () => {
    const log = logged();
    log.tamper.inclusion = true;
    expect(
      await refusal(witness(log).readCollectionCheckpoint(collectionQuery())),
    ).toBe("rekor-inclusion-invalid");
  });

  it("refuses a tree smaller than the high-water mark, and advances only after consistency", async () => {
    const log = logged();
    const stateDir = path.join(tempDir(), "rekor-witness");
    const adapter = witness(log, { stateDir });
    const head = await adapter.verifyTreeHead();
    const file = path.join(stateDir, `${log.logId}.json`);
    expect(JSON.parse(readFileSync(file, "utf8")).treeSize).toBe(
      head.treeSize.toString(),
    );
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    }
    log.tamper.servedSize = log.size - 2;
    expect(
      await refusal(adapter.readCollectionCheckpoint(collectionQuery())),
    ).toBe("rekor-rollback");
    // A refused consistency proof leaves the mark where it was.
    log.tamper = { consistency: true };
    log.filler(3);
    expect(await refusal(adapter.verifyTreeHead())).toBe(
      "rekor-consistency-invalid",
    );
    expect(JSON.parse(readFileSync(file, "utf8")).treeSize).toBe(
      head.treeSize.toString(),
    );
  });

  it.skipIf(process.platform === "win32")(
    "refuses a high-water file that is a symlink or readable by others",
    async () => {
      const log = logged();
      const stateDir = path.join(tempDir(), "rekor-witness");
      const adapter = witness(log, { stateDir });
      await adapter.verifyTreeHead();
      const file = path.join(stateDir, `${log.logId}.json`);
      chmodSync(file, 0o644);
      expect(await refusal(adapter.verifyTreeHead())).toBe(
        "rekor-state-invalid",
      );
      const elsewhere = path.join(tempDir(), "state.json");
      writeFileSync(elsewhere, readFileSync(file), { mode: 0o600 });
      const linked = path.join(tempDir(), "rekor-witness");
      await witness(log, { stateDir: linked }).verifyTreeHead();
      const target = path.join(linked, `${log.logId}.json`);
      rmSync(target);
      symlinkSync(elsewhere, target);
      expect(
        await refusal(witness(log, { stateDir: linked }).verifyTreeHead()),
      ).toBe("rekor-state-invalid");
    },
  );

  it("ignores statements signed by another key and refuses a bad issuer signature", async () => {
    const log = new FakeRekor();
    log.filler();
    log.publish(freeze, stranger);
    expect(
      await refusal(witness(log).readCollectionCheckpoint(collectionQuery())),
    ).toBe("rekor-statement-missing");
    // An entry naming the issuer key whose signature does not verify.
    log.publish(freeze, issuer, { badSignature: true });
    expect(
      await refusal(witness(log).readCollectionCheckpoint(collectionQuery())),
    ).toBe("rekor-signature-invalid");
    // The issuer key given to the adapter decides whose statements count.
    const own = logged();
    expect(
      await refusal(
        witness(own, {
          issuerPublicKeyPem: pem(stranger.publicKey),
        }).readCollectionCheckpoint(collectionQuery()),
      ),
    ).toBe("rekor-statement-missing");
  });

  it("refuses a missing statement, a duplicate freeze and a payload that does not match", async () => {
    const log = new FakeRekor();
    log.filler(2);
    expect(
      await refusal(witness(log).readCollectionCheckpoint(collectionQuery())),
    ).toBe("rekor-statement-missing");
    expect(
      await refusal(witness(log).readGovernanceCheckpoint(collectionQuery())),
    ).toBe("rekor-statement-missing");
    log.publish(freeze, issuer);
    expect(
      await refusal(
        witness(log, {
          readPayload: async () => Buffer.from("{}"),
        }).readCollectionCheckpoint(collectionQuery()),
      ),
    ).toBe("rekor-statement-invalid");
    log.publish(
      { ...freeze, frozenDigests: { "trust.json": d("other") } },
      issuer,
    );
    expect(
      await refusal(witness(log).readCollectionCheckpoint(collectionQuery())),
    ).toBe("rekor-statement-ambiguous");
  });

  it("refuses with a distinct code when the fetch budget runs out before an answer", async () => {
    const log = new FakeRekor();
    const grantId = d("flooded-grant");
    const flood = (subject: string, count: number) => {
      for (let i = 0; i < count; i++)
        log.append(
          Buffer.from(canonicalJson({ junk: randomBytes(8).toString("hex") })),
          [subject],
        );
    };
    flood(
      ownerStatementSubjectDigest({ kind: "freeze", projectId, collectionId }),
      12,
    );
    expect(
      await refusal(
        witness(log, { fetchBudgetPerSubject: 10 }).readCollectionCheckpoint(
          collectionQuery(),
        ),
      ),
    ).toBe("rekor-search-budget-exhausted");
    // A grant subject must be read completely: an unread hit could revoke it.
    flood(
      ownerStatementSubjectDigest({
        kind: "grant-revocation",
        projectId,
        grantId,
      }),
      12,
    );
    expect(
      await refusal(
        witness(log, { fetchBudgetPerSubject: 10 }).readGrantStatus(
          grantQuery(grantId),
        ),
      ),
    ).toBe("rekor-search-budget-exhausted");
    // A hit list larger than the search byte limit is the same refusal.
    expect(
      await refusal(
        witness(log, { maxSearchBytes: 200 }).readCollectionCheckpoint(
          collectionQuery(),
        ),
      ),
    ).toBe("rekor-search-budget-exhausted");
  });

  it("removes a stale high-water lock and releases its own", async () => {
    const log = logged();
    const stateDir = path.join(tempDir(), "rekor-witness");
    const adapter = witness(log, { stateDir });
    await adapter.verifyTreeHead();
    const lock = path.join(stateDir, `${log.logId}.json.lock`);
    writeFileSync(lock, "1\n", { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    log.filler(2);
    await adapter.verifyTreeHead();
    expect(() => statSync(lock)).toThrow();
    // Concurrent readers never lower the mark.
    log.filler(3);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        witness(log, { stateDir })
          .verifyTreeHead()
          .catch(() => undefined),
      ),
    );
    expect(
      JSON.parse(readFileSync(path.join(stateDir, `${log.logId}.json`), "utf8"))
        .treeSize,
    ).toBe(String(log.size));
  });

  it("refuses a host that is not allowlisted before any request", async () => {
    const log = logged();
    expect(
      await refusal(
        witness(log, {
          allowedHosts: ["rekor.sigstore.dev"],
        }).readCollectionCheckpoint(collectionQuery()),
      ),
    ).toBe("rekor-host-not-allowed");
    expect(log.requests).toEqual([]);
    expect(() => witness(log, { baseUrl: `http://${HOST}` })).toThrow(
      RekorWitnessError,
    );
  });

  it("refuses a request for another witness or with a malformed challenge", async () => {
    const log = logged();
    expect(
      await refusal(
        witness(log).readCollectionCheckpoint({
          ...collectionQuery(),
          witnessId: "other",
        }),
      ),
    ).toBe("rekor-request-invalid");
    expect(
      await refusal(
        witness(log).readGrantStatus({ ...grantQuery(d("g")), challenge: "x" }),
      ),
    ).toBe("rekor-request-invalid");
    expect(log.requests).toEqual([]);
  });

  it("bounds response size", async () => {
    const log = logged();
    expect(
      await refusal(
        witness(log, { maxResponseBytes: 64 }).readCollectionCheckpoint(
          collectionQuery(),
        ),
      ),
    ).toBe("rekor-response-invalid");
  });

  it("keeps its state under the per-user data directory", () => {
    expect(defaultRekorStateDir("darwin", {}, "/Users/o")).toBe(
      path.join(
        "/Users/o",
        "Library",
        "Application Support",
        "graph-engineering",
        "rekor-witness",
      ),
    );
    expect(
      defaultRekorStateDir("linux", { XDG_DATA_HOME: "/x" }, "/home/o"),
    ).toBe(path.join("/x", "graph-engineering", "rekor-witness"));
    expect(
      ownerStatementSubjectDigest({ kind: "freeze", projectId, collectionId }),
    ).toBe(
      d(
        `graph-engineering/promotion-owner-statement/v1/freeze/${projectId}/${collectionId}`,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Live, read-only check against the public log (GRAPH_ENGINE_REKOR_LIVE=1).

/** rekor.sigstore.dev's log key, as pinned in Sigstore's TUF trusted_root.json. */
const SIGSTORE_REKOR_V1_KEY = SIGSTORE_REKOR_V1.logPublicKeyPem;

it.runIf(process.env.GRAPH_ENGINE_REKOR_LIVE === "1")(
  "verifies the live Rekor tree head, a consistency proof and an inclusion proof",
  async () => {
    const stateDir = path.join(tempDir(), "rekor-witness");
    const live = createRekorWitness({
      witnessId: "rekor-d6",
      baseUrl: "https://rekor.sigstore.dev",
      origin: "rekor.sigstore.dev",
      logPublicKeyPem: SIGSTORE_REKOR_V1_KEY,
      issuerPublicKeyPem: pem(issuer.publicKey),
      allowedHosts: ["rekor.sigstore.dev"],
      stateDir,
    });
    const first = await live.verifyTreeHead();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    // The second head is verified consistent with the first (the high-water).
    const second = await live.verifyTreeHead();
    expect(second.treeId).toBe(first.treeId);
    expect(second.treeSize >= first.treeSize).toBe(true);

    // An existing public entry: its inclusion proof, tied to a signed head
    // that is consistent with the verified one. Global log indices count the
    // inactive shards first; the proof's index is local to the active tree.
    const info = (await (
      await fetch("https://rekor.sigstore.dev/api/v1/log")
    ).json()) as { inactiveShards?: { treeSize: number }[] };
    const offset = (info.inactiveShards ?? []).reduce(
      (sum, shard) => sum + shard.treeSize,
      0,
    );
    const index = Number(first.treeSize) - 1_000;
    const response = await fetch(
      `https://rekor.sigstore.dev/api/v1/log/entries?logIndex=${index + offset}`,
    );
    const [[, entry]] = Object.entries(
      (await response.json()) as Record<string, any>,
    );
    const key = createPublicKey(SIGSTORE_REKOR_V1_KEY);
    const logId = createHash("sha256")
      .update(key.export({ type: "spki", format: "der" }))
      .digest("hex");
    expect(entry.logID).toBe(logId);
    const proof = entry.verification.inclusionProof;
    const proofHead = verifyRekorCheckpoint(proof.checkpoint, {
      origin: "rekor.sigstore.dev",
      key,
      logId,
    });
    expect(proofHead.rootHash).toBe(proof.rootHash);
    expect(proof.logIndex).toBe(index);
    expect(
      verifyInclusion(
        BigInt(proof.logIndex),
        BigInt(proof.treeSize),
        rekorLeafHash(Buffer.from(entry.body, "base64")),
        proof.hashes,
        proof.rootHash,
      ),
    ).toBe(true);
    const [older, newer] =
      proofHead.treeSize <= second.treeSize
        ? [proofHead, second]
        : [second, proofHead];
    const consistency = (await (
      await fetch(
        `https://rekor.sigstore.dev/api/v1/log/proof?firstSize=${older.treeSize}&lastSize=${newer.treeSize}&treeID=${newer.treeId}`,
      )
    ).json()) as { hashes: string[] };
    expect(
      verifyConsistency(
        older.treeSize,
        newer.treeSize,
        older.rootHash,
        newer.rootHash,
        consistency.hashes,
      ),
    ).toBe(true);
    // A search for a subject no owner has published finds nothing to trust.
    expect(
      await refusal(
        live.readCollectionCheckpoint({
          witnessId: "rekor-d6",
          projectId: `absent-${randomBytes(6).toString("hex")}`,
          collectionId: "none",
          challenge: challenge(),
        }),
      ),
    ).toBe("rekor-statement-missing");
  },
  60_000,
);
