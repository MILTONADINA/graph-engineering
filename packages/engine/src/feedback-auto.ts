import Database from "better-sqlite3";
import { closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import {
  assertProjectPolicy,
  type ProjectPolicy,
} from "@graph-engineering/contracts";
import {
  AUTOMATIC_FEEDBACK_COMMANDS,
  buildFeedbackReport,
  ERROR_KINDS,
  FEEDBACK_REPOSITORY,
  feedbackDir,
  feedbackReportText,
  type ErrorKind,
} from "./feedback.js";
import { assertEndpoint } from "./policy.js";
import { command, hash, id } from "./util.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const MAX_STORED_ATTEMPTS = 256;
const API_ORIGIN = "https://api.github.com";
const LEDGER_FILE = "automatic.sqlite";

export interface AutomaticFeedbackSettings {
  enabled: boolean;
  storedEnabled: boolean | null;
  source: "default" | "stored" | "environment" | "unavailable";
}
export type AutomaticFeedbackReason =
  | "disabled"
  | "state-unavailable"
  | "policy-denied"
  | "test-environment"
  | "cancelled"
  | "duplicate"
  | "rate-limited"
  | "notice-unavailable"
  | "transport-failed"
  | "invalid-response";
export type AutomaticFeedbackResult =
  | { status: "submitted"; issueUrl: string }
  | { status: "skipped" | "failed"; reason: AutomaticFeedbackReason };
export interface AutomaticFeedbackInput {
  engineVersion: string;
  command: string | undefined;
  kind: string;
  readPolicy: () => Promise<ProjectPolicy>;
  notify: (notice: string) => void;
  signal?: AbortSignal;
}
/** Injectable local dependencies for sealed tests; never a CLI transport option. */
export interface AutomaticFeedbackDependencies {
  dir?: string;
  now?: () => number;
  runCommand?: typeof command;
  environment?: NodeJS.ProcessEnv;
}

class FeedbackStateError extends Error {
  constructor() {
    super("Automatic feedback settings or attempt history are unavailable");
  }
}

interface Attempt {
  id: string;
  fingerprint: string;
  attemptedAt: number;
  state: "reserved" | "submitted" | "failed";
}

/** No credentials, raw messages, payloads or project identities enter this DB. */
function openLedger(
  dir: string,
  create: boolean,
  writable = create,
): Database.Database | undefined {
  let db: Database.Database | undefined;
  try {
    if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
    let directory;
    try {
      directory = lstatSync(dir);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT")
        return undefined;
      throw error;
    }
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (process.platform !== "win32" &&
        ((directory.mode & 0o077) !== 0 ||
          directory.uid !== process.getuid?.()))
    )
      throw new FeedbackStateError();
    const file = path.join(dir, LEDGER_FILE);
    let created = false;
    if (create) {
      try {
        const descriptor = openSync(
          file,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        closeSync(descriptor);
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    let info;
    try {
      info = lstatSync(file);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT")
        return undefined;
      throw error;
    }
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > 1024 * 1024 ||
      (process.platform !== "win32" &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
    )
      throw new FeedbackStateError();
    db = new Database(file, {
      readonly: !writable,
      fileMustExist: true,
      timeout: 1000,
    });
    if (created) {
      db.pragma("synchronous = FULL");
      db.transaction(() => {
        db!.exec(`
          CREATE TABLE automatic_settings (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            enabled INTEGER CHECK(enabled IS NULL OR enabled IN (0, 1))
          );
          INSERT INTO automatic_settings VALUES(1, NULL);
          CREATE TABLE attempts (
            id TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            attemptedAt INTEGER NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('reserved', 'submitted', 'failed'))
          );
          PRAGMA user_version = 1;
        `);
      }).immediate();
    }
    validateLedger(db);
    return db;
  } catch {
    db?.close();
    throw new FeedbackStateError();
  }
}

function validateLedger(db: Database.Database): boolean | null {
  if (db.pragma("user_version", { simple: true }) !== 1)
    throw new FeedbackStateError();
  const settings = db
    .prepare("SELECT id, enabled FROM automatic_settings")
    .all();
  const row = settings[0] as { id: unknown; enabled: unknown } | undefined;
  if (
    settings.length !== 1 ||
    row?.id !== 1 ||
    ![null, 0, 1].includes(row.enabled as number | null)
  )
    throw new FeedbackStateError();
  const attempts = db
    .prepare("SELECT id, fingerprint, attemptedAt, state FROM attempts LIMIT ?")
    .all(MAX_STORED_ATTEMPTS + 1) as Attempt[];
  if (
    attempts.length > MAX_STORED_ATTEMPTS ||
    attempts.some(
      (attempt) =>
        typeof attempt.id !== "string" ||
        !/^[a-f0-9-]{36}$/.test(attempt.id) ||
        typeof attempt.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(attempt.fingerprint) ||
        !Number.isSafeInteger(attempt.attemptedAt) ||
        attempt.attemptedAt < 0 ||
        !["reserved", "submitted", "failed"].includes(attempt.state),
    )
  )
    throw new FeedbackStateError();
  return row.enabled === null ? null : row.enabled === 1;
}

function optedOut(environment: NodeJS.ProcessEnv): boolean {
  return (
    environment.GRAPH_ENGINE_NO_FEEDBACK === "1" ||
    process.env.GRAPH_ENGINE_NO_FEEDBACK === "1"
  );
}

function readSettings(
  dir: string,
  environment: NodeJS.ProcessEnv,
): AutomaticFeedbackSettings {
  if (optedOut(environment))
    return { enabled: false, storedEnabled: null, source: "environment" };
  let db: Database.Database | undefined;
  try {
    db = openLedger(dir, false);
    const storedEnabled = db ? validateLedger(db) : null;
    return {
      enabled: storedEnabled !== false,
      storedEnabled,
      source: storedEnabled === null ? "default" : "stored",
    };
  } catch {
    return { enabled: false, storedEnabled: null, source: "unavailable" };
  } finally {
    db?.close();
  }
}

/** Read-only; missing state means enabled, malformed existing state means off. */
export async function readAutomaticFeedbackSettings(
  dir = feedbackDir(),
): Promise<AutomaticFeedbackSettings> {
  return readSettings(dir, process.env);
}

export async function setAutomaticFeedbackEnabled(
  enabled: boolean,
  dir = feedbackDir(),
): Promise<AutomaticFeedbackSettings> {
  if (typeof enabled !== "boolean") throw new FeedbackStateError();
  const db = openLedger(dir, true)!;
  try {
    db.transaction(() => {
      validateLedger(db);
      db.prepare("UPDATE automatic_settings SET enabled=? WHERE id=1").run(
        enabled ? 1 : 0,
      );
    }).immediate();
  } catch {
    throw new FeedbackStateError();
  } finally {
    db.close();
  }
  return readSettings(dir, process.env);
}

export function automaticFeedbackNotice(): string {
  return [
    `Automatic feedback is enabled by default. Eligible reports create PUBLIC issues at https://github.com/${FEEDBACK_REPOSITORY}/issues using your existing GitHub CLI login; they are attributed to that GitHub account, not anonymous.`,
    "Only engine version, a fixed command/phase, difficulty kind/count, OS/architecture and Node major version are sent. No notes, project names, paths, code, prompts, context, raw errors or credentials are included.",
    "Project outbound policy, daily attempt limits and duplicate suppression still apply. Disable with graph-engine feedback-config off or GRAPH_ENGINE_NO_FEEDBACK=1.",
  ].join("\n");
}

function automaticPayload(input: AutomaticFeedbackInput) {
  const kind: ErrorKind = ERROR_KINDS.some((entry) => entry.kind === input.kind)
    ? (input.kind as ErrorKind)
    : "unknown";
  const report = buildFeedbackReport({
    engineVersion:
      typeof input.engineVersion === "string" &&
      input.engineVersion.length <= 64
        ? input.engineVersion
        : "unknown",
    command: input.command,
    commands: AUTOMATIC_FEEDBACK_COMMANDS,
    kinds: [{ kind, count: 1 }],
  });
  if (
    !/^(?:aix|android|darwin|freebsd|linux|openbsd|sunos|win32)$/.test(
      report.os,
    )
  )
    report.os = "unknown";
  if (
    !/^(?:arm|arm64|ia32|loong64|mips|mipsel|ppc|ppc64|riscv64|s390|s390x|x64)$/.test(
      report.arch,
    )
  )
    report.arch = "unknown";
  if (!/^\d{1,3}$/.test(report.node)) report.node = "unknown";
  const body = JSON.stringify({
    title: `Automatic feedback: ${kind} (${report.command})`,
    body: feedbackReportText(report),
  });
  if (Buffer.byteLength(body, "utf8") > 8192) throw new FeedbackStateError();
  return { body, fingerprint: hash(report) };
}

/** No ambient provider, enterprise, proxy, debug or Node injection settings. */
function githubEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "GH_CONFIG_DIR",
    // Existing login keyrings may need the user's session bus/runtime paths.
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
  ])
    if (environment[name] !== undefined) result[name] = environment[name];
  return {
    ...result,
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_PAGER: "cat",
    NO_COLOR: "1",
  };
}

function testEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(
    environment.VITEST ||
    environment.NODE_TEST_CONTEXT ||
    environment.NODE_ENV === "test" ||
    environment.CI ||
    environment.GITHUB_ACTIONS,
  );
}

function reserveAttempt(
  dir: string,
  fingerprint: string,
  timestamp: number,
  environment: NodeJS.ProcessEnv,
): string | AutomaticFeedbackReason {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0)
    throw new FeedbackStateError();
  const db = openLedger(dir, true)!;
  try {
    return db
      .transaction(() => {
        const enabled = validateLedger(db);
        if (optedOut(environment) || enabled === false) return "disabled";
        // Future timestamps also consume the allowance: a backwards clock must
        // not restore headroom. Old attempts are never replayed.
        db.prepare("DELETE FROM attempts WHERE attemptedAt <= ?").run(
          timestamp - DAY_MS,
        );
        if (
          db
            .prepare("SELECT 1 FROM attempts WHERE fingerprint=?")
            .get(fingerprint)
        )
          return "duplicate";
        if (
          (
            db.prepare("SELECT COUNT(*) AS count FROM attempts").get() as {
              count: number;
            }
          ).count >= MAX_ATTEMPTS
        )
          return "rate-limited";
        const attemptId = id();
        db.prepare("INSERT INTO attempts VALUES(?,?,?,?)").run(
          attemptId,
          fingerprint,
          timestamp,
          "reserved",
        );
        return attemptId;
      })
      .immediate();
  } finally {
    db.close();
  }
}

