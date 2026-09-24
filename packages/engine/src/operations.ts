import { constants } from "node:fs";
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
import { z } from "zod";
import {
  assertProjectConfig,
  type ProjectConfig,
} from "@graph-engineering/contracts";
import { ContextEngine } from "./context/index.js";
import { ContextDatabase, CONTEXT_SCHEMA_VERSION } from "./context/database.js";
import { fingerprintFile } from "./context/maintenance.js";
import { canonicalJson } from "./context/intelligence.js";
import {
  decisionProviderSchema,
  promotionEvidenceSchema,
} from "./decisions.js";
import { containsSecret } from "./policy.js";
import { loadProviders } from "./project.js";
import type { RunStore } from "./store.js";

const JSON_FILES = [
  "providers.json",
  "decisions.json",
  "promotions.json",
  "project-config.reference.json",
] as const;
const FILES = [
  "context.sqlite",
  "context.sqlite.receipt.json",
  "runs.sqlite",
  ...JSON_FILES,
] as const;
const ACTIVE = new Set(["planned", "running", "verifying"]);
const manifestSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string().min(1).max(100),
    createdAt: z.string().datetime(),
    schema: z
      .object({
        context: z.number().int().min(1).max(CONTEXT_SCHEMA_VERSION),
        runs: z.number().int().min(1).max(4),
      })
      .strict(),
    files: z
      .array(
        z
          .object({
            path: z.enum(FILES),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            bytes: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(3)
      .max(FILES.length),
    excluded: z.array(z.string()),
    resumePolicy: z.literal("manual-reconciliation-required"),
  })
  .strict();
export type ProjectBackupManifest = z.infer<typeof manifestSchema>;

function inspectSecrets(value: unknown, key = ""): void {
  if (key === "apiKeyEnv") {
    if (
      typeof value !== "string" ||
      !/^[A-Z][A-Z0-9_]*$/.test(value) ||
      containsSecret(value)
    )
      throw new Error(
        "Backup config contains an invalid credential environment reference",
      );
    return;
  }
  if (
    /^(?:api[_-]?key|password|passwd|secret|credential|authorization|access[_-]?token|refresh[_-]?token|token)$/i.test(
      key,
    )
  )
    throw new Error("Backup config may not contain raw credential fields");
  if (typeof value === "string") {
    if (containsSecret(value))
      throw new Error("Backup config contains a credential pattern");
    if (key === "endpoint") {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash)
        throw new Error(
          "Backup endpoint may not contain credentials, query parameters, or fragments",
        );
    }
  } else if (Array.isArray(value))
    for (const item of value) inspectSecrets(item);
  else if (value && typeof value === "object")
    for (const [name, item] of Object.entries(value))
      inspectSecrets(item, name);
}
async function validateJsonFiles(
  directory: string,
  projectId: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const file of JSON_FILES) {
    let text: string;
    try {
      const info = await lstat(join(directory, file));
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 2 * 1024 * 1024
      )
        throw new Error(`Invalid private backup config: ${file}`);
      text = await readFile(join(directory, file), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const value: unknown = JSON.parse(text);
    inspectSecrets(value);
    if (file === "providers.json") await loadProviders(directory);
    if (file === "decisions.json") z.array(decisionProviderSchema).parse(value);
    if (file === "promotions.json")
      z.array(promotionEvidenceSchema).parse(value);
    if (file === "project-config.reference.json") {
      assertProjectConfig(value);
      if (value.projectId !== projectId)
        throw new Error("Backup config belongs to a different project");
    }
    result.set(file, text);
  }
  return result;
}

