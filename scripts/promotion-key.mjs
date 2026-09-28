#!/usr/bin/env node
// The owner's promotion key helper:
//   npm run promotion-key -- <command> [arguments] [--key-dir <dir>]
// Keeps one Ed25519 key per role (approver, issuer, labeler) in a
// passphrase-encrypted file, and signs inside this process after the owner
// types that key's passphrase at the terminal. Nothing in the graph engine,
// its MCP server, the dashboard or a managed run calls this; see
// docs/promotion-keys.md.
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  pbkdf2Sync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROLES = Object.freeze(["approver", "issuer", "labeler"]);
export const KEY_FORMAT = "graph-engineering.promotion-key";
export const BACKUP_FORMAT = "graph-engineering.promotion-key-backup";
export const ENVELOPE_VERSION = 1;
export const ITERATIONS = 1_000_000;
const MIN_ITERATIONS = 600_000;
const MAX_ITERATIONS = 10_000_000;
export const MIN_PASSPHRASE_CHARACTERS = 12;
const MAX_SIGNED_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 64 * 1024;
const MAX_PASSPHRASE_BYTES = 1024;

export const EXIT = Object.freeze({
  failure: 1,
  usage: 2,
  noTerminal: 3,
  ci: 4,
  refused: 5,
});

export class KeyError extends Error {
  constructor(message, code = EXIT.failure) {
    super(message);
    this.code = code;
  }
}

const usage = `Usage: npm run promotion-key -- <command> [arguments] [--key-dir <dir>]

Commands, in the order an owner first uses them:
  create <role>          Make a new key under a new passphrase; refuses if the role has one.
  public <role>          Print the role's public key (no passphrase).
  sign <role> <file>     Sign the file's exact bytes; prints a base64 signature.
  backup <role> <out>    Write a copy of the key under a separate backup passphrase.
  restore <role> <in>    Put a backed-up key back, under a new key passphrase.

Roles: approver, issuer, labeler.

Keys live in ${defaultKeyDir()} unless --key-dir is given.
Every command except \`public\` and \`--help\` needs an interactive terminal on
stdin and stderr, and refuses when CI is set. Never type your key passphrase
into a prompt you did not start yourself.
`;

// ---------------------------------------------------------------------------
// Paths and permissions

/** The default key directory for a platform. */
export function defaultKeyDir(
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
) {
  if (platform === "darwin")
    return path.join(
      home,
      "Library",
      "Application Support",
      "graph-engineering",
      "promotion-keys",
    );
  const data =
    env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME
      : path.join(home, ".local", "share");
  return path.join(data, "graph-engineering", "promotion-keys");
}

// Windows has no POSIX mode bits or uids; only the symlink check applies.
const posix = process.platform !== "win32";

function checkPrivate(target, stat, kind) {
  if (stat.isSymbolicLink())
    throw new KeyError(`${target} is a symlink; refusing`, EXIT.refused);
  if (kind === "dir" ? !stat.isDirectory() : !stat.isFile())
    throw new KeyError(
      `${target} is not a ${kind === "dir" ? "directory" : "regular file"}`,
      EXIT.refused,
    );
  if (!posix) return;
  if (stat.mode & 0o077)
    throw new KeyError(
      `${target} is readable or writable by group or others (mode ${(stat.mode & 0o777).toString(8)}); refusing`,
      EXIT.refused,
    );
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    throw new KeyError(
      `${target} is owned by another user; refusing`,
      EXIT.refused,
    );
}

