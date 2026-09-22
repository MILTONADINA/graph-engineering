import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { command } from "../src/util.js";

afterEach(() => {
  vi.restoreAllMocks();
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
});
