import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import ignore from "ignore";
import picomatch from "picomatch";
import {
  SCHEMA_VERSION,
  type CodeSymbol,
  type ContextItem,
  type ContextPacket,
  type GraphEdge,
  type MemoryKind,
  type MemoryRecord,
  type ProjectPolicy,
  type RepositorySnapshot,
  type SourceReference,
} from "@graph-engineering/contracts";
import { ContextDatabase, type Statement } from "./database.js";
import {
  canonicalJson,
  summarizeFiles,
  reviewMemoryRecords,
  SUMMARY_VERSION,
  type ContextSummary,
  type MemoryReview,
  type SolutionInput,
  type CachedSolution,
} from "./intelligence.js";
import {
  backupDatabase,
  restoreContextBackup,
  type BackupReceipt,
} from "./maintenance.js";
export type {
  ContextSummary,
  MemoryReview,
  SolutionInput,
  CachedSolution,
} from "./intelligence.js";
export type { BackupReceipt } from "./maintenance.js";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_KEY,
  LocalEmbeddings,
} from "./embeddings.js";
import {
  chunkFile,
  hash,
  PARSER_VERSION,
  parseFile,
  type ParsedFile,
} from "./parser.js";
import {
  containsSecret,
  inWorkingSet,
  isAllowedPath,
  reachesWorkingSet,
} from "../policy.js";
import { errorMessage, subprocessEnvironment } from "../util.js";
import { resolveSnapshotBindings, SEMANTIC_VERSION } from "./semantic.js";
import {
  pythonRuntime,
  PYTHON_VERSION,
  resolvePythonBindings,
} from "./python.js";
import { GO_VERSION, goRuntime, resolveGoBindings } from "./go.js";
import { JAVA_VERSION, javaRuntime, resolveJavaBindings } from "./java.js";
import {
  CSHARP_VERSION,
  csharpRuntime,
  resolveCSharpBindings,
} from "./csharp.js";
import { RUST_VERSION, rustRuntime, resolveRustBindings } from "./rust.js";
import {
  attachReviewedAssertions,
  parseReviewedAssertions,
  reviewSupersession,
} from "./memory-assertions.js";
export { containsSecret } from "../policy.js";

const execFileAsync = promisify(execFile);
// Committed documentation fetched with graph-engine knowledge-add.
const KNOWLEDGE_PACK_DIR = ".graph/knowledge-packs";
const BUILTIN_EXCLUSIONS = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.graph/local/**",
  "**/.graph/workspaces/**",
  "**/.graph/cache/**",
  "**/.graph/knowledge/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.venv/**",
  "**/__pycache__/**",
];
// A byte upper bound avoids claiming compatibility with a particular tokenizer.
export const estimateTokens = (text: string): number =>
  Buffer.byteLength(text, "utf8");
// Preserve portable path identity while still allowing .graph/project.json as
// local context; worker policy separately protects execution-control metadata.
const safePath = (path: string): boolean =>
  !!path &&
  !isAbsolute(path) &&
  !path.includes("\\") &&
  !/[<>:"|?*\x00-\x1f]/.test(path) &&
  !path
    .split("/")
    .some(
      (part) =>
        part === ".." ||
        part === "." ||
        part === "" ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    );
async function insideGitRepository(directory: string): Promise<boolean> {
  let current = resolve(directory);
  while (true) {
    try {
      await lstat(join(current, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
/** The most candidate files one snapshot indexes. */
export const INDEX_FILE_LIMIT = 100_000;
const CANDIDATE_FILES_LIMIT_MESSAGE = `Index limit exceeded: at most ${INDEX_FILE_LIMIT} candidate files per snapshot. Set policy.workingSet to the directories you are working on.`;
const SOURCE_BYTES_LIMIT_MESSAGE =
  "Index limit exceeded: at most 256 MiB source bytes per snapshot. Set policy.workingSet to the directories you are working on.";

/**
 * Whether the context index leaves a path out: unsafe names, built-in and
 * policy exclusions, and paths outside the working set (knowledge packs
 * excepted). `ignoreWorkingSet` answers for the whole repository.
 */
export function excludedFromIndex(
  path: string,
  policy: ProjectPolicy,
  options: { directory?: boolean; ignoreWorkingSet?: boolean } = {},
): boolean {
  if (!safePath(path)) return true;
  // Knowledge packs serve every part of the repository, so a working set
  // never hides them.
  const pack =
    path === KNOWLEDGE_PACK_DIR ||
    path.startsWith(`${KNOWLEDGE_PACK_DIR}/`) ||
    (options.directory === true && KNOWLEDGE_PACK_DIR.startsWith(`${path}/`));
  if (
    !pack &&
    !options.ignoreWorkingSet &&
    !(options.directory
      ? reachesWorkingSet(path, policy)
      : inWorkingSet(path, policy))
  )
    return true;
  const segments = path.split("/");
  const prefixes = segments.map((_, index) =>
    segments.slice(0, index + 1).join("/"),
  );
  return [...BUILTIN_EXCLUSIONS, ...policy.excludedPaths].some((pattern) =>
    prefixes.some((prefix) =>
      picomatch(pattern, {
        dot: true,
        nocase: true,
        basename: !pattern.includes("/"),
      })(prefix),
    ),
  );
}
type Payload = { payload: string };
type Chunk = { id: string; text: string; source: SourceReference };
const json = <T>(row: Payload): T => JSON.parse(row.payload);

