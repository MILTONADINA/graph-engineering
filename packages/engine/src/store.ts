import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
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
import type {
  DualConsultAttemptMeta,
  DualConsultEvidence,
  TaskBinding,
} from "./decision-dual.js";
import {
  summarizeInferenceCalls,
  type AccountingSummary,
} from "./accounting.js";

type DualConsultState = "in-flight" | "completed" | "uncertain";
interface DualConsultRow {
  owner_id: string;
  task_id: string;
  source_sha256: string;
  policy_hash: string;
  request_hash: string;
  state: DualConsultState;
  evidence_json: string | null;
  failure: string | null;
  created_at: string;
  updated_at: string;
}
export interface DualConsultStatus {
  ownerId: string;
  binding: TaskBinding;
  policyVersion: string;
  requestHash: string;
  state: DualConsultState;
  evidence: DualConsultEvidence | null;
  failure: string | null;
  createdAt: string;
  updatedAt: string;
}
function dualStatus(row: DualConsultRow): DualConsultStatus {
  return {
    ownerId: row.owner_id,
    binding: { taskId: row.task_id, sourceSha256: row.source_sha256 },
    policyVersion: row.policy_hash,
    requestHash: row.request_hash,
    state: row.state,
    evidence: row.evidence_json ? JSON.parse(row.evidence_json) : null,
    failure: row.failure,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Open the retained attempt without creating a database or making a model call. */
export function readDualConsultStatus(
  dataDir: string,
  projectId: string,
  ownerId: string,
): DualConsultStatus | null {
  const file = path.join(dataDir, "runs.sqlite");
  if (!existsSync(file)) return null;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='dual_consult_attempts'",
      )
      .get();
    if (!table) return null;
    const row = db
      .prepare(
        "SELECT * FROM dual_consult_attempts WHERE project_id=? AND owner_id=?",
      )
      .get(projectId, ownerId) as DualConsultRow | undefined;
    return row ? dualStatus(row) : null;
  } finally {
    db.close();
  }
}

