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
  BACKUP_SET_FORMAT,
  KeyError,
  askNewPassphrase,
  defaultBackupPath,
  backupEntries,
  ensureKeyDir,
  restoreAll,
  setupKeys,
  storeEnvelopes,
  verifyBackup,
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
  for (const command of ["setup", "restore-all", "verify-backup"])
    assert.match(help.stdout, new RegExp(`^\\s+${command} `, "m"));
  for (const command of ["setup", "restore-all", "verify-backup"])
    assert.match(help.stdout, new RegExp(`^\\s+${command} `, "m"));
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
    ["setup"],
    ["setup", out],
    ["restore-all", out],
    ["verify-backup", out],
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

function roleFiles(keyDir) {
  return ["approver", "issuer", "labeler"].flatMap((role) =>
    Object.values(keyPaths(keyDir, role)).filter((file) => existsSync(file)),
  );
}

test("promotion-key setup makes three distinct keys under one passphrase and one backup that restore-all restores", () => {
  const keyDir = freshDir();
  const out = path.join(work, "set.backup.json");
  const made = setupKeys(keyDir, out, pass(KEY_PASS));
  const prints = ["approver", "issuer", "labeler"].map((role) =>
    engineFingerprint(made[role]),
  );
  assert.equal(new Set(prints).size, 3);
  if (posix) assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.equal(
    defaultBackupPath("/home/o"),
    path.join("/home/o", "graph-engineering-keys.backup.json"),
  );

  // The backup bundles the stored key envelopes unchanged, each with its
  // own salt and nonce.
  const set = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(set.format, BACKUP_SET_FORMAT);
  assert.equal(set.version, 1);
  const salts = new Set();
  for (const role of ["approver", "issuer", "labeler"]) {
    const stored = JSON.parse(readFileSync(keyPaths(keyDir, role).key, "utf8"));
    assert.deepEqual(set.keys[role], stored);
    assert.equal(stored.format, KEY_FORMAT);
    salts.add(stored.salt).add(stored.nonce);
    const bytes = Buffer.from(`as ${role}`);
    const signature = signFile(keyDir, role, bytes, pass(KEY_PASS));
    assert.equal(verify(null, bytes, made[role], signature), true);
  }
  assert.equal(salts.size, 6);

  const restoredDir = freshDir();
  assert.throws(
    () => restoreAll(restoredDir, out, pass("not the passphrase")),
    /wrong passphrase/,
  );
  assert.deepEqual(roleFiles(restoredDir), []);
  const restored = restoreAll(restoredDir, out, pass(KEY_PASS));
  for (const role of ["approver", "issuer", "labeler"]) {
    assert.equal(
      engineFingerprint(restored[role]),
      engineFingerprint(made[role]),
    );
    assert.equal(
      readFileSync(keyPaths(restoredDir, role).pub, "utf8"),
      readFileSync(keyPaths(keyDir, role).pub, "utf8"),
    );
    const bytes = Buffer.from(`restored ${role}`);
    assert.equal(
      verify(
        null,
        bytes,
        made[role],
        signFile(restoredDir, role, bytes, pass(KEY_PASS)),
      ),
      true,
    );
  }
  if (posix) {
    assert.equal(
      statSync(keyPaths(restoredDir, "issuer").key).mode & 0o777,
      0o600,
    );
    assert.equal(statSync(restoredDir).mode & 0o777, 0o700);
  }

  // One role can also come back from the combined backup.
  const single = freshDir();
  restoreKey(
    single,
    "labeler",
    openBackup(out, "labeler", pass(KEY_PASS)),
    pass("another key passphrase"),
  );
  assert.equal(
    engineFingerprint(readPublicKey(single, "labeler")),
    engineFingerprint(made.labeler),
  );
});

test("promotion-key verify-backup reports OK and names a mismatched role", () => {
  const keyDir = freshDir();
  const out = path.join(work, "verify.backup.json");
  setupKeys(keyDir, out, pass(KEY_PASS));
  const before = roleFiles(keyDir).map((file) => readFileSync(file));
  const good = verifyBackup(keyDir, out, pass(KEY_PASS));
  assert.equal(good.ok, true);
  assert.deepEqual(
    good.results.map((result) => result.role),
    ["approver", "issuer", "labeler"],
  );
  assert.throws(
    () => verifyBackup(keyDir, out, pass("not the passphrase")),
    /wrong passphrase/,
  );

  // Replace the stored issuer public key with another key's.
  const other = freshDir();
  createKey(other, "issuer", pass(KEY_PASS));
  const { pub } = keyPaths(keyDir, "issuer");
  rmSync(pub);
  writeFileSync(pub, readFileSync(keyPaths(other, "issuer").pub), {
    mode: 0o600,
  });
  const bad = verifyBackup(keyDir, out, pass(KEY_PASS));
  assert.equal(bad.ok, false);
  assert.deepEqual(
    bad.results.filter((result) => !result.ok).map((result) => result.role),
    ["issuer"],
  );
  // Writes nothing: the other files are unchanged and no file was added.
  const after = roleFiles(keyDir);
  assert.equal(after.length, before.length);
  assert.deepEqual(readFileSync(keyPaths(keyDir, "approver").key), before[0]);
});

