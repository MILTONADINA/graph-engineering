// Tests for the owner's promotion key helper. Every key here is made in a
// temporary directory passed explicitly (`--key-dir` or a function
// argument); nothing reads or writes the owner's key directory. The CLI is
// only spawned to check help and its refusals, and passphrases reach the
// key functions as Buffers in-process, never through the environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  pbkdf2Sync,
  verify,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKUP_FORMAT,
  EXIT,
  KEY_FORMAT,
  backupKey,
  characterCount,
  checkNewPassphrase,
  createKey,
  defaultKeyDir,
  describeSigning,
  keyPaths,
  openBackup,
  openKey,
  readPublicKey,
  requireInteractiveOwner,
  restoreKey,
  signBytes,
  signFile,
} from "./promotion-key.mjs";

const script = fileURLToPath(new URL("./promotion-key.mjs", import.meta.url));
const root = path.dirname(path.dirname(script));
const posix = process.platform !== "win32";
const work = mkdtempSync(path.join(os.tmpdir(), "promotion-key-test-"));
test.after(() => rmSync(work, { recursive: true, force: true }));

let counter = 0;
const freshDir = () => path.join(work, `keys-${++counter}`);
const pass = (text) => Buffer.from(text, "utf8");
const KEY_PASS = "correct horse battery staple";
const BACKUP_PASS = "a different backup passphrase";

function cli(args, env = {}) {
  const base = { ...process.env };
  delete base.CI;
  return spawnSync(process.execPath, [script, ...args], {
    env: { ...base, ...env },
    stdio: "pipe",
    encoding: "utf8",
    timeout: 60_000,
  });
}

function engineFingerprint(key) {
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
}

test("promotion-key uses a per-user data directory by default", () => {
  assert.equal(
    defaultKeyDir("darwin", {}, "/Users/o"),
    path.join(
      "/Users/o",
      "Library",
      "Application Support",
      "graph-engineering",
      "promotion-keys",
    ),
  );
  assert.equal(
    defaultKeyDir("linux", { XDG_DATA_HOME: "/data" }, "/home/o"),
    path.join("/data", "graph-engineering", "promotion-keys"),
  );
  assert.equal(
    defaultKeyDir("linux", { XDG_DATA_HOME: "relative" }, "/home/o"),
    path.join(
      "/home/o",
      ".local",
      "share",
      "graph-engineering",
      "promotion-keys",
    ),
  );
});

test("promotion-key is not reachable from the engine, MCP server or dashboard", () => {
  const listed = spawnSync(
    "git",
    ["grep", "-l", "-e", "promotion-key", "--", "packages"],
    { encoding: "utf8", cwd: root },
  );
  assert.equal(listed.status, 1, listed.stderr || listed.stdout);
});

test("promotion-key help lists the owner commands and rejects unknown ones", () => {
  const help = cli(["--help"]);
  assert.equal(help.status, 0);
  for (const command of ["create", "public", "sign", "backup", "restore"])
    assert.match(help.stdout, new RegExp(`^\\s+${command} <role>`, "m"));
  const unknown = cli(["export", "approver"]);
  assert.equal(unknown.status, EXIT.usage);
  assert.match(unknown.stderr, /unknown command export/);
  const role = cli(["sign", "admin", "file", "--key-dir", freshDir()]);
  assert.equal(role.status, EXIT.usage);
  assert.match(role.stderr, /unknown role admin/);
});

test("promotion-key refuses under CI first and without a terminal, before touching keys", () => {
  const keyDir = freshDir();
  const message = path.join(work, "message.bin");
  writeFileSync(message, "bytes to sign");
  const out = path.join(work, "never.json");
  for (const args of [
    ["create", "labeler"],
    ["sign", "approver", message],
    ["backup", "issuer", out],
    ["restore", "labeler", out],
  ]) {
    const piped = cli([...args, "--key-dir", keyDir]);
    assert.equal(
      piped.status,
      EXIT.noTerminal,
      `${args[0]} without a terminal`,
    );
    assert.match(piped.stderr, /must be an interactive terminal/);
    assert.equal(piped.stdout, "");
    const ci = cli([...args, "--key-dir", keyDir], { CI: "" });
    assert.equal(ci.status, EXIT.ci, `${args[0]} under CI`);
    assert.match(ci.stderr, /CI is set/);
    assert.equal(ci.stdout, "");
  }
  assert.equal(existsSync(keyDir), false);
  assert.equal(existsSync(out), false);
  assert.throws(() => requireInteractiveOwner({ CI: "1" }, true, true), {
    code: EXIT.ci,
  });
  assert.throws(() => requireInteractiveOwner({ CI: "1" }, false, false), {
    code: EXIT.ci,
  });
  assert.throws(() => requireInteractiveOwner({}, true, false), {
    code: EXIT.noTerminal,
  });
  assert.doesNotThrow(() => requireInteractiveOwner({}, true, true));
});