function lstatOrNull(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Creates the key directory with mode 0700 if absent, then checks it. */
export function ensureKeyDir(keyDir) {
  if (!lstatOrNull(keyDir)) mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  checkPrivate(keyDir, lstatSync(keyDir), "dir");
}

/** Checks an existing key directory without creating it. */
export function checkKeyDir(keyDir) {
  const stat = lstatOrNull(keyDir);
  if (!stat) throw new KeyError(`there is no key directory at ${keyDir}`);
  checkPrivate(keyDir, stat, "dir");
}

export function keyPaths(keyDir, role) {
  checkRole(role);
  return {
    key: path.join(keyDir, `${role}.key.json`),
    pub: path.join(keyDir, `${role}.pub.pem`),
  };
}

function readBounded(target, limit, { private: isPrivate = false } = {}) {
  const stat = lstatOrNull(target);
  if (!stat) throw new KeyError(`${target} does not exist`);
  if (isPrivate) checkPrivate(target, stat, "file");
  else if (stat.isSymbolicLink() || !stat.isFile())
    throw new KeyError(`${target} is not a regular file`, EXIT.refused);
  if (stat.size > limit)
    throw new KeyError(`${target} is larger than ${limit} bytes`);
  return readFileSync(target);
}

/** Writes a new file with mode 0600; never overwrites or follows a link. */
export function writeNewPrivateFile(target, data) {
  let fd;
  try {
    fd = openSync(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (error.code === "EEXIST")
      throw new KeyError(
        `${target} already exists; not overwriting`,
        EXIT.refused,
      );
    throw error;
  }
  try {
    if (posix) fchmodSync(fd, 0o600);
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Keys and envelopes

export function checkRole(role) {
  if (!ROLES.includes(role))
    throw new KeyError(
      `unknown role ${role}; use approver, issuer or labeler`,
      EXIT.usage,
    );
}

/** The engine's fingerprint: SHA-256 of the SPKI DER. */
export function fingerprint(publicKey) {
  return createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
}

function ed25519Public(pem) {
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new KeyError("the public key file is not a public key");
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw new KeyError("the public key is not Ed25519");
  return key;
}

function aad(format, role, publicKeySha256) {
  return Buffer.from(
    `${format}:v${ENVELOPE_VERSION}:${role}:${publicKeySha256}`,
  );
}

/** Counts characters in UTF-8 bytes without making a string. */
export function characterCount(bytes) {
  let count = 0;
  for (const byte of bytes) if ((byte & 0xc0) !== 0x80) count++;
  return count;
}

export function checkNewPassphrase(first, second) {
  if (!first.equals(second)) throw new KeyError("the passphrases differ");
  if (characterCount(first) < MIN_PASSPHRASE_CHARACTERS)
    throw new KeyError(
      `the passphrase must be at least ${MIN_PASSPHRASE_CHARACTERS} characters`,
    );
}

/**
 * Encrypts a PKCS8 Ed25519 private key: PBKDF2-HMAC-SHA256 then AES-256-GCM,
 * with the format, version, role and public key hash as associated data.
 */
export function sealKey({ pkcs8, role, passphrase, format = KEY_FORMAT }) {
  checkRole(role);
  if (![KEY_FORMAT, BACKUP_FORMAT].includes(format))
    throw new KeyError(`unknown envelope format ${format}`);
  const privateKey = createPrivateKey({
    key: pkcs8,
    format: "der",
    type: "pkcs8",
  });
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new KeyError("only Ed25519 keys are supported");
  const publicKeySha256 = fingerprint(createPublicKey(privateKey));
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const derived = pbkdf2Sync(passphrase, salt, ITERATIONS, 32, "sha256");
  try {
    const cipher = createCipheriv("aes-256-gcm", derived, nonce);
    cipher.setAAD(aad(format, role, publicKeySha256));
    const ciphertext = Buffer.concat([cipher.update(pkcs8), cipher.final()]);
    const envelope = {
      cipher: "AES-256-GCM",
      ciphertext: ciphertext.toString("base64"),
      format,
      iterations: ITERATIONS,
      kdf: "PBKDF2-HMAC-SHA256",
      nonce: nonce.toString("base64"),
      publicKeySha256,
      role,
      salt: salt.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      version: ENVELOPE_VERSION,
    };
    return Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`);
  } finally {
    derived.fill(0);
  }
}

function base64Field(envelope, field, bytes) {
  const value = envelope[field];
  const data =
    typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
      ? Buffer.from(value, "base64")
      : null;
  if (!data || (bytes !== undefined && data.length !== bytes))
    throw new KeyError(
      `the envelope's ${field} is not valid base64 of the right size`,
    );
  return data;
}

/**
 * Decrypts an envelope and returns the PKCS8 private key bytes, after
 * checking the format, role and that the key matches the recorded hash.
 * The caller must zero the returned buffer.
 */
export function openKey(json, { role, passphrase, format = KEY_FORMAT }) {
  checkRole(role);
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(json).toString("utf8"));
  } catch {
    throw new KeyError("the key file is not JSON");
  }
  if (
    !envelope ||
    envelope.format !== format ||
    envelope.version !== ENVELOPE_VERSION ||
    envelope.kdf !== "PBKDF2-HMAC-SHA256" ||
    envelope.cipher !== "AES-256-GCM"
  )
    throw new KeyError(
      `the file is not a version ${ENVELOPE_VERSION} ${format} envelope`,
    );
  if (envelope.role !== role)
    throw new KeyError("the file is for another role");
  if (
    !Number.isInteger(envelope.iterations) ||
    envelope.iterations < MIN_ITERATIONS ||
    envelope.iterations > MAX_ITERATIONS
  )
    throw new KeyError("the envelope's iteration count is out of range");
  if (!/^[0-9a-f]{64}$/.test(envelope.publicKeySha256 ?? ""))
    throw new KeyError("the envelope has no public key hash");
  const salt = base64Field(envelope, "salt", 16);
  const nonce = base64Field(envelope, "nonce", 12);
  const tag = base64Field(envelope, "tag", 16);
  const ciphertext = base64Field(envelope, "ciphertext");
  if (ciphertext.length > 256) throw new KeyError("the envelope is too large");
  const derived = pbkdf2Sync(
    passphrase,
    salt,
    envelope.iterations,
    32,
    "sha256",
  );
  let pkcs8;
  try {
    const decipher = createDecipheriv("aes-256-gcm", derived, nonce);
    decipher.setAAD(aad(format, role, envelope.publicKeySha256));
    decipher.setAuthTag(tag);
    pkcs8 = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new KeyError("wrong passphrase, or the file was changed");
  } finally {
    derived.fill(0);
  }
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  } catch {
    pkcs8.fill(0);
    throw new KeyError("the decrypted key is not a private key");
  }
  if (
    privateKey.asymmetricKeyType !== "ed25519" ||
    fingerprint(createPublicKey(privateKey)) !== envelope.publicKeySha256
  ) {
    pkcs8.fill(0);
    throw new KeyError(
      "the decrypted key does not match the recorded public key hash",
    );
  }
  return pkcs8;
}

/**
 * Signs the exact bytes with a PKCS8 key, checks the signature against the
 * stored public key, and zeroes the key bytes. Node keeps its own copy
 * inside the KeyObject until it is garbage collected.
 */
export function signBytes(pkcs8, message, publicKeyPem) {
  try {
    const expected = ed25519Public(publicKeyPem);
    const privateKey = createPrivateKey({
      key: pkcs8,
      format: "der",
      type: "pkcs8",
    });
    if (fingerprint(createPublicKey(privateKey)) !== fingerprint(expected))
      throw new KeyError("the key does not match its public key file");
    const signature = sign(null, message, privateKey);
    if (!verify(null, message, expected, signature))
      throw new KeyError("the signature did not verify");
    return signature;
  } finally {
    pkcs8.fill(0);
  }
}

function publicPem(publicKey) {
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

// ---------------------------------------------------------------------------
// Operations on a key directory. Each takes passphrases as Buffers that the
// command layer read from the terminal, and zeroes nothing it did not make.

function refuseIfRoleExists(keyDir, role) {
  const { key, pub } = keyPaths(keyDir, role);
  if (lstatOrNull(key) || lstatOrNull(pub))
    throw new KeyError(
      `the ${role} key already exists in ${keyDir}; not replacing it`,
      EXIT.refused,
    );
}

function storeKey(keyDir, role, pkcs8, passphrase) {
  const { key, pub } = keyPaths(keyDir, role);
  const publicKey = createPublicKey(
    createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }),
  );
  writeNewPrivateFile(key, sealKey({ pkcs8, role, passphrase }));
  try {
    writeNewPrivateFile(pub, Buffer.from(publicPem(publicKey)));
  } catch (error) {
    rmSync(key, { force: true });
    throw error;
  }
  return publicKey;
}