function finishAttempt(
  dir: string,
  attemptId: string,
  state: "submitted" | "failed",
): void {
  const db = openLedger(dir, false, true);
  if (!db) throw new FeedbackStateError();
  try {
    if (
      db
        .prepare("UPDATE attempts SET state=? WHERE id=? AND state='reserved'")
        .run(state, attemptId).changes !== 1
    )
      throw new FeedbackStateError();
  } finally {
    db.close();
  }
}

/** One fixed-destination attempt; failures never alter the failed CLI command. */
export async function submitAutomaticFeedback(
  input: AutomaticFeedbackInput,
  dependencies: AutomaticFeedbackDependencies = {},
): Promise<AutomaticFeedbackResult> {
  const environment = dependencies.environment ?? process.env;
  const dir = dependencies.dir ?? feedbackDir();
  const skipped = (
    reason: AutomaticFeedbackReason,
  ): AutomaticFeedbackResult => ({
    status: "skipped",
    reason,
  });
  const stopped = (): AutomaticFeedbackReason | undefined => {
    if (optedOut(environment)) return "disabled";
    if (input.signal?.aborted) return "cancelled";
    if (
      !dependencies.runCommand &&
      (testEnvironment(environment) || testEnvironment(process.env))
    )
      return "test-environment";
    return undefined;
  };
  const initialStop = stopped();
  if (initialStop) return skipped(initialStop);
  const settings = readSettings(dir, environment);
  if (!settings.enabled)
    return skipped(
      settings.source === "unavailable" ? "state-unavailable" : "disabled",
    );
  const allowPolicy = async () => {
    const policy = structuredClone(await input.readPolicy());
    assertProjectPolicy(policy);
    assertEndpoint(API_ORIGIN, policy);
  };
  try {
    await allowPolicy();
  } catch {
    return skipped("policy-denied");
  }
  let payload: ReturnType<typeof automaticPayload>;
  try {
    payload = automaticPayload(input);
  } catch {
    return skipped("state-unavailable");
  }
  try {
    input.notify(automaticFeedbackNotice());
  } catch {
    return skipped("notice-unavailable");
  }
  try {
    // Re-read after all earlier awaits. The durable reservation below reads
    // preferences under its write lock; nothing awaits again before POST.
    await allowPolicy();
  } catch {
    return skipped("policy-denied");
  }
  const finalStop = stopped();
  if (finalStop) return skipped(finalStop);
  let attemptId: string;
  try {
    const reservation = reserveAttempt(
      dir,
      payload.fingerprint,
      (dependencies.now ?? Date.now)(),
      environment,
    );
    if (["disabled", "duplicate", "rate-limited"].includes(reservation))
      return skipped(reservation as AutomaticFeedbackReason);
    attemptId = reservation;
  } catch {
    return skipped("state-unavailable");
  }
  let outcome: AutomaticFeedbackResult;
  try {
    const response = await (dependencies.runCommand ?? command)(
      "gh",
      [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "POST",
        `repos/${FEEDBACK_REPOSITORY}/issues`,
        "--input",
        "-",
        "--jq",
        "{number,html_url}",
      ],
      {
        cwd: dir,
        input: payload.body,
        env: githubEnvironment(environment),
        signal: input.signal,
        timeoutMs: 10000,
        maxBytes: 16384,
      },
    );
    if (input.signal?.aborted)
      outcome = { status: "failed", reason: "cancelled" };
    else if (response.code !== 0)
      outcome = { status: "failed", reason: "transport-failed" };
    else {
      let receipt: { number?: unknown; html_url?: unknown } | undefined;
      try {
        receipt = JSON.parse(response.stdout);
      } catch {
        // Provider diagnostics and invalid responses never enter a report.
      }
      outcome =
        receipt &&
        !Array.isArray(receipt) &&
        Object.keys(receipt).length === 2 &&
        Number.isSafeInteger(receipt.number) &&
        Number(receipt.number) > 0 &&
        receipt.html_url ===
          `https://github.com/${FEEDBACK_REPOSITORY}/issues/${receipt.number}`
          ? { status: "submitted", issueUrl: receipt.html_url }
          : { status: "failed", reason: "invalid-response" };
    }
  } catch {
    outcome = {
      status: "failed",
      reason: input.signal?.aborted ? "cancelled" : "transport-failed",
    };
  }
  try {
    finishAttempt(
      dir,
      attemptId,
      outcome.status === "submitted" ? "submitted" : "failed",
    );
  } catch {
    // The pre-dispatch reservation is retained even when acknowledgement
    // storage fails. Never retry a POST that may already have made an issue.
    return { status: "failed", reason: "state-unavailable" };
  }
  return outcome;
}
