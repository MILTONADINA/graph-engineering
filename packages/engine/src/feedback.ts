import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import envPaths from "env-paths";
import { containsSecret } from "./policy.js";

/** Where consented reports go: the maintainers' issue tracker. */
export const FEEDBACK_REPOSITORY = "MILTONADINA/graph-engineering";

/**
 * The only error descriptions a report may carry. A report names one of
 * these kinds, never the error message, which can hold paths or code.
 */
export const ERROR_KINDS = [
  {
    kind: "worker-unavailable",
    pattern:
      /No permitted worker|Selected worker .* unavailable|is not a configured provider|installed .* client is not available/,
    description: "No configured worker could be used",
  },
  {
    kind: "worker-no-progress",
    pattern:
      /repeated source requests|no exportable evidence|context-request turn budget|worker-turn budget/,
    description: "A worker stopped making progress",
  },
  {
    kind: "checks-failed",
    pattern:
      /Required checks failed|DAG checks failed|recovery controller stopped/,
    description: "Required checks still failed after repair attempts",
  },
  {
    kind: "verification-infrastructure",
    pattern:
      /Docker|docker|verification image|infrastructure|could not start the check/,
    description: "The verification container could not run",
  },
  {
    kind: "security-gate",
    pattern: /Security scan|OSV vulnerability database/,
    description: "The security gate stopped the run",
  },
  {
    kind: "review-gate",
    pattern: /Code review|reviewer/,
    description: "The review gate stopped the run",
  },
  {
    kind: "policy-changed",
    pattern: /Policy changed|policy changed/,
    description: "The project policy changed during a run",
  },
  {
    kind: "workspace-reconciliation",
    pattern: /Workspace changed|reconcil|modified the workspace/,
    description: "A run's workspace needed reconciliation",
  },
  {
    kind: "context-budget",
    pattern: /context budget|exceeds configured context/,
    description: "The context budget was too small",
  },
  {
    kind: "patch-rejected",
    pattern: /Patch precondition|Refusing to replace|write scope/,
    description: "A proposed change could not be applied",
  },
  {
    kind: "index-limit",
    pattern: /indexes at most|more than [\d,]+ files/,
    description: "The repository exceeded an indexing limit",
  },
  {
    kind: "cost-cap",
    pattern: /spending cap|maxCostUsd|cost cap|budget exceeded/,
    description: "A spending cap stopped the work",
  },
  {
    kind: "provider-call",
    pattern:
      /HTTP \d{3}|ECONNREFUSED|ETIMEDOUT|timed out|provider returned|refused the request/,
    description: "A model provider call failed",
  },
  {
    kind: "configuration",
    pattern: /Invalid|must be|Project policy|not configured/,
    description: "The project configuration was rejected",
  },
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number]["kind"] | "unknown";

/** The catalog kind of an error message; the message itself is discarded. */
export function classifyError(message: string): ErrorKind {
  return (
    ERROR_KINDS.find(({ pattern }) => pattern.test(message))?.kind ?? "unknown"
  );
}

const PHASES: Record<string, string> = {
  init: "setup",
  "provider-add": "setup",
  policy: "setup",
  reviewer: "setup",
  tester: "setup",
  "check-add": "setup",
  index: "index",
  context: "index",
  scale: "index",
  plan: "plan",
  decompose: "plan",
  "plan-approve": "plan",
  run: "run",
  resume: "run",
  "security-scan": "security",
  "security-plan": "security",
  "security-db-update": "security",
  serve: "dashboard",
  mcp: "mcp",
};

export interface FeedbackReport {
  engineVersion: string;
  command: string;
  phase: string;
  kinds: { kind: ErrorKind; count: number }[];
  os: string;
  arch: string;
  node: string;
  note?: string;
}

/**
 * A report from allowlisted fields only. The command must be one of the
 * CLI's own command names; anything else is reported as "other". A note is
 * the person's own words, refused if it looks like it holds a secret.
 */
export function buildFeedbackReport(input: {
  engineVersion: string;
  command: string | undefined;
  commands: readonly string[];
  kinds: { kind: ErrorKind; count: number }[];
  note?: string;
}): FeedbackReport {
  const command =
    input.command && input.commands.includes(input.command)
      ? input.command
      : "other";
  const note = input.note?.trim();
  if (note && containsSecret(note))
    throw new Error(
      "The note looks like it contains a secret; remove it and try again",
    );
  const known = new Set<string>([
    ...ERROR_KINDS.map(({ kind }) => kind),
    "unknown",
  ]);
  return {
    engineVersion: /^\d+\.\d+\.\d+/.exec(input.engineVersion)?.[0] ?? "unknown",
    command,
    phase: PHASES[command] ?? "other",
    kinds: input.kinds
      .filter(({ kind }) => known.has(kind))
      .map(({ kind, count }) => ({
        kind,
        count: Math.max(1, Math.min(9999, Math.floor(count))),
      })),
    os: os.platform(),
    arch: os.arch(),
    node: process.versions.node.split(".")[0] ?? "unknown",
    ...(note ? { note: note.slice(0, 2000) } : {}),
  };
}

