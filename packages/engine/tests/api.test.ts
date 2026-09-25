import { it, expect, vi } from "vitest";
import { createServer } from "node:http";
import {
  DEFAULT_POLICY,
  type ContextPacket,
} from "@graph-engineering/contracts";
import {
  fitWorkerContext,
  invokeApiWorker,
  proposalJsonSchema,
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

it("requests Anthropic structured output and rejects refusal or truncation", async () => {
  const proposal = {
    summary: "Fix",
    changes: [{ path: "sum.js", before: "a-b", after: "a+b" }],
    requests: [],
  };
  const replies = [
    {
      model: "fixture",
      content: [
        { type: "thinking", thinking: "", signature: "fixture" },
        { type: "text", text: JSON.stringify(proposal) },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 20 },
    },
    {
      model: "fixture",
      content: [],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: null },
      usage: { input_tokens: 100, output_tokens: 0 },
    },
    {
      model: "fixture",
      content: [{ type: "text", text: '{"summary":"Fi' }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 100, output_tokens: 4000 },
    },
  ];
  const received: any[] = [];
  const paths: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push(JSON.parse(body));
    paths.push(String(request.url));
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(replies.shift()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("GRAPH_TEST_ANTHROPIC_KEY", "fixture-only-not-a-real-key");
  try {
    const port = (server.address() as { port: number }).port;
    const input: WorkerInput = {
      provider: {
        id: "claude-api",
        kind: "anthropic",
        model: "fixture",
        endpoint: `http://127.0.0.1:${port}`,
        apiKeyEnv: "GRAPH_TEST_ANTHROPIC_KEY",
        efforts: ["medium"],
      },
      policy: {
        ...DEFAULT_POLICY,
        providers: ["claude-api"],
        inference: "allowlisted",
        network: "allowlisted",
      },
      context: {
        version: "1.0.0",
        projectId: "project",
        snapshotId: "snapshot",
        query: "fix",
        mandatory: ["tests pass"],
        items: [],
        estimatedTokens: 20,
        budgetTokens: 1000,
        coverage: { semantic: false, graph: "syntactic", warnings: [] },
      },
      objective: "Fix sum",
      acceptance: ["sum is correct"],
      effort: "medium",
    };
    const result = await invokeApiWorker(input);
    expect(result.proposal).toEqual(proposal);
    expect(result.usage.inputTokens).toBe(100);
    expect(paths[0]).toBe("/v1/messages");
    expect(received[0].output_config).toEqual({
      format: { type: "json_schema", schema: proposalJsonSchema },
      effort: "medium",
    });
    expect(received[0].tools).toBeUndefined();
    expect(received[0].tool_choice).toBeUndefined();
    await expect(invokeApiWorker(input)).rejects.toThrow("declined");
    await expect(invokeApiWorker(input)).rejects.toThrow("maxOutputTokens");
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