/** Read a persisted managed-run receipt without opening or recovering the engine. */
export function readRunReceipt(
  dataDir: string,
  projectId: string,
  runId: string,
): { run: RunRecord; events: RunEvent[] } {
  const file = path.join(dataDir, "runs.sqlite");
  if (!existsSync(file)) throw new Error("Run receipt database does not exist");
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      const row = db
        .prepare("SELECT json FROM runs WHERE project_id=? AND id=?")
        .get(projectId, runId) as { json: string } | undefined;
      if (!row) throw new Error("Run receipt does not exist for this project");
      const events = db
        .prepare(
          "SELECT json FROM run_events WHERE project_id=? AND run_id=? ORDER BY seq",
        )
        .all(projectId, runId)
        .map((item) => JSON.parse((item as { json: string }).json) as RunEvent);
      return { run: JSON.parse(row.json) as RunRecord, events };
    })();
  } finally {
    db.close();
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
      CREATE TABLE IF NOT EXISTS dual_consult_attempts(project_id TEXT NOT NULL,owner_id TEXT NOT NULL,task_id TEXT NOT NULL,source_sha256 TEXT NOT NULL,policy_hash TEXT NOT NULL,request_hash TEXT NOT NULL,state TEXT NOT NULL,evidence_json TEXT,failure TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,owner_id));
      CREATE TABLE IF NOT EXISTS worker_leases(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,pid INTEGER NOT NULL);
      PRAGMA user_version = 4;`);
      })
      .immediate();
  }
  tryAcquireWorker(callId: string, limit: number): boolean {
    return this.db
      .transaction(() => {
        const leases = this.db
          .prepare("SELECT id,pid FROM worker_leases WHERE project_id=?")
          .all(this.projectId) as { id: string; pid: number }[];
        for (const lease of leases) {
          try {
            process.kill(lease.pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH")
              this.db
                .prepare(
                  "DELETE FROM worker_leases WHERE id=? AND project_id=?",
                )
                .run(lease.id, this.projectId);
          }
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
        return true;
      })
      .immediate();
  }
  releaseWorker(callId: string): void {
    this.db
      .prepare(
        "DELETE FROM worker_leases WHERE id=? AND project_id=? AND pid=?",
      )
      .run(callId, this.projectId, process.pid);
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
        return resumed;
      })
      .immediate();
  }
  claim(runId: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO run_owners VALUES(?,?)")
      .run(runId, process.pid);
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
  private dualAttempt(ownerId: string): DualConsultRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM dual_consult_attempts WHERE project_id=? AND owner_id=?",
      )
      .get(this.projectId, ownerId) as DualConsultRow | undefined;
  }
  /** One owner may dispatch one exact request; completed evidence is replayable. */
  beginDualConsultAttempt(
    meta: DualConsultAttemptMeta,
  ): DualConsultEvidence | null {
    return this.db
      .transaction(() => {
        if (meta.projectId !== this.projectId)
          throw new Error("Decision attempt project mismatch");
        const prior = this.dualAttempt(meta.ownerId);
        if (prior) {
          if (
            prior.task_id !== meta.binding.taskId ||
            prior.source_sha256 !== meta.binding.sourceSha256 ||
            prior.policy_hash !== meta.policyVersion ||
            prior.request_hash !== meta.requestHash
          )
            throw new Error(
              "Decision ledger owner is bound to a different task/source, policy or request",
            );
          if (prior.state === "completed" && prior.evidence_json) {
            const evidence = JSON.parse(
              prior.evidence_json,
            ) as DualConsultEvidence;
            if (evidence.ready) {
              for (const [provider, observation] of Object.entries(
                evidence.observations,
              )) {
                if (
                  !observation.valid ||
                  !observation.callId ||
                  observation.usage?.callId !== observation.callId
                )
                  throw new Error("Completed decision evidence is incomplete");
                const call = this.db
                  .prepare(
                    "SELECT usage_json FROM inference_calls WHERE project_id=? AND owner_id=? AND id=? AND provider=?",
                  )
                  .get(
                    this.projectId,
                    meta.ownerId,
                    observation.callId,
                    provider,
                  ) as { usage_json: string | null } | undefined;
                if (!call?.usage_json)
                  throw new Error(
                    "Completed decision is missing retained call usage",
                  );
                for (const record of observation.records) {
                  const saved = this.db
                    .prepare(
                      "SELECT 1 FROM decisions WHERE project_id=? AND id=?",
                    )
                    .get(this.projectId, record.id);
                  if (!saved)
                    throw new Error(
                      "Completed decision is missing a retained record",
                    );
                }
              }
              return evidence;
            }
          }
          throw new Error(
            "Decision attempt is in-flight or uncertain; reconcile before using a new owner",
          );
        }
        const calls = this.db
          .prepare(
            "SELECT count(*) AS count FROM inference_calls WHERE project_id=? AND owner_id=?",
          )
          .get(this.projectId, meta.ownerId) as { count: number };
        if (calls.count || this.events(meta.ownerId).length)
          throw new Error("Decision ledger owner has unbound prior history");
        const at = now();
        this.db
          .prepare(
            "INSERT INTO dual_consult_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            this.projectId,
            meta.ownerId,
            meta.binding.taskId,
            meta.binding.sourceSha256,
            meta.policyVersion,
            meta.requestHash,
            "in-flight",
            null,
            null,
            at,
            at,
          );
        return null;
      })
      .immediate();
  }
  /** Persist all observations and the terminal state in one transaction. */
  finishDualConsultAttempt(evidence: DualConsultEvidence): void {
    this.db
      .transaction(() => {
        const row = this.dualAttempt(evidence.ownerId);
        if (
          !row ||
          row.state !== "in-flight" ||
          row.request_hash !== evidence.requestHash ||
          row.policy_hash !== evidence.policyVersion ||
          row.task_id !== evidence.binding.taskId ||
          row.source_sha256 !== evidence.binding.sourceSha256 ||
          evidence.projectId !== this.projectId
        )
          throw new Error(
            "Decision attempt changed before evidence was retained",
          );
        if (
          evidence.ready !==
            (evidence.observations.laya.valid &&
              evidence.observations.jev.valid) ||
          (evidence.ready &&
            (!evidence.observations.laya.callId ||
              !evidence.observations.jev.callId ||
              evidence.observations.laya.callId ===
                evidence.observations.jev.callId))
        )
          throw new Error(
            "Decision evidence readiness does not match its observations",
          );
        for (const observation of Object.values(evidence.observations))
          for (const record of observation.records) {
            if (
              record.projectId !== this.projectId ||
              record.policyVersion !== evidence.policyVersion
            )
              throw new Error(
                "Decision record does not match the retained attempt",
              );
            this.decision(record);
          }
        this.event(evidence.ownerId, "decision.dual-consult", {
          binding: evidence.binding,
          requestHash: evidence.requestHash,
          policyVersion: evidence.policyVersion,
          ready: evidence.ready,
          observations: Object.fromEntries(
            Object.entries(evidence.observations).map(([provider, item]) => [
              provider,
              {
                callId: item.callId,
                observedModel: item.observedModel,
                choices: item.choices,
                valid: item.valid,
                failure: item.failure,
              },
            ]),
          ),
        });
        const failure = evidence.ready
          ? null
          : Object.values(evidence.observations)
              .flatMap((item) => (item.failure ? [item.failure] : []))
              .join("; ");
        this.db
          .prepare(
            "UPDATE dual_consult_attempts SET state=?,evidence_json=?,failure=?,updated_at=? WHERE project_id=? AND owner_id=?",
          )
          .run(
            evidence.ready ? "completed" : "uncertain",
            JSON.stringify(evidence),
            failure,
            now(),
            this.projectId,
            evidence.ownerId,
          );
      })
      .immediate();
  }
  markDualConsultUncertain(meta: DualConsultAttemptMeta, reason: string): void {
    this.db
      .transaction(() => {
        const row = this.dualAttempt(meta.ownerId);
        if (!row || row.request_hash !== meta.requestHash)
          throw new Error(
            "Decision attempt identity changed during failure recording",
          );
        if (row.state !== "in-flight") return;
        this.db
          .prepare(
            "UPDATE dual_consult_attempts SET state='uncertain',failure=?,updated_at=? WHERE project_id=? AND owner_id=?",
          )
          .run(redact(reason), now(), this.projectId, meta.ownerId);
      })
      .immediate();
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
  recoverInterrupted(): void {
    for (const run of this.runs())
      if (["planned", "running", "verifying"].includes(run.status)) {
        const owner = this.db
          .prepare("SELECT pid FROM run_owners WHERE run_id=?")
          .get(run.id) as { pid: number } | undefined;
        if (owner) {
          try {
            process.kill(owner.pid, 0);
            continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
          }
        }
        this.saveRun({
          ...run,
          status: "needs_reconciliation",
          updatedAt: now(),
          error:
            "The previous process stopped during execution. Inspect its workspace and events before retrying.",
        });
        this.event(run.id, "recovery.required", {});
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
