import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_POLICY,
  type ContextPacket,
} from "@graph-engineering/contracts";
import {
  invokePlanWorker,
  PLANNER_INSTRUCTIONS,
  type Decomposition,
} from "../src/workers/plan.js";

const decomposition: Decomposition = {
  rationale: "Model first, then the endpoint",
  steps: [
    { id: "model", objective: "Add the Invoice model", dependsOn: [] },
    { id: "api", objective: "Expose GET /invoices", dependsOn: ["model"] },
  ],
};
const item = (path: string, score: number, text: string) => ({
  id: `${path}-${score}`,
  kind: "code" as const,
  text,
  score,
  source: {
    path,
    startLine: 1,
    endLine: 1,
    contentHash: "a".repeat(64),
    snapshotId: "snapshot",
  },
});
const packet = (items: ContextPacket["items"]): ContextPacket =>
  ({
    version: "1.0.0",
    snapshotId: "snapshot",
    query: "Add invoices",
    mandatory: [
      "GET /invoices lists invoices",
      "Money is stored as integer cents",
    ],
    items,
    estimatedTokens: 0,
    budgetTokens: 16000,
    coverage: { semantic: false, graph: "", warnings: [] },
  }) as unknown as ContextPacket;
const local = { id: "planner", kind: "local" as const, model: "m" };
const input = (overrides = {}) => ({
  provider: local,
  policy: { ...DEFAULT_POLICY, providers: ["planner"] },
  objective: "Add invoices",
  acceptance: ["GET /invoices lists invoices"],
  context: packet([item("src/app.ts", 5, "export const app = 1;")]),
  ...overrides,
});
const respond = (sent: { body?: Record<string, any> }) =>
  vi.fn(async (_url: string, init: { body: string }) => {
    sent.body = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        model: "planner-model",
        choices: [{ message: { content: JSON.stringify(decomposition) } }],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      }),
    );
  });

describe("plan worker", () => {
  it("asks for a structured decomposition with the task and its context", async () => {
    const sent: { body?: Record<string, any> } = {};
    const result = await invokePlanWorker(input(), respond(sent));
    expect(result.decomposition).toEqual(decomposition);
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 8 });
    expect(sent.body!.messages[0].content).toBe(PLANNER_INSTRUCTIONS);
    expect(sent.body!.response_format.json_schema.name).toBe(
      "plan_decomposition",
    );
    expect(JSON.parse(sent.body!.messages[1].content)).toEqual({
      task: "Add invoices",
      acceptance: ["GET /invoices lists invoices"],
      constraints: ["Money is stored as integer cents"],
      repository: [
        { path: "src/app.ts", lines: "1-1", text: "export const app = 1;" },
      ],
    });
  });

  it("drops the lowest-scoring context to fit, and refuses when the task alone does not", async () => {
    const sent: { body?: Record<string, any> } = {};
    const policy = {
      ...DEFAULT_POLICY,
      providers: ["planner"],
      maxContextTokens: 2500,
    };
    await invokePlanWorker(
      input({
        policy,
        context: packet([
          item("src/low.ts", 1, "x".repeat(1500)),
          item("src/high.ts", 9, "keep me"),
        ]),
      }),
      respond(sent),
    );
    const request = JSON.parse(sent.body!.messages[1].content);
    expect(request.repository.map((entry: any) => entry.path)).toEqual([
      "src/high.ts",
    ]);
    const fetch = vi.fn();
    await expect(
      invokePlanWorker(
        input({ policy, objective: "x".repeat(5000), context: packet([]) }),
        fetch,
      ),
    ).rejects.toThrow("too large for the planner's context budget");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses secrets for cloud planners and installed agents, and rejects malformed plans", async () => {
    const fetch = vi.fn();
    await expect(
      invokePlanWorker(
        input({
          provider: { id: "planner", kind: "openai", model: "m" },
          policy: {
            ...DEFAULT_POLICY,
            providers: ["planner"],
            inference: "allowlisted",
            network: "allowlisted",
            allowedHosts: ["api.openai.com"],
          },
          objective: `Replace const serviceToken = "${"Zq7Lm2Xp" + "9Rt4Vb8Nc3Kd"}";`,
        }),
        fetch,
      ),
    ).rejects.toThrow(/secret/);
    await expect(
      invokePlanWorker(
        input({ provider: { id: "planner", kind: "claude", model: "m" } }),
        fetch,
      ),
    ).rejects.toThrow("installed agents cannot plan yet");
    expect(fetch).not.toHaveBeenCalled();
    const tooMany = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    rationale: "",
                    steps: Array.from({ length: 13 }, (_, index) => ({
                      id: `s${index}`,
                      objective: "x",
                      dependsOn: [],
                    })),
                  }),
                },
              },
            ],
          }),
        ),
    );
    await expect(invokePlanWorker(input(), tooMany)).rejects.toThrow();
  });
});
