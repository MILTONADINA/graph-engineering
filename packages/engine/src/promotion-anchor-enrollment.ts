// The owner's D3 trust-anchor tooling (docs/promotion-trust-boundary.md,
// PR-4): prepare an anchor from the owner's PUBLIC keys, verify the installed
// one, and enroll it locally with the Rekor witness high-water state. None of
// this admits anything. The engine never writes the compiled root-owned
// anchor path and never runs sudo: `anchor-prepare` writes a file the owner
// chooses and prints the sudo commands for the owner to run. The anchor's
// controllers can only be the closed registries' "none" entries, so the
// importer still refuses at step 1 with an anchor installed, and the Rekor
// config built here is not registered in `promotionControllersFor`.
import { createHash, createPublicKey, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadProject } from "./project.js";
import { recomputeRepositoryIdentity } from "./promotion-importer.js";
import {
  ENROLLMENT_DIR_NAME,
  ENROLLMENT_FILE_NAME,
  OWNER_KEY_DIR_NAME,
  PREPARED_ANCHOR_FILE_NAME,
  promotionUserDataDir,
} from "./promotion-local-paths.js";
import {
  PromotionAnchorRefusalError,
  PromotionImportRefusalError,
  promotionAnchorRefusalSchema,
  type PromotionAnchorRefusal,
} from "./promotion-refusal-codes.js";
import {
  createRekorWitness,
  REKOR_API_VERSION,
  RekorWitnessError,
  type RekorWitnessOptions,
} from "./promotion-rekor-witness.js";
import {
  inspectPromotionTrustAnchorInstall,
  PROMOTION_TRUST_ANCHOR_PATHS,
  promotionTrustAnchorPath,
  promotionTrustAnchorSchema,
  type RekorPromotionTrustAnchor,
} from "./promotion-trust-anchor.js";
import { canonicalJson, digestSchema } from "./sealed-collection-schema.js";

const refuse = (code: PromotionAnchorRefusal, detail: string): never => {
  throw new PromotionAnchorRefusalError(code, detail);
};
const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------------------
// The pinned Rekor v1 log

/**
 * rekor.sigstore.dev's log key, from the `rekor.sigstore.dev` entry of
 * Sigstore's TUF `trusted_root.json` (PKIX_ECDSA_P256_SHA_256, valid from
 * 2021-01-12T11:53:27Z). On 2026-09-28 the live
 * `GET https://rekor.sigstore.dev/api/v1/log/publicKey` returned these exact
 * PEM bytes (SHA-256 `pemSha256`), and the SHA-256 of their SPKI DER is the
 * log ID the trusted root lists. The engine never fetches this key.
 */
export const SIGSTORE_REKOR_V1 = Object.freeze({
  baseUrl: "https://rekor.sigstore.dev",
  origin: "rekor.sigstore.dev",
  apiVersion: REKOR_API_VERSION,
  logId: "c0d23d6ad406973f9559f3ba2d1ca01f84147d8ffc5b8445c224f98b9591801d",
  logPublicKeyPem: `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2G2Y+2tabdTV5BcGiBIx0a9fAFwr
kBbmLSGtks4L3qX6yYY0zufBnhC8Ur/iy55GhWP/9A/bY2LhC30M9+RYtw==
-----END PUBLIC KEY-----
`,
  pemSha256: "dce5ef715502ec9f3cdfd11f8cc384b31a6141023d3e7595e9908a81cb6241bd",
  validFrom: "2021-01-12T11:53:27Z",
  verifiedLive: "2026-09-28",
});
/** The witness ID `anchor-prepare` gives the Rekor witness. */
export const REKOR_WITNESS_ID = "rekor-sigstore-v1";

// ---------------------------------------------------------------------------
// The owner's public keys

/** The roles the owner's key tool makes, one Ed25519 key each. */
export const OWNER_KEY_ROLES = ["approver", "issuer", "labeler"] as const;
export type OwnerKeyRole = (typeof OWNER_KEY_ROLES)[number];
export interface OwnerPublicKey {
  pem: string;
  /** SHA-256 of the SPKI DER, the fingerprint every pin uses. */
  publicKeySha256: string;
  keyId: string;
}
export type OwnerPublicKeys = Readonly<Record<OwnerKeyRole, OwnerPublicKey>>;