test("promotion-key signature verifies in Node as Ed25519 with the engine fingerprint", () => {
  const keyDir = freshDir();
  const made = createKey(keyDir, "approver", pass(KEY_PASS));
  assert.equal(made.asymmetricKeyType, "ed25519");
  const { key, pub } = keyPaths(keyDir, "approver");
  if (posix) {
    assert.equal(statSync(keyDir).mode & 0o777, 0o700);
    assert.equal(statSync(key).mode & 0o777, 0o600);
    assert.equal(statSync(pub).mode & 0o777, 0o600);
  }
  const envelope = JSON.parse(readFileSync(key, "utf8"));
  assert.equal(envelope.format, KEY_FORMAT);
  assert.equal(envelope.version, 1);
  assert.equal(envelope.role, "approver");
  assert.ok(envelope.iterations >= 1_000_000);
  assert.equal(envelope.publicKeySha256, engineFingerprint(made));

  const publicCli = cli(["public", "approver", "--key-dir", keyDir]);
  assert.equal(publicCli.status, 0, publicCli.stderr);
  assert.ok(publicCli.stdout.startsWith(readFileSync(pub, "utf8")));
  assert.match(publicCli.stdout, new RegExp(engineFingerprint(made)));

  const bytes = Buffer.from('{"claim":"promotion-approval","n":1}\n');
  const shown = describeSigning("approver", bytes);
  assert.equal(shown.sha256, createHash("sha256").update(bytes).digest("hex"));
  const signature = signFile(keyDir, "approver", bytes, pass(KEY_PASS));
  const publicKey = createPublicKey(readFileSync(pub));
  assert.equal(publicKey.asymmetricKeyType, "ed25519");
  assert.equal(verify(null, bytes, publicKey, signature), true);
  assert.equal(
    verify(
      null,
      Buffer.concat([bytes, Buffer.from(" ")]),
      publicKey,
      signature,
    ),
    false,
  );
  assert.equal(readPublicKey(keyDir, "approver").equals(publicKey), true);

  assert.throws(
    () => signFile(keyDir, "approver", bytes, pass("not the passphrase")),
    /wrong passphrase/,
  );
  assert.throws(() => createKey(keyDir, "approver", pass(KEY_PASS)), {
    code: EXIT.refused,
  });
  assert.throws(
    () => signFile(keyDir, "issuer", bytes, pass(KEY_PASS)),
    /no issuer key/,
  );
});

test("promotion-key zeroes key bytes and requires a checked new passphrase", () => {
  const keyDir = freshDir();
  createKey(keyDir, "labeler", pass(KEY_PASS));
  const { key, pub } = keyPaths(keyDir, "labeler");
  const pkcs8 = openKey(readFileSync(key), {
    role: "labeler",
    passphrase: pass(KEY_PASS),
  });
  signBytes(pkcs8, Buffer.from("x"), readFileSync(pub, "utf8"));
  assert.ok(pkcs8.every((byte) => byte === 0));
  assert.throws(
    () =>
      openKey(readFileSync(key), {
        role: "approver",
        passphrase: pass(KEY_PASS),
      }),
    /another role/,
  );

  assert.throws(
    () => checkNewPassphrase(pass("eleven char"), pass("eleven char")),
    /at least 12/,
  );
  assert.throws(
    () => checkNewPassphrase(pass(KEY_PASS), pass(`${KEY_PASS}!`)),
    /differ/,
  );
  assert.doesNotThrow(() => checkNewPassphrase(pass(KEY_PASS), pass(KEY_PASS)));
  assert.equal(characterCount(pass("pässwörd✓")), 9);
});