async function inspectDatabases(
  directory: string,
  projectId: string,
  schema: ProjectBackupManifest["schema"],
): Promise<void> {
  const context = new ContextDatabase(join(directory, "context.sqlite"), {
    readonly: true,
  });
  const runs = new ContextDatabase(join(directory, "runs.sqlite"), {
    readonly: true,
  });
  try {
    for (const db of [context, runs])
      if (
        (await db.get<{ quick_check: string }>("PRAGMA quick_check"))
          ?.quick_check !== "ok"
      )
        throw new Error("Backup database integrity check failed");
    if (
      (
        await context.get<{ value: string }>(
          "SELECT value FROM context_metadata WHERE key='projectId'",
        )
      )?.value !== projectId
    )
      throw new Error("Backup context project identity mismatch");
    if (
      Number(
        (
          await context.get<{ value: string }>(
            "SELECT value FROM context_metadata WHERE key='schemaVersion'",
          )
        )?.value,
      ) !== schema.context ||
      (await runs.get<{ user_version: number }>("PRAGMA user_version"))
        ?.user_version !== schema.runs
    )
      throw new Error("Backup schema version mismatch");
    const tables = await runs.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'",
    );
    for (const table of tables) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table.name))
        throw new Error("Unexpected run-store table name");
      const columns = await runs.all<{ name: string }>(
        `PRAGMA table_info(${table.name})`,
      );
      if (
        columns.some((column) => column.name === "project_id") &&
        (await runs.get(
          `SELECT 1 FROM ${table.name} WHERE project_id IS NULL OR project_id<>? LIMIT 1`,
          [projectId],
        ))
      )
        throw new Error("Backup run-store contains another project");
    }
    for (const row of await runs.all<{ json: string }>(
      "SELECT json FROM plans",
    )) {
      const plan = JSON.parse(row.json);
      if (
        typeof plan.snapshotId !== "string" ||
        !(await context.get(
          "SELECT 1 FROM snapshots WHERE id=? AND project_id=?",
          [plan.snapshotId, projectId],
        ))
      )
        throw new Error(
          "Backup is missing a plan's context snapshot; retry while the project is idle",
        );
    }
    for (const row of await runs.all<{ json: string }>("SELECT json FROM runs"))
      if (ACTIVE.has(JSON.parse(row.json).status))
        throw new Error(
          "Cannot archive active runs; stop work before backing up",
        );
  } finally {
    await Promise.all([context.close(), runs.close()]);
  }
}

