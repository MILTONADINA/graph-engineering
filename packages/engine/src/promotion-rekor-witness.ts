// Read-only Rekor witness adapter for the promotion trust boundary
// (docs/promotion-rekor-witness.md). The owner publishes signed statements to
// Sigstore's public Rekor v1 log (witness D6); this adapter reads them back
// and TRANSLATES them into the replies the importer's WitnessController
// methods return. Rekor cannot echo a challenge, so for this kind the reply's
// challenge, issuedAt and expiresAt carry no security: they are filled from
// the request and the local clock only after every proof below verifies:
//
//   1. the log's signed tree head against a pinned log key (a constructor
//      input from the trust anchor, never fetched from Rekor);
//   2. a consistency proof from the persisted high-water tree to that head;
//   3. an inclusion proof, tied to that head, for every statement read, and
//      the owner's Ed25519 signature over the statement.
//
// Any failure refuses with a RekorWitnessError; no reply is ever built from
// unverified data. This module is NOT in the closed controller registry and
// nothing selects it; admission and wiring are a later reviewed change
// (PR-5). It never uploads: the only requests it can make are the four
// read endpoints named in `rekorRequest`.
import {
  createHash,
  createPublicKey,
  randomBytes,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
  type Stats,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  SignedCollectionCheckpoint,
  SignedGrantStatus,
  WitnessController,
} from "./promotion-controllers.js";
import {
  canonicalJson,
  digestSchema,
  hashJson,
  parseBoundedJson,
} from "./sealed-collection-schema.js";

// ---------------------------------------------------------------------------
// Errors

export type RekorWitnessErrorCode =
  | "rekor-config-invalid"
  | "rekor-request-invalid"
  | "rekor-host-not-allowed"
  | "rekor-network-failed"
  | "rekor-response-invalid"
  | "rekor-tree-head-invalid"
  | "rekor-consistency-invalid"
  | "rekor-rollback"
  | "rekor-inclusion-invalid"
  | "rekor-signature-invalid"
  | "rekor-statement-invalid"
  | "rekor-statement-missing"
  | "rekor-statement-ambiguous"
  | "rekor-statement-order-invalid"
  | "rekor-state-invalid";

export class RekorWitnessError extends Error {
  constructor(
    readonly code: RekorWitnessErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "RekorWitnessError";
  }
}
const fail = (code: RekorWitnessErrorCode, detail: string): never => {
  throw new RekorWitnessError(code, detail);
};

// ---------------------------------------------------------------------------
// Owner statements (the payloads the owner publishes as Rekor entries)

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const positiveCount = z.number().int().positive().safe();

/** The in-toto predicate type of every owner statement, version 1. */
export const OWNER_STATEMENT_PREDICATE_TYPE =
  "urn:graph-engineering:promotion-owner-statement:v1";
/** Owner statements are DSSE payloads of this type, so Rekor indexes their subject. */
export const OWNER_STATEMENT_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
const SUBJECT_PREFIX = "graph-engineering/promotion-owner-statement/v1";

export const GOVERNANCE_SECTIONS = [
  "registration",
  "population",
  "first-attempt",
  "head",
  "current-trust",
] as const;
export type GovernanceSection = (typeof GOVERNANCE_SECTIONS)[number];

const freezePredicate = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("freeze"),
    projectId: id,
    collectionId: id,
    frozenDigests: z.record(id, digestSchema),
  })
  .strict();
const governanceBase = {
  version: z.literal("1.0.0"),
  kind: z.literal("governance-checkpoint"),
  projectId: id,
  collectionId: id,
};
const governancePredicate = z.discriminatedUnion("section", [
  z
    .object({
      ...governanceBase,
      section: z.literal("registration"),
      planSha256: digestSchema,
      registrySha256: digestSchema,
      firstEventSha256: digestSchema,
    })
    .strict(),
  z
    .object({
      ...governanceBase,
      section: z.literal("population"),
      sourceInventorySha256: digestSchema,
      signedManifestSha256: digestSchema,
      populationTrustSha256: digestSchema,
    })
    .strict(),
  z
    .object({
      ...governanceBase,
      section: z.literal("first-attempt"),
      eventSha256: digestSchema,
    })
    .strict(),
  z
    .object({
      ...governanceBase,
      section: z.literal("head"),
      eventCount: positiveCount,
      eventHeadSha256: digestSchema,
      closureSha256: digestSchema,
    })
    .strict(),
  z
    .object({
      ...governanceBase,
      section: z.literal("current-trust"),
      rowTrustSha256: digestSchema,
      aggregateTrustSha256: digestSchema,
    })
    .strict(),
]);
const grantPredicate = (kind: "grant-registration" | "grant-revocation") =>
  z
    .object({
      version: z.literal("1.0.0"),
      kind: z.literal(kind),
      projectId: id,
      grantId: digestSchema,
    })
    .strict();

/** Every owner statement predicate, versioned by `version`. */
export const ownerStatementPredicateSchema = z.union([
  freezePredicate,
  governancePredicate,
  grantPredicate("grant-registration"),
  grantPredicate("grant-revocation"),
]);
export type OwnerStatementPredicate = z.infer<
  typeof ownerStatementPredicateSchema
>;

type SubjectKey =
  | { kind: "freeze"; projectId: string; collectionId: string }
  | {
      kind: "governance-checkpoint";
      projectId: string;
      collectionId: string;
      section: GovernanceSection;
    }
  | {
      kind: "grant-registration" | "grant-revocation";
      projectId: string;
      grantId: string;
    };

/**
 * The deterministic subject name of a statement. IDs cannot contain "/", so
 * the joined form is unambiguous.
 */
