// Read-only reader for the D3 local trust anchor
// (docs/promotion-trust-boundary.md, decision 1, option A; owner decision in
// specs/decisions/promotion-custody.md): a root-owned file at a path compiled
// into the engine, written by the owner with sudo after checking its pins out
// of band. The engine never creates, repairs or writes it, and no environment
// variable, flag, setting or data-dir file can point elsewhere.
import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  MODEL_IDENTITY_ATTESTORS,
  SIGNER_CUSTODIES,
  WITNESS_CONTROLLERS,
} from "./promotion-controllers.js";
import { PromotionImportRefusalError } from "./promotion-refusal-codes.js";
import { digestSchema, parseBoundedJson } from "./sealed-collection-schema.js";

/** Compiled anchor locations. Other platforms are refused. */
export const PROMOTION_TRUST_ANCHOR_PATHS = Object.freeze({
  darwin:
    "/Library/Application Support/GraphEngineering/promotion-trust-anchor.json",
  linux: "/etc/graph-engineering/promotion-trust-anchor.json",
});
const MAX_ANCHOR_BYTES = 256 * 1024;
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const registryName = <T extends Readonly<Record<string, unknown>>>(
  registry: T,
) =>
  z
    .string()
    .refine((value) => Object.hasOwn(registry, value))
    .transform((value) => value as keyof T & string);

const keyPins = <K extends string>(actor: K) =>
  z
    .array(
      z
        .object({
          [actor]: name,
          keyId: name,
          publicKeySha256: digestSchema,
        } as Record<K | "keyId" | "publicKeySha256", typeof name>)
        .strict(),
    )
    .min(1)
    .max(20);
const anchorCommon = {
  kind: z.literal("graph-engineering-promotion-trust-anchor"),
  enrolledProjects: z
    .array(
      z
        .object({
          projectId: name,
          repositoryIdentitySha256: digestSchema,
        })
        .strict(),
    )
    .min(1)
    .max(100),
  approverKeys: keyPins("operatorId"),
  issuerKeys: keyPins("issuerId"),
  witnessId: name,
  controllers: z
    .object({
      witness: registryName(WITNESS_CONTROLLERS),
      custody: registryName(SIGNER_CUSTODIES),
      modelIdentity: registryName(MODEL_IDENTITY_ATTESTORS),
    })
    .strict(),
};

const MAX_PEM_CHARACTERS = 1_024;
/** SHA-256 of a public key's SPKI DER, the fingerprint every pin uses. */
const spkiSha256 = (key: KeyObject): string =>
  createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
/** The key, when `pem` is exactly the canonical SPKI PEM of one public key. */
function canonicalPublicKey(pem: string): KeyObject | undefined {
  try {
    const key = createPublicKey(pem);
    return key.export({ type: "spki", format: "pem" }).toString() === pem
      ? key
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Rekor v1 witness pins (docs/promotion-rekor-witness.md): the log's
 * ECDSA P-256 key and ID, its API origin, and the owner's Ed25519 issuer key
 * that signs every statement. Every cross-field rule is checked here, so an
 * anchor that parses always yields a config the adapter accepts.
 */
const rekorPinsSchema = z
  .object({
    kind: z.literal("rekor-v1"),
    apiVersion: z.literal("v1"),
    baseUrl: z.string().regex(/^https:\/\/[a-z0-9.-]{1,253}$/),
    origin: z.string().regex(/^[a-z0-9.-]{1,253}$/),
    logId: digestSchema,
    logPublicKeyPem: z.string().max(MAX_PEM_CHARACTERS),
    issuerKeyId: name,
    issuerPublicKeyPem: z.string().max(MAX_PEM_CHARACTERS),
  })
  .strict();

const anchorV1_1 = z
  .object({
    version: z.literal("1.1.0"),
    ...anchorCommon,
    labelerKeys: keyPins("labelerId"),
    rekor: rekorPinsSchema,
  })
  .strict()
  .superRefine((anchor, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message, path: ["rekor"] });
    const { rekor } = anchor;
    if (new URL(rekor.baseUrl).hostname !== rekor.origin)
      issue("the Rekor base URL host differs from its origin");
    const logKey = canonicalPublicKey(rekor.logPublicKeyPem);
    if (
      !logKey ||
      logKey.asymmetricKeyType !== "ec" ||
      logKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    )
      issue("the Rekor log key is not a canonical ECDSA P-256 PEM");
    else if (spkiSha256(logKey) !== rekor.logId)
      issue("the Rekor log ID is not the SHA-256 of its key");
    const issuerKey = canonicalPublicKey(rekor.issuerPublicKeyPem);
    const pins = anchor.issuerKeys.filter(
      (pin) => pin.keyId === rekor.issuerKeyId,
    );
    if (!issuerKey || issuerKey.asymmetricKeyType !== "ed25519")
      issue("the issuer key is not a canonical Ed25519 PEM");
    else if (
      pins.length !== 1 ||
      pins[0]!.publicKeySha256 !== spkiSha256(issuerKey)
    )
      issue("the issuer key is not the one issuer pin it names");
  });

/**
 * Anchor versions: 1.0.0 (PR-3, no witness pins) and 1.1.0 (PR-4, adds the
 * labeler pins and the Rekor witness pins). Both are strict, and either way
 * the controllers can only be the "none" entries of the closed registries.
 */
