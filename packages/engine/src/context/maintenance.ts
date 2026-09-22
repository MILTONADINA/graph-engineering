import { constants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ContextDatabase, CONTEXT_SCHEMA_VERSION } from "./database.js";

export async function fingerprintFile(
  path: string,
): Promise<{ sha256: string; bytes: number }> {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: digest.digest("hex"), bytes };
}

export interface BackupReceipt {
  version: 1;
  projectId: string;
  path: string;
  sha256: string;
  bytes: number;
  schemaVersion: number;
  createdAt: string;
  includes: string[];
}

export async function backupDatabase(
  db: ContextDatabase,
  projectId: string,
  dataDir: string,
  destination: string,
): Promise<BackupReceipt> {
  const parent = await realpath(dirname(resolve(destination)));
  const path = join(parent, basename(destination));
  const canonicalData = await realpath(dataDir);
  if (
    path === join(canonicalData, "context.sqlite") ||
    parent === canonicalData ||
    parent.startsWith(canonicalData + sep)
  )
    throw new Error("Backup must be outside the live data directory");
  // Reserve an exact new file. Never replace an earlier backup or a symlink.
  await writeFile(path, "", { flag: "wx", mode: 0o600 });
  await db.backup(path);
  await chmod(path, 0o600);
  const fingerprint = await fingerprintFile(path);
  const receipt: BackupReceipt = {
    version: 1,
    projectId,
    path,
    ...fingerprint,
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    includes: [
      "context.sqlite only (not runs.sqlite, models, or workspaces)",
      "memories",
      "summaries",
      "solution cache",
      "embedding vectors",
    ],
  };
  await writeFile(
    `${path}.receipt.json`,
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return receipt;
}

export async function restoreContextBackup(options: {
  backupPath: string;
  dataDir: string;
  projectId: string;
}): Promise<BackupReceipt> {
  const backupPath = resolve(options.backupPath),
    dataDir = resolve(options.dataDir);
  const info = await lstat(backupPath);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Backup must be a regular file, not a symlink");
  const receipt = JSON.parse(
    await readFile(`${backupPath}.receipt.json`, "utf8"),
  ) as BackupReceipt;
  const content = await fingerprintFile(backupPath);
  if (
    receipt.version !== 1 ||
    receipt.projectId !== options.projectId ||
    receipt.sha256 !== content.sha256 ||
    receipt.bytes !== content.bytes ||
    !Number.isInteger(receipt.schemaVersion) ||
    receipt.schemaVersion < 1 ||
    receipt.schemaVersion > CONTEXT_SCHEMA_VERSION
  )
    throw new Error(
      "Backup receipt, checksum, project, or schema verification failed",
    );
  const inspection = new ContextDatabase(backupPath, { readonly: true });
  try {
    const check = await inspection.get<{ quick_check: string }>(
      "PRAGMA quick_check",
    );
    const project = await inspection.get<{ value: string }>(
      "SELECT value FROM context_metadata WHERE key='projectId'",
    );
    const schema = await inspection.get<{ value: string }>(
      "SELECT value FROM context_metadata WHERE key='schemaVersion'",
    );
    if (
      check?.quick_check !== "ok" ||
      project?.value !== options.projectId ||
      Number(schema?.value) !== receipt.schemaVersion
    )
      throw new Error(
        "Backup database integrity, project, or schema verification failed",
      );
  } finally {
    await inspection.close();
  }
  // Requiring a NEW directory makes restoring over live context impossible.
  await mkdir(dataDir, { recursive: false, mode: 0o700 });
  await copyFile(
    backupPath,
    join(dataDir, "context.sqlite"),
    constants.COPYFILE_EXCL,
  );
  await chmod(join(dataDir, "context.sqlite"), 0o600);
  if (
    (await fingerprintFile(join(dataDir, "context.sqlite"))).sha256 !==
    receipt.sha256
  )
    throw new Error(
      "Backup changed during restore; destination must not be used",
    );
  return receipt;
}