const SETUP_FIRST = "run npm run promotion-key -- setup first";
const MAX_PUBLIC_KEY_BYTES = 1_024;

/** The default directory of the owner's `<role>.pub.pem` files. */
export const defaultOwnerKeyDir = (): string =>
  path.join(promotionUserDataDir(), OWNER_KEY_DIR_NAME);

function lstatOrNull(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Read one regular, non-symlinked, bounded file through the checked descriptor. */
function readCheckedFile(
  target: string,
  stat: Stats,
  limit: number,
  onRefuse: (detail: string) => never,
): Buffer {
  if (stat.isSymbolicLink() || !stat.isFile())
    onRefuse(`${target} is not a regular file`);
  if (stat.size > limit) onRefuse(`${target} is larger than ${limit} bytes`);
  let fd: number;
  try {
    fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return onRefuse(`${target} cannot be opened safely`);
  }
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      opened.size > limit
    )
      onRefuse(`${target} changed while opening`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read ONLY `<keyDir>/<role>.pub.pem` for each role: never an encrypted key
 * file. Each must be a canonical Ed25519 SPKI PEM, and the three distinct.
 */
export function readOwnerPublicKeys(keyDir: string): OwnerPublicKeys {
  const keys = {} as Record<OwnerKeyRole, OwnerPublicKey>;
  for (const role of OWNER_KEY_ROLES) {
    const file = path.join(keyDir, `${role}.pub.pem`);
    const stat = lstatOrNull(file);
    if (!stat)
      refuse(
        "owner-public-key-missing",
        `there is no ${role} public key at ${file}; ${SETUP_FIRST}`,
      );
    const pem = readCheckedFile(file, stat!, MAX_PUBLIC_KEY_BYTES, (detail) =>
      refuse("owner-public-key-invalid", detail),
    ).toString("utf8");
    let key;
    try {
      key = createPublicKey(pem);
    } catch {
      return refuse("owner-public-key-invalid", `${file} is not a public key`);
    }
    if (
      key.asymmetricKeyType !== "ed25519" ||
      key.export({ type: "spki", format: "pem" }).toString() !== pem
    )
      refuse(
        "owner-public-key-invalid",
        `${file} is not a canonical Ed25519 public key PEM`,
      );
    const publicKeySha256 = sha256(key.export({ type: "spki", format: "der" }));
    keys[role] = {
      pem,
      publicKeySha256,
      keyId: `${role}-${publicKeySha256.slice(0, 16)}`,
    };
  }
  if (
    new Set(OWNER_KEY_ROLES.map((role) => keys[role].publicKeySha256)).size !==
    OWNER_KEY_ROLES.length
  )
    refuse(
      "owner-public-keys-not-distinct",
      "two roles share one public key; each role needs its own key",
    );
  return Object.freeze(keys);
}

// ---------------------------------------------------------------------------
// Building and serializing an anchor

export interface EnrolledProject {
  projectId: string;
  repositoryIdentitySha256: string;
}

/** Build and schema-check a 1.1.0 anchor. Pure: no I/O. */
export function buildPromotionTrustAnchor(input: {
  projects: readonly EnrolledProject[];
  keys: OwnerPublicKeys;
}): RekorPromotionTrustAnchor {
  const { keys } = input;
  const anchor = promotionTrustAnchorSchema.parse({
    version: "1.1.0",
    kind: "graph-engineering-promotion-trust-anchor",
    enrolledProjects: input.projects.map((project) => ({
      projectId: project.projectId,
      repositoryIdentitySha256: project.repositoryIdentitySha256,
    })),
    approverKeys: [
      {
        operatorId: "owner",
        keyId: keys.approver.keyId,
        publicKeySha256: keys.approver.publicKeySha256,
      },
    ],
    issuerKeys: [
      {
        issuerId: "owner",
        keyId: keys.issuer.keyId,
        publicKeySha256: keys.issuer.publicKeySha256,
      },
    ],
    labelerKeys: [
      {
        labelerId: "owner",
        keyId: keys.labeler.keyId,
        publicKeySha256: keys.labeler.publicKeySha256,
      },
    ],
    witnessId: REKOR_WITNESS_ID,
    rekor: {
      kind: "rekor-v1",
      apiVersion: SIGSTORE_REKOR_V1.apiVersion,
      baseUrl: SIGSTORE_REKOR_V1.baseUrl,
      origin: SIGSTORE_REKOR_V1.origin,
      logId: SIGSTORE_REKOR_V1.logId,
      logPublicKeyPem: SIGSTORE_REKOR_V1.logPublicKeyPem,
      issuerKeyId: keys.issuer.keyId,
      issuerPublicKeyPem: keys.issuer.pem,
    },
    // The closed registries hold only "none"; nothing else parses.
    controllers: { witness: "none", custody: "none", modelIdentity: "none" },
  });
  return anchor as RekorPromotionTrustAnchor;
}

/** The one canonical byte form of an anchor: canonical JSON and a newline. */
export const canonicalAnchorBytes = (anchor: unknown): Buffer =>
  Buffer.from(`${canonicalJson(anchor)}\n`, "utf8");

// ---------------------------------------------------------------------------
// The Rekor witness config, derived only from an anchor

/**
 * The validated Rekor witness config an anchor pins, with the network
 * allowlist derived from the anchor's base URL. Pure: it creates no witness,
 * reads no state and is not registered in `promotionControllersFor`; the
 * caller's `stateDir` and `fetch` are left to their defaults.
 */
export function rekorWitnessOptionsFromAnchor(
  anchor: unknown,
): Omit<RekorWitnessOptions, "stateDir" | "fetch" | "readPayload" | "now"> {
  const parsed = promotionTrustAnchorSchema.safeParse(anchor);
  if (!parsed.success)
    throw new RekorWitnessError(
      "rekor-config-invalid",
      "the anchor differs from its schema",
    );
  if (parsed.data.version !== "1.1.0")
    throw new RekorWitnessError(
      "rekor-config-invalid",
      `anchor ${parsed.data.version} pins no Rekor witness`,
    );
  const { rekor, witnessId } = parsed.data;
  if (rekor.apiVersion !== REKOR_API_VERSION)
    throw new RekorWitnessError(
      "rekor-config-invalid",
      `the adapter speaks Rekor ${REKOR_API_VERSION}, not ${rekor.apiVersion}`,
    );
  const host = new URL(rekor.baseUrl).hostname;
  return Object.freeze({
    witnessId,
    baseUrl: rekor.baseUrl,
    origin: rekor.origin,
    logPublicKeyPem: rekor.logPublicKeyPem,
    issuerPublicKeyPem: rekor.issuerPublicKeyPem,
    allowedHosts: Object.freeze([host]),
  });
}

// ---------------------------------------------------------------------------
// anchor-prepare

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The exact commands that install `file` at the compiled anchor path, for
 * the owner to run. The engine prints them and never runs them.
 */
export function anchorInstallCommands(
  file: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const target = promotionTrustAnchorPath(platform);
  const group = platform === "darwin" ? "wheel" : "root";
  const digest = platform === "darwin" ? "shasum -a 256" : "sha256sum";
  return [
    `sudo install -d -o root -g ${group} -m 0755 ${shellQuote(path.dirname(target))}`,
    `sudo install -o root -g ${group} -m 0644 ${shellQuote(file)} ${shellQuote(target)}`,
    `${digest} ${shellQuote(target)}`,
  ];
}

const compiledAnchorLocations = (): string[] =>
  Object.values(PROMOTION_TRUST_ANCHOR_PATHS).flatMap((target) => [
    target,
    path.dirname(target),
  ]);

/** Refuse an output path at or inside a compiled anchor location. */
function checkOutputPath(out: string): string {
  if (!path.isAbsolute(out))
    refuse("anchor-output-invalid", "the output path must be absolute");
  const resolved = path.resolve(out);
  for (const location of compiledAnchorLocations()) {
    const relative = path.relative(location, resolved);
    if (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    )
      refuse(
        "anchor-output-invalid",
        `${resolved} is the root-owned anchor location; install it with the printed sudo command instead`,
      );
  }
  return resolved;
}

/** Create `target` with `data`, never replacing anything, via a linked temp file. */
function writeNewFile(
  target: string,
  data: Buffer,
  mode: number,
  exists: (detail: string) => never,
): void {
  if (lstatOrNull(target)) exists(`${target} already exists; not replacing it`);
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const fd = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    try {
      if (process.platform !== "win32") fchmodSync(fd, mode);
      if (writeSync(fd, data) !== data.length)
        throw new Error(`could not write ${temporary}`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // link() fails if the target appeared meanwhile, so nothing is replaced.
    try {
      linkSync(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        exists(`${target} already exists; not replacing it`);
      throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

export interface PreparedTrustAnchor {
  file: string;
  anchorSha256: string;
  anchor: RekorPromotionTrustAnchor;
  installPath: string;
  installCommands: string[];
}

/**
 * Build the anchor from the owner's public keys and this project, and write
 * it to `out` (default: the user data dir), refusing to overwrite. It never
 * writes the compiled anchor path.
 */
export async function preparePromotionTrustAnchor(options: {
  projectRoot: string;
  keyDir?: string;
  out?: string;
}): Promise<PreparedTrustAnchor> {
  const keys = readOwnerPublicKeys(options.keyDir ?? defaultOwnerKeyDir());
  const project = await loadProject(options.projectRoot);
  let repositoryIdentitySha256: string;
  try {
    repositoryIdentitySha256 = await recomputeRepositoryIdentity(
      options.projectRoot,
    );
  } catch (error) {
    if (error instanceof PromotionImportRefusalError)
      return refuse("project-identity-unavailable", error.message);
    throw error;
  }
  const anchor = buildPromotionTrustAnchor({
    projects: [{ projectId: project.projectId, repositoryIdentitySha256 }],
    keys,
  });
  let file: string;
  if (options.out === undefined) {
    const base = promotionUserDataDir();
    mkdirSync(base, { recursive: true, mode: 0o700 });
    file = checkOutputPath(path.join(base, PREPARED_ANCHOR_FILE_NAME));
  } else file = checkOutputPath(path.resolve(options.out));
  const bytes = canonicalAnchorBytes(anchor);
  writeNewFile(file, bytes, 0o600, (detail) =>
    refuse("anchor-output-exists", detail),
  );
  return {
    file,
    anchorSha256: sha256(bytes),
    anchor,
    installPath: promotionTrustAnchorPath(),
    installCommands: anchorInstallCommands(file),
  };
}

// ---------------------------------------------------------------------------
// anchor-verify

export type AnchorVerification =
  | {
      outcome: "ok";
      path: string;
      anchorSha256: string;
      anchor: RekorPromotionTrustAnchor;
      keys: OwnerPublicKeys;
    }
  | { outcome: "refused"; refusal: PromotionAnchorRefusal; detail: string };

const asRefusal = (
  error: unknown,
): { outcome: "refused"; refusal: PromotionAnchorRefusal; detail: string } => {
  if (
    error instanceof PromotionAnchorRefusalError ||
    error instanceof PromotionImportRefusalError
  ) {
    const code = promotionAnchorRefusalSchema.safeParse(error.code);
    if (code.success)
      return { outcome: "refused", refusal: code.data, detail: error.message };
  }
  throw error;
};

const pinMatches = (
  pins: readonly { publicKeySha256: string; keyId: string }[],
  key: OwnerPublicKey,
) =>
  pins.length === 1 &&
  pins[0]!.publicKeySha256 === key.publicKeySha256 &&
  pins[0]!.keyId === key.keyId;

/**
 * Read-only check of the anchor installed at the compiled path: root owner,
 * mode 0644, protected directories, schema, canonical bytes, the pinned
 * Rekor log, and one pin per role matching the local `<role>.pub.pem`. It
 * takes no anchor path: the path is compiled in.
 */
export async function verifyInstalledPromotionTrustAnchor(options: {
  keyDir?: string;
}): Promise<AnchorVerification> {
  try {
    const target = promotionTrustAnchorPath();
    const installed = await inspectPromotionTrustAnchorInstall(target);
    if (installed.uid !== 0)
      refuse("anchor-owner-mismatch", `${target} is not owned by root`);
    if (installed.mode !== 0o644)
      refuse(
        "anchor-mode-mismatch",
        `${target} has mode ${installed.mode.toString(8)}, not 644`,
      );
    const { anchor } = installed;
    if (anchor.version !== "1.1.0")
      return refuse(
        "anchor-version-unsupported",
        `anchor ${anchor.version} pins no Rekor witness or labeler key`,
      );
    const bytes = Buffer.from(installed.text, "utf8");
    if (!bytes.equals(canonicalAnchorBytes(anchor)))
      refuse("anchor-not-canonical", `${target} is not in canonical form`);
    const { rekor } = anchor;
    if (
      rekor.baseUrl !== SIGSTORE_REKOR_V1.baseUrl ||
      rekor.origin !== SIGSTORE_REKOR_V1.origin ||
      rekor.apiVersion !== SIGSTORE_REKOR_V1.apiVersion ||
      rekor.logId !== SIGSTORE_REKOR_V1.logId ||
      rekor.logPublicKeyPem !== SIGSTORE_REKOR_V1.logPublicKeyPem
    )
      refuse(
        "anchor-rekor-pin-mismatch",
        "the anchor's Rekor log differs from the pinned rekor.sigstore.dev key",
      );
    const keys = readOwnerPublicKeys(options.keyDir ?? defaultOwnerKeyDir());
    if (
      !pinMatches(anchor.approverKeys, keys.approver) ||
      !pinMatches(anchor.issuerKeys, keys.issuer) ||
      !pinMatches(anchor.labelerKeys, keys.labeler) ||
      rekor.issuerKeyId !== keys.issuer.keyId ||
      rekor.issuerPublicKeyPem !== keys.issuer.pem
    )
      refuse(
        "anchor-key-mismatch",
        "the anchor's key pins differ from the local public keys",
      );
    return {
      outcome: "ok",
      path: target,
      anchorSha256: sha256(bytes),
      anchor,
      keys,
    };
  } catch (error) {
    return asRefusal(error);
  }
}

// ---------------------------------------------------------------------------
// Enrollment

const enrollmentSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("graph-engineering-promotion-enrollment"),
    anchorSha256: digestSchema,
    witness: z
      .object({
        witnessId: z.string().min(1).max(200),
        kind: z.literal("rekor-v1"),
        baseUrl: z.string().max(300),
        logId: digestSchema,
      })
      .strict(),
    signers: z
      .object({
        approver: z
          .object({ keyId: z.string(), publicKeySha256: digestSchema })
          .strict(),
        issuer: z
          .object({ keyId: z.string(), publicKeySha256: digestSchema })
          .strict(),
        labeler: z
          .object({ keyId: z.string(), publicKeySha256: digestSchema })
          .strict(),
      })
      .strict(),
    enrolledProjects: z
      .array(
        z
          .object({
            projectId: z.string(),
            repositoryIdentitySha256: digestSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type PromotionEnrollment = z.infer<typeof enrollmentSchema>;

/** The local enrollment record: `<user data dir>/promotion-enrollment/enrollment.json`. */
export const promotionEnrollmentPath = (): string =>
  path.join(promotionUserDataDir(), ENROLLMENT_DIR_NAME, ENROLLMENT_FILE_NAME);

/** The record for a verified anchor. Pure. */
export function enrollmentRecord(
  anchor: RekorPromotionTrustAnchor,
  anchorSha256: string,
): PromotionEnrollment {
  const signer = (
    pins: readonly { keyId: string; publicKeySha256: string }[],
  ) => ({
    keyId: pins[0]!.keyId,
    publicKeySha256: pins[0]!.publicKeySha256,
  });
  return enrollmentSchema.parse({
    version: 1,
    kind: "graph-engineering-promotion-enrollment",
    anchorSha256,
    witness: {
      witnessId: anchor.witnessId,
      kind: anchor.rekor.kind,
      baseUrl: anchor.rekor.baseUrl,
      logId: anchor.rekor.logId,
    },
    signers: {
      approver: signer(anchor.approverKeys),
      issuer: signer(anchor.issuerKeys),
      labeler: signer(anchor.labelerKeys),
    },
    enrolledProjects: anchor.enrolledProjects,
  });
}

const posix = process.platform !== "win32";
function checkPrivate(target: string, stat: Stats, kind: "dir" | "file") {
  if (stat.isSymbolicLink())
    refuse("enrollment-invalid", `${target} is a symlink`);
  if (kind === "dir" ? !stat.isDirectory() : !stat.isFile())
    refuse("enrollment-invalid", `${target} is not a ${kind}`);
  if (!posix) return;
  if (stat.mode & 0o077)
    refuse(
      "enrollment-invalid",
      `${target} is accessible by group or others (mode ${(stat.mode & 0o777).toString(8)})`,
    );
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    refuse("enrollment-invalid", `${target} is owned by another user`);
}

/** The existing record's bytes, or undefined; refuses an unsafe or malformed one. */
function readEnrollment(file: string): Buffer | undefined {
  const dir = path.dirname(file);
  if (!lstatOrNull(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  checkPrivate(dir, lstatSync(dir), "dir");
  const stat = lstatOrNull(file);
  if (!stat) return undefined;
  checkPrivate(file, stat, "file");
  const bytes = readCheckedFile(file, stat, 64 * 1024, (detail) =>
    refuse("enrollment-invalid", detail),
  );
  let parsed;
  try {
    parsed = enrollmentSchema.safeParse(JSON.parse(bytes.toString("utf8")));
  } catch {
    return refuse("enrollment-invalid", `${file} is not JSON`);
  }
  if (!parsed.success) refuse("enrollment-invalid", `${file} is malformed`);
  return bytes;
}

export type EnrollmentResult =
  | {
      outcome: "enrolled" | "already-enrolled";
      file: string;
      enrollment: PromotionEnrollment;
      witnessHighWater: { logId: string; treeId: string; treeSize: string };
    }
  | { outcome: "refused"; refusal: PromotionAnchorRefusal; detail: string };

/**
 * Enroll the installed, verified anchor: record its witness and signer
 * fingerprints in a 0600 file under the user data dir, and initialise the
 * Rekor high-water mark by verifying the log's current signed tree head
 * against the anchor's pinned key (one read-only request to the anchor's
 * Rekor host). Re-running with the same anchor is a no-op apart from
 * advancing the mark; a different anchor is refused as a conflict.
 */
export async function enrollPromotionTrustAnchor(options: {
  keyDir?: string;
}): Promise<EnrollmentResult> {
  const verified = await verifyInstalledPromotionTrustAnchor(options);
  if (verified.outcome === "refused") return verified;
  try {
    const record = enrollmentRecord(verified.anchor, verified.anchorSha256);
    const bytes = canonicalAnchorBytes(record);
    const file = promotionEnrollmentPath();
    const existing = readEnrollment(file);
    if (existing && !existing.equals(bytes))
      refuse(
        "enrollment-conflict",
        `${file} records another anchor; remove it yourself only if you mean to re-enroll`,
      );
    let head;
    try {
      head = await createRekorWitness(
        rekorWitnessOptionsFromAnchor(verified.anchor),
      ).verifyTreeHead();
    } catch (error) {
      if (error instanceof RekorWitnessError)
        return refuse("witness-state-init-failed", error.message);
      throw error;
    }
    if (!existing)
      writeNewFile(file, bytes, 0o600, (detail) =>
        refuse("enrollment-conflict", detail),
      );
    return {
      outcome: existing ? "already-enrolled" : "enrolled",
      file,
      enrollment: record,
      witnessHighWater: {
        logId: verified.anchor.rekor.logId,
        treeId: head.treeId,
        treeSize: head.treeSize.toString(),
      },
    };
  } catch (error) {
    return asRefusal(error);
  }
}
