import { performance } from "node:perf_hooks";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { command, registerDecisionCredentialEnvNames } from "../src/util.js";
import { decisionProviders } from "../src/decisions.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

  it("does not inherit configured decision keys into any subprocess", async () => {
    vi.stubEnv("GRAPH_JEV_API_KEY", "JEV_CANARY_NOT_A_REAL_KEY");
    vi.stubEnv("TYPESAFE_API_KEY", "TYPESAFE_CANARY_NOT_A_REAL_KEY");
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
    const argv = [
      "-e",
      "process.stdout.write(String(['GRAPH_JEV_API_KEY','TYPESAFE_API_KEY','CUSTOM_DECISION_CREDENTIAL'].every(key => process.env[key] === undefined)))",
    ];
    const inherited = await command(process.execPath, argv);
    const explicit = await command(process.execPath, argv, {
      env: { ...process.env },
    });
    expect(inherited.stdout).toBe("true");
    expect(explicit.stdout).toBe("true");
  });

  it("forwards only an installed worker's explicit credential", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "TYPESAFE_CANARY_NOT_A_REAL_KEY");
    const result = await command(
      process.execPath,
      [
        "-e",
        "process.stdout.write(String(process.env.ANTHROPIC_API_KEY === 'WORKER_CANARY' && process.env.TYPESAFE_API_KEY === undefined))",
      ],
      {
        env: { ...process.env, ANTHROPIC_API_KEY: "WORKER_CANARY" },
        workerCredentialEnv: "ANTHROPIC_API_KEY",
      },
    );
    expect(result.stdout).toBe("true");
  });

  it("refuses a worker credential that collides with a configured decision key", async () => {
    registerDecisionCredentialEnvNames(["ANTHROPIC_API_KEY"]);
    await expect(
      command(process.execPath, ["-e", "process.stdout.write('ran')"], {
        env: { ...process.env, ANTHROPIC_API_KEY: "COLLISION_CANARY" },
        workerCredentialEnv: "ANTHROPIC_API_KEY",
      }),
    ).rejects.toThrow("collides with a decision credential");
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

  it("allows a command without a wall-clock deadline while preserving output limits", async () => {
    await expect(
      command(process.execPath, ["-e", "process.stdout.write('ok')"], {
        timeoutMs: null,
        maxBytes: 2,
      }),
    ).resolves.toEqual({ code: 0, stdout: "ok", stderr: "" });
  });
});