export function ownerStatementSubjectName(key: SubjectKey): string {
  switch (key.kind) {
    case "freeze":
      return `${SUBJECT_PREFIX}/freeze/${key.projectId}/${key.collectionId}`;
    case "governance-checkpoint":
      return `${SUBJECT_PREFIX}/governance-checkpoint/${key.projectId}/${key.collectionId}/${key.section}`;
    default:
      return `${SUBJECT_PREFIX}/${key.kind}/${key.projectId}/${key.grantId}`;
  }
}

/** The SHA-256 Rekor indexes for a subject: the adapter's search key. */
export const ownerStatementSubjectDigest = (key: SubjectKey): string =>
  sha256Hex(Buffer.from(ownerStatementSubjectName(key), "utf8"));

const inTotoStatementSchema = z
  .object({
    _type: z.literal(IN_TOTO_STATEMENT_TYPE),
    subject: z
      .array(
        z
          .object({
            name: z.string().min(1).max(600),
            digest: z.object({ sha256: digestSchema }).strict(),
          })
          .strict(),
      )
      .length(1),
    predicateType: z.literal(OWNER_STATEMENT_PREDICATE_TYPE),
    predicate: ownerStatementPredicateSchema,
  })
  .strict();

/**
 * The exact payload bytes the owner signs and publishes for a predicate:
 * canonical JSON of an in-toto Statement v1 naming the statement's subject.
 * The adapter accepts only these canonical bytes.
 */
export function ownerStatementPayload(
  predicateInput: OwnerStatementPredicate,
): Buffer {
  const predicate = ownerStatementPredicateSchema.parse(predicateInput);
  const name = ownerStatementSubjectName(subjectKeyOf(predicate));
  return Buffer.from(
    canonicalJson({
      _type: IN_TOTO_STATEMENT_TYPE,
      subject: [
        { name, digest: { sha256: sha256Hex(Buffer.from(name, "utf8")) } },
      ],
      predicateType: OWNER_STATEMENT_PREDICATE_TYPE,
      predicate,
    }),
    "utf8",
  );
}

function subjectKeyOf(predicate: OwnerStatementPredicate): SubjectKey {
  if (predicate.kind === "freeze")
    return {
      kind: "freeze",
      projectId: predicate.projectId,
      collectionId: predicate.collectionId,
    };
  if (predicate.kind === "governance-checkpoint")
    return {
      kind: predicate.kind,
      projectId: predicate.projectId,
      collectionId: predicate.collectionId,
      section: predicate.section,
    };
  return {
    kind: predicate.kind,
    projectId: predicate.projectId,
    grantId: predicate.grantId,
  };
}