test(
  "promotion-key refuses group- or world-readable and symlinked key files",
  { skip: !posix && "Windows has no POSIX modes or unprivileged symlinks" },
  () => {
    const keyDir = freshDir();
    createKey(keyDir, "issuer", pass(KEY_PASS));
    const { key } = keyPaths(keyDir, "issuer");
    const bytes = Buffer.from("x");
    chmodSync(key, 0o640);
    assert.throws(() => signFile(keyDir, "issuer", bytes, pass(KEY_PASS)), {
      code: EXIT.refused,
    });
    chmodSync(key, 0o600);
    chmodSync(keyDir, 0o755);
    assert.throws(() => signFile(keyDir, "issuer", bytes, pass(KEY_PASS)), {
      code: EXIT.refused,
    });
    chmodSync(keyDir, 0o700);
    assert.ok(signFile(keyDir, "issuer", bytes, pass(KEY_PASS)).length === 64);

    const linked = freshDir();
    symlinkSync(keyDir, linked);
    assert.throws(() => readPublicKey(linked, "issuer"), /symlink/);
    const other = freshDir();
    createKey(other, "approver", pass(KEY_PASS));
    const target = keyPaths(other, "approver").key;
    rmSync(target);
    symlinkSync(key, target);
    assert.throws(
      () => signFile(other, "approver", bytes, pass(KEY_PASS)),
      /symlink/,
    );
  },
);

test("promotion-key backup re-encrypts, decrypts independently in Node and restores", () => {
  const keyDir = freshDir();
  const made = createKey(keyDir, "issuer", pass(KEY_PASS));
  const out = path.join(work, "issuer.backup.json");
  assert.throws(
    () => backupKey(keyDir, "issuer", out, pass(KEY_PASS), pass(KEY_PASS)),
    /different from the key passphrase/,
  );
  assert.throws(
    () =>
      backupKey(
        keyDir,
        "issuer",
        out,
        pass("wrong passphrase!"),
        pass(BACKUP_PASS),
      ),
    /wrong passphrase/,
  );
  assert.equal(existsSync(out), false);
  backupKey(keyDir, "issuer", out, pass(KEY_PASS), pass(BACKUP_PASS));
  if (posix) assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.throws(
    () => backupKey(keyDir, "issuer", out, pass(KEY_PASS), pass(BACKUP_PASS)),
    { code: EXIT.refused },
  );

  const envelope = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(envelope.format, BACKUP_FORMAT);
  assert.equal(envelope.kdf, "PBKDF2-HMAC-SHA256");
  assert.equal(envelope.cipher, "AES-256-GCM");
  assert.ok(envelope.iterations >= 600_000);
  const derived = pbkdf2Sync(
    BACKUP_PASS,
    Buffer.from(envelope.salt, "base64"),
    envelope.iterations,
    32,
    "sha256",
  );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    derived,
    Buffer.from(envelope.nonce, "base64"),
  );
  decipher.setAAD(
    Buffer.from(`${BACKUP_FORMAT}:v1:issuer:${envelope.publicKeySha256}`),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const pkcs8 = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  const independent = createPublicKey(
    createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }),
  );
  assert.equal(engineFingerprint(independent), engineFingerprint(made));

  // A backup is not a key file, and a key file is not a backup.
  assert.throws(
    () =>
      openKey(readFileSync(out), {
        role: "issuer",
        passphrase: pass(BACKUP_PASS),
      }),
    /not a version 1/,
  );
  assert.throws(
    () => openBackup(out, "issuer", pass(KEY_PASS)),
    /wrong passphrase/,
  );
  assert.throws(
    () => openBackup(out, "approver", pass(BACKUP_PASS)),
    /another role/,
  );
  assert.throws(
    () =>
      restoreKey(
        keyDir,
        "issuer",
        openBackup(out, "issuer", pass(BACKUP_PASS)),
        pass(KEY_PASS),
      ),
    { code: EXIT.refused },
  );

  const newDir = freshDir();
  const restored = restoreKey(
    newDir,
    "issuer",
    openBackup(out, "issuer", pass(BACKUP_PASS)),
    pass("a new key passphrase"),
  );
  assert.equal(engineFingerprint(restored), engineFingerprint(made));
  const bytes = Buffer.from("after restore");
  const signature = signFile(
    newDir,
    "issuer",
    bytes,
    pass("a new key passphrase"),
  );
  assert.equal(verify(null, bytes, made, signature), true);
});
