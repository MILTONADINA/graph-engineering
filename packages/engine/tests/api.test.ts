import { it, expect } from "vitest";
import { createServer } from "node:http";
import {
  DEFAULT_POLICY,
  type ContextPacket,
} from "@graph-engineering/contracts";
import {
  fitWorkerContext,
  invokeApiWorker,
  workerRequestBytes,
  type WorkerInput,
} from "../src/workers/api.js";

it("budgets serialized metadata and framing without trimming mandatory evidence", () => {
  const input: WorkerInput = {
    provider: { id: "local", kind: "local", model: "fixture" },
    policy: { ...DEFAULT_POLICY, providers: ["local"], maxContextTokens: 5000 },
    objective: "Fix the regression",
    acceptance: ["Keep required behavior"],
    context: {
      version: "1.0.0",
      projectId: "project",
      snapshotId: "snapshot",
      query: "regression",
      mandatory: ["Do not change the API"],
      estimatedTokens: 4900,
      budgetTokens: 5000,
      coverage: { semantic: false, graph: "syntactic", warnings: [] },
      items: [
        { id: "useful", kind: "code", text: "important".repeat(50), score: 1 },
        { id: "extra", kind: "code", text: '\\"\n'.repeat(1800), score: 0.1 },
      ],
    },
  };
  expect(workerRequestBytes(input)).toBeGreaterThan(5000);
  const result = fitWorkerContext(input);
  expect(workerRequestBytes(result)).toBeLessThanOrEqual(5000);
  expect(result.context.items.map((item) => item.id)).toEqual(["useful"]);
  expect(result.context.mandatory).toEqual(input.context.mandatory);
  expect(input.context.items).toHaveLength(2);
  expect(() =>
    fitWorkerContext({
      ...input,
      context: { ...input.context, mandatory: ["required".repeat(1000)] },
    }),
  ).toThrow("Mandatory worker request");
  expect(() =>
    fitWorkerContext({
      ...input,
      provider: { ...input.provider, maxContextTokens: 1000 },
    }),
  ).toThrow("Mandatory worker request");
});

it("uses a local OpenAI-compatible endpoint and validates its structured patch", async () => {
  let received: any;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        model: "local-fixture",
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Fix",
                changes: [{ path: "sum.js", before: "a-b", after: "a+b" }],
                requests: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const packet: ContextPacket = {
      version: "1.0.0",
      projectId: "project",
      snapshotId: "snapshot",
      query: "fix",
      mandatory: ["tests pass"],
      items: [],
      estimatedTokens: 20,
      budgetTokens: 1000,
      coverage: { semantic: false, graph: "syntactic", warnings: [] },
    };
    const result = await invokeApiWorker({
      provider: {
        id: "local",
        kind: "local",
        model: "fixture",
        endpoint: `http://127.0.0.1:${port}/v1`,
        localOptions: { enableThinking: false, thinkingBudget: 0 },
      },
      policy: { ...DEFAULT_POLICY, providers: ["local"] },
      context: packet,
      objective: "Fix sum",
      acceptance: ["sum is correct"],
    });
    expect(result.proposal.changes[0].after).toBe("a+b");
    expect(result.usage.inputTokens).toBe(100);
    expect(received.response_format.type).toBe("json_schema");
    expect(received.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(received.thinking_budget).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