export const promotionTrustAnchorSchema = z.union([
  z.object({ version: z.literal("1.0.0"), ...anchorCommon }).strict(),
  anchorV1_1,
]);
export type PromotionTrustAnchor = z.infer<typeof promotionTrustAnchorSchema>;
export type RekorPromotionTrustAnchor = z.infer<typeof anchorV1_1>;

const refuse = (
  code:
    | "trust-anchor-platform-unsupported"
    | "trust-anchor-absent"
    | "trust-anchor-unprotected"
    | "trust-anchor-invalid",
  detail: string,
): never => {
  throw new PromotionImportRefusalError(code, detail);
};

/** The compiled anchor path for this platform, or a refusal. */
export function promotionTrustAnchorPath(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "darwin" && platform !== "linux")
    return refuse(
      "trust-anchor-platform-unsupported",
      `no compiled trust-anchor path for ${platform}`,
    );
  return PROMOTION_TRUST_ANCHOR_PATHS[platform];
}

const protectedEntry = (
  info: { uid: number; mode: number },
  directory: boolean,
) =>
  info.uid === 0 &&
  (info.mode & 0o022) === 0 &&
  // A sticky world-writable directory still lets others create entries.
  (!directory || (info.mode & 0o002) === 0);

/**
 * Inspect one anchor file, read-only. It must be a regular, non-symlinked,
 * root-owned file that neither group nor others can write, reached through
 * root-owned directories that are not group- or world-writable. The importer
 * only ever passes the compiled path; tests pass files they cannot make
 * root-owned, which therefore refuse.
 */
export async function inspectPromotionTrustAnchorFile(
  filename: string,
  platform: NodeJS.Platform = process.platform,
): Promise<PromotionTrustAnchor> {
  return (await inspectPromotionTrustAnchorInstall(filename, platform)).anchor;
}

/** What the installed anchor holds and how it is installed. */
export interface InstalledPromotionTrustAnchor {
  anchor: PromotionTrustAnchor;
  /** The exact bytes read, as UTF-8. */
  text: string;
  uid: number;
  /** Permission bits of the opened file, e.g. 0o644. */
  mode: number;
}

/**
 * The same read-only inspection as `inspectPromotionTrustAnchorFile`, also
 * returning the bytes, owner and mode, so `anchor-verify` can check the
 * installed form. It refuses exactly what that function refuses.
 */
export async function inspectPromotionTrustAnchorInstall(
  filename: string,
  platform: NodeJS.Platform = process.platform,
): Promise<InstalledPromotionTrustAnchor> {
  if (platform !== "darwin" && platform !== "linux")
    return refuse(
      "trust-anchor-platform-unsupported",
      `trust anchors are not supported on ${platform}`,
    );
  if (!path.isAbsolute(filename) || path.normalize(filename) !== filename)
    return refuse("trust-anchor-invalid", "anchor path is not canonical");
  let info;
  try {
    info = await lstat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return refuse("trust-anchor-absent", "no trust anchor is installed");
    return refuse("trust-anchor-unprotected", "trust anchor is unreadable");
  }
  if (info.isSymbolicLink() || !info.isFile())
    return refuse("trust-anchor-unprotected", "anchor is not a regular file");
  if (!protectedEntry(info, false))
    return refuse(
      "trust-anchor-unprotected",
      "anchor is not root-owned or is writable by group or others",
    );
  if (info.size > MAX_ANCHOR_BYTES)
    return refuse("trust-anchor-invalid", "anchor exceeds its byte limit");
  // Every directory on the way must be root-owned, not writable by others,
  // and reached without a symlink.
  let resolved: string;
  try {
    resolved = await realpath(filename);
  } catch {
    return refuse("trust-anchor-unprotected", "anchor path cannot be resolved");
  }
  if (resolved !== filename)
    return refuse("trust-anchor-unprotected", "anchor path contains a symlink");
  for (
    let directory = path.dirname(filename);
    ;
    directory = path.dirname(directory)
  ) {
    const parent = await lstat(directory).catch(() => undefined);
    if (!parent?.isDirectory() || !protectedEntry(parent, true))
      return refuse(
        "trust-anchor-unprotected",
        `anchor directory ${directory} is not root-owned and protected`,
      );
    if (path.dirname(directory) === directory) break;
  }
  let text: string;
  let uid: number;
  let mode: number;
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() =>
    refuse("trust-anchor-unprotected", "anchor cannot be opened safely"),
  );
  try {
    const opened = await handle.stat();
    if (
      opened.ino !== info.ino ||
      opened.dev !== info.dev ||
      !opened.isFile() ||
      !protectedEntry(opened, false) ||
      opened.size > MAX_ANCHOR_BYTES
    )
      return refuse("trust-anchor-unprotected", "anchor changed while opening");
    uid = opened.uid;
    mode = opened.mode & 0o7777;
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  if (Buffer.byteLength(text) > MAX_ANCHOR_BYTES)
    return refuse("trust-anchor-invalid", "anchor exceeds its byte limit");
  let value: unknown;
  try {
    value = parseBoundedJson(text);
  } catch {
    return refuse("trust-anchor-invalid", "anchor is not bounded JSON");
  }
  const anchor = promotionTrustAnchorSchema.safeParse(value);
  if (!anchor.success)
    return refuse("trust-anchor-invalid", "anchor differs from its schema");
  return { anchor: anchor.data, text, uid, mode };
}

/** Read the anchor at the compiled path for this platform. Never writes it. */
export async function readPromotionTrustAnchor(): Promise<PromotionTrustAnchor> {
  return inspectPromotionTrustAnchorFile(promotionTrustAnchorPath());
}
