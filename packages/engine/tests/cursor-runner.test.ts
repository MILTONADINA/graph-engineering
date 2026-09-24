import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as CursorSdk from "@cursor/sdk";
import {
  runCursorTextProposal,
  type CursorRunnerRequest,
} from "../src/workers/cursor-runner.js";

const proposal = {
  summary: "Use the existing return value",
  changes: [],
  requests: [],
};
const scratchWorkspace = path.resolve(os.tmpdir(), "graph-cursor-fixture");

function fixture(events: Array<Record<string, unknown>> = []) {
  const cancel = vi.fn(async () => {});
  const close = vi.fn();
  const run = {
    async *stream() {
      for (const event of events) yield event;
    },
    wait: vi.fn(async () => ({
      status: "finished",
      result: JSON.stringify(proposal),
      model: { id: "fixture-model" },
      usage: {
        inputTokens: 55,
        outputTokens: 40,
        cacheReadTokens: 8,
      },
    })),
    cancel,
  };
  const send = vi.fn(async () => run);
  const create = vi.fn(async () => ({ send, close }));
  class JsonlLocalAgentStore {
    constructor(public readonly directory: string) {}
  }
  return {
    sdk: {
      Agent: { create },
      JsonlLocalAgentStore,
    } as unknown as typeof CursorSdk,
    create,
    send,
    close,
    cancel,
    run,
  };
}

function request(): CursorRunnerRequest {
  return {
    workspace: scratchWorkspace,
    model: "fixture-model",
    prompt: "Return a JSON proposal for this selected public source.",
    maxInputTokens: 1024,
    maxOutputTokens: 128,
  };
}

describe("Cursor SDK scratch proposal runner", () => {
  it("disables every ambient settings layer and built-in tool", async () => {
    const fake = fixture();
    const result = await runCursorTextProposal(
      request(),
      "test-user-key",
      fake.sdk,
    );
    expect(result).toEqual({
      proposal,
      model: "fixture-model",
      usage: {
        inputTokens: 55,
        outputTokens: 40,
        cachedTokens: 8,
        costUsd: null,
        estimated: false,
      },
    });
    expect(fake.create).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "test-user-key",
        model: { id: "fixture-model" },
        tools: [],
        disallowedTools: ["shell", "mcp", "task"],
        mcpServers: {},
        local: expect.objectContaining({
          cwd: scratchWorkspace,
          settingSources: [],
          sandboxOptions: { enabled: true },
          autoReview: false,
          customTools: {},
          enableAgentRetries: false,
        }),
      }),
    );
    expect(fake.send).toHaveBeenCalledWith(request().prompt, {
      mcpServers: {},
    });
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("rejects tool activity and cancels before accepting a proposal", async () => {
    const fake = fixture([{ type: "tool_call", name: "read" }]);
    await expect(
      runCursorTextProposal(request(), "test-user-key", fake.sdk),
    ).rejects.toThrow("tool operation");
    expect(fake.cancel).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("rejects reported token overruns and missing credentials before success", async () => {
    const fake = fixture([
      {
        type: "usage",
        usage: { inputTokens: 55, outputTokens: 129 },
      },
    ]);
    await expect(
      runCursorTextProposal(request(), "test-user-key", fake.sdk),
    ).rejects.toThrow("token bound");
    expect(fake.cancel).toHaveBeenCalledOnce();
    const missing = fixture();
    await expect(
      runCursorTextProposal(request(), "", missing.sdk),
    ).rejects.toThrow("user key is required");
    expect(missing.create).not.toHaveBeenCalled();
  });

  it("rejects oversized final text before parsing and closes the agent", async () => {
    const fake = fixture();
    fake.run.wait.mockResolvedValueOnce({
      status: "finished",
      result: "x".repeat(1_000_001),
      model: { id: "fixture-model" },
      usage: { inputTokens: 55, outputTokens: 40, cacheReadTokens: 8 },
    });
    await expect(
      runCursorTextProposal(request(), "test-user-key", fake.sdk),
    ).rejects.toThrow("response byte limit");
    expect(fake.close).toHaveBeenCalledOnce();
  });
});
