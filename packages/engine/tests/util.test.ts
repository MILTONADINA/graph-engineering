import { performance } from "node:perf_hooks";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { command, subprocessEnvironment } from "../src/util.js";
import { decisionProviders } from "../src/decisions.js";
import { invokeApiWorker } from "../src/workers/api.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("bounded command transport", () => {
  it("preserves an ordinary successful result", async () => {
    await expect(
      command(process.execPath, ["-e", "process.stdout.write('ok')"], {
        timeoutMs: 10000,
      }),
    ).resolves.toEqual({ code: 0, stdout: "ok", stderr: "" });
  });

  it("does not inherit any decision-provider key into a subprocess", async () => {
    vi.stubEnv("GRAPH_JEV_API_KEY", "JEV_CANARY_NOT_A_REAL_KEY");
    vi.stubEnv("TYPESAFE_API_KEY", "TYPESAFE_CANARY_NOT_A_REAL_KEY");
    vi.stubEnv("GRAPH_LAYA_TOKEN", "LAYA_CANARY_NOT_A_REAL_KEY");
    vi.stubEnv("CUSTOM_DECISION_CREDENTIAL", "CUSTOM_CANARY_NOT_A_REAL_KEY");
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "graph-decision-env-"),
    );
    try {
      await writeFile(
        path.join(directory, "decisions.json"),
        JSON.stringify([
          {
            id: "jev",
            endpoint: "https://api.typesafe.ai/v1/systemone",
            model: "test",
            apiKeyEnv: "CUSTOM_DECISION_CREDENTIAL",
            maxStateChars: 1000,
          },
        ]),
      );
      await decisionProviders(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    const keys = [
      "GRAPH_JEV_API_KEY",
      "TYPESAFE_API_KEY",
      "GRAPH_LAYA_TOKEN",
      "CUSTOM_DECISION_CREDENTIAL",
    ];
    for (const key of keys)
      expect(subprocessEnvironment()[key]).toBeUndefined();
    expect(subprocessEnvironment().PATH).toBe(process.env.PATH);
    const argv = [
      "-e",
      `process.stdout.write(String(${JSON.stringify(keys)}.every((key) => process.env[key] === undefined)))`,
    ];
    const inherited = await command(process.execPath, argv);
    const explicit = await command(process.execPath, argv, {
      env: { ...process.env },
    });
    expect(inherited.stdout).toBe("true");
    expect(explicit.stdout).toBe("true");
  });

  it("preserves UTF-8 code points split across subprocess output chunks", async () => {
    const script = [
      "const first = Buffer.from([0xf0]);",
      "const rest = Buffer.from([0x9f, 0x98, 0x80]);",
      "process.stdout.write(first);",
      "process.stderr.write(first);",
      "setTimeout(() => { process.stdout.write(rest); process.stderr.write(rest); }, 100);",
    ].join("\n");
    await expect(
      command(process.execPath, ["-e", script], { timeoutMs: 10000 }),
    ).resolves.toEqual({ code: 0, stdout: "😀", stderr: "😀" });
  });

  it("rejects a late successful exit even when its timeout callback cannot run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(2000);
    // The subprocess really exits; only the parent's clock and timer delivery
    // are controlled. No wall-clock speed assumption or artificial sleep.
    await expect(
      command(process.execPath, ["-e", "process.exitCode = 0"], {
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("timeout or cancellation");
  });

  it("still rejects output overflow independently of exit status", async () => {
    await expect(
      command(process.execPath, ["-e", "process.stdout.write('oversized')"], {
        timeoutMs: 10000,
        maxBytes: 1,
      }),
    ).rejects.toThrow("output limit");
  });

  it("refuses decision keys that would strip variables subprocesses need", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "graph-decision-reserved-"),
    );
    try {
      for (const reserved of [
        "PATH",
        "HOME",
        "GH_TOKEN",
        "ANTHROPIC_API_KEY",
      ]) {
        await writeFile(
          path.join(directory, "decisions.json"),
          JSON.stringify([
            {
              id: "jev",
              endpoint: "https://api.typesafe.ai/v1/systemone",
              model: "test",
              apiKeyEnv: reserved,
              maxStateChars: 1000,
            },
          ]),
        );
        await expect(decisionProviders(directory)).rejects.toThrow(
          "must not reuse a system or worker variable",
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a worker configured with a decision-provider key", async () => {
    vi.stubEnv("GRAPH_JEV_API_KEY", "JEV_CANARY_NOT_A_REAL_KEY");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      invokeApiWorker({
        provider: {
          id: "cloud",
          kind: "anthropic",
          model: "fixture",
          apiKeyEnv: "GRAPH_JEV_API_KEY",
          endpoint: "http://127.0.0.1:9",
        },
        policy: {
          ...DEFAULT_POLICY,
          providers: ["cloud"],
          inference: "allowlisted",
          network: "allowlisted",
        },
        context: {
          version: "1.0.0",
          projectId: "project",
          snapshotId: "snapshot",
          query: "fix",
          mandatory: [],
          mandatorySources: [],
          items: [],
          estimatedTokens: 20,
          budgetTokens: 1000,
          coverage: { semantic: false, graph: "syntactic", warnings: [] },
        },
        objective: "Fix",
        acceptance: ["done"],
      }),
    ).rejects.toThrow("cannot use decision credential GRAPH_JEV_API_KEY");
    expect(fetch).not.toHaveBeenCalled();
  });
});