/** The exact text the person reviews and the issue carries. */
export function feedbackReportText(report: FeedbackReport): string {
  const description = (kind: ErrorKind) =>
    ERROR_KINDS.find((entry) => entry.kind === kind)?.description ??
    "An error outside the catalog";
  return [
    "Graph Engineering feedback report",
    "",
    `- Engine version: ${report.engineVersion}`,
    `- Command: ${report.command} (${report.phase})`,
    ...report.kinds.map(
      ({ kind, count }) =>
        `- Difficulty: ${kind} x${count}: ${description(kind)}`,
    ),
    `- Platform: ${report.os} ${report.arch}, Node ${report.node}`,
    ...(report.note
      ? ["", "Note from the person sending it:", report.note]
      : []),
    "",
    "This report holds no project name, path, file, code, prompt or error message.",
  ].join("\n");
}

/** A prefilled new-issue link; the person reviews and submits it themselves. */
export function feedbackIssueUrl(
  report: FeedbackReport,
  repository = FEEDBACK_REPOSITORY,
): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("Invalid feedback repository");
  const title = `Feedback: ${report.kinds.map(({ kind }) => kind).join(", ") || "general"} (${report.command})`;
  const query = new URLSearchParams({
    title,
    body: feedbackReportText(report),
    labels: "feedback",
  });
  return `https://github.com/${repository}/issues/new?${query}`;
}

export interface DifficultyLog {
  version: 1;
  kinds: Record<string, { count: number; lastAt: string }>;
}

/** The private, per-person log directory, outside any repository. */
export function feedbackDir(): string {
  return path.join(
    process.env.GRAPH_ENGINE_DATA_DIR ??
      envPaths("graph-engineering", { suffix: "" }).data,
    "feedback",
  );
}

export async function readDifficulties(
  dir = feedbackDir(),
): Promise<DifficultyLog> {
  try {
    const log = JSON.parse(
      await readFile(path.join(dir, "difficulties.json"), "utf8"),
    ) as DifficultyLog;
    return log.version === 1 && log.kinds && typeof log.kinds === "object"
      ? log
      : { version: 1, kinds: {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { version: 1, kinds: {} };
  }
}

/** Counts one difficulty kind; only the kind and a timestamp are kept. */
export async function recordDifficulty(
  kind: ErrorKind,
  dir = feedbackDir(),
): Promise<void> {
  const log = await readDifficulties(dir);
  const entry = log.kinds[kind] ?? { count: 0, lastAt: "" };
  log.kinds[kind] = {
    count: entry.count + 1,
    lastAt: new Date().toISOString(),
  };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "difficulties.json");
  await writeFile(file, `${JSON.stringify(log, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

export async function clearDifficulties(dir = feedbackDir()): Promise<void> {
  await rm(path.join(dir, "difficulties.json"), { force: true });
}

export interface FeedbackIo {
  /** A person is at an interactive terminal. */
  interactive: boolean;
  ask: (question: string) => Promise<string>;
  write: (text: string) => void;
  open: (url: string) => Promise<void>;
}

/**
 * Shows the exact report and opens it as a prefilled issue only if the
 * person answers yes. Nothing is asked or sent without a person present.
 */
export async function offerFeedback(
  report: FeedbackReport,
  io: FeedbackIo,
  repository = FEEDBACK_REPOSITORY,
): Promise<"sent" | "declined" | "not-asked"> {
  if (!io.interactive || process.env.GRAPH_ENGINE_NO_FEEDBACK === "1")
    return "not-asked";
  io.write(
    [
      "",
      "Graph Engineering hit a difficulty. You can help improve it by sending",
      "this anonymous report to its maintainers. It contains exactly:",
      "",
      feedbackReportText(report),
      "",
    ].join("\n"),
  );
  const answer = (
    await io.ask("Open it as a GitHub issue you can review and submit? [y/N] ")
  )
    .trim()
    .toLowerCase();
  if (answer !== "y" && answer !== "yes") return "declined";
  const url = feedbackIssueUrl(report, repository);
  await io.open(url);
  io.write(`Opened in your browser. If it did not open, use:\n${url}\n`);
  return "sent";
}