export function createKey(keyDir, role, passphrase) {
  checkRole(role);
  ensureKeyDir(keyDir);
  refuseIfRoleExists(keyDir, role);
  const { privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  try {
    return storeKey(keyDir, role, pkcs8, passphrase);
  } finally {
    pkcs8.fill(0);
  }
}

export function readPublicKey(keyDir, role) {
  checkKeyDir(keyDir);
  const { pub } = keyPaths(keyDir, role);
  if (!lstatOrNull(pub))
    throw new KeyError(`there is no ${role} key in ${keyDir}`);
  const pem = readBounded(pub, MAX_ENVELOPE_BYTES, {
    private: true,
  }).toString();
  const key = ed25519Public(pem);
  if (publicPem(key) !== pem)
    throw new KeyError("the public key file is not canonical PEM");
  return key;
}

/** What `sign` shows before asking for the passphrase. */
export function describeSigning(role, message) {
  return {
    role,
    bytes: message.length,
    sha256: createHash("sha256").update(message).digest("hex"),
  };
}

export function readSignedFile(file) {
  return readBounded(file, MAX_SIGNED_FILE_BYTES);
}

export function signFile(keyDir, role, message, passphrase) {
  const publicKey = readPublicKey(keyDir, role);
  const { key } = keyPaths(keyDir, role);
  const pkcs8 = openKey(
    readBounded(key, MAX_ENVELOPE_BYTES, { private: true }),
    {
      role,
      passphrase,
    },
  );
  return signBytes(pkcs8, message, publicPem(publicKey));
}

export function backupKey(keyDir, role, out, keyPassphrase, backupPassphrase) {
  if (keyPassphrase.equals(backupPassphrase))
    throw new KeyError(
      "use a backup passphrase different from the key passphrase",
    );
  const publicKey = readPublicKey(keyDir, role);
  if (lstatOrNull(out))
    throw new KeyError(`${out} already exists; not overwriting`, EXIT.refused);
  const { key } = keyPaths(keyDir, role);
  const pkcs8 = openKey(
    readBounded(key, MAX_ENVELOPE_BYTES, { private: true }),
    {
      role,
      passphrase: keyPassphrase,
    },
  );
  try {
    writeNewPrivateFile(
      out,
      sealKey({
        pkcs8,
        role,
        passphrase: backupPassphrase,
        format: BACKUP_FORMAT,
      }),
    );
  } finally {
    pkcs8.fill(0);
  }
  return publicKey;
}

/** Opens a backup; the caller stores it with restoreKey. */
export function openBackup(file, role, backupPassphrase) {
  return openKey(readBounded(file, MAX_ENVELOPE_BYTES), {
    role,
    passphrase: backupPassphrase,
    format: BACKUP_FORMAT,
  });
}

export function restoreKey(keyDir, role, pkcs8, keyPassphrase) {
  try {
    ensureKeyDir(keyDir);
    refuseIfRoleExists(keyDir, role);
    return storeKey(keyDir, role, pkcs8, keyPassphrase);
  } finally {
    pkcs8.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Terminal

/** Refuses under CI (first) or without a terminal on stdin and stderr. */
export function requireInteractiveOwner(
  env = process.env,
  stdinTTY = process.stdin.isTTY,
  stderrTTY = process.stderr.isTTY,
) {
  if (Object.hasOwn(env, "CI"))
    throw new KeyError(
      "refusing: CI is set; promotion keys are only used by the owner at a terminal",
      EXIT.ci,
    );
  if (!stdinTTY || !stderrTTY)
    throw new KeyError(
      "refusing: stdin and stderr must be an interactive terminal",
      EXIT.noTerminal,
    );
}

/**
 * Reads a passphrase from the terminal in raw mode with no echo, into a
 * Buffer the caller zeroes. Only called after requireInteractiveOwner.
 */
function readPassphrase(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const bytes = Buffer.alloc(MAX_PASSPHRASE_BYTES);
    let length = 0;
    process.stderr.write(prompt);
    const finish = (error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (error) {
        bytes.fill(0);
        reject(error);
      } else {
        const result = Buffer.from(bytes.subarray(0, length));
        bytes.fill(0);
        resolve(result);
      }
    };
    const onData = (chunk) => {
      try {
        for (const byte of chunk) {
          if (byte === 0x0d || byte === 0x0a) return finish();
          if (byte === 0x03) return finish(new KeyError("cancelled", 130));
          if (byte === 0x04 && length === 0)
            return finish(new KeyError("cancelled", 130));
          if (byte === 0x7f || byte === 0x08) {
            // Remove one UTF-8 character.
            while (length > 0 && (bytes[--length] & 0xc0) === 0x80);
            continue;
          }
          if (byte < 0x20) continue;
          if (length >= bytes.length)
            return finish(new KeyError("the passphrase is too long"));
          bytes[length++] = byte;
        }
      } finally {
        chunk.fill(0);
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function newPassphrase(what) {
  const first = await readPassphrase(
    `New ${what} passphrase (at least ${MIN_PASSPHRASE_CHARACTERS} characters): `,
  );
  const second = await readPassphrase(`Repeat the ${what} passphrase: `);
  try {
    checkNewPassphrase(first, second);
  } catch (error) {
    first.fill(0);
    throw error;
  } finally {
    second.fill(0);
  }
  return first;
}

// ---------------------------------------------------------------------------
// Commands

function note(message) {
  process.stderr.write(`${message}\n`);
}

function printPublic(role, publicKey) {
  process.stdout.write(publicPem(publicKey));
  process.stdout.write(
    `${role} public key SHA-256 (SPKI DER): ${fingerprint(publicKey)}\n`,
  );
}

const ARITY = { create: 1, public: 1, sign: 2, backup: 2, restore: 2 };

export function parseArguments(argv) {
  const rest = [];
  let keyDir;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--key-dir") {
      const value = argv[++index];
      if (!value || keyDir !== undefined)
        throw new KeyError("--key-dir takes one directory", EXIT.usage);
      keyDir = path.resolve(value);
    } else rest.push(argv[index]);
  }
  const [command, ...operands] = rest;
  if (["--help", "-h", "help"].includes(command)) return { command: "help" };
  if (!command || !(command in ARITY) || operands.length !== ARITY[command])
    throw new KeyError(
      command && !(command in ARITY)
        ? `unknown command ${command}\n\n${usage}`
        : usage,
      EXIT.usage,
    );
  checkRole(operands[0]);
  return {
    command,
    role: operands[0],
    path: operands[1],
    keyDir: keyDir ?? defaultKeyDir(),
  };
}

async function run(argv) {
  const { command, role, path: target, keyDir } = parseArguments(argv);
  if (command === "help") return void process.stdout.write(usage);
  if (command === "public")
    return printPublic(role, readPublicKey(keyDir, role));
  requireInteractiveOwner();
  note(
    "Never type your key passphrase into a prompt you did not start yourself.",
  );
  if (command === "create") {
    ensureKeyDir(keyDir);
    refuseIfRoleExists(keyDir, role);
    const passphrase = await newPassphrase(`${role} key`);
    try {
      printPublic(role, createKey(keyDir, role, passphrase));
    } finally {
      passphrase.fill(0);
    }
    note(`Stored in ${keyDir}. Back it up next: backup ${role} <file>.`);
  } else if (command === "sign") {
    readPublicKey(keyDir, role);
    const message = readSignedFile(target);
    const shown = describeSigning(role, message);
    note(`Signing ${target} (${shown.bytes} bytes) as the ${role}.`);
    note(`SHA-256 ${shown.sha256}`);
    const passphrase = await readPassphrase(`${role} key passphrase: `);
    let signature;
    try {
      signature = signFile(keyDir, role, message, passphrase);
    } finally {
      passphrase.fill(0);
    }
    process.stdout.write(`${signature.toString("base64")}\n`);
  } else if (command === "backup") {
    readPublicKey(keyDir, role);
    if (lstatOrNull(target))
      throw new KeyError(
        `${target} already exists; not overwriting`,
        EXIT.refused,
      );
    const keyPassphrase = await readPassphrase(`${role} key passphrase: `);
    try {
      const backupPassphrase = await newPassphrase("backup");
      try {
        backupKey(keyDir, role, target, keyPassphrase, backupPassphrase);
      } finally {
        backupPassphrase.fill(0);
      }
    } finally {
      keyPassphrase.fill(0);
    }
    note(
      `Wrote ${target} (mode 0600). Move it off this laptop and keep the backup passphrase apart from it.`,
    );
  } else if (command === "restore") {
    ensureKeyDir(keyDir);
    refuseIfRoleExists(keyDir, role);
    const backupPassphrase = await readPassphrase("Backup passphrase: ");
    let pkcs8;
    try {
      pkcs8 = openBackup(target, role, backupPassphrase);
    } finally {
      backupPassphrase.fill(0);
    }
    let keyPassphrase;
    try {
      keyPassphrase = await newPassphrase(`${role} key`);
    } catch (error) {
      pkcs8.fill(0);
      throw error;
    }
    try {
      printPublic(role, restoreKey(keyDir, role, pkcs8, keyPassphrase));
    } finally {
      keyPassphrase.fill(0);
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `promotion-key: ${error instanceof KeyError ? error.message : error.stack}\n`,
    );
    process.exitCode = error instanceof KeyError ? error.code : EXIT.failure;
  });
