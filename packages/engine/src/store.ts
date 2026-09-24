import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { lstat, chmod } from "node:fs/promises";
import path from "node:path";
import type {
  DecisionRecord,
  DualPlanPreflight,
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
import {
  outcomeFeedbackSchema,
  outcomeHash,
  validateOutcomeFeedback,
} from "./outcome-feedback.js";

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
  readonly schemaVersion = 5;
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
    if (version > 5) {
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
      CREATE TABLE IF NOT EXISTS dual_worker_claims(project_id TEXT NOT NULL,owner_id TEXT NOT NULL,plan_id TEXT NOT NULL,run_id TEXT,scope_sha256 TEXT NOT NULL,PRIMARY KEY(project_id,owner_id),UNIQUE(project_id,plan_id),UNIQUE(project_id,run_id));
      CREATE TABLE IF NOT EXISTS worker_leases(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,pid INTEGER NOT NULL);
      PRAGMA user_version = 5;`);
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
  /** Verify a completed, metered, task-bound pair without starting a new attempt. */
  assertDualPreflight(preflight: DualPlanPreflight, policyHash: string): void {
    const row = this.dualAttempt(preflight.ownerId);
    if (
      !row ||
      row.state !== "completed" ||
      row.request_hash !== preflight.requestHash ||
      row.policy_hash !== policyHash ||
      row.task_id !== preflight.binding.taskId ||
      row.source_sha256 !== preflight.binding.sourceSha256 ||
      !row.evidence_json
    )
      throw new Error("A matching completed dual consultation is required");
    const evidence = JSON.parse(row.evidence_json) as DualConsultEvidence;
    if (
      !evidence.ready ||
      evidence.projectId !== this.projectId ||
      evidence.ownerId !== preflight.ownerId ||
      evidence.requestHash !== preflight.requestHash ||
      evidence.policyVersion !== policyHash ||
      evidence.binding.taskId !== preflight.binding.taskId ||
      evidence.binding.sourceSha256 !== preflight.binding.sourceSha256
    )
      throw new Error(
        "Retained dual evidence does not match the selected task",
      );
    const callIds = new Set<string>();
    for (const provider of ["laya", "jev"] as const) {
      const item = evidence.observations[provider];
      if (
        !item?.valid ||
        item.provider !== provider ||
        !item.callId ||
        item.observedModel !== item.configuredModel ||
        item.choices.dispatch !== "proceed" ||
        item.usage?.callId !== item.callId ||
        item.usage.outcome !== "completed" ||
        item.records.length !== 1 ||
        item.records[0]?.selected !== "proceed"
      )
        throw new Error("Both retained models must validly select proceed");
      callIds.add(item.callId);
      const call = this.db
        .prepare(
          "SELECT usage_json FROM inference_calls WHERE project_id=? AND owner_id=? AND id=? AND provider=?",
        )
        .get(this.projectId, preflight.ownerId, item.callId, provider) as
        { usage_json: string | null } | undefined;
      if (!call?.usage_json)
        throw new Error("Dual consultation is missing retained call usage");
      const saved = this.db
        .prepare("SELECT json FROM decisions WHERE project_id=? AND id=?")
        .get(this.projectId, item.records[0]!.id) as { json: string } | undefined;
      if (!saved ||
          outcomeHash(JSON.parse(saved.json)) !== outcomeHash(item.records[0]))
        throw new Error("Dual consultation decision differs from its retained record");
    }
    if (callIds.size !== 2)
      throw new Error("Dual consultation calls are not independent");
  }
  assertAvailableDualPreflight(
    preflight: DualPlanPreflight,
    policyHash: string,
  ): void {
    this.assertDualPreflight(preflight, policyHash);
    const claimed = this.db
      .prepare(
        "SELECT 1 FROM dual_worker_claims WHERE project_id=? AND owner_id=?",
      )
      .get(this.projectId, preflight.ownerId);
    if (claimed)
      throw new Error("Dual consultation is already claimed by another plan");
  }
  assertBoundDualPlan(plan: ExecutionPlan): void {
    const preflight = plan.dualPreflight;
    if (!preflight) throw new Error("Plan is missing dual preflight metadata");
    this.assertDualPreflight(preflight, plan.policyHash);
    const claim = this.db
      .prepare(
        "SELECT plan_id,scope_sha256 FROM dual_worker_claims WHERE project_id=? AND owner_id=?",
      )
      .get(this.projectId, preflight.ownerId) as
      { plan_id: string; scope_sha256: string } | undefined;
    if (
      claim?.plan_id !== plan.id ||
      claim.scope_sha256 !== preflight.scopeSha256
    )
      throw new Error(
        "Dual consultation is not claimed by this plan and scope",
      );
  }
  /** Called again at each worker dispatch, including resumed runs. */
  assertBoundDualRun(run: RunRecord): void {
    this.assertBoundDualPlan(run.plan);
    const preflight = run.plan.dualPreflight!;
    if (
      !run.dualPreflight ||
      JSON.stringify(run.dualPreflight) !== JSON.stringify(preflight)
    )
      throw new Error("Run dual preflight differs from its plan");
    const claim = this.db
      .prepare(
        "SELECT run_id FROM dual_worker_claims WHERE project_id=? AND owner_id=?",
      )
      .get(this.projectId, preflight.ownerId) as
      { run_id: string | null } | undefined;
    if (claim?.run_id !== run.id)
      throw new Error("Dual consultation is not claimed by this run");
  }
  savePlan(plan: ExecutionPlan): void {
    this.db
      .transaction(() => {
        if (plan.dualPreflight) {
          this.assertDualPreflight(plan.dualPreflight, plan.policyHash);
          this.db
            .prepare("INSERT INTO dual_worker_claims VALUES(?,?,?,?,?)")
            .run(
              this.projectId,
              plan.dualPreflight.ownerId,
              plan.id,
              null,
              plan.dualPreflight.scopeSha256,
            );
        }
        this.db
          .prepare("INSERT INTO plans VALUES(?,?,?)")
          .run(plan.id, this.projectId, JSON.stringify(plan));
      })
      .immediate();
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
        if (run.plan.dualPreflight) {
          this.assertBoundDualPlan(run.plan);
          if (
            !run.dualPreflight ||
            JSON.stringify(run.dualPreflight) !==
              JSON.stringify(run.plan.dualPreflight)
          )
            throw new Error("Run dual preflight differs from its plan");
          const claim = this.db
            .prepare(
              "UPDATE dual_worker_claims SET run_id=? WHERE project_id=? AND owner_id=? AND plan_id=? AND run_id IS NULL",
            )
            .run(
              run.id,
              this.projectId,
              run.plan.dualPreflight.ownerId,
              run.plan.id,
            );
          if (claim.changes !== 1)
            throw new Error(
              "Dual consultation was already used by another run",
            );
        }
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
        if (run.plan.dualPreflight) this.assertBoundDualRun(run);
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
  /** Preserve an external review claim after verifying GE's dual, scope, run and check binding. */
  recordOutcomeFeedback(input: unknown, consultationBytes: Buffer): RunEvent {
    return this.db.transaction(() => {
      const candidate = outcomeFeedbackSchema.parse(input);
      const attempt = this.dualAttempt(candidate.dispatch_id);
      if (attempt?.state !== "completed" || !attempt.evidence_json)
        throw new Error("Outcome feedback requires a completed GE dual attempt");
      const retained = JSON.parse(attempt.evidence_json) as DualConsultEvidence;
      const run = this.run(candidate.run_id);
      this.assertBoundDualRun(run);
      const feedback = validateOutcomeFeedback(candidate, consultationBytes, retained, run);
      const events = this.events(run.id);
      const published = events.filter((event) => event.type === "publication.started");
      if (published.length !== 1 ||
          published[0]!.data.mode !== "none" ||
          published[0]!.data.snapshotHash !== feedback.workspace_snapshot_sha256 ||
          events.filter((event) => event.type === "publication.completed").length !== 1 ||
          events.filter((event) => event.type === "run.succeeded").length !== 1)
        throw new Error("Feedback snapshot is not the retained verified GE run");
      for (const [provider, observation] of Object.entries(retained.observations)) {
        const call = this.db.prepare("SELECT usage_json FROM inference_calls WHERE project_id=? AND owner_id=? AND id=? AND provider=?")
          .get(this.projectId, feedback.dispatch_id, observation.callId, provider) as
          { usage_json: string | null } | undefined;
        if (!call?.usage_json) throw new Error("Outcome feedback lacks settled decision usage");
        const settled = JSON.parse(call.usage_json) as Record<string, unknown>;
        const reported = observation.usage;
        if (!reported || reported.callId !== observation.callId ||
            reported.provider !== provider || reported.outcome !== "completed" ||
            settled.inputTokens !== reported.inputTokens ||
            settled.outputTokens !== reported.outputTokens ||
            settled.cachedTokens !== 0 ||
            settled.costUsd !== reported.chargedUsd ||
            settled.estimated !== (reported.reportedCostUsd === null))
          throw new Error("Settled decision usage differs from the retained observation");
      }
      for (const record of Object.values(retained.observations).flatMap((item) => item.records)) {
        const saved = this.db.prepare("SELECT json FROM decisions WHERE project_id=? AND id=?")
          .get(this.projectId, record.id) as { json: string } | undefined;
        if (!saved || outcomeHash(JSON.parse(saved.json)) !== outcomeHash(record))
          throw new Error("Outcome feedback decision differs from retained GE record");
      }
      const prior = this.events(feedback.run_id).filter((event) => event.type === "learning.external-claim-unverified");
      if (prior.length) {
        if (prior.length !== 1 || outcomeHash(prior[0]!.data.feedback) !== outcomeHash(feedback))
          throw new Error("GE run already has different reviewed outcome feedback");
        return prior[0]!;
      }
      return this.event(feedback.run_id, "learning.external-claim-unverified", {
        status: "UNVERIFIED_EXTERNAL_CLAIM", feedback,
      });
    }).immediate();
  }
  outcomeSummary() {
    let unverifiedClaims = 0;
    const groups = new Map<string, {
      provider: "laya" | "jev"; model: string; choice: "proceed";
      observed: number; automatedPassed: number; failed: number; cancelled: number;
      knownDecisionCostUsd: number; unknownDecisionCost: number;
    }>();
    let observedRuns = 0;
    for (const run of this.runs()) {
      const events = this.events(run.id).filter((event) => event.type === "learning.external-claim-unverified");
      if (events.length > 1) throw new Error("GE run has conflicting outcome feedback");
      if (events.length) {
        if (events[0]!.data.status !== "UNVERIFIED_EXTERNAL_CLAIM")
          throw new Error("Outcome claim has invalid verification state");
        outcomeFeedbackSchema.parse(events[0]!.data.feedback);
        unverifiedClaims++;
      }
      if (!run.plan?.dualPreflight ||
          !["succeeded", "failed", "cancelled"].includes(run.status)) continue;
      this.assertBoundDualRun(run);
      const attempt = this.dualAttempt(run.plan.dualPreflight.ownerId);
      if (!attempt?.evidence_json) throw new Error("Observed run lacks its dual consultation");
      const dual = JSON.parse(attempt.evidence_json) as DualConsultEvidence;
      const runEvents = this.events(run.id);
      if (run.status === "succeeded") {
        const published = runEvents.filter((event) => event.type === "publication.started");
        if (run.plan.publication !== "none" ||
            run.completion?.automatedChecksPassed !== true ||
            run.completion.humanAcceptance !== "pending" ||
            published.length !== 1 || published[0]!.data.mode !== "none" ||
            !/^[a-f0-9]{64}$/.test(String(published[0]!.data.snapshotHash)) ||
            runEvents.filter((event) => event.type === "publication.completed").length !== 1 ||
            runEvents.filter((event) => event.type === "run.succeeded").length !== 1)
          throw new Error("Observed success lacks the retained verified snapshot");
      } else {
        const stopped = runEvents.filter((event) => event.type === "run.stopped");
        if (!stopped.length || stopped.at(-1)!.data.status !== run.status)
          throw new Error("Observed failure lacks its terminal run event");
      }
      observedRuns++;
      for (const provider of ["laya", "jev"] as const) {
        const item = dual.observations[provider];
        const key = JSON.stringify([provider, item.configuredModel, item.choices.dispatch]);
        const group = groups.get(key) ?? {
          provider, model: item.configuredModel, choice: "proceed" as const,
          observed: 0, automatedPassed: 0, failed: 0, cancelled: 0,
          knownDecisionCostUsd: 0, unknownDecisionCost: 0,
        };
        const settled = this.db.prepare(
          "SELECT usage_json FROM inference_calls WHERE project_id=? AND owner_id=? AND id=? AND provider=?",
        ).get(this.projectId, run.plan.dualPreflight.ownerId, item.callId, provider) as
          { usage_json: string | null } | undefined;
        if (!settled?.usage_json) throw new Error("Observed run lacks settled decision usage");
        const usage = JSON.parse(settled.usage_json) as Usage;
        if (usage.estimated || usage.costUsd === null || !Number.isFinite(usage.costUsd))
          group.unknownDecisionCost++;
        else group.knownDecisionCostUsd += usage.costUsd;
        group.observed++;
        if (run.status === "succeeded") group.automatedPassed++;
        else if (run.status === "failed") group.failed++;
        else group.cancelled++;
        groups.set(key, group);
      }
    }
    return { version: "1.0.0" as const, kind: "advisory-ge-run-observations" as const,
      observedRuns, unverifiedClaims,
      groups: [...groups.values()].sort((left, right) =>
        JSON.stringify([left.provider, left.model]).localeCompare(JSON.stringify([right.provider, right.model]))),
      localDecisionContextEligible: true as const, routingEligible: false as const,
      promotionEligible: false as const, completionAuthority: false as const };
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