test("promotion-key setup removes the keys it created when it fails midway", () => {
  const keyDir = freshDir();
  const out = path.join(work, "missing-dir", "set.backup.json");
  assert.throws(() => setupKeys(keyDir, out, pass(KEY_PASS)));
  assert.deepEqual(roleFiles(keyDir), []);
  assert.equal(existsSync(out), false);
  // A re-run starts clean.
  const retry = path.join(work, "retry.backup.json");
  const made = setupKeys(keyDir, retry, pass(KEY_PASS));
  assert.equal(roleFiles(keyDir).length, 6);
  assert.equal(verifyBackup(keyDir, retry, pass(KEY_PASS)).ok, true);
  assert.equal(Object.keys(made).length, 3);
});

test("promotion-key setup cleanup leaves a public key file it did not create", () => {
  // The source keys: envelopes as a combined backup holds them.
  const source = freshDir();
  const out = path.join(work, "race-source.backup.json");
  setupKeys(source, out, pass(KEY_PASS));
  const entries = backupEntries(readFileSync(out));
  const envelopes = Object.fromEntries(
    ["approver", "issuer", "labeler"].map((role) => [
      role,
      entries[role].bytes,
    ]),
  );
  const publicKeys = Object.fromEntries(
    ["approver", "issuer", "labeler"].map((role) => [
      role,
      readPublicKey(source, role),
    ]),
  );
  // issuer.pub.pem appears after the existence check (a concurrent run),
  // so this call's write of it fails with EEXIST.
  const keyDir = freshDir();
  ensureKeyDir(keyDir);
  const racing = keyPaths(keyDir, "issuer").pub;
  const theirs = Buffer.from("written by another run\n");
  writeFileSync(racing, theirs, { mode: 0o600 });
  assert.throws(() => storeEnvelopes(keyDir, envelopes, publicKeys), {
    code: EXIT.refused,
  });
  // The other run's file is untouched; everything this call wrote is gone.
  assert.deepEqual(readFileSync(racing), theirs);
  assert.deepEqual(roleFiles(keyDir), [racing]);
});

test("promotion-key setup and restore-all refuse when any role or the backup exists", () => {
  const keyDir = freshDir();
  createKey(keyDir, "approver", pass(KEY_PASS));
  const existing = roleFiles(keyDir).map((file) => [file, readFileSync(file)]);
  const out = path.join(work, "refused.backup.json");
  assert.throws(() => setupKeys(keyDir, out, pass(KEY_PASS)), {
    code: EXIT.refused,
  });
  assert.equal(existsSync(out), false);
  assert.deepEqual(
    roleFiles(keyDir),
    existing.map(([file]) => file),
  );
  for (const [file, bytes] of existing)
    assert.deepEqual(readFileSync(file), bytes);

  const full = freshDir();
  const backup = path.join(work, "exists.backup.json");
  setupKeys(full, backup, pass(KEY_PASS));
  const kept = readFileSync(backup);
  assert.throws(() => setupKeys(freshDir(), backup, pass(KEY_PASS)), {
    code: EXIT.refused,
  });
  assert.deepEqual(readFileSync(backup), kept);
  assert.throws(() => restoreAll(keyDir, backup, pass(KEY_PASS)), {
    code: EXIT.refused,
  });
  assert.deepEqual(
    roleFiles(keyDir),
    existing.map(([file]) => file),
  );
  // A single-role backup is not a combined backup.
  const single = path.join(work, "single.backup.json");
  backupKey(full, "issuer", single, pass(KEY_PASS), pass(BACKUP_PASS));
  assert.throws(
    () => restoreAll(freshDir(), single, pass(BACKUP_PASS)),
    /combined backup/,
  );
});

test("promotion-key re-asks a mismatched or short new passphrase up to three times", async () => {
  const reader = (answers) => {
    const queue = answers.map(pass);
    return async () => queue.shift();
  };
  const told = [];
  const tell = (message) => told.push(message);
  const good = await askNewPassphrase(
    reader([
      "one passphrase!!",
      "another phrase!!",
      "short",
      "short",
      KEY_PASS,
      KEY_PASS,
    ]),
    "key",
    { tell },
  );
  assert.equal(good.toString(), KEY_PASS);
  assert.equal(told.length, 2);
  assert.match(told[0], /differ.*2 tries left/);
  assert.match(told[1], /at least 12.*1 try left/);
  await assert.rejects(
    askNewPassphrase(reader(["a", "b", "c", "d", "e", "f"]), "key", { tell }),
    /at least 12|differ/,
  );
  const cancelling = async () => {
    throw new KeyError("cancelled", 130);
  };
  await assert.rejects(askNewPassphrase(cancelling, "key", { tell }), {
    code: 130,
  });
});