/** Quiesce project writes before calling; every file is private and newly created. */
export async function backupProject(options: {
  context: ContextEngine;
  store: Pick<RunStore, "backup" | "runs" | "schemaVersion">;
  dataDir: string;
  projectId: string;
  destination: string;
  config?: ProjectConfig;
}): Promise<ProjectBackupManifest> {
  if (options.context.projectId !== options.projectId)
    throw new Error("Context project identity mismatch");
  if (options.store.runs().some((run) => ACTIVE.has(run.status)))
    throw new Error("Cannot archive active runs; stop work before backing up");
  const observer = new ContextDatabase(join(options.dataDir, "runs.sqlite"), {
    readonly: true,
  });
  try {
    const beforeVersion = (
      await observer.get<{ data_version: number }>("PRAGMA data_version")
    )?.data_version;
    const before = canonicalJson(options.store.runs());
    const configs = await validateJsonFiles(options.dataDir, options.projectId);
    if (options.config) {
      assertProjectConfig(options.config);
      inspectSecrets(options.config);
      if (options.config.projectId !== options.projectId)
        throw new Error("Project config identity mismatch");
      configs.set(
        "project-config.reference.json",
        JSON.stringify(options.config, null, 2) + "\n",
      );
    }
    const parent = await realpath(dirname(resolve(options.destination))),
      destination = join(parent, basename(options.destination));
    const source = await realpath(options.dataDir);
    if (destination === source || destination.startsWith(source + sep))
      throw new Error("Project backup must be outside the live data directory");
    await mkdir(destination, { recursive: false, mode: 0o700 });
    const receipt = await options.context.backup(
      join(destination, "context.sqlite"),
    );
    await writeFile(join(destination, "runs.sqlite"), "", {
      flag: "wx",
      mode: 0o600,
    });
    await options.store.backup(join(destination, "runs.sqlite"));
    for (const [name, text] of configs)
      await writeFile(join(destination, name), text, {
        flag: "wx",
        mode: 0o600,
      });
    const schema = {
      context: receipt.schemaVersion,
      runs: options.store.schemaVersion,
    };
    await inspectDatabases(destination, options.projectId, schema);
    if (canonicalJson(options.store.runs()) !== before)
      throw new Error(
        "Run state changed during backup; incomplete archive must not be restored",
      );
    if (
      (await observer.get<{ data_version: number }>("PRAGMA data_version"))
        ?.data_version !== beforeVersion
    )
      throw new Error(
        "Run database changed during backup; incomplete archive must not be restored",
      );
    const currentConfigs = await validateJsonFiles(
      options.dataDir,
      options.projectId,
    );
    for (const file of JSON_FILES.filter(
      (file) => file !== "project-config.reference.json",
    ))
      if (currentConfigs.get(file) !== configs.get(file))
        throw new Error(
          "Provider configuration changed during backup; retry while idle",
        );
    const files: ProjectBackupManifest["files"] = [];
    for (const file of FILES) {
      try {
        files.push({
          path: file,
          ...(await fingerprintFile(join(destination, file))),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const manifest = manifestSchema.parse({
      version: 1,
      projectId: options.projectId,
      createdAt: new Date().toISOString(),
      schema,
      files,
      excluded: [
        "environment files/values and raw credential configuration fields (private database history is preserved)",
        "model weights and model caches",
        "working repositories and workspaces",
        "shared Git files except a non-executable project-config reference",
        "external assets",
      ],
      resumePolicy: "manual-reconciliation-required",
    });
    await writeFile(
      join(destination, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return manifest;
  } finally {
    await observer.close();
  }
}

export async function restoreProject(options: {
  backupDirectory: string;
  dataDir: string;
  projectId: string;
}): Promise<ProjectBackupManifest> {
  const directory = await realpath(options.backupDirectory);
  const manifestInfo = await lstat(join(directory, "manifest.json"));
  if (
    !manifestInfo.isFile() ||
    manifestInfo.isSymbolicLink() ||
    manifestInfo.size > 100_000
  )
    throw new Error("Invalid project backup manifest");
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")),
  );
  if (
    manifest.projectId !== options.projectId ||
    new Set(manifest.files.map((file) => file.path)).size !==
      manifest.files.length ||
    !["context.sqlite", "context.sqlite.receipt.json", "runs.sqlite"].every(
      (name) => manifest.files.some((file) => file.path === name),
    )
  )
    throw new Error("Backup project identity or required files mismatch");
  for (const file of manifest.files) {
    const path = join(directory, file.path),
      info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Backup files must be regular files");
    const actual = await fingerprintFile(path);
    if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes)
      throw new Error(`Backup checksum mismatch: ${file.path}`);
  }
  const validatedConfigs = await validateJsonFiles(
    directory,
    options.projectId,
  );
  for (const name of validatedConfigs.keys())
    if (!manifest.files.some((file) => file.path === name))
      throw new Error("Unmanifested backup config file");
  await inspectDatabases(directory, options.projectId, manifest.schema);
  // New destination only. No live repository/config or workspace is overwritten.
  await ContextEngine.restoreBackup({
    backupPath: join(directory, "context.sqlite"),
    dataDir: options.dataDir,
    projectId: options.projectId,
  });
  for (const file of manifest.files.filter(
    (file) =>
      file.path !== "context.sqlite" &&
      file.path !== "context.sqlite.receipt.json",
  )) {
    const destination = join(resolve(options.dataDir), file.path);
    await copyFile(
      join(directory, file.path),
      destination,
      constants.COPYFILE_EXCL,
    );
    await chmod(destination, 0o600);
    if ((await fingerprintFile(destination)).sha256 !== file.sha256)
      throw new Error(
        "Backup changed during restore; destination must not be used",
      );
  }
  await inspectDatabases(
    resolve(options.dataDir),
    options.projectId,
    manifest.schema,
  );
  await writeFile(
    join(options.dataDir, "restore-receipt.json"),
    JSON.stringify(
      {
        ...manifest,
        restoredAt: new Date().toISOString(),
        warning:
          "Workspaces and model weights were not restored. Review configuration and reconcile interrupted/failed runs manually; unknown or reserved costs remain unknown.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return manifest;
}
