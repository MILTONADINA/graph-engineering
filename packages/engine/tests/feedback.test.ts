import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildFeedbackReport,
  classifyError,
  clearDifficulties,
  FEEDBACK_REPOSITORY,
  feedbackIssueUrl,
  feedbackReportText,
  offerFeedback,
  readDifficulties,
  recordDifficulty,
  type FeedbackIo,
} from "../src/feedback.js";

const SENTINEL = "zq7-private-sentinel";
const COMMANDS = ["init", "index", "plan", "run", "resume", "feedback"];
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

// Error messages as the engine writes them, carrying project details.
const messages = [
  `Requested source is unavailable: src/${SENTINEL}/Billing.ts`,
  `Required checks failed; recovery controller stopped for review (${SENTINEL})`,
  `Patch precondition failed: /Users/${SENTINEL}/work/app.ts must contain exactly one matching substring`,
  `DAG worker repeated source requests without new evidence in ${SENTINEL}.java`,
  `Something no catalog entry knows about in /home/${SENTINEL}/secret-project`,
];

function io(answer: string): FeedbackIo & {
  written: string[];
  opened: string[];
} {
  const written: string[] = [];
  const opened: string[] = [];
  return {
    interactive: true,
    ask: vi.fn(async () => answer),
    write: (text) => written.push(text),
    open: async (url) => void opened.push(url),
    written,
    opened,
  };
}

describe("feedback reports", () => {
  it("carry only allowlisted fields and never project paths, names, code or messages", () => {
    for (const message of messages) {
      const report = buildFeedbackReport({
        engineVersion: `0.1.0-${SENTINEL}`,
        command: SENTINEL,
        commands: COMMANDS,
        kinds: [{ kind: classifyError(message), count: 1 }],
      });
      const everything = [
        JSON.stringify(report),
        feedbackReportText(report),
        feedbackIssueUrl(report),
        decodeURIComponent(feedbackIssueUrl(report)),
      ].join("\n");
      expect(everything).not.toContain(SENTINEL);
      expect(Object.keys(report).sort()).toEqual(
        [
          "arch",
          "command",
          "engineVersion",
          "kinds",
          "node",
          "os",
          "phase",
        ].sort(),
      );
      expect(report.command).toBe("other");
    }
    expect(classifyError(messages[0]!)).toBe("unknown");
    expect(classifyError(messages[1]!)).toBe("checks-failed");
    expect(classifyError(messages[3]!)).toBe("worker-no-progress");
  });

  it("refuses a note that looks like it holds a secret", () => {
    expect(() =>
      buildFeedbackReport({
        engineVersion: "0.1.0",
        command: "run",
        commands: COMMANDS,
        kinds: [],
        note: "my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH",
      }),
    ).toThrow("looks like it contains a secret");
  });

  it("asks a person, shows the exact report, and opens an issue link only after a yes", async () => {
    const report = buildFeedbackReport({
      engineVersion: "0.1.0",
      command: "run",
      commands: COMMANDS,
      kinds: [{ kind: "checks-failed", count: 1 }],
    });
    const declined = io("n");
    expect(await offerFeedback(report, declined)).toBe("declined");
    expect(declined.opened).toEqual([]);
    expect(declined.written.join("")).toContain(feedbackReportText(report));

    const accepted = io("y");
    expect(await offerFeedback(report, accepted)).toBe("sent");
    expect(accepted.opened).toHaveLength(1);
    expect(accepted.opened[0]).toMatch(
      new RegExp(`^https://github\\.com/${FEEDBACK_REPOSITORY}/issues/new\\?`),
    );

    const unattended = { ...io("y"), interactive: false };
    expect(await offerFeedback(report, unattended)).toBe("not-asked");
    expect(unattended.opened).toEqual([]);
    expect(unattended.ask).not.toHaveBeenCalled();

    vi.stubEnv("GRAPH_ENGINE_NO_FEEDBACK", "1");
    const optedOut = io("y");
    expect(await offerFeedback(report, optedOut)).toBe("not-asked");
    expect(optedOut.opened).toEqual([]);
  });

  it("keeps a private local log of difficulty kinds only, outside the repository", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "graph-feedback-"));
    dirs.push(dir);
    for (const message of messages)
      await recordDifficulty(classifyError(message), dir);
    const file = path.join(dir, "difficulties.json");
    const text = await readFile(file, "utf8");
    expect(text).not.toContain(SENTINEL);
    if (process.platform !== "win32")
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    const log = await readDifficulties(dir);
    expect(log.kinds["unknown"]?.count).toBe(2);
    expect(Object.keys(log.kinds).sort()).toEqual(
      [
        "checks-failed",
        "patch-rejected",
        "unknown",
        "worker-no-progress",
      ].sort(),
    );
    await clearDifficulties(dir);
    expect((await readDifficulties(dir)).kinds).toEqual({});
  });
});