/** DSSE pre-authentication encoding: what the owner's Ed25519 key signs. */
export function dssePae(payloadType: string, payload: Uint8Array): Buffer {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `, "utf8"),
    type,
    Buffer.from(` ${payload.length} `, "utf8"),
    payload,
  ]);
}

// ---------------------------------------------------------------------------
// RFC 6962 / RFC 9162 Merkle verification (BigInt: Rekor trees exceed 2^31)

const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const nodeHash = (left: Buffer, right: Buffer): Buffer =>
  createHash("sha256")
    .update(Buffer.from([1]))
    .update(left)
    .update(right)
    .digest();
/** The RFC 6962 leaf hash of an entry body: SHA-256(0x00 || body). */
export const rekorLeafHash = (body: Uint8Array): string =>
  createHash("sha256")
    .update(Buffer.from([0]))
    .update(body)
    .digest("hex");

const hexHash = (value: string, what: string): Buffer => {
  if (!digestSchema.safeParse(value).success)
    fail("rekor-response-invalid", `${what} is not a SHA-256 hex digest`);
  return Buffer.from(value, "hex");
};

/** Verify an inclusion proof for a leaf at `index` in a tree of `size`. */
export function verifyInclusion(
  index: bigint,
  size: bigint,
  leafHash: string,
  proof: readonly string[],
  rootHash: string,
): boolean {
  if (index < 0n || index >= size) return false;
  let fn = index;
  let sn = size - 1n;
  let r = hexHash(leafHash, "leaf hash");
  for (const item of proof) {
    const p = hexHash(item, "inclusion proof hash");
    if (sn === 0n) return false;
    if ((fn & 1n) === 1n || fn === sn) {
      r = nodeHash(p, r);
      if ((fn & 1n) === 0n)
        while ((fn & 1n) === 0n && fn !== 0n) {
          fn >>= 1n;
          sn >>= 1n;
        }
    } else r = nodeHash(r, p);
    fn >>= 1n;
    sn >>= 1n;
  }
  return sn === 0n && r.equals(hexHash(rootHash, "root hash"));
}

/** Verify that the tree of `size1` is a prefix of the tree of `size2`. */
export function verifyConsistency(
  size1: bigint,
  size2: bigint,
  root1: string,
  root2: string,
  proof: readonly string[],
): boolean {
  const first = hexHash(root1, "first root");
  const second = hexHash(root2, "second root");
  if (size1 < 1n || size2 < size1) return false;
  if (size1 === size2) return proof.length === 0 && first.equals(second);
  const path = proof.map((item) => hexHash(item, "consistency proof hash"));
  // A power-of-two first tree is itself a node of the second.
  if ((size1 & (size1 - 1n)) === 0n) path.unshift(first);
  if (!path.length) return false;
  let fn = size1 - 1n;
  let sn = size2 - 1n;
  while ((fn & 1n) === 1n) {
    fn >>= 1n;
    sn >>= 1n;
  }
  let fr = path[0]!;
  let sr = path[0]!;
  for (const c of path.slice(1)) {
    if (sn === 0n) return false;
    if ((fn & 1n) === 1n || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if ((fn & 1n) === 0n)
        while ((fn & 1n) === 0n && fn !== 0n) {
          fn >>= 1n;
          sn >>= 1n;
        }
    } else sr = nodeHash(sr, c);
    fn >>= 1n;
    sn >>= 1n;
  }
  return fr.equals(first) && sr.equals(second) && sn === 0n;
}

// ---------------------------------------------------------------------------
// Signed tree heads (Rekor v1 checkpoints: signed notes, ECDSA P-256)

export interface RekorTreeHead {
  treeId: string;
  treeSize: bigint;
  rootHash: string;
}

/**
 * Verify a Rekor v1 signed-note checkpoint with the pinned log key and parse
 * it. The note must be "<origin> - <treeID>", the size and a base64 root,
 * signed by a line naming `origin` whose 4-byte key hint is the log ID.
 */
export function verifyRekorCheckpoint(
  note: string,
  log: Readonly<{ origin: string; key: KeyObject; logId: string }>,
): RekorTreeHead {
  if (typeof note !== "string" || note.length > 4_096)
    fail("rekor-tree-head-invalid", "checkpoint is not a bounded string");
  const split = note.indexOf("\n\n");
  if (split < 0) fail("rekor-tree-head-invalid", "checkpoint has no signature");
  const body = note.slice(0, split + 1);
  const lines = body.slice(0, -1).split("\n");
  const [origin, size, root] = lines;
  const match = /^(.+) - ([0-9]{1,20})$/.exec(origin ?? "");
  if (
    !match ||
    match[1] !== log.origin ||
    !/^[1-9][0-9]{0,19}$/.test(size ?? "") ||
    !/^[A-Za-z0-9+/]{43}=$/.test(root ?? "")
  )
    fail("rekor-tree-head-invalid", "checkpoint body is not a Rekor v1 note");
  const hint = Buffer.from(log.logId, "hex").subarray(0, 4);
  const signatures = note
    .slice(split + 2)
    .split("\n")
    .filter((line) => line.length)
    .map((line) => /^— (\S+) ([A-Za-z0-9+/=]+)$/.exec(line))
    .filter(
      (parsed): parsed is RegExpExecArray =>
        !!parsed && parsed[1] === log.origin,
    )
    .map((parsed) => Buffer.from(parsed[2]!, "base64"))
    .filter((raw) => raw.length > 4 && raw.subarray(0, 4).equals(hint));
  if (signatures.length !== 1)
    fail(
      "rekor-tree-head-invalid",
      "checkpoint has no single signature by the pinned log key",
    );
  const valid = verify(
    "sha256",
    Buffer.from(body, "utf8"),
    { key: log.key, dsaEncoding: "der" },
    signatures[0]!.subarray(4),
  );
  if (!valid)
    fail(
      "rekor-tree-head-invalid",
      "checkpoint signature does not verify with the pinned log key",
    );
  return {
    treeId: match![2]!,
    treeSize: BigInt(size!),
    rootHash: Buffer.from(root!, "base64").toString("hex"),
  };
}

// ---------------------------------------------------------------------------
// Network gate

export type RekorFetch = (
  url: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    redirect: "error";
    signal: AbortSignal;
  },
) => Promise<Response>;

/** Pinned to the Rekor v1 REST API observed on 2026-09-28. */
export const REKOR_API_VERSION = "v1" as const;
const READ_PATHS = Object.freeze({
  log: "/api/v1/log",
  proof: "/api/v1/log/proof",
  entry: "/api/v1/log/entries/",
  search: "/api/v1/index/retrieve",
});

async function boundedBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes)
    fail("rekor-response-invalid", `response exceeds ${maxBytes} bytes`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      fail("rekor-response-invalid", `response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---------------------------------------------------------------------------
// High-water state (per log, under the user data dir)

/** The default state directory: the promotion-key tool's per-user base. */
export function defaultRekorStateDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  if (platform === "darwin")
    return path.join(
      home,
      "Library",
      "Application Support",
      "graph-engineering",
      "rekor-witness",
    );
  const data =
    env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME
      : path.join(home, ".local", "share");
  return path.join(data, "graph-engineering", "rekor-witness");
}

const posix = process.platform !== "win32";
const stateSchema = z
  .object({
    version: z.literal(1),
    logId: digestSchema,
    treeId: z.string().regex(/^[0-9]{1,20}$/),
    treeSize: z.string().regex(/^[1-9][0-9]{0,19}$/),
    rootHash: digestSchema,
  })
  .strict();
type HighWater = { treeId: string; treeSize: bigint; rootHash: string };
const STATE_MAX_BYTES = 4_096;

function checkPrivate(target: string, stat: Stats, kind: "dir" | "file") {
  if (stat.isSymbolicLink())
    fail("rekor-state-invalid", `${target} is a symlink`);
  if (kind === "dir" ? !stat.isDirectory() : !stat.isFile())
    fail("rekor-state-invalid", `${target} is not a ${kind}`);
  if (!posix) return;
  if (stat.mode & 0o077)
    fail(
      "rekor-state-invalid",
      `${target} is accessible by group or others (mode ${(stat.mode & 0o777).toString(8)})`,
    );
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    fail("rekor-state-invalid", `${target} is owned by another user`);
}

