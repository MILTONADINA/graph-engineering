import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  DEFAULT_POLICY,
  type ProjectPolicy,
} from "@graph-engineering/contracts";
import {
  automaticFeedbackNotice,
  readAutomaticFeedbackSettings,
  setAutomaticFeedbackEnabled,
  submitAutomaticFeedback,
  type AutomaticFeedbackInput,
} from "../src/feedback-auto.js";
import { FEEDBACK_REPOSITORY } from "../src/feedback.js";
import * as utilities from "../src/util.js";

const SENTINEL = "toy-private-feedback-sentinel";
const DAY_MS = 86_400_000;
const NOW = 1_800_000_000_000;
const ISSUE_URL = `https://github.com/${FEEDBACK_REPOSITORY}/issues/123`;
const SUCCESS = {
  code: 0,
  stdout: JSON.stringify({ number: 123, html_url: ISSUE_URL }),
  stderr: "",
};
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function permittedPolicy(): ProjectPolicy {
  return {
    ...structuredClone(DEFAULT_POLICY),
    inference: "allowlisted",
    network: "allowlisted",
    allowedHosts: ["api.github.com"],
  };
}

interface Attempt {
  id: string;
  fingerprint: string;
  attemptedAt: number;
  state: string;
}

function attempts(dir: string): Attempt[] {
  const db = new Database(path.join(dir, "automatic.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return db
      .prepare("SELECT * FROM attempts ORDER BY attemptedAt, id")
      .all() as Attempt[];
  } finally {
    db.close();
  }
}

async function fixture() {
  vi.stubEnv("GRAPH_ENGINE_NO_FEEDBACK", "");
  const dir = await mkdtemp(path.join(tmpdir(), "graph-feedback-auto-"));
  directories.push(dir);
  const order: string[] = [];
  const notify = vi.fn((message: string) => {
    order.push("notice");
    void message;
  });
  const readPolicy = vi.fn(async () => permittedPolicy());
  const runCommand = vi.fn<typeof utilities.command>(async () => {
    order.push("transport");
    return SUCCESS;
  });
  const input: AutomaticFeedbackInput = {
    engineVersion: "0.1.0",
    command: "run",
    kind: "checks-failed",
    readPolicy,
    notify,
  };
  const environment: NodeJS.ProcessEnv = {};
  const dependencies = { dir, now: () => NOW, runCommand, environment };
  return {
    dir,
    input,
    dependencies,
    order,
    notify,
    readPolicy,
    runCommand,
    environment,
  };
}

describe("automatic feedback", () => {
  it("defaults on without creating state, persists opt-out and gives environment refusal priority", async () => {
    const test = await fixture();
    expect(await readAutomaticFeedbackSettings(test.dir)).toEqual({
      enabled: true,
      storedEnabled: null,
      source: "default",
    });
    expect(await readdir(test.dir)).toEqual([]);
    expect(await setAutomaticFeedbackEnabled(false, test.dir)).toEqual({
      enabled: false,
      storedEnabled: false,
      source: "stored",
    });
    expect(
      await submitAutomaticFeedback(test.input, test.dependencies),
    ).toEqual({ status: "skipped", reason: "disabled" });
    expect(test.runCommand).not.toHaveBeenCalled();
    expect(await setAutomaticFeedbackEnabled(true, test.dir)).toEqual({
      enabled: true,
      storedEnabled: true,
      source: "stored",
    });
    vi.stubEnv("GRAPH_ENGINE_NO_FEEDBACK", "1");
    expect(await readAutomaticFeedbackSettings(test.dir)).toEqual({
      enabled: false,
      storedEnabled: null,
      source: "environment",
    });
    expect(
      await submitAutomaticFeedback(test.input, test.dependencies),
    ).toEqual({ status: "skipped", reason: "disabled" });
    vi.stubEnv("GRAPH_ENGINE_NO_FEEDBACK", "");
    expect((await readAutomaticFeedbackSettings(test.dir)).storedEnabled).toBe(
      true,
    );
    await expect(
      setAutomaticFeedbackEnabled(SENTINEL as unknown as boolean, test.dir),
    ).rejects.toThrow("unavailable");
    expect((await readAutomaticFeedbackSettings(test.dir)).storedEnabled).toBe(
      true,
    );
    if (process.platform !== "win32") {
      expect((await stat(test.dir)).mode & 0o777).toBe(0o700);
      expect(
        (await stat(path.join(test.dir, "automatic.sqlite"))).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it("announces account-attributed public submission before one fixed JSON-stdin POST with minimal environment", async () => {
    const test = await fixture();
    Object.assign(test.environment, {
      PATH: "/synthetic/bin",
      HOME: "/synthetic/account",
      GH_CONFIG_DIR: "/synthetic/gh",
      GH_TOKEN: SENTINEL,
      GITHUB_TOKEN: SENTINEL,
      GH_ENTERPRISE_TOKEN: SENTINEL,
      GITHUB_ENTERPRISE_TOKEN: SENTINEL,
      GRAPH_JEV_API_KEY: SENTINEL,
      TYPESAFE_API_KEY: SENTINEL,
      GRAPH_LAYA_TOKEN: SENTINEL,
      ANTHROPIC_API_KEY: SENTINEL,
      OPENAI_API_KEY: SENTINEL,
      HTTP_PROXY: SENTINEL,
      HTTPS_PROXY: SENTINEL,
      ALL_PROXY: SENTINEL,
      NODE_OPTIONS: SENTINEL,
      GH_DEBUG: SENTINEL,
      GH_HOST: "synthetic.invalid",
      GH_REPO: SENTINEL,
      GITHUB_API_URL: SENTINEL,
      SSL_CERT_FILE: SENTINEL,
    });
    expect(
      await submitAutomaticFeedback(test.input, test.dependencies),
    ).toEqual({ status: "submitted", issueUrl: ISSUE_URL });
    expect(test.order).toEqual(["notice", "transport"]);
    expect(test.notify).toHaveBeenCalledWith(automaticFeedbackNotice());
    expect(automaticFeedbackNotice()).toContain("PUBLIC");
    expect(automaticFeedbackNotice()).toContain("not anonymous");
    expect(automaticFeedbackNotice()).toContain(
      "graph-engine feedback-config off",
    );
    expect(automaticFeedbackNotice()).toContain("GRAPH_ENGINE_NO_FEEDBACK=1");
    expect(test.runCommand).toHaveBeenCalledTimes(1);
    const [executable, argv, options] = test.runCommand.mock.calls[0]!;
    expect(executable).toBe("gh");
    expect(argv).toEqual([
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
    ]);
    expect(options).toMatchObject({
      cwd: test.dir,
      timeoutMs: 10_000,
      maxBytes: 16_384,
    });
    expect(options?.env).toEqual({
      PATH: "/synthetic/bin",
      HOME: "/synthetic/account",
      GH_CONFIG_DIR: "/synthetic/gh",
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      GH_PAGER: "cat",
      NO_COLOR: "1",
    });
    const payload = JSON.parse(options!.input!) as Record<string, string>;
    expect(Object.keys(payload).sort()).toEqual(["body", "title"]);
    expect(payload.title).toBe("Automatic feedback: checks-failed (run)");
    expect(payload.body).toContain("- Difficulty: checks-failed x1:");
    expect(payload.body).toContain("- Command: run (run)");
    expect(JSON.stringify([argv, options?.input, options?.env])).not.toContain(
      SENTINEL,
    );
    expect(test.readPolicy).toHaveBeenCalledTimes(2);
  });

  it("drops notes, extra fields, raw errors, unknown commands and version suffixes from payload and durable state", async () => {
    const test = await fixture();
    const input = Object.assign({}, test.input, {
      engineVersion: `0.1.0-${SENTINEL}`,
      command: SENTINEL,
      kind: SENTINEL,
      note: SENTINEL,
      rawError: SENTINEL,
      source: `src/${SENTINEL}.ts`,
      prompt: SENTINEL,
      repository: SENTINEL,
      credentials: SENTINEL,
    });
    expect(await submitAutomaticFeedback(input, test.dependencies)).toEqual({
      status: "submitted",
      issueUrl: ISSUE_URL,
    });
    const payload = JSON.parse(test.runCommand.mock.calls[0]![2]!.input!) as {
      title: string;
      body: string;
    };
    expect(payload.title).toBe("Automatic feedback: unknown (other)");
    expect(payload.body).toContain("- Engine version: 0.1.0");
    expect(payload.body).toContain("- Command: other (other)");
    expect(payload.body).not.toContain("Note from the person");
    expect(
      JSON.stringify([payload, test.notify.mock.calls, attempts(test.dir)]),
    ).not.toContain(SENTINEL);
    expect(
      (await readFile(path.join(test.dir, "automatic.sqlite"))).toString(
        "utf8",
      ),
    ).not.toContain(SENTINEL);
    expect(Object.keys(attempts(test.dir)[0]!).sort()).toEqual([
      "attemptedAt",
      "fingerprint",
      "id",
      "state",
    ]);
  });

  it.each([
    ["local inference", () => ({ ...permittedPolicy(), inference: "local" })],
    ["network denial", () => ({ ...permittedPolicy(), network: "deny" })],
    [
      "web host only",
      () => ({ ...permittedPolicy(), allowedHosts: ["github.com"] }),
    ],
    ["missing API host", () => ({ ...permittedPolicy(), allowedHosts: [] })],
    [
      "malformed policy",
      () => ({ ...permittedPolicy(), unknownField: SENTINEL }),
    ],
  ])(
    "refuses %s before notice, ledger reservation or transport",
    async (_name, policy) => {
      const test = await fixture();
      test.readPolicy.mockResolvedValue(policy() as ProjectPolicy);
      expect(
        await submitAutomaticFeedback(test.input, test.dependencies),
      ).toEqual({ status: "skipped", reason: "policy-denied" });
      expect(test.runCommand).not.toHaveBeenCalled();
      expect(test.notify).not.toHaveBeenCalled();
      expect(await readdir(test.dir)).toEqual([]);
    },
  );

  it("refuses unreadable or changed policy without retaining private diagnostics", async () => {
    const test = await fixture();
    test.readPolicy.mockRejectedValueOnce(new Error(SENTINEL));
    expect(
      await submitAutomaticFeedback(test.input, test.dependencies),
    ).toEqual({ status: "skipped", reason: "policy-denied" });
    test.readPolicy
      .mockResolvedValueOnce(permittedPolicy())
      .mockResolvedValueOnce(structuredClone(DEFAULT_POLICY));
    expect(
      await submitAutomaticFeedback(test.input, test.dependencies),
    ).toEqual({ status: "skipped", reason: "policy-denied" });
    expect(test.notify).toHaveBeenCalledTimes(1);
    expect(test.runCommand).not.toHaveBeenCalled();
    expect(JSON.stringify(test.notify.mock.calls)).not.toContain(SENTINEL);
    expect(await readdir(test.dir)).toEqual([]);
  });

  it("rechecks a persisted opt-out set during awaited policy validation", async () => {
    const test = await fixture();
    test.readPolicy
      .mockImplementationOnce(async () => permittedPolicy())
      .mockImplementationOnce(async () => {
        await setAutomaticFeedbackEnabled(false, test.dir);
        return permittedPolicy();
      });
    expect(
      await submitAutomaticFeedback(test.input, test.dependencies),
    ).toEqual({ status: "skipped", reason: "disabled" });
    expect(test.runCommand).not.toHaveBeenCalled();
    expect(attempts(test.dir)).toEqual([]);
  });

  it("rechecks environment opt-out and cancellation after asynchronous prerequisites", async () => {
    for (const stop of ["environment", "cancelled"] as const) {
      const test = await fixture();
      const controller = new AbortController();
      test.input.signal = controller.signal;
      test.readPolicy
        .mockImplementationOnce(async () => permittedPolicy())
        .mockImplementationOnce(async () => {
          if (stop === "environment")
            test.environment.GRAPH_ENGINE_NO_FEEDBACK = "1";
          else controller.abort();
          return permittedPolicy();
        });
      expect(
        await submitAutomaticFeedback(test.input, test.dependencies),
      ).toEqual({
        status: "skipped",
        reason: stop === "environment" ? "disabled" : "cancelled",
      });
      expect(test.runCommand).not.toHaveBeenCalled();
      expect(await readdir(test.dir)).toEqual([]);
    }
  });

  it("does not submit without a deliverable notice or after initial cancellation", async () => {
    const test = await fixture();
    test.notify.mockImplementation(() => {
      throw new Error(SENTINEL);
    });
    expect(
      await submitAutomaticFeedback(test.input, test.dependencies),
    ).toEqual({ status: "skipped", reason: "notice-unavailable" });
    const controller = new AbortController();
    controller.abort();
    test.input.signal = controller.signal;
    expect(
      await submitAutomaticFeedback(test.input, test.dependencies),
    ).toEqual({ status: "skipped", reason: "cancelled" });
    expect(test.runCommand).not.toHaveBeenCalled();
    expect(await readdir(test.dir)).toEqual([]);
  });

  it("suppresses native transports in test environments while explicit sealed transports remain testable", async () => {
    const test = await fixture();
    const markers = [
      "VITEST",
      "NODE_ENV",
      "CI",
      "GITHUB_ACTIONS",
      "NODE_TEST_CONTEXT",
    ];
    for (const marker of markers) vi.stubEnv(marker, "");
    const native = vi
      .spyOn(utilities, "command")
      .mockRejectedValue(new Error("Native transport forbidden"));
    for (const marker of markers)
      expect(
        await submitAutomaticFeedback(test.input, {
          dir: test.dir,
          environment: { [marker]: marker === "NODE_ENV" ? "test" : "true" },
        }),
      ).toEqual({ status: "skipped", reason: "test-environment" });
    vi.stubEnv("NODE_TEST_CONTEXT", "child-v8");
    expect(
      await submitAutomaticFeedback(test.input, {
        dir: test.dir,
        environment: {},
      }),
    ).toEqual({ status: "skipped", reason: "test-environment" });
    expect(native).not.toHaveBeenCalled();
    expect(test.readPolicy).not.toHaveBeenCalled();
    expect(
      await submitAutomaticFeedback(test.input, test.dependencies),
    ).toEqual({ status: "submitted", issueUrl: ISSUE_URL });
    expect(native).not.toHaveBeenCalled();
    expect(test.runCommand).toHaveBeenCalledTimes(1);
  });

  it("durably reserves before dispatch and conservatively counts a transport failure without retry or replay", async () => {
    const test = await fixture();
    test.runCommand.mockImplementation(async () => {
      expect(attempts(test.dir)).toMatchObject([
        { attemptedAt: NOW, state: "reserved" },
      ]);
      throw new Error(SENTINEL);
    });
    const result = await submitAutomaticFeedback(test.input, test.dependencies);
    expect(result).toEqual({ status: "failed", reason: "transport-failed" });
    expect(attempts(test.dir)).toMatchObject([
      { attemptedAt: NOW, state: "failed" },
    ]);
    await setAutomaticFeedbackEnabled(false, test.dir);
    await setAutomaticFeedbackEnabled(true, test.dir);
    expect(
      await submitAutomaticFeedback(test.input, test.dependencies),
    ).toEqual({ status: "skipped", reason: "duplicate" });
    expect(test.runCommand).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify([result, test.notify.mock.calls, attempts(test.dir)]),
    ).not.toContain(SENTINEL);
  });

  it.each([
    [
      "nonzero",
      { code: 1, stdout: SENTINEL, stderr: SENTINEL },
      "transport-failed",
    ],
    ["malformed JSON", { ...SUCCESS, stdout: SENTINEL }, "invalid-response"],
    [
      "wrong destination",
      {
        ...SUCCESS,
        stdout: JSON.stringify({
          number: 123,
          html_url: "https://github.com/toy/other/issues/123",
        }),
      },
      "invalid-response",
    ],
    [
      "mismatched number",
      {
        ...SUCCESS,
        stdout: JSON.stringify({ number: 124, html_url: ISSUE_URL }),
      },
      "invalid-response",
    ],
    [
      "extra response fields",
      {
        ...SUCCESS,
        stdout: JSON.stringify({
          number: 123,
          html_url: ISSUE_URL,
          body: SENTINEL,
        }),
      },
      "invalid-response",
    ],
    ["array response", { ...SUCCESS, stdout: "[]" }, "invalid-response"],
  ])(
    "rejects %s receipts without leaking diagnostics or refunding the attempt",
    async (_name, response, reason) => {
      const test = await fixture();
      test.runCommand.mockResolvedValue(response);
      const result = await submitAutomaticFeedback(
        test.input,
        test.dependencies,
      );
      expect(result).toEqual({ status: "failed", reason });
      expect(attempts(test.dir)).toMatchObject([{ state: "failed" }]);
      expect(JSON.stringify([result, test.notify.mock.calls])).not.toContain(
        SENTINEL,
      );
      expect(
        await submitAutomaticFeedback(test.input, test.dependencies),
      ).toEqual({ status: "skipped", reason: "duplicate" });
      expect(test.runCommand).toHaveBeenCalledTimes(1);
    },
  );

  it("does not claim a successful receipt after dispatched cancellation", async () => {
    const test = await fixture();
    const controller = new AbortController();
    test.input.signal = controller.signal;
    test.runCommand.mockImplementation(async (_executable, _argv, options) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort();
      return SUCCESS;
    });
    expect(
      await submitAutomaticFeedback(test.input, test.dependencies),
    ).toEqual({ status: "failed", reason: "cancelled" });
    expect(attempts(test.dir)).toMatchObject([{ state: "failed" }]);
  });

  it("refuses corrupt or inconsistent history without replacing it or dispatching", async () => {
    const test = await fixture();
    const file = path.join(test.dir, "automatic.sqlite");
    await writeFile(file, SENTINEL, { mode: 0o600 });
    expect(await readAutomaticFeedbackSettings(test.dir)).toEqual({
      enabled: false,
      storedEnabled: null,
      source: "unavailable",
    });
    expect(
      await submitAutomaticFeedback(test.input, test.dependencies),
    ).toEqual({ status: "skipped", reason: "state-unavailable" });
    await expect(setAutomaticFeedbackEnabled(true, test.dir)).rejects.toThrow(
      "unavailable",
    );
    expect(await readFile(file, "utf8")).toBe(SENTINEL);
    expect(test.runCommand).not.toHaveBeenCalled();

    const inconsistent = await fixture();
    await setAutomaticFeedbackEnabled(true, inconsistent.dir);
    const db = new Database(path.join(inconsistent.dir, "automatic.sqlite"));
    try {
      db.prepare("INSERT INTO attempts VALUES(?,?,?,?)").run(
        "00000000-0000-0000-0000-000000000000",
        "invalid-fingerprint",
        NOW,
        "reserved",
      );
    } finally {
      db.close();
    }
    expect(
      await submitAutomaticFeedback(
        inconsistent.input,
        inconsistent.dependencies,
      ),
    ).toEqual({ status: "skipped", reason: "state-unavailable" });
    expect(inconsistent.runCommand).not.toHaveBeenCalled();
    expect(attempts(inconsistent.dir)).toHaveLength(1);
  });

  it("does not recreate missing acknowledgement state after a potentially successful POST", async () => {
    const test = await fixture();
    test.runCommand.mockImplementation(async () => {
      await rm(path.join(test.dir, "automatic.sqlite"));
      return SUCCESS;
    });
    expect(
      await submitAutomaticFeedback(test.input, test.dependencies),
    ).toEqual({ status: "failed", reason: "state-unavailable" });
    expect(await readdir(test.dir)).toEqual([]);
    expect(test.runCommand).toHaveBeenCalledTimes(1);
  });

  it("caps concurrent distinct attempts at three in a rolling day, including failures and backwards clocks", async () => {
    const test = await fixture();
    const kinds = [
      "checks-failed",
      "worker-unavailable",
      "configuration",
      "provider-call",
      "cost-cap",
      "patch-rejected",
    ];
    test.runCommand.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: SENTINEL,
    });
    const results = await Promise.all(
      kinds.map((kind) =>
        submitAutomaticFeedback({ ...test.input, kind }, test.dependencies),
      ),
    );
    expect(results.filter((result) => result.status === "failed")).toHaveLength(
      3,
    );
    expect(
      results.filter(
        (result) =>
          result.status === "skipped" && result.reason === "rate-limited",
      ),
    ).toHaveLength(3);
    expect(test.runCommand).toHaveBeenCalledTimes(3);
    expect(attempts(test.dir)).toHaveLength(3);
    expect(
      await submitAutomaticFeedback(
        { ...test.input, kind: "review-gate" },
        { ...test.dependencies, now: () => NOW - 1000 },
      ),
    ).toEqual({ status: "skipped", reason: "rate-limited" });
    expect(
      await submitAutomaticFeedback(
        { ...test.input, kind: "review-gate" },
        { ...test.dependencies, now: () => NOW + DAY_MS - 1 },
      ),
    ).toEqual({ status: "skipped", reason: "rate-limited" });
    expect(
      await submitAutomaticFeedback(
        { ...test.input, kind: "review-gate" },
        { ...test.dependencies, now: () => NOW + DAY_MS },
      ),
    ).toEqual({ status: "failed", reason: "transport-failed" });
    expect(test.runCommand).toHaveBeenCalledTimes(4);
    expect(attempts(test.dir)).toHaveLength(1);
  });

  it("suppresses concurrent sanitized duplicates until the exact cooldown expires", async () => {
    const test = await fixture();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        submitAutomaticFeedback(
          { ...test.input, engineVersion: `0.1.0-${SENTINEL}-${index}` },
          test.dependencies,
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === "submitted"),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          result.status === "skipped" && result.reason === "duplicate",
      ),
    ).toHaveLength(5);
    expect(test.runCommand).toHaveBeenCalledTimes(1);
    expect(
      await submitAutomaticFeedback(test.input, {
        ...test.dependencies,
        now: () => NOW + DAY_MS - 1,
      }),
    ).toEqual({ status: "skipped", reason: "duplicate" });
    expect(
      await submitAutomaticFeedback(test.input, {
        ...test.dependencies,
        now: () => NOW + DAY_MS,
      }),
    ).toEqual({ status: "submitted", issueUrl: ISSUE_URL });
    expect(test.runCommand).toHaveBeenCalledTimes(2);
  });
});
