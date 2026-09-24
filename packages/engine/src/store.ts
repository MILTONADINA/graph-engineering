import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { lstat, chmod } from "node:fs/promises";
import path from "node:path";
import type {
  DecisionRecord,
  ExecutionPlan,
  RunEvent,
  RunRecord,
  Usage,
} from "@graph-engineering/contracts";
import { id, now } from "./util.js";
import { redact } from "./policy.js";
import {
  summarizeInferenceCalls,
  type AccountingSummary,
} from "./accounting.js";
import {
  localProcessOwner,
  localProcessOwnerReady,
  processOwnerState,
  type ProcessOwner,
} from "./process-owner.js";

/**
 * V3 rows have no instance proof: a live PID is unknown, never proof of ownership.
 * A recycled live PID may require manual reconciliation after an in-place upgrade.
 */
function legacyOwnerState(pid: number | undefined): "dead" | "unknown" {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
    return "dead";
  try {
    process.kill(pid, 0);
    return "unknown";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? "dead"
      : "unknown";
  }
}

/** Small operational records only. Context DB/index work lives in the context worker. */
export class RunStore {
  readonly schemaVersion = 4;
  private db: Database.Database;
  constructor(
    dataDir: string,
    private projectId: string,
  ) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(dataDir, "runs.sqlite"));
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 4) {
      this.db.close();
      throw new Error(
        "Run database is newer than this engine; refusing a downgrade",
      );
    }
    this.db
      .transaction(() => {
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,run_id TEXT,project_id TEXT,json TEXT);
      CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON run_events(project_id,run_id,seq);
      CREATE TABLE IF NOT EXISTS run_owners(run_id TEXT PRIMARY KEY,pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inference_calls(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,owner_id TEXT NOT NULL,provider TEXT NOT NULL,reserved REAL,usage_json TEXT);
      CREATE INDEX IF NOT EXISTS inference_owner ON inference_calls(project_id,owner_id);
      CREATE TABLE IF NOT EXISTS worker_leases(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS owner_proofs(kind TEXT NOT NULL,id TEXT NOT NULL,project_id TEXT NOT NULL,endpoint TEXT NOT NULL,verifier TEXT NOT NULL,PRIMARY KEY(kind,id));
      PRAGMA user_version = 4;`);
      })
      .immediate();
    localProcessOwner();
  }
  async ownerReady(): Promise<void> {
    await localProcessOwnerReady();
  }
  private proof(
    kind: "run" | "worker",
    ownerId: string,
    pid: number,
  ): ProcessOwner | null {
    const row = this.db
      .prepare(
        "SELECT endpoint,verifier FROM owner_proofs WHERE kind=? AND id=? AND project_id=?",
      )
      .get(kind, ownerId, this.projectId) as
      { endpoint: string; verifier: string } | undefined;
    return row ? { pid, ...row } : null;
  }
  private recordProof(kind: "run" | "worker", ownerId: string): void {
    const owner = localProcessOwner();
    this.db
      .prepare("INSERT OR REPLACE INTO owner_proofs VALUES(?,?,?,?,?)")
      .run(kind, ownerId, this.projectId, owner.endpoint, owner.verifier);
  }
  async tryAcquireWorker(callId: string, limit: number): Promise<boolean> {
    await this.ownerReady();
    const leases = this.db
      .prepare("SELECT id,pid FROM worker_leases WHERE project_id=?")
      .all(this.projectId) as { id: string; pid: number }[];
    const stale: { id: string; pid: number; owner: ProcessOwner | null }[] = [];
    for (const lease of leases) {
      const owner = this.proof("worker", lease.id, lease.pid);
      const state = owner
        ? await processOwnerState(owner)
        : legacyOwnerState(lease.pid);
      if (state === "dead") stale.push({ id: lease.id, pid: lease.pid, owner });
    }
    return this.db
      .transaction(() => {
        for (const lease of stale) {
          const current = this.db
            .prepare(
              "SELECT pid FROM worker_leases WHERE id=? AND project_id=?",
            )
            .get(lease.id, this.projectId) as { pid: number } | undefined;
          if (!current) continue;
          const proof = this.proof("worker", lease.id, current.pid);
          if (
            current.pid !== lease.pid ||
            proof?.pid !== lease.owner?.pid ||
            proof?.endpoint !== lease.owner?.endpoint ||
            proof?.verifier !== lease.owner?.verifier
          )
            continue;
          this.db
            .prepare("DELETE FROM worker_leases WHERE id=? AND project_id=?")
            .run(lease.id, this.projectId);
          this.db
            .prepare(
              "DELETE FROM owner_proofs WHERE kind='worker' AND id=? AND project_id=?",
            )
            .run(lease.id, this.projectId);
        }
        const count = this.db
          .prepare(
            "SELECT count(*) AS count FROM worker_leases WHERE project_id=?",
          )
          .get(this.projectId) as { count: number };
        if (count.count >= limit) return false;
        this.db
          .prepare("INSERT INTO worker_leases VALUES(?,?,?)")
          .run(callId, this.projectId, process.pid);
        this.recordProof("worker", callId);
        return true;
      })
      .immediate();
  }
  releaseWorker(callId: string): void {
    this.db.transaction(() => {
      const owner = this.proof("worker", callId, process.pid);
      if (!owner || owner.verifier !== localProcessOwner().verifier) return;
      this.db
        .prepare(
          "DELETE FROM worker_leases WHERE id=? AND project_id=? AND pid=?",
        )
        .run(callId, this.projectId, process.pid);
      this.db
        .prepare(
          "DELETE FROM owner_proofs WHERE kind='worker' AND id=? AND project_id=?",
        )
        .run(callId, this.projectId);
    })();
  }
  planSnapshotIds(): string[] {
    return [
      ...new Set(
        (this.all("plans") as ExecutionPlan[]).map((plan) => plan.snapshotId),
      ),
    ];
  }
  async backup(destination: string): Promise<void> {
    const target = await lstat(destination);
    if (!target.isFile() || target.isSymbolicLink() || target.size !== 0)
      throw new Error(
        "Run backup destination must be an exclusively reserved empty file",
      );
    await chmod(destination, 0o600);
    await this.db.backup(destination);
  }
  /** Cross-process reservations serialize paid dispatches, including parallel DAG calls. */
  reserveCall(
    ownerId: string,
    callId: string,
    provider: string,
    reservedUsd: number | null,
    ceiling: number | null,
    maxWorkerCalls?: number,
  ): void {
    if (
      reservedUsd !== null &&
      (!Number.isFinite(reservedUsd) || reservedUsd < 0)
    )
      throw new Error("Invalid inference reservation");
    this.db
      .transaction(() => {
        if (maxWorkerCalls !== undefined) {
          const count = this.db
            .prepare(
              "SELECT count(*) AS count FROM inference_calls WHERE project_id=? AND owner_id=? AND id LIKE 'worker-%'",
            )
            .get(this.projectId, ownerId) as { count: number };
          if (count.count >= maxWorkerCalls)
            throw new Error("Run exhausted its shared worker-turn budget");
        }
        const usage = this.usage(ownerId);
        if (
          ceiling !== null &&
          (reservedUsd === null ||
            usage.costUsd === null ||
            usage.costUsd + reservedUsd > ceiling)
        )
          throw new Error(
            "The next call exceeds the configured estimated cost budget",
          );
        this.db
          .prepare("INSERT INTO inference_calls VALUES(?,?,?,?,?,NULL)")
          .run(callId, this.projectId, ownerId, provider, reservedUsd);
      })
      .immediate();
  }
  settleCall(
    ownerId: string,
    callId: string,
    provider: string,
    usage: Usage,
  ): void {
    for (const value of [
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedTokens,
      usage.costUsd,
    ])
      if (value !== null && (!Number.isFinite(value) || value < 0))
        throw new Error("Invalid inference usage");
    this.db
      .transaction(() => {
        const row = this.db
          .prepare(
            "SELECT owner_id,reserved,usage_json FROM inference_calls WHERE id=? AND project_id=?",
          )
          .get(callId, this.projectId) as
          | {
              owner_id: string;
              reserved: number | null;
              usage_json: string | null;
            }
          | undefined;
        if (row && row.owner_id !== ownerId)
          throw new Error("Inference accounting owner mismatch");
        if (row?.usage_json) {
          if (row.usage_json !== JSON.stringify(usage))
            throw new Error("Inference usage was already settled differently");
          return;
        }
        if (row)
          this.db
            .prepare(
              "UPDATE inference_calls SET usage_json=? WHERE id=? AND project_id=?",
            )
            .run(JSON.stringify(usage), callId, this.projectId);
        else
          this.db
            .prepare("INSERT INTO inference_calls VALUES(?,?,?,?,?,?)")
            .run(
              callId,
              this.projectId,
              ownerId,
              provider,
              usage.costUsd,
              JSON.stringify(usage),
            );
      })
      .immediate();
  }
  usage(ownerId: string): Usage {
    const total: Usage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      estimated: false,
    };
    const rows = this.db
      .prepare(
        "SELECT reserved,usage_json FROM inference_calls WHERE project_id=? AND owner_id=?",
      )
      .all(this.projectId, ownerId) as {
      reserved: number | null;
      usage_json: string | null;
    }[];
    for (const row of rows) {
      const usage: Usage = row.usage_json
        ? JSON.parse(row.usage_json)
        : {
            inputTokens: null,
            outputTokens: null,
            cachedTokens: null,
            costUsd: row.reserved,
            estimated: true,
          };
      for (const key of [
        "inputTokens",
        "outputTokens",
        "cachedTokens",
        "costUsd",
      ] as const)
        total[key] =
          total[key] === null || usage[key] === null
            ? null
            : total[key]! + usage[key]!;
      total.estimated ||= usage.estimated;
    }
    return total;
  }
  savePlan(plan: ExecutionPlan): void {
    this.db
      .prepare("INSERT INTO plans VALUES(?,?,?)")
      .run(plan.id, this.projectId, JSON.stringify(plan));
  }
  plan(id: string): ExecutionPlan {
    return this.one("plans", id);
  }
  saveRun(run: RunRecord): void {
    this.db
      .prepare("INSERT OR REPLACE INTO runs VALUES(?,?,?)")
      .run(run.id, this.projectId, JSON.stringify(run));
  }
  reserve(run: RunRecord, limit: number): void {
    this.db
      .transaction(() => {
        const active = this.runs().filter((r) =>
          ["planned", "running", "verifying"].includes(r.status),
        );
        if (active.length >= limit)
          throw new Error("Project concurrency limit reached");
        if (this.runs().some((existing) => existing.plan.id === run.plan.id))
          throw new Error(
            "A plan can start only one run; resume that run or create a fresh plan",
          );
        this.saveRun(run);
        this.db
          .prepare("INSERT OR REPLACE INTO run_owners VALUES(?,?)")
          .run(run.id, process.pid);
        this.recordProof("run", run.id);
      })
      .immediate();
  }
  reserveResume(runId: string, limit: number): RunRecord {
    return this.db
      .transaction(() => {
        const run = this.run(runId);
        if (
          !["failed", "cancelled", "needs_reconciliation"].includes(run.status)
        )
          throw new Error("Run does not need resumption");
        this.assertResumeAccounting(runId);
        if (
          this.runs().filter((r) =>
            ["planned", "running", "verifying"].includes(r.status),
          ).length >= limit
        )
          throw new Error("Project concurrency limit reached");
        const resumed = {
          ...run,
          status: "planned" as const,
          updatedAt: now(),
        };
        this.saveRun(resumed);
        this.db
          .prepare("INSERT OR REPLACE INTO run_owners VALUES(?,?)")
          .run(run.id, process.pid);
        this.recordProof("run", run.id);
        return resumed;
      })
      .immediate();
  }
  claim(runId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare("INSERT OR REPLACE INTO run_owners VALUES(?,?)")
        .run(runId, process.pid);
      this.recordProof("run", runId);
    })();
  }
  run(id: string): RunRecord {
    return this.one("runs", id);
  }
  runs(): RunRecord[] {
    return this.all("runs").reverse() as RunRecord[];
  }
  events(runId: string): RunEvent[] {
    return this.db
      .prepare(
        "SELECT json FROM run_events WHERE project_id=? AND run_id=? ORDER BY seq",
      )
      .all(this.projectId, runId)
      .map((r) => JSON.parse((r as { json: string }).json));
  }
  event(
    runId: string,
    type: string,
    data: Record<string, unknown>,
    stepId?: string,
  ): RunEvent {
    const clean = (value: unknown): unknown =>
      typeof value === "string"
        ? redact(value)
        : Array.isArray(value)
          ? value.map(clean)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value).map(([k, v]) => [
                  k,
                  /api.?key|password|credential|secret|token/i.test(k) &&
                  !["inputTokens", "outputTokens", "cachedTokens"].includes(k)
                    ? "[REDACTED]"
                    : clean(v),
                ]),
              )
            : value;
    const safeData = clean(data) as Record<string, unknown>;
    const event: RunEvent = {
      version: "1.0.0",
      id: id(),
      runId,
      projectId: this.projectId,
      at: now(),
      type,
      stepId,
      data: safeData,
    };
    this.db
      .prepare(
        "INSERT INTO run_events(id,run_id,project_id,json) VALUES(?,?,?,?)",
      )
      .run(event.id, runId, this.projectId, JSON.stringify(event));
    return event;
  }
  decision(record: DecisionRecord): void {
    this.db
      .prepare("INSERT INTO decisions VALUES(?,?,?)")
      .run(record.id, this.projectId, JSON.stringify(record));
  }
  decisions(): DecisionRecord[] {
    return this.all("decisions").reverse() as DecisionRecord[];
  }
  async recoverInterrupted(): Promise<void> {
    await this.ownerReady();
    for (const run of this.runs())
      if (["planned", "running", "verifying"].includes(run.status)) {
        const original = this.db
          .prepare("SELECT pid FROM run_owners WHERE run_id=?")
          .get(run.id) as { pid: number } | undefined;
        const owner = original ? this.proof("run", run.id, original.pid) : null;
        const state = owner
          ? await processOwnerState(owner)
          : legacyOwnerState(original?.pid);
        if (state !== "dead") continue;
        this.db.transaction(() => {
          const current = this.db
            .prepare("SELECT pid FROM run_owners WHERE run_id=?")
            .get(run.id) as { pid: number } | undefined;
          const currentOwner = current
            ? this.proof("run", run.id, current.pid)
            : null;
          if (
            current?.pid !== original?.pid ||
            currentOwner?.endpoint !== owner?.endpoint ||
            currentOwner?.verifier !== owner?.verifier
          )
            return;
          const latest = this.run(run.id);
          if (!["planned", "running", "verifying"].includes(latest.status))
            return;
          this.saveRun({
            ...latest,
            status: "needs_reconciliation",
            updatedAt: now(),
            error:
              "The previous process stopped during execution. Inspect its workspace and events before retrying.",
          });
          this.event(run.id, "recovery.required", {});
        })();
      }
  }
  /** An aggregate from older engines cannot establish individual worker turns. */
  assertResumeAccounting(runId: string): void {
    this.db.transaction(() => {
      const run = this.run(runId);
      const rows = this.db
        .prepare(
          "SELECT id,owner_id FROM inference_calls WHERE project_id=? AND (owner_id=? OR owner_id=?)",
        )
        .all(this.projectId, run.plan.id, run.id) as {
        id: string;
        owner_id: string;
      }[];
      const fail = () => {
        throw new Error(
          "Historical inference accounting is incomplete; reconcile the retained cost and worker-call history before resuming this run. Aggregate usage alone cannot restore a safe budget.",
        );
      };
      if (rows.some((row) => row.owner_id !== run.plan.id)) fail();
      const total = this.usage(run.plan.id);
      for (const key of [
        "inputTokens",
        "outputTokens",
        "cachedTokens",
        "costUsd",
      ] as const) {
        const historical = run.usage[key],
          recorded = total[key];
        // Newer unresolved reservations may make ledger totals less precise, but
        // a missing ledger must never replace an unknown/greater historical total.
        if (
          recorded !== null &&
          (historical === null || historical > recorded + 1e-9)
        )
          fail();
      }
      const events = this.events(runId);
      const workerCalls = rows.filter((row) =>
        row.id.startsWith("worker-"),
      ).length;
      const dispatched = events.filter(
        (event) => event.type === "worker.dispatched",
      ).length;
      const completed = events.filter(
        (event) => event.type === "worker.completed",
      ).length;
      if (Math.max(dispatched, completed) > workerCalls) fail();
      const callIds = new Set(rows.map((row) => row.id));
      for (const event of events) {
        if (
          !event.type.startsWith("decision.") ||
          !Array.isArray(event.data.callUsage)
        )
          continue;
        for (const usage of event.data.callUsage) {
          if (
            usage &&
            typeof usage === "object" &&
            "callId" in usage &&
            typeof usage.callId === "string" &&
            !callIds.has(usage.callId)
          )
            fail();
        }
      }
    })();
  }
  accountingSummary(): AccountingSummary {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT owner_id,reserved,usage_json FROM inference_calls WHERE project_id=?",
        )
        .all(this.projectId) as {
        owner_id: string;
        reserved: number | null;
        usage_json: string | null;
      }[];
      const plans = this.all("plans") as ExecutionPlan[];
      return summarizeInferenceCalls(
        rows,
        plans.map((plan) => plan.id),
        this.runs(),
      );
    })();
  }
  private one<T>(table: string, id: string): T {
    const row = this.db
      .prepare(`SELECT json FROM ${table} WHERE id=? AND project_id=?`)
      .get(id, this.projectId) as { json: string } | undefined;
    if (!row) throw new Error(`${table}: record not found`);
    return JSON.parse(row.json) as T;
  }
  private all(table: string): unknown[] {
    return this.db
      .prepare(`SELECT json FROM ${table} WHERE project_id=? ORDER BY rowid`)
      .all(this.projectId)
      .map((r) => JSON.parse((r as { json: string }).json));
  }
  close(): void {
    this.db.close();
  }
}
