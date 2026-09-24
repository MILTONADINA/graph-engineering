import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { command } from "../src/util.js";

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

  it("does not inherit the Jev bearer key into any subprocess", async () => {
    vi.stubEnv("GRAPH_JEV_API_KEY", "JEV_CANARY_NOT_A_REAL_KEY");
    const argv = [
      "-e",
      "process.stdout.write(String(process.env.GRAPH_JEV_API_KEY === undefined))",
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

  it("allows a command without a wall-clock deadline while preserving output limits", async () => {
    await expect(
      command(process.execPath, ["-e", "process.stdout.write('ok')"], {
        timeoutMs: null,
        maxBytes: 2,
      }),
    ).resolves.toEqual({ code: 0, stdout: "ok", stderr: "" });
  });
});