export class ContextEngine {
  private db!: ContextDatabase;
  private embeddings: LocalEmbeddings;
  private ready: Promise<void>;
  private indexing?: Promise<RepositorySnapshot>;
  private embeddingIndexes = new Map<string, Promise<void>>();
  private exportScopes = new Map<string, Promise<void>>();
  private exportScopeUsers = new Map<string, number>();
  private exportEvictions = new Map<string, Promise<void>>();
  private vectorError: string | null = null;
  private watchers = new Set<{ close(): Promise<void> }>();
  readonly projectId: string;
  readonly root: string;
  readonly dataDir: string;
  readonly policy: ProjectPolicy;
  constructor(options: {
    projectId: string;
    root: string;
    dataDir: string;
    policy: ProjectPolicy;
  }) {
    this.projectId = options.projectId;
    this.root = resolve(options.root);
    this.dataDir = resolve(options.dataDir);
    this.policy = structuredClone(options.policy);
    this.embeddings = new LocalEmbeddings(this.dataDir);
    this.ready = this.initialize();
  }
  updatePolicy(policy: ProjectPolicy): void {
    Object.assign(this.policy, structuredClone(policy));
  }
  private async ensureExportScope(
    snapshotId: string,
    policy: ProjectPolicy,
  ): Promise<string> {
    const scope = hash(
      JSON.stringify({
        version: 1,
        snapshotId,
        excludedPaths: policy.excludedPaths,
        exportPaths: policy.exportPaths,
        allowPublicTemplateLedger: policy.allowPublicTemplateLedger,
        workingSet: policy.workingSet,
      }),
    );
    const eviction = this.exportEvictions.get(scope);
    if (eviction) await eviction;
    let pending = this.exportScopes.get(scope);
    if (!pending) {
      pending = (async () => {
        // The table is connection-local. A failed build never becomes visible
        // to retrieval, and a new process rebuilds it from its own snapshot.
        await this.db.exec(
          "CREATE TEMP TABLE IF NOT EXISTS context_export_eligible (scope TEXT NOT NULL, chunk_id TEXT NOT NULL, PRIMARY KEY(scope,chunk_id))",
        );
        let cursor = "";
        while (true) {
          const rows = await this.db.all<{
            id: string;
            path: string;
            text: string;
          }>(
            "SELECT id,path,text FROM chunks WHERE snapshot_id=? AND id>? ORDER BY id LIMIT 256",
            [snapshotId, cursor],
          );
          if (!rows.length) break;
          cursor = rows.at(-1)!.id;
          const statements = rows
            .filter(
              (row) =>
                !this.excluded(row.path, policy) &&
                isAllowedPath(row.path, policy, true) &&
                !containsSecret(row.path) &&
                !containsSecret(row.text),
            )
            .map((row) => ({
              sql: "INSERT OR IGNORE INTO context_export_eligible(scope,chunk_id) VALUES(?,?)",
              params: [scope, row.id],
            }));
          if (statements.length) await this.db.batch(statements);
        }
      })().catch(async (error: unknown) => {
        try {
          await this.db.run(
            "DELETE FROM context_export_eligible WHERE scope=?",
            [scope],
          );
        } catch {
          // Preserve the original build error if the connection also failed.
        }
        throw error;
      });
      this.exportScopes.set(scope, pending);
    } else {
      // Keep recently used scopes while bounding temporary index retention.
      this.exportScopes.delete(scope);
      this.exportScopes.set(scope, pending);
    }
    this.exportScopeUsers.set(
      scope,
      (this.exportScopeUsers.get(scope) ?? 0) + 1,
    );
    try {
      await pending;
    } catch (error) {
      const users = this.exportScopeUsers.get(scope)! - 1;
      if (users > 0) this.exportScopeUsers.set(scope, users);
      else this.exportScopeUsers.delete(scope);
      this.exportScopes.delete(scope);
      throw error;
    }
    return scope;
  }
  private async releaseExportScope(scope: string): Promise<void> {
    const users = (this.exportScopeUsers.get(scope) ?? 1) - 1;
    if (users > 0) this.exportScopeUsers.set(scope, users);
    else this.exportScopeUsers.delete(scope);
    for (const candidate of this.exportScopes.keys()) {
      if (this.exportScopes.size <= 2) break;
      if (this.exportScopeUsers.has(candidate)) continue;
      this.exportScopes.delete(candidate);
      const eviction = this.db.run(
        "DELETE FROM context_export_eligible WHERE scope=?",
        [candidate],
      );
      this.exportEvictions.set(candidate, eviction);
      try {
        await eviction;
      } finally {
        this.exportEvictions.delete(candidate);
      }
    }
  }
  private async initialize(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    this.db = new ContextDatabase(join(this.dataDir, "context.sqlite"));
    try {
      await this.db.migrate(this.projectId);
      await this.db.run(
        "INSERT OR IGNORE INTO context_metadata(key,value) VALUES(?,?)",
        ["projectId", this.projectId],
      );
      const existing = await this.db.get<{ value: string }>(
        "SELECT value FROM context_metadata WHERE key=?",
        ["projectId"],
      );
      if (existing?.value !== this.projectId)
        throw new Error("Context database belongs to a different project");
      this.vectorError = await this.db.vectorStatus();
      await chmod(join(this.dataDir, "context.sqlite"), 0o600);
    } catch (error) {
      await this.db.close();
      throw error;
    }
  }
  private excluded(
    path: string,
    policy: ProjectPolicy = this.policy,
    directory = false,
  ): boolean {
    return excludedFromIndex(path, policy, { directory });
  }
  private async git(args: string[]): Promise<string | null> {
    try {
      return (
        await execFileAsync(
          "git",
          ["-c", "core.fsmonitor=false", "-C", this.root, ...args],
          {
            env: subprocessEnvironment(),
            maxBuffer: 32 * 1024 * 1024,
            timeout: 10000,
          },
        )
      ).stdout;
    } catch {
      return null;
    }
  }
  private async inventory(): Promise<string[]> {
    let listed: string | null = null;
    try {
      listed = (
        await execFileAsync(
          "git",
          [
            "-c",
            "core.fsmonitor=false",
            "-C",
            this.root,
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
          ],
          {
            env: subprocessEnvironment(),
            // Large repositories list tens of megabytes of paths.
            maxBuffer: 512 * 1024 * 1024,
            timeout: 120_000,
          },
        )
      ).stdout;
    } catch (error) {
      // Inside a Git repository a failed listing is an error, never a
      // silent switch to a walk with different ignore rules. Look for the
      // repository on disk, since Git itself just failed.
      if (await insideGitRepository(this.root))
        throw new Error(
          `Could not list repository files with git: ${errorMessage(error)}`,
          { cause: error },
        );
    }
    if (listed !== null)
      return [...new Set(listed.split("\0").filter(Boolean))]
        .filter((path) => !this.excluded(path))
        .sort();
    const result: string[] = [];
    const walk = async (
      directory: string,
      inherited: { base: string; matcher: ReturnType<typeof ignore> }[],
    ): Promise<void> => {
      const rules = [...inherited];
      try {
        rules.push({
          base: directory,
          matcher: ignore().add(
            await readFile(join(directory, ".gitignore"), "utf8"),
          ),
        });
      } catch {
        /* optional */
      }
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name),
          path = relative(this.root, absolute).split(sep).join("/");
        let ignored = false;
        for (const rule of rules) {
          const result = rule.matcher.test(
            relative(rule.base, absolute).split(sep).join("/") +
              (entry.isDirectory() ? "/" : ""),
          );
          if (result.ignored) ignored = true;
          else if (result.unignored) ignored = false;
        }
        if (
          entry.isSymbolicLink() ||
          this.excluded(path, this.policy, entry.isDirectory()) ||
          ignored
        )
          continue;
        if (entry.isDirectory()) await walk(absolute, rules);
        else if (entry.isFile()) {
          result.push(path);
          if (result.length > INDEX_FILE_LIMIT)
            throw new Error(CANDIDATE_FILES_LIMIT_MESSAGE);
        }
      }
    };
    await walk(this.root, [
      {
        base: this.root,
        matcher: ignore().add([
          ".git/",
          "node_modules/",
          ".graph/local/",
          ".graph/workspaces/",
          ".graph/cache/",
        ]),
      },
    ]);
    return result.sort();
  }
  async index(
    options: { semantic?: boolean } = {},
  ): Promise<RepositorySnapshot> {
    await this.ready;
    if (!this.indexing)
      this.indexing = this.buildIndex().finally(() => {
        this.indexing = undefined;
      });
    const snapshot = await this.indexing;
    if (options.semantic !== false)
      await this.ensureSnapshotEmbeddings(snapshot.id);
    return snapshot;
  }
  private async buildIndex(): Promise<RepositorySnapshot> {
    const [canonicalRoot, revision, branch, paths] = await Promise.all([
      realpath(this.root),
      this.git(["rev-parse", "HEAD"]),
      this.git(["symbolic-ref", "--quiet", "--short", "HEAD"]),
      this.inventory(),
    ]);
    const worktreeId = hash(canonicalRoot);
    if (paths.length > INDEX_FILE_LIMIT)
      throw new Error(CANDIDATE_FILES_LIMIT_MESSAGE);
    const files: {
      path: string;
      text: string;
      hash: string;
      executableMode: number;
    }[] = [];
    const errors: string[] = [];
    let totalBytes = 0;
    for (const path of paths) {
      const absolute = join(this.root, path);
      try {
        const info = await lstat(absolute);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        const canonical = await realpath(absolute);
        if (
          !canonical.startsWith(canonicalRoot + sep) ||
          canonical.startsWith(this.dataDir + sep)
        )
          continue;
        if (info.size > 1024 * 1024) {
          errors.push(`${path}: skipped file larger than 1 MiB`);
          continue;
        }
        const bytes = await readFile(absolute);
        totalBytes += bytes.length;
        if (totalBytes > 256 * 1024 * 1024)
          throw new RangeError(SOURCE_BYTES_LIMIT_MESSAGE);
        if (bytes.includes(0)) continue;
        const text = bytes.toString("utf8");
        if (containsSecret(text)) {
          errors.push(
            `${path}: omitted because a credential pattern was detected`,
          );
          continue;
        }
        files.push({
          path,
          text,
          hash: hash(text),
          executableMode: info.mode & 0o111,
        });
      } catch (error) {
        if (error instanceof RangeError) throw error;
        errors.push(`${path}: file unavailable during indexing`);
      }
    }
    const contentHash = hash(
      JSON.stringify(files.map((file) => [file.path, file.hash])),
    );
    // Parsing depends on bytes, but execution-sensitive repository identity
    // must also change when any indexed file's executable permission changes.
    const executableModes = files
      .filter((file) => file.executableMode !== 0)
      .map((file) => [file.path, file.executableMode]);
    const python = files.some((file) => file.path.endsWith(".py"))
      ? await pythonRuntime()
      : null;
    const go = files.some((file) => file.path.endsWith(".go"))
      ? await goRuntime()
      : null;
    const java = files.some((file) => file.path.endsWith(".java"))
      ? await javaRuntime()
      : null;
    const csharp = files.some((file) => file.path.endsWith(".cs"))
      ? await csharpRuntime()
      : null;
    const rust = files.some((file) => file.path.endsWith(".rs"))
      ? await rustRuntime()
      : null;
    const id = hash(
      JSON.stringify({
        project: this.projectId,
        worktreeId,
        revision: revision?.trim(),
        branch: branch?.trim(),
        contentHash,
        ...(executableModes.length > 0
          ? { executableModes: hash(JSON.stringify(executableModes)) }
          : {}),
        parser: PARSER_VERSION,
        staticBindings: SEMANTIC_VERSION,
        pythonBindings: [PYTHON_VERSION, python?.identity ?? "unavailable"],
        goBindings: [GO_VERSION, go?.identity ?? "unavailable"],
        javaBindings: [JAVA_VERSION, java?.identity ?? "unavailable"],
        csharpBindings: [CSHARP_VERSION, csharp?.identity ?? "unavailable"],
        rustBindings: [RUST_VERSION, rust?.identity ?? "unavailable"],
        summaries: SUMMARY_VERSION,
        excluded: this.policy.excludedPaths,
      }),
    );
    const existing = await this.db.get<Payload>(
      "SELECT payload FROM snapshots WHERE id=? AND project_id=?",
      [id, this.projectId],
    );
    if (existing) {
      await this.db.run(
        "INSERT OR REPLACE INTO context_metadata(key,value) VALUES(?,?)",
        ["currentSnapshot", id],
      );
      await this.importSharedMemories();
      return json(existing);
    }
    const snapshot: RepositorySnapshot = {
      version: SCHEMA_VERSION,
      id,
      projectId: this.projectId,
      worktreeId,
      revision: revision?.trim() || null,
      contentHash,
      createdAt: new Date().toISOString(),
      fileCount: files.length,
      languages: [],
      coverage: { parsed: 0, textOnly: 0, errors },
    };
    const statements: Statement[] = [];
    const parsedFiles: ParsedFile[] = [];
    const knownFiles = new Set(files.map((file) => file.path));
    for (const file of files) {
      const cached = await this.db.get<Payload>(
        "SELECT payload FROM files WHERE path=? AND content_hash=? LIMIT 1",
        [file.path, file.hash],
      );
      let parsed: ParsedFile;
      if (cached && json<ParsedFile>(cached).parserVersion === PARSER_VERSION) {
        parsed = json<ParsedFile>(cached);
        for (const symbol of parsed.symbols) symbol.source.snapshotId = id;
        for (const edge of parsed.edges) edge.source.snapshotId = id;
      } else parsed = await parseFile(file.path, file.text, id);
      parsedFiles.push(parsed);
      for (const edge of parsed.edges)
        if (edge.kind === "imports") {
          edge.to = null;
          edge.evidence = "syntactic";
          const match = edge.target.match(
            /(?:from\s+|import\s+)(['"])(\.[^'"]+)\1/,
          );
          if (match && ["typescript", "javascript"].includes(parsed.language)) {
            const target = posix.normalize(
              posix.join(posix.dirname(file.path), match[2]!),
            );
            const candidates = [
              target,
              ...[
                ".ts",
                ".tsx",
                ".js",
                ".jsx",
                ".mts",
                ".cts",
                ".mjs",
                ".cjs",
              ].map((extension) => target + extension),
              ...[".ts", ".tsx", ".js", ".jsx"].map((extension) =>
                posix.join(target, "index" + extension),
              ),
            ];
            const resolved = candidates.filter((candidate) =>
              knownFiles.has(candidate),
            );
            // Only bind an unambiguous concrete file. Package exports, path
            // aliases, generated sources and overloaded resolution stay unresolved.
            if (resolved.length === 1) {
              edge.to = hash(`file:${resolved[0]}`);
              edge.evidence = "resolved";
            }
          }
        }
      snapshot.coverage[parsed.parsed ? "parsed" : "textOnly"]++;
      snapshot.coverage.errors.push(...parsed.errors);
      if (!snapshot.languages.includes(parsed.language))
        snapshot.languages.push(parsed.language);
    }
    const bindings = await Promise.all([
      resolveSnapshotBindings(parsedFiles, id),
      resolvePythonBindings(parsedFiles, id, { runtime: python }),
      resolveGoBindings(parsedFiles, id, { runtime: go }),
      resolveJavaBindings(parsedFiles, id, { runtime: java }),
      resolveCSharpBindings(parsedFiles, id, { runtime: csharp }),
      resolveRustBindings(parsedFiles, id, { runtime: rust }),
    ]);
    snapshot.coverage.errors.push(
      ...bindings.flatMap((result) => result.diagnostics),
    );
    const bindingUpdates = new Map(
      bindings
        .flatMap((result) => result.updates)
        .map((edge) => [edge.id, edge]),
    );
    for (const parsed of parsedFiles) {
      statements.push({
        sql: "INSERT INTO files(snapshot_id,path,content_hash,payload) VALUES(?,?,?,?)",
        // Cache syntax extraction only. Compiler bindings depend on OTHER files
        // and must be recomputed when any snapshot input changes.
        params: [id, parsed.path, parsed.hash, JSON.stringify(parsed)],
      });
      for (const symbol of parsed.symbols)
        statements.push({
          sql: "INSERT INTO symbols(snapshot_id,id,name,payload) VALUES(?,?,?,?)",
          params: [id, symbol.id, symbol.name, JSON.stringify(symbol)],
        });
      for (const edge of parsed.edges)
        statements.push({
          sql: "INSERT INTO edges(snapshot_id,id,source_id,target_id,payload) VALUES(?,?,?,?,?)",
          params: [
            id,
            edge.id,
            edge.from,
            (bindingUpdates.get(edge.id) ?? edge).to,
            JSON.stringify(bindingUpdates.get(edge.id) ?? edge),
          ],
        });
      for (const chunk of chunkFile(parsed, id)) {
        statements.push({
          sql: "INSERT INTO chunks(id,snapshot_id,path,content_hash,text,payload) VALUES(?,?,?,?,?,?)",
          params: [
            chunk.id,
            id,
            parsed.path,
            parsed.hash,
            chunk.text,
            JSON.stringify(chunk),
          ],
        });
        statements.push({
          sql: "INSERT INTO chunks_fts(id,snapshot_id,path,text) VALUES(?,?,?,?)",
          params: [chunk.id, id, parsed.path, chunk.text],
        });
      }
    }
    snapshot.languages.sort();
    for (const summary of summarizeFiles(parsedFiles, id))
      statements.push({
        sql: "INSERT INTO summaries(snapshot_id,path,level,content_hash,payload) VALUES(?,?,?,?,?)",
        params: [
          id,
          summary.path,
          summary.level,
          summary.contentHash,
          JSON.stringify(summary),
        ],
      });
    statements.unshift({
      sql: "INSERT INTO snapshots(id,project_id,payload) VALUES(?,?,?)",
      params: [id, this.projectId, JSON.stringify(snapshot)],
    });
    statements.push({
      sql: "INSERT OR REPLACE INTO context_metadata(key,value) VALUES(?,?)",
      params: ["currentSnapshot", id],
    });
    const inserted = await this.db.snapshotBatch(id, statements);
    if (!inserted) {
      await this.db.run(
        "INSERT OR REPLACE INTO context_metadata(key,value) VALUES(?,?)",
        ["currentSnapshot", id],
      );
      await this.importSharedMemories();
      return json<RepositorySnapshot>(
        (await this.db.get<Payload>(
          "SELECT payload FROM snapshots WHERE id=? AND project_id=?",
          [id, this.projectId],
        ))!,
      );
    }
    await this.importSharedMemories();
    return snapshot;
  }
  private async ensureSnapshotEmbeddings(snapshotId: string): Promise<void> {
    let pending = this.embeddingIndexes.get(snapshotId);
    if (!pending) {
      pending = (async () => {
        if (this.vectorError || !(await this.embeddings.available())) return;
        const rows = await this.db.all<Payload>(
          "SELECT c.payload FROM chunks c WHERE c.snapshot_id=? AND NOT EXISTS (SELECT 1 FROM chunk_embeddings ce JOIN embeddings e ON e.cache_key=ce.cache_key WHERE ce.snapshot_id=c.snapshot_id AND ce.chunk_id=c.id AND e.model=?)",
          [snapshotId, EMBEDDING_KEY],
        );
        if (rows.length)
          await this.embedChunks(
            snapshotId,
            rows
              .map((row) => json<Chunk>(row))
              .filter((chunk) => !this.excluded(chunk.source.path)),
          );
      })().finally(() => {
        this.embeddingIndexes.delete(snapshotId);
      });
      this.embeddingIndexes.set(snapshotId, pending);
    }
    await pending;
  }
  private async embedChunks(
    snapshotId: string,
    chunks: Chunk[],
  ): Promise<void> {
    if (this.vectorError || !(await this.embeddings.available())) return;
    for (const chunk of chunks) {
      const cacheKey = hash(`${EMBEDDING_KEY}:${chunk.text}`);
      const existing = await this.db.get(
        "SELECT cache_key FROM embeddings WHERE cache_key=?",
        [cacheKey],
      );
      if (!existing) {
        const vector = await this.embeddings.embed(chunk.text);
        if (!vector) return;
        await this.db.run(
          "INSERT OR IGNORE INTO embeddings(cache_key,model,dimensions,vector) VALUES(?,?,?,?)",
          [
            cacheKey,
            EMBEDDING_KEY,
            EMBEDDING_DIMENSIONS,
            Buffer.from(vector.buffer),
          ],
        );
      }
      await this.db.run(
        "INSERT OR REPLACE INTO chunk_embeddings(snapshot_id,chunk_id,cache_key) VALUES(?,?,?)",
        [snapshotId, chunk.id, cacheKey],
      );
    }
  }
  async provisionEmbeddings(): Promise<{
    model: string;
    revision: string;
    directory: string;
  }> {
    await this.ready;
    const result = await this.embeddings.provision(this.policy);
    for (const snapshot of await this.listSnapshots()) {
      const chunks = await this.db.all<Payload>(
        "SELECT payload FROM chunks WHERE snapshot_id=?",
        [snapshot.id],
      );
      await this.embedChunks(
        snapshot.id,
        chunks.map((row) => json<Chunk>(row)),
      );
    }
    return result;
  }
  async listSnapshots(): Promise<RepositorySnapshot[]> {
    await this.ready;
    return (
      await this.db.all<Payload>(
        "SELECT payload FROM snapshots WHERE project_id=? ORDER BY rowid DESC",
        [this.projectId],
      )
    ).map((row) => json<RepositorySnapshot>(row));
  }
  /** Return the selected snapshot, which may be older than the newest row. */
  async currentSnapshot(): Promise<RepositorySnapshot | null> {
    await this.ready;
    const current = await this.db.get<{ value: string }>(
      "SELECT value FROM context_metadata WHERE key=?",
      ["currentSnapshot"],
    );
    return current ? this.snapshot(current.value) : null;
  }
  /** A stored snapshot of this project. */
  async snapshotById(id: string): Promise<RepositorySnapshot> {
    return this.snapshot(id);
  }
  private async snapshot(id?: string): Promise<RepositorySnapshot> {
    await this.ready;
    if (!id) return this.index();
    const row = await this.db.get<Payload>(
      "SELECT payload FROM snapshots WHERE id=? AND project_id=?",
      [id, this.projectId],
    );
    if (!row)
      throw new Error(
        "Snapshot does not belong to this project or is unavailable",
      );
    return json(row);
  }
  async searchSymbols(
    query: string,
    snapshotId?: string,
  ): Promise<CodeSymbol[]> {
    const snapshot = await this.snapshot(snapshotId);
    const escaped = query.replace(/[\\%_]/g, "\\$&");
    return (
      await this.db.all<Payload>(
        "SELECT payload FROM symbols WHERE snapshot_id=? AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 100",
        [snapshot.id, `%${escaped}%`],
      )
    )
      .map((row) => json<CodeSymbol>(row))
      .filter((symbol) => !this.excluded(symbol.source.path));
  }
  async neighbors(
    symbolId: string,
    snapshotId?: string,
    depth = 1,
    options: { exportOnly?: boolean; policy?: ProjectPolicy } = {},
  ): Promise<GraphEdge[]> {
    const snapshot = await this.snapshot(snapshotId);
    const policy = options.policy ?? this.policy;
    if (!Number.isInteger(depth) || depth < 1 || depth > 3)
      throw new Error("Graph depth must be between 1 and 3");
    let frontier = [symbolId];
    const visited = new Set<string>();
    const edges = new Map<string, GraphEdge>();
    const symbols = new Map<string, Promise<CodeSymbol | undefined>>();
    const readSymbol = (id: string): Promise<CodeSymbol | undefined> => {
      let pending = symbols.get(id);
      if (!pending) {
        pending = this.db
          .get<Payload>(
            "SELECT payload FROM symbols WHERE snapshot_id=? AND id=?",
            [snapshot.id, id],
          )
          .then((row) => (row ? json<CodeSymbol>(row) : undefined));
        symbols.set(id, pending);
      }
      return pending;
    };
    const exportable = (symbol: CodeSymbol | undefined): boolean =>
      !!symbol &&
      !this.excluded(symbol.source.path, policy) &&
      isAllowedPath(symbol.source.path, policy, true) &&
      ![symbol.name, symbol.signature, symbol.source.path].some(containsSecret);
    for (
      let hop = 0;
      hop < depth && frontier.length && edges.size < 200;
      hop++
    ) {
      const next: string[] = [];
      for (const symbol of frontier.slice(0, 100)) {
        if (visited.has(symbol)) continue;
        visited.add(symbol);
        // Apply the cloud boundary before traversal: filtering only returned
        // edges would still reveal reachability through non-exportable nodes.
        if (options.exportOnly && !exportable(await readSymbol(symbol)))
          continue;
        const rows = await this.db.all<Payload>(
          "SELECT payload FROM edges WHERE snapshot_id=? AND (source_id=? OR target_id=?) LIMIT 200",
          [snapshot.id, symbol, symbol],
        );
        for (const row of rows) {
          const edge = json<GraphEdge>(row);
          if (this.excluded(edge.source.path, policy)) continue;
          const mappingSources = edge.resolution?.sources ?? [];
          if (
            options.exportOnly &&
            mappingSources.some(
              (source) =>
                this.excluded(source.path, policy) ||
                !isAllowedPath(source.path, policy, true) ||
                containsSecret(source.path),
            )
          )
            continue;
          if (
            mappingSources.some(
              (source) =>
                this.excluded(source.path, policy) ||
                source.snapshotId !== snapshot.id,
            )
          ) {
            // A hidden configuration cannot establish historical reachability.
            // Keep only the caller's own syntactic evidence, without its target
            // or private configuration paths/hashes.
            if (edge.from !== symbol) continue;
            edge.to = null;
            edge.evidence = "syntactic";
            delete edge.resolution;
          }
          if (
            options.exportOnly &&
            (!isAllowedPath(edge.source.path, policy, true) ||
              [edge.target, edge.source.path].some(containsSecret) ||
              !exportable(await readSymbol(edge.from)))
          )
            continue;
          if (edge.to) {
            const target = await readSymbol(edge.to);
            if (options.exportOnly && !exportable(target)) continue;
            if (!target || this.excluded(target.source.path, policy)) {
              edge.to = null;
              edge.evidence = "syntactic";
              delete edge.resolution;
            }
          }
          edges.set(edge.id, edge);
          next.push(edge.from);
          if (edge.to) next.push(edge.to);
          if (edges.size >= 200) break;
        }
      }
      frontier = next;
    }
    return [...edges.values()].slice(0, 200);
  }
  async getContext(input: {
    query: string;
    budgetTokens?: number;
    snapshotId?: string;
    mandatory?: string[];
    retrieval?: "lexical" | "graph" | "hybrid";
    exportOnly?: boolean;
  }): Promise<ContextPacket> {
    const retrieval = input.retrieval ?? "hybrid";
    const exportOnly = input.exportOnly === true;
    const exportPolicy = exportOnly
      ? structuredClone(this.policy)
      : this.policy;
    if (!["lexical", "graph", "hybrid"].includes(retrieval))
      throw new Error("Unknown retrieval mode");
    // Lexical/graph retrieval must not pay embedding-index costs. Hybrid heals
    // missing vectors below, after cheap validation and mandatory-budget checks.
    const snapshot = input.snapshotId
      ? await this.snapshot(input.snapshotId)
      : await this.index({ semantic: false });
    const budget = input.budgetTokens ?? this.policy.maxContextTokens;
    if (
      !Number.isInteger(budget) ||
      budget < 1 ||
      budget > this.policy.maxContextTokens
    )
      throw new Error("Context budget is outside project policy");
    if (containsSecret(input.query) || input.mandatory?.some(containsSecret))
      throw new Error("Context request contains a credential pattern");
    const exportableChunk = (chunk: Chunk): boolean =>
      !this.excluded(chunk.source.path, exportPolicy) &&
      (!exportOnly ||
        (isAllowedPath(chunk.source.path, exportPolicy, true) &&
          !containsSecret(chunk.source.path) &&
          !containsSecret(chunk.text)));
    const memories = (await this.listMemories()).filter(
      (memory) =>
        memory.status === "accepted" ||
        (memory.status === "conflicted" &&
          ["constraint", "requirement"].includes(memory.kind)),
    );
    const mandatoryMemories = memories.filter((memory) =>
      ["constraint", "requirement"].includes(memory.kind),
    );
    if (
      exportOnly &&
      mandatoryMemories.some(
        (memory) =>
          memory.visibility !== "shared" ||
          memory.sources.length === 0 ||
          containsSecret(memory.text) ||
          memory.sources.some(
            (source) =>
              !isAllowedPath(source.path, exportPolicy, true) ||
              containsSecret(source.path),
          ),
      )
    )
      throw new Error("Mandatory memory is not exportable to this client");
    const authorizations = await this.exportAuthorizations();
    const mandatorySources = mandatoryMemories.map((memory) => {
      const textSha256 = hash(memory.text);
      return {
        memoryId: memory.id,
        text: memory.text,
        textSha256,
        visibility: memory.visibility,
        sources: memory.sources,
        exportAuthorized: authorizations.has(`${memory.id}:${textSha256}`),
      };
    });
    // Every contributing record must be authorized, including duplicates of
    // the same text, and nothing is dropped to make the export succeed.
    if (exportOnly && mandatorySources.some((entry) => !entry.exportAuthorized))
      throw new Error(
        "Mandatory memory has not been authorized for export to this client",
      );
    const mandatory = [
      ...new Set([
        ...(input.mandatory ?? []),
        ...mandatoryMemories.map((memory) => memory.text),
      ]),
    ];
    let used =
      estimateTokens(input.query) +
      mandatory.reduce((total, text) => total + estimateTokens(text), 0) +
      64;
    if (used > budget)
      throw new Error(
        `Mandatory context needs at least ${used} tokens; budget is ${budget}. Increase the permitted budget or refine the task.`,
      );
    const candidates = new Map<string, ContextItem>();
    const exportScope = exportOnly
      ? await this.ensureExportScope(snapshot.id, exportPolicy)
      : null;
    try {
      const terms = [
        ...new Set(input.query.match(/[\p{L}\p{N}_]{2,}/gu) ?? []),
      ].slice(0, 24);
      if (terms.length) {
        const match = terms
          .map((term) => `"${term.replaceAll('"', '""')}"`)
          .join(" OR ");
        const rankTerms = terms.slice(0, 8).map((term) => term.toLowerCase());
        const publicRank = rankTerms
          .map(() => "(instr(lower(c.path || ' ' || c.text), ?) > 0)")
          .join(" + ");
        const rows = await this.db.all<Payload>(
          exportOnly
            ? `SELECT c.payload FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.id AND c.snapshot_id=chunks_fts.snapshot_id JOIN context_export_eligible eligible ON eligible.chunk_id=c.id AND eligible.scope=? WHERE chunks_fts MATCH ? AND chunks_fts.snapshot_id=? ORDER BY (${publicRank}) DESC, length(c.text), c.id LIMIT 80`
            : "SELECT c.payload FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.id AND c.snapshot_id=chunks_fts.snapshot_id WHERE chunks_fts MATCH ? AND chunks_fts.snapshot_id=? ORDER BY bm25(chunks_fts,0,0,4,1) LIMIT 80",
          exportOnly
            ? [exportScope, match, snapshot.id, ...rankTerms]
            : [match, snapshot.id],
        );
        const matching = rows
          .map((row) => json<Chunk>(row))
          .filter(exportableChunk);
        // Cloud ranking sees only eligible chunks and uses per-chunk signals,
        // never private-corpus BM25 statistics or an unbounded result set.
        matching.slice(0, 80).forEach((chunk, index) => {
          candidates.set(chunk.id, {
            ...chunk,
            kind: /\.(?:md|txt|rst|adoc)$/i.test(chunk.source.path)
              ? "document"
              : "code",
            score: 1 / (60 + index),
          });
        });
      }
      let semantic = false;
      const warnings = [...snapshot.coverage.errors];
      for (const memory of mandatoryMemories)
        if (memory.status === "conflicted")
          warnings.push(
            `Mandatory memory ${memory.id} has an unresolved conflict; review is required and its original constraint remains in force.`,
          );
      if (retrieval === "hybrid" && !this.vectorError) {
        await this.ensureSnapshotEmbeddings(snapshot.id);
        const queryVector = await this.embeddings.embed(input.query);
        if (queryVector) {
          const rows = await this.db.all<Payload & { distance: number }>(
            exportOnly
              ? "SELECT c.payload, vec_distance_cosine(e.vector,?) AS distance FROM chunks c JOIN chunk_embeddings ce ON ce.snapshot_id=c.snapshot_id AND ce.chunk_id=c.id JOIN embeddings e ON e.cache_key=ce.cache_key JOIN context_export_eligible eligible ON eligible.chunk_id=c.id AND eligible.scope=? WHERE c.snapshot_id=? AND e.model=? ORDER BY distance,c.id LIMIT 80"
              : "SELECT c.payload, vec_distance_cosine(e.vector,?) AS distance FROM chunks c JOIN chunk_embeddings ce ON ce.snapshot_id=c.snapshot_id AND ce.chunk_id=c.id JOIN embeddings e ON e.cache_key=ce.cache_key WHERE c.snapshot_id=? AND e.model=? ORDER BY distance LIMIT 80",
            exportOnly
              ? [
                  Buffer.from(queryVector.buffer),
                  exportScope,
                  snapshot.id,
                  EMBEDDING_KEY,
                ]
              : [Buffer.from(queryVector.buffer), snapshot.id, EMBEDDING_KEY],
          );
          const matching = rows
            .map((row) => json<Chunk>(row))
            .filter(exportableChunk)
            .slice(0, 80);
          semantic = matching.length > 0;
          matching.forEach((chunk, index) => {
            candidates.set(chunk.id, {
              ...chunk,
              kind: "code",
              score: (candidates.get(chunk.id)?.score ?? 0) + 1 / (60 + index),
            });
          });
        } else warnings.push(this.embeddings.warning);
      } else if (retrieval === "hybrid")
        warnings.push(`Vector extension unavailable: ${this.vectorError}`);
      if (retrieval !== "hybrid")
        warnings.push(
          `Retrieval mode ${retrieval}: semantic search intentionally disabled`,
        );
      for (const memory of memories.filter(
        (memory) =>
          !exportOnly && !["constraint", "requirement"].includes(memory.kind),
      )) {
        const matches = terms.filter((term) =>
          memory.text.toLowerCase().includes(term.toLowerCase()),
        ).length;
        if (matches)
          candidates.set(memory.id, {
            id: memory.id,
            kind: "memory",
            text: memory.text,
            memoryId: memory.id,
            score: matches / Math.max(terms.length, 1) / 50,
          });
      }
      // An exact repository path in the task is stronger evidence than fuzzy
      // term overlap. Resolve only paths present in this frozen snapshot, and
      // preserve all normal exclusions; this is a priority hint, not authority
      // to read an arbitrary file or bypass the context budget.
      const pathHints = [
        ...new Set(
          (
            input.query.match(
              /(?<![A-Za-z0-9_./-])(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+/g,
            ) ?? []
          )
            .map((value) => value.replace(/[.,;:!?]+$/, ""))
            .filter(
              (value) =>
                /\.[A-Za-z0-9]{1,8}$/.test(value) &&
                isAllowedPath(value, exportPolicy, exportOnly) &&
                (!exportOnly || !containsSecret(value)) &&
                !this.excluded(value, exportPolicy),
            ),
        ),
      ].slice(0, 8);
      const rankingTerms = terms
        .filter((term) => term.length >= 4)
        .map((term) => term.toLowerCase());
      for (const hintedPath of pathHints) {
        const rows = await this.db.all<Payload>(
          "SELECT payload FROM chunks WHERE snapshot_id=? AND path=? ORDER BY rowid LIMIT 64",
          [snapshot.id, hintedPath],
        );
        const ranked = rows
          .map((row) => {
            const chunk = json<Chunk>(row);
            const lower = chunk.text.toLowerCase();
            const matches = rankingTerms.filter((term) => lower.includes(term));
            return {
              chunk,
              score:
                1 +
                matches.length / 100 +
                1 / (1 + chunk.source.startLine) / 1000,
            };
          })
          .filter(({ chunk }) => exportableChunk(chunk))
          .sort(
            (a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id),
          )
          .slice(0, 12);
        for (const { chunk, score } of ranked)
          candidates.set(chunk.id, {
            ...chunk,
            kind: /\.(?:md|txt|rst|adoc)$/i.test(chunk.source.path)
              ? "document"
              : "code",
            score,
          });
      }
      const topPaths = [
        ...new Set(
          [...candidates.values()]
            .sort((a, b) => b.score - a.score)
            .slice(0, 5)
            .flatMap((item) => (item.source ? [item.source.path] : [])),
        ),
      ];
      for (const path of retrieval === "lexical" ? [] : topPaths) {
        const related = await this.neighbors(
          hash(`file:${path}`),
          snapshot.id,
          1,
          { exportOnly, policy: exportPolicy },
        );
        for (const edge of related.slice(0, 10)) {
          const target = edge.to
            ? await this.db.get<Payload>(
                "SELECT payload FROM symbols WHERE snapshot_id=? AND id=?",
                [snapshot.id, edge.to],
              )
            : undefined;
          const path = target
            ? json<CodeSymbol>(target).source.path
            : edge.source.path;
          if (
            this.excluded(path, exportPolicy) ||
            (exportOnly &&
              (!isAllowedPath(path, exportPolicy, true) ||
                containsSecret(path)))
          )
            continue;
          const rows = await this.db.all<Payload>(
            "SELECT payload FROM chunks WHERE snapshot_id=? AND path=? LIMIT 8",
            [snapshot.id, path],
          );
          for (const row of rows) {
            const chunk = json<Chunk>(row);
            if (exportableChunk(chunk) && !candidates.has(chunk.id))
              candidates.set(chunk.id, {
                ...chunk,
                kind: "code",
                score: 1 / 150,
              });
          }
        }
      }
      const items: ContextItem[] = [];
      const textHashes = new Set<string>();
      for (const candidate of [...candidates.values()]
        .filter(
          (item) =>
            !exportOnly ||
            (item.source !== undefined && exportableChunk(item as Chunk)),
        )
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))) {
        const digest = hash(candidate.text);
        if (textHashes.has(digest)) continue;
        const size =
          estimateTokens(candidate.text) +
          estimateTokens(candidate.source?.path ?? "") +
          48;
        if (used + size > budget) continue;
        used += size;
        textHashes.add(digest);
        items.push(candidate);
      }
      if (candidates.size > items.length)
        warnings.push(
          "Some candidates were omitted by the context budget or deduplication",
        );
      warnings.push(
        "Token estimate is a conservative UTF-8 byte bound; provider message framing is budgeted separately",
      );
      if (input.snapshotId)
        warnings.push(
          "Explicit snapshot requested: evidence represents that snapshot, not necessarily current working files",
        );
      // Documentation ages: say so when a retrieved knowledge pack is old.
      for (const packPath of new Set(
        items
          .map((item) => item.source?.path)
          .filter((file): file is string =>
            Boolean(file?.startsWith(`${KNOWLEDGE_PACK_DIR}/`)),
          ),
      )) {
        const row = await this.db.get<Payload>(
          "SELECT payload FROM files WHERE snapshot_id=? AND path=?",
          [snapshot.id, packPath],
        );
        const retrieved = row
          ? /^retrieved: (.+)$/m.exec(
              json<ParsedFile>(row).text.slice(0, 2000),
            )?.[1]
          : undefined;
        const age = retrieved
          ? (Date.now() - Date.parse(retrieved)) / 86_400_000
          : Number.NaN;
        if (!(age <= 180))
          warnings.push(
            `Knowledge pack ${packPath} was retrieved ${retrieved ?? "at an unknown time"}, over 180 days ago or undated; check the source for newer documentation`,
          );
      }
      return {
        version: SCHEMA_VERSION,
        projectId: this.projectId,
        snapshotId: snapshot.id,
        query: input.query,
        mandatory,
        mandatorySources,
        items,
        estimatedTokens: used,
        budgetTokens: budget,
        coverage: {
          semantic,
          graph:
            retrieval === "lexical"
              ? "Graph expansion intentionally disabled by lexical retrieval mode."
              : "Syntax declarations, imports and calls with bounded snapshot-only JS/TS, Python, Go, Java, C# and Rust declaration bindings where resolution metadata is present and a trusted runtime is available. Static bindings are not runtime proofs or full-program typechecks; unsupported, ambiguous or resource-limited cases retain syntactic/heuristic evidence. Expansion limited to 1 hop, 5 seed files.",
          warnings,
        },
      };
    } finally {
      if (exportScope) await this.releaseExportScope(exportScope);
    }
  }
  async listMemories(): Promise<MemoryRecord[]> {
    await this.ready;
    return (
      await this.db.all<Payload>(
        "SELECT payload FROM memories WHERE project_id=? ORDER BY rowid",
        [this.projectId],
      )
    ).map((row) => json<MemoryRecord>(row));
  }
  private validateMemory(record: MemoryRecord): void {
    if (
      record.version !== SCHEMA_VERSION ||
      record.projectId !== this.projectId ||
      !/^[a-zA-Z0-9_-]{8,80}$/.test(record.id) ||
      ![
        "observation",
        "decision",
        "requirement",
        "constraint",
        "solution",
      ].includes(record.kind) ||
      typeof record.text !== "string" ||
      !record.text.trim() ||
      record.text.length > 100000 ||
      containsSecret(record.text)
    )
      throw new Error("Invalid or sensitive memory record");
    if (
      !Array.isArray(record.sources) ||
      record.sources.some(
        (source) =>
          !safePath(source.path) ||
          this.excluded(source.path) ||
          !Number.isInteger(source.startLine) ||
          !Number.isInteger(source.endLine) ||
          source.startLine < 1 ||
          source.endLine < source.startLine ||
          typeof source.contentHash !== "string" ||
          typeof source.snapshotId !== "string",
      )
    )
      throw new Error("Memory has an invalid or excluded source");
    if (record.supersedes && !/^[a-zA-Z0-9_-]{8,80}$/.test(record.supersedes))
      throw new Error("Invalid superseded memory id");
    if (record.assertions !== undefined)
      record.assertions = parseReviewedAssertions(record.assertions);
  }
  async createMemory(input: {
    text: string;
    kind: MemoryKind;
    sources?: SourceReference[];
    supersedes?: string;
  }): Promise<MemoryRecord> {
    await this.ready;
    const record: MemoryRecord = {
      version: SCHEMA_VERSION,
      id: randomUUID(),
      projectId: this.projectId,
      kind: input.kind,
      text: input.text,
      visibility: "private",
      status: "proposed",
      createdAt: new Date().toISOString(),
      sources: input.sources ?? [],
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    };
    this.validateMemory(record);
    if (record.supersedes) await this.memory(record.supersedes);
    await this.verifyMemorySources(record.sources);
    await this.db.batch(
      [
        {
          sql: "INSERT INTO memories(id,project_id,status,payload) VALUES(?,?,?,?)",
          params: [
            record.id,
            this.projectId,
            record.status,
            JSON.stringify(record),
          ],
        },
      ],
      [...new Set(record.sources.map((source) => source.snapshotId))],
    );
    return record;
  }
  private async verifyMemorySources(sources: SourceReference[]): Promise<void> {
    for (const source of sources) {
      await this.snapshot(source.snapshotId);
      const file = await this.db.get<Payload>(
        "SELECT payload FROM files WHERE snapshot_id=? AND path=? AND content_hash=?",
        [source.snapshotId, source.path, source.contentHash],
      );
      if (
        !file ||
        source.endLine > json<ParsedFile>(file).text.split("\n").length
      )
        throw new Error("Memory source does not match indexed evidence");
    }
  }
  private async exportAuthorizations(): Promise<Set<string>> {
    const rows = await this.db.all<{ memory_id: string; text_sha256: string }>(
      "SELECT memory_id,text_sha256 FROM memory_export_authorizations",
    );
    return new Set(rows.map((row) => `${row.memory_id}:${row.text_sha256}`));
  }
  /** Shows exactly what memoryExportAuthorize would release, without recording consent. */
  async memoryExportReview(id: string): Promise<{
    id: string;
    kind: MemoryKind;
    status: MemoryRecord["status"];
    visibility: MemoryRecord["visibility"];
    text: string;
    textSha256: string;
    sources: SourceReference[];
    exportAuthorized: boolean;
  }> {
    await this.ready;
    const record = await this.memory(id);
    this.validateMemory(record);
    const textSha256 = hash(record.text);
    return {
      id: record.id,
      kind: record.kind,
      status: record.status,
      visibility: record.visibility,
      text: record.text,
      textSha256,
      sources: record.sources,
      exportAuthorized: (await this.exportAuthorizations()).has(
        `${record.id}:${textSha256}`,
      ),
    };
  }
  /**
   * Records operator consent to export one accepted, shared memory's exact
   * text to cloud consumers. The caller must echo the SHA-256 of the text it
   * reviewed; sharing alone never authorizes export.
   */
  async authorizeMemoryExport(
    id: string,
    textSha256: string,
  ): Promise<{ id: string; textSha256: string; authorizedAt: string }> {
    await this.ready;
    const record = await this.memory(id);
    this.validateMemory(record);
    if (record.status !== "accepted")
      throw new Error("Only accepted memories can be authorized for export");
    if (record.visibility !== "shared")
      throw new Error("Share the memory before authorizing its export");
    if (
      record.sources.length === 0 ||
      containsSecret(record.text) ||
      record.sources.some(
        (source) =>
          !isAllowedPath(source.path, this.policy, true) ||
          containsSecret(source.path),
      )
    )
      throw new Error(
        "Memory needs source evidence inside the export policy before it can be exported",
      );
    await this.verifyMemorySources(record.sources);
    if (textSha256 !== hash(record.text))
      throw new Error("The SHA-256 does not match this memory's exact text");
    const authorizedAt = new Date().toISOString();
    await this.db.run(
      "INSERT OR IGNORE INTO memory_export_authorizations(memory_id,text_sha256,authorized_at) VALUES(?,?,?)",
      [record.id, textSha256, authorizedAt],
    );
    return { id: record.id, textSha256, authorizedAt };
  }
  /** Withdraws every recorded cloud-export consent for one memory. */
  async revokeMemoryExport(
    id: string,
  ): Promise<{ id: string; removed: number }> {
    await this.ready;
    const record = await this.memory(id);
    const rows = await this.db.all<{ text_sha256: string }>(
      "SELECT text_sha256 FROM memory_export_authorizations WHERE memory_id=?",
      [record.id],
    );
    await this.db.run(
      "DELETE FROM memory_export_authorizations WHERE memory_id=?",
      [record.id],
    );
    return { id: record.id, removed: rows.length };
  }
  private async memoryPayload(id: string): Promise<string> {
    const row = await this.db.get<Payload>(
      "SELECT payload FROM memories WHERE id=? AND project_id=?",
      [id, this.projectId],
    );
    if (!row) throw new Error("Memory is unavailable in this project");
    return row.payload;
  }
  private async memory(id: string): Promise<MemoryRecord> {
    return JSON.parse(await this.memoryPayload(id)) as MemoryRecord;
  }
  async setMemoryAssertions(id: string, input: unknown): Promise<MemoryRecord> {
    await this.ready;
    const original = await this.memoryPayload(id);
    const previous = JSON.parse(original) as MemoryRecord;
    const record = attachReviewedAssertions(previous, input);
    this.validateMemory(record);
    await this.db.batch([
      {
        sql: "UPDATE memories SET payload=? WHERE id=? AND project_id=? AND status='proposed' AND payload=?",
        params: [JSON.stringify(record), id, this.projectId, original],
        expectedChanges: 1,
      },
    ]);
    return record;
  }
  /**
   * A person declines a proposal. It stays on record, private, and is never
   * accepted or retrieved; the reason is kept with it.
   */
  async rejectMemory(id: string, reason: string): Promise<MemoryRecord> {
    await this.ready;
    const trimmed = reason.trim();
    if (!trimmed) throw new Error("Say why the proposal is rejected");
    if (containsSecret(trimmed))
      throw new Error("The reason contains a potential secret; rephrase it");
    const original = await this.memoryPayload(id);
    const record: MemoryRecord = JSON.parse(original);
    if (record.status !== "proposed")
      throw new Error(
        `Only a proposed memory can be rejected; this one is ${record.status}`,
      );
    record.status = "rejected";
    record.rejectionReason = trimmed.slice(0, 2000);
    await this.db.batch([
      {
        sql: "UPDATE memories SET status=?,payload=? WHERE id=? AND project_id=? AND status='proposed' AND payload=?",
        params: [
          "rejected",
          JSON.stringify(record),
          id,
          this.projectId,
          original,
        ],
        expectedChanges: 1,
      },
    ]);
    return record;
  }
  async acceptMemory(id: string): Promise<MemoryRecord> {
    await this.ready;
    const original = await this.memoryPayload(id);
    const record = JSON.parse(original) as MemoryRecord;
    if (
      record.status === "superseded" ||
      record.status === "conflicted" ||
      record.status === "rejected"
    )
      throw new Error(
        `A ${record.status} memory cannot be accepted; propose a new one instead`,
      );
    this.validateMemory(record);
    if (record.status === "accepted") return record;
    record.status = "accepted";
    const statements: Statement[] = [];
    if (record.supersedes) {
      const previousPayload = await this.memoryPayload(record.supersedes);
      const previous = JSON.parse(previousPayload) as MemoryRecord;
      if (previous.status !== "accepted")
        throw new Error("Only an accepted memory can be superseded");
      this.validateMemory(previous);
      const findings = reviewSupersession(record, await this.listMemories());
      if (findings.length)
        throw new Error(
          `Supersession requires review: ${findings.map((finding) => finding.reason).join(" ")}`,
        );
      previous.status = "superseded";
      statements.push({
        sql: "UPDATE memories SET status=?,payload=? WHERE id=? AND project_id=? AND status='accepted' AND payload=? AND NOT EXISTS (SELECT 1 FROM memories AS sibling WHERE sibling.project_id=? AND sibling.id<>? AND sibling.status IN ('accepted','conflicted') AND json_extract(sibling.payload,'$.supersedes')=?)",
        params: [
          previous.status,
          JSON.stringify(previous),
          previous.id,
          this.projectId,
          previousPayload,
          this.projectId,
          record.id,
          previous.id,
        ],
        expectedChanges: 1,
      });
    }
    statements.push({
      sql: "UPDATE memories SET status=?,payload=? WHERE id=? AND project_id=? AND payload=?",
      params: [
        record.status,
        JSON.stringify(record),
        id,
        this.projectId,
        original,
      ],
      expectedChanges: 1,
    });
    await this.db.batch(statements);
    return record;
  }
  async promoteMemory(
    id: string,
  ): Promise<{ path: string; record: MemoryRecord }> {
    await this.ready;
    const original = await this.memoryPayload(id);
    const record = JSON.parse(original) as MemoryRecord;
    this.validateMemory(record);
    if (record.status !== "accepted")
      throw new Error("Only accepted memories can be shared");
    record.visibility = "shared";
    const directory = join(this.root, ".graph", "knowledge");
    await mkdir(directory, { recursive: true });
    const canonicalRoot = await realpath(this.root);
    if (!(await realpath(directory)).startsWith(canonicalRoot + sep))
      throw new Error("Shared knowledge directory escapes the project");
    const path = `.graph/knowledge/${id}.json`,
      absolute = join(this.root, path);
    const output = JSON.stringify(record, null, 2) + "\n";
    try {
      await writeFile(absolute, output, { flag: "wx", mode: 0o644 });
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST" &&
        (await readFile(absolute, "utf8")) === output
      ))
        throw error;
    }
    await this.db.batch([
      {
        sql: "UPDATE memories SET payload=? WHERE id=? AND project_id=? AND status='accepted' AND payload=?",
        params: [JSON.stringify(record), id, this.projectId, original],
        expectedChanges: 1,
      },
    ]);
    return { path, record };
  }
  async importSharedMemories(): Promise<number> {
    await this.ready;
    const directory = join(this.root, ".graph", "knowledge");
    let entries: string[];
    try {
      if (
        !(await realpath(directory)).startsWith(
          (await realpath(this.root)) + sep,
        )
      )
        throw new Error("Shared knowledge directory escapes the project");
      entries = await readdir(directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return 0;
      throw error;
    }
    let imported = 0;
    for (const name of entries.sort()) {
      if (!/^[a-zA-Z0-9_-]{8,80}\.json$/.test(name)) continue;
      const path = join(directory, name),
        info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 150000)
        continue;
      const record = JSON.parse(await readFile(path, "utf8")) as MemoryRecord;
      this.validateMemory(record);
      if (
        record.id !== name.slice(0, -5) ||
        record.visibility !== "shared" ||
        !["accepted", "superseded", "conflicted"].includes(record.status)
      )
        throw new Error(`Invalid shared memory ${name}`);
      const existing = await this.db.get<Payload>(
        "SELECT payload FROM memories WHERE id=? AND project_id=?",
        [record.id, this.projectId],
      );
      if (existing) {
        const previous = json<MemoryRecord>(existing);
        this.validateMemory(previous);
        if (
          previous.text !== record.text ||
          previous.kind !== record.kind ||
          JSON.stringify(previous.sources) !== JSON.stringify(record.sources) ||
          canonicalJson(previous.assertions ?? null) !==
            canonicalJson(record.assertions ?? null) ||
          previous.supersedes !== record.supersedes
        ) {
          previous.status = "conflicted";
          await this.db.batch([
            {
              sql: "UPDATE memories SET status=?,payload=? WHERE id=? AND project_id=? AND payload=?",
              params: [
                previous.status,
                JSON.stringify(previous),
                previous.id,
                this.projectId,
                existing.payload,
              ],
              expectedChanges: 1,
            },
          ]);
        }
        continue;
      }
      // Shared files are explicit reviewed project knowledge. Imported records
      // retain their accepted status; they never silently overwrite local text.
      await this.db.run(
        "INSERT INTO memories(id,project_id,status,payload) VALUES(?,?,?,?)",
        [record.id, this.projectId, record.status, JSON.stringify(record)],
      );
      imported++;
    }
    // Imported links can conflict or form cycles. Preserve every record for
    // review rather than letting filename order choose an architecture decision.
    const memoryRows = await this.db.all<Payload>(
      "SELECT payload FROM memories WHERE project_id=? ORDER BY rowid",
      [this.projectId],
    );
    const allMemories = memoryRows.map((row) => json<MemoryRecord>(row));
    const payloads = new Map(
      memoryRows.map((row) => [json<MemoryRecord>(row).id, row.payload]),
    );
    const byId = new Map(allMemories.map((record) => [record.id, record]));
    const guards: Statement[] = [];
    const transitions: Statement[] = [];
    for (const record of allMemories)
      if (record.status === "accepted" && record.supersedes) {
        if (reviewSupersession(record, allMemories).length) continue;
        const previous = byId.get(record.supersedes);
        if (!previous) continue;
        if (previous.status === "accepted") {
          this.validateMemory(previous);
          guards.push({
            sql: "UPDATE memories SET payload=payload WHERE id=? AND project_id=? AND status='accepted' AND payload=?",
            params: [record.id, this.projectId, payloads.get(record.id)!],
            expectedChanges: 1,
          });
          transitions.push({
            sql: "UPDATE memories SET status=?,payload=? WHERE id=? AND project_id=? AND status='accepted' AND payload=? AND NOT EXISTS (SELECT 1 FROM memories AS sibling WHERE sibling.project_id=? AND sibling.id<>? AND sibling.status IN ('accepted','conflicted') AND json_extract(sibling.payload,'$.supersedes')=?)",
            params: [
              "superseded",
              JSON.stringify({ ...previous, status: "superseded" }),
              previous.id,
              this.projectId,
              payloads.get(previous.id)!,
              this.projectId,
              record.id,
              previous.id,
            ],
            expectedChanges: 1,
          });
        }
      }
    // Validate every candidate before any transition; chain order must not pick
    // which ancestor survives. A concurrent edit/sibling rolls the batch back.
    if (transitions.length) await this.db.batch([...guards, ...transitions]);
    return imported;
  }
  async listSummaries(snapshotId?: string): Promise<ContextSummary[]> {
    const snapshot = await this.snapshot(snapshotId);
    const rows = await this.db.all<Payload>(
      "SELECT payload FROM summaries WHERE snapshot_id=? ORDER BY level,path",
      [snapshot.id],
    );
    // Rebuild the hierarchy if policy tightened since this snapshot. A parent
    // aggregate may otherwise leak excluded filenames/symbols through its text.
    const paths = await this.db.all<{ path: string }>(
      "SELECT path FROM files WHERE snapshot_id=?",
      [snapshot.id],
    );
    if (paths.some((file) => this.excluded(file.path)) || !rows.length) {
      const files = (
        await this.db.all<Payload>(
          "SELECT payload FROM files WHERE snapshot_id=?",
          [snapshot.id],
        )
      )
        .map((row) => json<ParsedFile>(row))
        .filter((file) => !this.excluded(file.path));
      return summarizeFiles(files, snapshot.id);
    }
    return rows.map((row) => json<ContextSummary>(row));
  }
  private solutionIdentity(
    input: SolutionInput,
    snapshotId: string,
  ): { cacheKey: string; inputsHash: string; policyHash: string } {
    if (!input.key || input.key.length > 200 || containsSecret(input.key))
      throw new Error("Invalid or sensitive solution cache key");
    const serialized = canonicalJson(input.inputs);
    const sensitive = (value: unknown): boolean =>
      typeof value === "string"
        ? containsSecret(value)
        : Array.isArray(value)
          ? value.some(sensitive)
          : !!value && typeof value === "object"
            ? Object.entries(value).some(
                ([key, item]) => containsSecret(key) || sensitive(item),
              )
            : false;
    if (
      serialized.length > 100_000 ||
      containsSecret(serialized) ||
      sensitive(input.inputs)
    )
      throw new Error("Invalid or sensitive solution cache inputs");
    const inputsHash = hash(serialized),
      policyHash = hash(canonicalJson(this.policy));
    return {
      inputsHash,
      policyHash,
      cacheKey: hash(
        canonicalJson({
          version: 1,
          projectId: this.projectId,
          key: input.key,
          inputsHash,
          policyHash,
          snapshotId,
          parser: PARSER_VERSION,
        }),
      ),
    };
  }
  async putSolution(
    input: SolutionInput & { value: string; sources: SourceReference[] },
  ): Promise<CachedSolution> {
    const snapshot = await this.snapshot(input.snapshotId);
    const identity = this.solutionIdentity(input, snapshot.id);
    if (
      !input.value.trim() ||
      input.value.length > 100_000 ||
      containsSecret(input.value) ||
      !input.sources.length ||
      input.sources.length > 100
    )
      throw new Error(
        "Solution cache needs bounded, non-sensitive text and source evidence",
      );
    for (const source of input.sources) {
      if (
        this.excluded(source.path) ||
        source.snapshotId !== snapshot.id ||
        !Number.isInteger(source.startLine) ||
        source.startLine < 1 ||
        !Number.isInteger(source.endLine) ||
        source.endLine < source.startLine
      )
        throw new Error("Invalid solution source provenance");
      const file = await this.db.get<Payload>(
        "SELECT payload FROM files WHERE snapshot_id=? AND path=?",
        [snapshot.id, source.path],
      );
      if (
        !file ||
        json<ParsedFile>(file).hash !== source.contentHash ||
        source.endLine > json<ParsedFile>(file).text.split("\n").length
      )
        throw new Error("Solution source does not match snapshot evidence");
    }
    const record: CachedSolution = {
      key: input.key,
      value: input.value,
      sources: structuredClone(input.sources),
      snapshotId: snapshot.id,
      policyHash: identity.policyHash,
      inputsHash: identity.inputsHash,
      createdAt: new Date().toISOString(),
    };
    await this.db.run(
      "INSERT OR REPLACE INTO solution_cache(cache_key,snapshot_id,policy_hash,payload) VALUES(?,?,?,?)",
      [
        identity.cacheKey,
        snapshot.id,
        identity.policyHash,
        JSON.stringify(record),
      ],
    );
    return record;
  }
  async getSolution(input: SolutionInput): Promise<CachedSolution | null> {
    const snapshot = await this.snapshot(input.snapshotId);
    const identity = this.solutionIdentity(input, snapshot.id);
    const row = await this.db.get<Payload>(
      "SELECT payload FROM solution_cache WHERE cache_key=? AND snapshot_id=? AND policy_hash=?",
      [identity.cacheKey, snapshot.id, identity.policyHash],
    );
    if (!row) return null;
    const record = json<CachedSolution>(row);
    return record.sources.some((source) => this.excluded(source.path)) ||
      containsSecret(record.value)
      ? null
      : record;
  }
  async reviewMemories(snapshotId?: string): Promise<MemoryReview[]> {
    const snapshot = await this.snapshot(snapshotId);
    const files = await this.db.all<{ path: string; content_hash: string }>(
      "SELECT path,content_hash FROM files WHERE snapshot_id=?",
      [snapshot.id],
    );
    const memories = await this.listMemories();
    if (memories.length > 2000)
      throw new Error(
        "Memory review limit exceeded: review at most 2000 records per project",
      );
    const reviews = reviewMemoryRecords(
      memories,
      new Map(files.map((file) => [file.path, file.content_hash])),
      snapshot.id,
      (path) => this.excluded(path),
    );
    await this.db.batch(
      reviews.map((review) => ({
        sql: "INSERT OR REPLACE INTO memory_reviews(memory_id,snapshot_id,payload) VALUES(?,?,?)",
        params: [review.memoryId, snapshot.id, JSON.stringify(review)],
      })),
    );
    return reviews;
  }
  watch(
    options: {
      intervalMs?: number;
      onIndex?: (snapshot: RepositorySnapshot) => void | Promise<void>;
      onError?: (error: Error) => void;
    } = {},
  ): { close(): Promise<void> } {
    const interval = options.intervalMs ?? 5000;
    if (!Number.isFinite(interval) || interval < 1000 || interval > 3_600_000)
      throw new Error("Watch interval must be between 1000 and 3600000 ms");
    let stopped = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      running: Promise<void> | undefined,
      previous: string | undefined;
    // Full content reconciliation is deliberate: mtime-only caches miss edits
    // after a branch switch or timestamp restoration. One scan at a time, bounded
    // by index limits; a delay after completion provides natural backpressure.
    const poll = async () => {
      try {
        const snapshot = await this.index();
        if (!stopped && snapshot.id !== previous) {
          previous = snapshot.id;
          await options.onIndex?.(snapshot);
        }
      } catch (error) {
        if (!stopped)
          options.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
      } finally {
        if (!stopped) {
          timer = setTimeout(() => {
            running = poll();
          }, interval);
          timer.unref();
        }
      }
    };
    const watcher = {
      close: async () => {
        stopped = true;
        clearTimeout(timer);
        await running;
        this.watchers.delete(watcher);
      },
    };
    this.watchers.add(watcher);
    running = poll();
    return watcher;
  }
  async pruneSnapshots(
    options: {
      keepLatest?: number;
      dryRun?: boolean;
      protectedSnapshotIds?: string[];
    } = {},
  ): Promise<{ dryRun: boolean; removed: string[]; protected: string[] }> {
    await this.ready;
    await this.indexing;
    await Promise.all(this.embeddingIndexes.values());
    const keep = options.keepLatest ?? 20;
    if (!Number.isInteger(keep) || keep < 1 || keep > 100_000)
      throw new Error(
        "Retention keepLatest must be a positive bounded integer",
      );
    const protectedSnapshotIds = options.protectedSnapshotIds ?? [];
    if (
      protectedSnapshotIds.length > 100_000 ||
      protectedSnapshotIds.some((id) => !/^[a-f0-9]{64}$/.test(id))
    )
      throw new Error("Invalid protected snapshot IDs");
    // All checks/deletions share one IMMEDIATE transaction: a concurrent memory
    // writer cannot race the provenance pin check. Callers must also pass refs
    // owned by separate stores (plans/runs), under their maintenance lock.
    return this.db.prune({
      keepLatest: keep,
      dryRun: options.dryRun !== false,
      protectedSnapshotIds,
    });
  }
  async backup(destination: string): Promise<BackupReceipt> {
    await this.ready;
    await this.indexing;
    return backupDatabase(this.db, this.projectId, this.dataDir, destination);
  }
  static restoreBackup = restoreContextBackup;
  async close(): Promise<void> {
    try {
      await Promise.all([...this.watchers].map((watcher) => watcher.close()));
      await this.ready;
      await this.indexing;
      await Promise.all(this.embeddingIndexes.values());
      await this.embeddings.close();
    } finally {
      await this.db?.close();
    }
  }
}
