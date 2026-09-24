import { describe, expect, it, vi } from "vitest";
import { dockerAvailable } from "../src/execution/docker.js";
import type { command } from "../src/util.js";

const available = { code: 0, stdout: "24.0", stderr: "" };
const unavailable = { code: 1, stdout: "", stderr: "daemon unavailable" };

describe("Docker availability", () => {
  it("accepts the first successful probe without retrying", async () => {
    const probe = vi.fn<typeof command>().mockResolvedValue(available);

    await expect(dockerAvailable(probe)).resolves.toBe(true);
    expect(probe).toHaveBeenCalledExactlyOnceWith(
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      { timeoutMs: 5_000 },
    );
  });

  it("retries a timed out probe with a longer timeout", async () => {
    const probe = vi
      .fn<typeof command>()
      .mockRejectedValueOnce(new Error("Command terminated (timeout)"))
      .mockResolvedValueOnce(available);

    await expect(dockerAvailable(probe)).resolves.toBe(true);
    expect(probe).toHaveBeenNthCalledWith(
      1,
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      { timeoutMs: 5_000 },
    );
    expect(probe).toHaveBeenNthCalledWith(
      2,
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      { timeoutMs: 15_000 },
    );
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("retries a nonzero exit and accepts a ready daemon", async () => {
    const probe = vi
      .fn<typeof command>()
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(available);

    await expect(dockerAvailable(probe)).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("fails closed after two unsuccessful probes", async () => {
    const probe = vi
      .fn<typeof command>()
      .mockResolvedValueOnce(unavailable)
      .mockRejectedValueOnce(new Error("Docker unavailable"));

    await expect(dockerAvailable(probe)).resolves.toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