function lstatOrNull(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

class HighWaterStore {
  constructor(
    private readonly dir: string,
    private readonly logId: string,
  ) {}

  private get file() {
    return path.join(this.dir, `${this.logId}.json`);
  }

  private ensureDir() {
    if (!lstatOrNull(this.dir))
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    checkPrivate(this.dir, lstatSync(this.dir), "dir");
  }

  read(): HighWater | undefined {
    this.ensureDir();
    const stat = lstatOrNull(this.file);
    if (!stat) return undefined;
    checkPrivate(this.file, stat, "file");
    if (stat.size > STATE_MAX_BYTES)
      fail("rekor-state-invalid", `${this.file} is too large`);
    const fd = openSync(
      this.file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    let text: string;
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino)
        fail("rekor-state-invalid", `${this.file} changed while opening`);
      if (opened.size > STATE_MAX_BYTES)
        fail("rekor-state-invalid", `${this.file} is too large`);
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
    let parsed;
    try {
      parsed = stateSchema.safeParse(parseBoundedJson(text));
    } catch {
      return fail("rekor-state-invalid", `${this.file} is not JSON`);
    }
    if (!parsed.success || parsed.data.logId !== this.logId)
      return fail("rekor-state-invalid", `${this.file} is malformed`);
    return {
      treeId: parsed.data.treeId,
      treeSize: BigInt(parsed.data.treeSize),
      rootHash: parsed.data.rootHash,
    };
  }

  /** Replace the state atomically; never lowers a newer concurrent value. */
  write(next: HighWater) {
    this.ensureDir();
    const current = this.read();
    if (
      current &&
      (current.treeId !== next.treeId || current.treeSize > next.treeSize)
    )
      fail("rekor-rollback", "the high-water mark moved during this read");
    if (
      current &&
      current.treeSize === next.treeSize &&
      current.rootHash === next.rootHash
    )
      return;
    const data = Buffer.from(
      `${JSON.stringify({
        version: 1,
        logId: this.logId,
        treeId: next.treeId,
        treeSize: next.treeSize.toString(),
        rootHash: next.rootHash,
      })}\n`,
      "utf8",
    );
    const temporary = `${this.file}.${randomBytes(8).toString("hex")}.tmp`;
    const fd = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let written = false;
    try {
      if (posix) fchmodSync(fd, 0o600);
      if (writeSync(fd, data) !== data.length)
        fail("rekor-state-invalid", `could not write ${temporary}`);
      fsyncSync(fd);
      written = true;
    } finally {
      closeSync(fd);
      if (!written) rmSync(temporary, { force: true });
    }
    // rename replaces the directory entry itself and never follows a link.
    renameSync(temporary, this.file);
  }
}

// ---------------------------------------------------------------------------
// Rekor responses

const b64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
const logInfoSchema = z
  .object({
    rootHash: digestSchema,
    signedTreeHead: z.string().max(4_096),
    treeID: z.string().regex(/^[0-9]{1,20}$/),
    treeSize: z.number().int().positive(),
  })
  .passthrough();
const proofSchema = z
  .object({
    hashes: z.array(digestSchema).max(128),
    // Observed: the live log reports its current root here, not the root at
    // lastSize, so it is ignored; the hashes are checked against both signed
    // roots instead.
    rootHash: digestSchema.optional(),
  })
  .passthrough();
const entrySchema = z
  .object({
    body: b64,
    integratedTime: z.number().int(),
    logID: digestSchema,
    logIndex: z.number().int().nonnegative(),
    verification: z
      .object({
        inclusionProof: z
          .object({
            checkpoint: z.string().max(4_096),
            hashes: z.array(digestSchema).max(128),
            logIndex: z.number().int().nonnegative(),
            rootHash: digestSchema,
            treeSize: z.number().int().positive(),
          })
          .passthrough(),
      })
      .passthrough(),
    attestation: z.object({ data: b64.optional() }).passthrough().optional(),
  })
  .passthrough();
const dsseBodySchema = z
  .object({
    apiVersion: z.literal("0.0.1"),
    kind: z.literal("dsse"),
    spec: z
      .object({
        payloadHash: z
          .object({ algorithm: z.literal("sha256"), value: digestSchema })
          .passthrough(),
        signatures: z
          .array(z.object({ signature: b64, verifier: b64 }).passthrough())
          .min(1)
          .max(16),
      })
      .passthrough(),
  })
  .passthrough();
const intotoBodySchema = z
  .object({
    apiVersion: z.literal("0.0.2"),
    kind: z.literal("intoto"),
    spec: z
      .object({
        content: z
          .object({
            envelope: z
              .object({
                payloadType: z.string(),
                signatures: z
                  .array(z.object({ sig: b64, publicKey: b64 }).passthrough())
                  .min(1)
                  .max(16),
              })
              .passthrough(),
            payloadHash: z
              .object({ algorithm: z.literal("sha256"), value: digestSchema })
              .passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

/** One owner statement whose inclusion and signature are verified. */
export interface VerifiedOwnerStatement {
  predicate: OwnerStatementPredicate;
  /** Tree-local leaf index, covered by the inclusion proof. */
  logIndex: bigint;
  leafHash: string;
  payloadSha256: string;
}

// ---------------------------------------------------------------------------
// The adapter

export interface RekorWitnessOptions {
  /** The witness ID the D3 anchor names; every request must carry it. */
  witnessId: string;
  /** Rekor base URL, https, e.g. https://rekor.sigstore.dev. */
  baseUrl: string;
  /** The checkpoint origin name, e.g. rekor.sigstore.dev. */
  origin: string;
  /** The pinned ECDSA P-256 log key (PEM), from the trust anchor. */
  logPublicKeyPem: string;
  /** The owner's Ed25519 issuer key (PEM) that signs every statement. */
  issuerPublicKeyPem: string;
  /** Hosts this adapter may contact; anything else is refused. */
  allowedHosts: readonly string[];
  /** Where the high-water mark lives; defaults to the per-user data dir. */
  stateDir?: string;
  fetch?: RekorFetch;
  /**
   * An untrusted source of payload bytes for DSSE entries (Rekor stores only
   * their hash). Bytes are accepted only when they hash to the logged
   * payloadHash. intoto v0.0.2 entries carry their payload in the log.
   */
  readPayload?: (payloadSha256: string) => Promise<Uint8Array | undefined>;
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxEntriesPerSubject?: number;
}

type Query = Readonly<{
  witnessId: string;
  projectId: string;
  collectionId: string;
  challenge: string;
}>;
type GrantQuery = Readonly<{
  witnessId: string;
  projectId: string;
  grantId: string;
  challenge: string;
}>;

/** The Rekor witness: the WitnessController methods under a distinct kind. */
export interface RekorWitnessController extends Omit<
  WitnessController,
  "kind"
> {
  readonly kind: "rekor-v1";
  /**
   * Verify the current signed tree head and its consistency with the
   * high-water mark, then advance the mark. Every read does this first.
   */
  verifyTreeHead(): Promise<RekorTreeHead>;
}

const challengeSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** Translated replies claim a 30 s window; the importer allows at most 60 s. */
const REPLY_WINDOW_MS = 30_000;

export function createRekorWitness(
  options: RekorWitnessOptions,
): RekorWitnessController {
  return new RekorWitness(options);
}

class RekorWitness implements RekorWitnessController {
  readonly kind = "rekor-v1" as const;
  private readonly base: URL;
  private readonly logKey: KeyObject;
  private readonly logId: string;
  private readonly issuerSpki: Buffer;
  private readonly issuerKey: KeyObject;
  private readonly allowed: ReadonlySet<string>;
  private readonly store: HighWaterStore;
  private readonly fetcher: RekorFetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxEntries: number;

  constructor(private readonly options: RekorWitnessOptions) {
    if (!id.safeParse(options.witnessId).success)
      fail("rekor-config-invalid", "witnessId is not an ID");
    try {
      this.base = new URL(options.baseUrl);
    } catch {
      throw new RekorWitnessError(
        "rekor-config-invalid",
        "baseUrl is not a URL",
      );
    }
    if (
      this.base.protocol !== "https:" ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      (this.base.pathname !== "/" && this.base.pathname !== "")
    )
      fail("rekor-config-invalid", "baseUrl must be a bare https origin");
    if (!/^[a-z0-9.-]{1,253}$/.test(options.origin))
      fail("rekor-config-invalid", "origin is not a host name");
    this.logKey = publicKey(options.logPublicKeyPem, "log");
    if (
      this.logKey.asymmetricKeyType !== "ec" ||
      this.logKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    )
      fail("rekor-config-invalid", "the pinned log key is not ECDSA P-256");
    this.logId = sha256Hex(this.logKey.export({ type: "spki", format: "der" }));
    this.issuerKey = publicKey(options.issuerPublicKeyPem, "issuer");
    if (this.issuerKey.asymmetricKeyType !== "ed25519")
      fail("rekor-config-invalid", "the issuer key is not Ed25519");
    this.issuerSpki = this.issuerKey.export({ type: "spki", format: "der" });
    if (
      !Array.isArray(options.allowedHosts) ||
      options.allowedHosts.some((host) => typeof host !== "string")
    )
      fail("rekor-config-invalid", "allowedHosts must be host names");
    this.allowed = new Set(
      options.allowedHosts.map((host) => host.toLowerCase()),
    );
    this.store = new HighWaterStore(
      options.stateDir ?? defaultRekorStateDir(),
      this.logId,
    );
    this.fetcher = options.fetch ?? (globalThis.fetch as RekorFetch);
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxBytes = options.maxResponseBytes ?? 262_144;
    this.maxEntries = options.maxEntriesPerSubject ?? 32;
  }

  /** The SHA-256 of the pinned log key's SPKI: Rekor's log ID. */
  get pinnedLogId(): string {
    return this.logId;
  }

  // -- WitnessController --------------------------------------------------

  async readCollectionCheckpoint(
    request: Query,
  ): Promise<SignedCollectionCheckpoint> {
    const query = this.checkQuery(request, "collectionId");
    const key = {
      kind: "freeze" as const,
      projectId: query.projectId,
      collectionId: query.collectionId,
    };
    const [freeze] = await this.read([key]);
    const statement = single(freeze!, "freeze");
    const predicate = statement.predicate as z.infer<typeof freezePredicate>;
    return {
      witnessId: query.witnessId,
      projectId: query.projectId,
      collectionId: query.collectionId,
      ...this.replyTimes(query.challenge),
      // Derived from the owner's freeze entry, never from the moving log root.
      checkpointSha256: hashJson({
        kind: "rekor-owner-freeze",
        logId: this.logId,
        logIndex: statement.logIndex.toString(),
        leafHash: statement.leafHash,
        payloadSha256: statement.payloadSha256,
      }),
      frozenDigests: { ...predicate.frozenDigests },
    };
  }

  async readGovernanceCheckpoint(request: Query): Promise<unknown> {
    const query = this.checkQuery(request, "collectionId");
    const keys = GOVERNANCE_SECTIONS.map((section) => ({
      kind: "governance-checkpoint" as const,
      projectId: query.projectId,
      collectionId: query.collectionId,
      section,
    }));
    const found = await this.read(keys);
    const [registration, population, firstAttempt, head, trust] = found.map(
      (statements, index) =>
        statements.length > 1
          ? fail(
              "rekor-statement-ambiguous",
              `more than one owner ${GOVERNANCE_SECTIONS[index]} statement`,
            )
          : statements[0],
    );
    const need = (
      statement: VerifiedOwnerStatement | undefined,
      section: GovernanceSection,
    ) =>
      statement ??
      fail(
        "rekor-statement-missing",
        `no owner governance ${section} statement`,
      );
    type Section<S> = Extract<
      z.infer<typeof governancePredicate>,
      { section: S }
    >;
    // Revisions are Rekor leaf indices + 1 (positive), fixed once published.
    const revision = (statement: VerifiedOwnerStatement) => {
      const value = statement.logIndex + 1n;
      if (value > BigInt(Number.MAX_SAFE_INTEGER))
        fail("rekor-statement-invalid", "log index is not a safe integer");
      return Number(value);
    };
    const reg = need(registration, "registration");
    const hd = need(head, "head");
    const tr = need(trust, "current-trust");
    if (!!population !== !!firstAttempt)
      fail(
        "rekor-statement-missing",
        "population and first-attempt statements must both be published",
      );
    const all = [reg, hd, tr, population, firstAttempt].filter(
      (item): item is VerifiedOwnerStatement => !!item,
    );
    const checkpointRevision = Math.max(...all.map(revision));
    if (revision(reg) >= revision(hd))
      fail(
        "rekor-statement-order-invalid",
        "the registration must be published before the head",
      );
    if (population && firstAttempt) {
      if (
        revision(reg) >= revision(firstAttempt) ||
        revision(population) >= revision(firstAttempt) ||
        revision(firstAttempt) >= revision(hd)
      )
        fail(
          "rekor-statement-order-invalid",
          "publish registration and population before first-attempt, and first-attempt before head",
        );
    }
    const r = reg.predicate as Section<"registration">;
    const h = hd.predicate as Section<"head">;
    const t = tr.predicate as Section<"current-trust">;
    const base = {
      version: "1.0.0" as string,
      kind: "sealed-governance-current-checkpoint",
      witnessId: query.witnessId,
      projectId: query.projectId,
      collectionId: query.collectionId,
      ...this.replyTimes(query.challenge),
      checkpointRevision,
      registration: {
        revision: revision(reg),
        planSha256: r.planSha256,
        registrySha256: r.registrySha256,
        firstEventSha256: r.firstEventSha256,
      },
      head: {
        revision: revision(hd),
        eventCount: h.eventCount,
        eventHeadSha256: h.eventHeadSha256,
        closureSha256: h.closureSha256,
      },
      currentTrust: {
        revision: revision(tr),
        rowTrustSha256: t.rowTrustSha256,
        aggregateTrustSha256: t.aggregateTrustSha256,
      },
    };
    if (!population || !firstAttempt) return base;
    const p = population.predicate as Section<"population">;
    const f = firstAttempt.predicate as Section<"first-attempt">;
    return {
      ...base,
      version: "2.0.0",
      population: {
        revision: revision(population),
        sourceInventorySha256: p.sourceInventorySha256,
        signedManifestSha256: p.signedManifestSha256,
        populationTrustSha256: p.populationTrustSha256,
      },
      firstAttempt: {
        revision: revision(firstAttempt),
        eventSha256: f.eventSha256,
      },
    };
  }

  async readGrantStatus(request: GrantQuery): Promise<SignedGrantStatus> {
    const query = this.checkQuery(request, "grantId");
    const [registrations, revocations] = await this.read([
      {
        kind: "grant-registration",
        projectId: query.projectId,
        grantId: query.grantId,
      },
      {
        kind: "grant-revocation",
        projectId: query.projectId,
        grantId: query.grantId,
      },
    ]);
    // A revocation can never be undone, and one without a registration is
    // still reported as revoked so the grant can never become active.
    const status: SignedGrantStatus["status"] = revocations!.length
      ? "revoked"
      : registrations!.length
        ? "active"
        : "unregistered";
    return {
      witnessId: query.witnessId,
      projectId: query.projectId,
      grantId: query.grantId,
      status,
      ...this.replyTimes(query.challenge),
    };
  }

  // -- Verification -------------------------------------------------------

  private checkQuery<T extends Query | GrantQuery>(
    request: T,
    field: "collectionId" | "grantId",
  ): T {
    const value = (request as Record<string, unknown> | null)?.[field];
    if (
      !request ||
      typeof request !== "object" ||
      request.witnessId !== this.options.witnessId ||
      !id.safeParse(request.projectId).success ||
      !(field === "grantId"
        ? digestSchema.safeParse(value).success
        : id.safeParse(value).success) ||
      !challengeSchema.safeParse(request.challenge).success
    )
      fail(
        "rekor-request-invalid",
        "the request names another witness or is malformed",
      );
    return request;
  }

  /** The only fields this kind fills without proof: see the module comment. */
  private replyTimes(challenge: string) {
    const now = this.now();
    return {
      challenge,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + REPLY_WINDOW_MS).toISOString(),
    };
  }

  /**
   * Verify the current tree head and advance the high-water mark, then find,
   * verify and return the owner statements for each subject.
   */
  private async read(
    keys: readonly SubjectKey[],
  ): Promise<VerifiedOwnerStatement[][]> {
    const head = await this.verifyTreeHead();
    const results: VerifiedOwnerStatement[][] = [];
    for (const key of keys) results.push(await this.statementsFor(key, head));
    return results;
  }

  /** Steps 1 and 2: the signed tree head and consistency from the high-water. */
  async verifyTreeHead(): Promise<RekorTreeHead> {
    const info = logInfoSchema.safeParse(
      await this.getJson(READ_PATHS.log, {}),
    );
    if (!info.success)
      return fail("rekor-response-invalid", "log info is malformed");
    const head = verifyRekorCheckpoint(info.data.signedTreeHead, {
      origin: this.options.origin,
      key: this.logKey,
      logId: this.logId,
    });
    if (
      head.treeId !== info.data.treeID ||
      head.treeSize !== BigInt(info.data.treeSize) ||
      head.rootHash !== info.data.rootHash
    )
      fail(
        "rekor-tree-head-invalid",
        "log info differs from its signed tree head",
      );
    const previous = this.store.read();
    if (previous) {
      if (previous.treeId !== head.treeId)
        fail(
          "rekor-rollback",
          `the log's tree changed from ${previous.treeId} to ${head.treeId}; an operator must re-pin`,
        );
      if (head.treeSize < previous.treeSize)
        fail(
          "rekor-rollback",
          `tree size ${head.treeSize} is below the high-water mark ${previous.treeSize}`,
        );
      await this.requireConsistent(previous, head);
    }
    // Advance only after the new head verified and is consistent.
    this.store.write(head);
    return head;
  }

  private async requireConsistent(older: RekorTreeHead, newer: RekorTreeHead) {
    if (older.treeSize === newer.treeSize) {
      if (older.rootHash !== newer.rootHash)
        fail(
          "rekor-consistency-invalid",
          "two signed heads of one size have different roots",
        );
      return;
    }
    const proof = proofSchema.safeParse(
      await this.getJson(READ_PATHS.proof, {
        firstSize: older.treeSize.toString(),
        lastSize: newer.treeSize.toString(),
        treeID: newer.treeId,
      }),
    );
    if (
      !proof.success ||
      !verifyConsistency(
        older.treeSize,
        newer.treeSize,
        older.rootHash,
        newer.rootHash,
        proof.data.hashes,
      )
    )
      fail(
        "rekor-consistency-invalid",
        `no valid consistency proof from size ${older.treeSize} to ${newer.treeSize}`,
      );
  }

  /** Step 3: every owner entry for one subject, with inclusion proven. */
  private async statementsFor(
    key: SubjectKey,
    head: RekorTreeHead,
  ): Promise<VerifiedOwnerStatement[]> {
    const subject = ownerStatementSubjectDigest(key);
    const uuids = z
      .array(z.string().regex(/^([a-f0-9]{16})?[a-f0-9]{64}$/))
      .safeParse(
        await this.postJson(READ_PATHS.search, { hash: `sha256:${subject}` }),
      );
    if (!uuids.success)
      return fail("rekor-response-invalid", "search result is malformed");
    const unique = [...new Set(uuids.data)];
    if (unique.length > this.maxEntries)
      fail(
        "rekor-statement-ambiguous",
        `more than ${this.maxEntries} entries claim one subject`,
      );
    const statements: VerifiedOwnerStatement[] = [];
    for (const uuid of unique) {
      const statement = await this.verifiedEntry(uuid, key, subject, head);
      if (statement) statements.push(statement);
    }
    return statements.sort((a, b) => (a.logIndex < b.logIndex ? -1 : 1));
  }

  /**
   * Fetch one entry, prove its inclusion in a head consistent with the
   * verified head, and return its statement when the owner signed it.
   * Entries signed by any other key are ignored: anyone can log a subject.
   */
  private async verifiedEntry(
    uuid: string,
    key: SubjectKey,
    subject: string,
    head: RekorTreeHead,
  ): Promise<VerifiedOwnerStatement | undefined> {
    const response = await this.getJson(`${READ_PATHS.entry}${uuid}`, {});
    if (
      !response ||
      typeof response !== "object" ||
      Array.isArray(response) ||
      Object.keys(response).length !== 1
    )
      return fail("rekor-response-invalid", "entry response is malformed");
    const [[entryKey, raw]] = Object.entries(response);
    const parsed = entrySchema.safeParse(raw);
    if (!parsed.success)
      return fail("rekor-response-invalid", "entry is malformed");
    const entry = parsed.data;
    const body = Buffer.from(entry.body, "base64");
    const leafHash = rekorLeafHash(body);
    const treeHex = BigInt(head.treeId).toString(16).padStart(16, "0");
    if (
      entry.logID !== this.logId ||
      !entryKey!.endsWith(leafHash) ||
      !uuid.endsWith(leafHash) ||
      (entryKey!.length === 80 && !entryKey!.startsWith(treeHex))
    )
      fail(
        "rekor-inclusion-invalid",
        "entry is from another log or its body does not match its UUID",
      );
    // The proof's own head must be signed by the pinned key and consistent
    // with the verified head; then the leaf must be included in it.
    const proof = entry.verification.inclusionProof;
    const proofHead = verifyRekorCheckpoint(proof.checkpoint, {
      origin: this.options.origin,
      key: this.logKey,
      logId: this.logId,
    });
    if (
      proofHead.treeId !== head.treeId ||
      proofHead.treeSize !== BigInt(proof.treeSize) ||
      proofHead.rootHash !== proof.rootHash
    )
      fail(
        "rekor-inclusion-invalid",
        "inclusion proof does not match its signed head",
      );
    if (proofHead.treeSize >= head.treeSize)
      await this.requireConsistent(head, proofHead);
    else await this.requireConsistent(proofHead, head);
    const logIndex = BigInt(proof.logIndex);
    if (
      !verifyInclusion(
        logIndex,
        proofHead.treeSize,
        leafHash,
        proof.hashes,
        proofHead.rootHash,
      )
    )
      fail(
        "rekor-inclusion-invalid",
        `inclusion proof for entry ${uuid} does not verify`,
      );

    const signed = this.ownerSignature(body, entry.attestation?.data);
    if (!signed) return undefined;
    const payload = await this.payloadFor(signed.payloadSha256, signed.inline);
    if (
      !verify(
        null,
        dssePae(OWNER_STATEMENT_PAYLOAD_TYPE, payload),
        this.issuerKey,
        signed.signature,
      )
    )
      fail(
        "rekor-signature-invalid",
        `entry ${uuid} names the issuer key but its signature does not verify`,
      );
    const statement = parseOwnerStatement(payload);
    const expected = ownerStatementSubjectName(key);
    if (
      statement.subject[0]!.name !== expected ||
      statement.subject[0]!.digest.sha256 !== subject ||
      ownerStatementSubjectName(subjectKeyOf(statement.predicate)) !== expected
    )
      fail(
        "rekor-statement-invalid",
        `the owner statement in entry ${uuid} is for another subject`,
      );
    return {
      predicate: statement.predicate,
      logIndex,
      leafHash,
      payloadSha256: signed.payloadSha256,
    };
  }

  /** The issuer's signature in an entry body, or undefined for another key. */
  private ownerSignature(
    body: Buffer,
    attestation: string | undefined,
  ): { signature: Buffer; payloadSha256: string; inline?: Buffer } | undefined {
    let json: unknown;
    try {
      json = parseBoundedJson(body.toString("utf8"));
    } catch {
      return fail("rekor-response-invalid", "entry body is not JSON");
    }
    const dsse = dsseBodySchema.safeParse(json);
    const intoto = intotoBodySchema.safeParse(json);
    let candidates: { signature: Buffer; key: string }[];
    let payloadSha256: string;
    if (dsse.success) {
      payloadSha256 = dsse.data.spec.payloadHash.value;
      candidates = dsse.data.spec.signatures.map((item) => ({
        signature: Buffer.from(item.signature, "base64"),
        key: Buffer.from(item.verifier, "base64").toString("utf8"),
      }));
    } else if (intoto.success) {
      const content = intoto.data.spec.content;
      if (content.envelope.payloadType !== OWNER_STATEMENT_PAYLOAD_TYPE)
        return undefined;
      payloadSha256 = content.payloadHash.value;
      // intoto v0.0.2 stores each DSSE sig base64-encoded once more.
      candidates = content.envelope.signatures.map((item) => ({
        signature: Buffer.from(
          Buffer.from(item.sig, "base64").toString("utf8"),
          "base64",
        ),
        key: Buffer.from(item.publicKey, "base64").toString("utf8"),
      }));
    } else return undefined; // hashedrekord and other kinds are never statements
    const own = candidates.filter((candidate) => {
      try {
        return createPublicKey(candidate.key)
          .export({ type: "spki", format: "der" })
          .equals(this.issuerSpki);
      } catch {
        return false;
      }
    });
    if (!own.length) return undefined;
    if (own.length > 1)
      fail("rekor-statement-invalid", "an entry repeats the issuer key");
    return {
      signature: own[0]!.signature,
      payloadSha256,
      ...(attestation ? { inline: Buffer.from(attestation, "base64") } : {}),
    };
  }

  /** Payload bytes bound to the logged hash; the source itself is untrusted. */
  private async payloadFor(
    payloadSha256: string,
    inline: Buffer | undefined,
  ): Promise<Buffer> {
    let bytes: Uint8Array | undefined = inline;
    if (!bytes || sha256Hex(bytes) !== payloadSha256)
      bytes = await this.options.readPayload?.(payloadSha256);
    if (!bytes)
      return fail(
        "rekor-statement-missing",
        `the payload ${payloadSha256} of an owner entry is not available`,
      );
    if (bytes.byteLength > 65_536 || sha256Hex(bytes) !== payloadSha256)
      fail(
        "rekor-statement-invalid",
        "payload bytes do not match the logged payload hash",
      );
    return Buffer.from(bytes);
  }

  // -- Transport ------------------------------------------------------------

  private async getJson(
    pathname: string,
    params: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(pathname, this.base);
    for (const [name, value] of Object.entries(params))
      url.searchParams.set(name, value);
    return this.rekorRequest(url, "GET");
  }

  private async postJson(pathname: string, body: unknown): Promise<unknown> {
    return this.rekorRequest(
      new URL(pathname, this.base),
      "POST",
      JSON.stringify(body),
    );
  }

  /**
   * The network gate. Only https to an allowlisted host, only the read
   * endpoints; the one POST is the index search, which uploads nothing.
   */
  private async rekorRequest(
    url: URL,
    method: "GET" | "POST",
    body?: string,
  ): Promise<unknown> {
    if (url.protocol !== "https:" || !this.allowed.has(url.hostname))
      fail(
        "rekor-host-not-allowed",
        `${url.hostname} is not in the Rekor host allowlist`,
      );
    const read =
      method === "GET"
        ? url.pathname === READ_PATHS.log ||
          url.pathname === READ_PATHS.proof ||
          /^\/api\/v1\/log\/entries\/[a-f0-9]{64,80}$/.test(url.pathname)
        : url.pathname === READ_PATHS.search;
    if (!read)
      fail("rekor-request-invalid", `${method} ${url.pathname} is not a read`);
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), {
        method,
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return fail(
        "rekor-network-failed",
        `${method} ${url.pathname}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let text: string;
    try {
      text = await boundedBody(response, this.maxBytes);
    } catch (error) {
      if (error instanceof RekorWitnessError) throw error;
      return fail(
        "rekor-network-failed",
        `${method} ${url.pathname}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status !== 200)
      fail(
        "rekor-network-failed",
        `${method} ${url.pathname} answered ${response.status}`,
      );
    try {
      return parseBoundedJson(text);
    } catch {
      return fail("rekor-response-invalid", `${url.pathname} is not JSON`);
    }
  }
}

function publicKey(pem: string, what: string): KeyObject {
  try {
    return createPublicKey(pem);
  } catch {
    return fail("rekor-config-invalid", `the ${what} key is not a public key`);
  }
}

function parseOwnerStatement(payload: Buffer) {
  let parsed;
  try {
    const value = parseBoundedJson(payload.toString("utf8"));
    parsed = inTotoStatementSchema.safeParse(value);
    if (parsed.success && canonicalJson(value) !== payload.toString("utf8"))
      return fail(
        "rekor-statement-invalid",
        "an owner statement is not canonical JSON",
      );
  } catch (error) {
    if (error instanceof RekorWitnessError) throw error;
    return fail("rekor-statement-invalid", "an owner statement is not JSON");
  }
  if (!parsed.success)
    return fail(
      "rekor-statement-invalid",
      "an owner statement does not match the v1 schema",
    );
  return parsed.data;
}

function single(
  statements: VerifiedOwnerStatement[],
  what: string,
): VerifiedOwnerStatement {
  if (!statements.length)
    fail("rekor-statement-missing", `no owner ${what} statement is logged`);
  if (statements.length > 1)
    fail("rekor-statement-ambiguous", `more than one owner ${what} statement`);
  return statements[0]!;
}
