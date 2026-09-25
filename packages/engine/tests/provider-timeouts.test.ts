import { afterEach, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  DEFAULT_POLICY,
  type ContextPacket,
} from "@graph-engineering/contracts";
import { invokeApiWorker } from "../src/workers/api.js";

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
const completion = JSON.stringify({
  model: "local-fixture",
  choices: [
    {
      message: {
        content: JSON.stringify({ summary: "Fix", changes: [], requests: [] }),
      },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
    server.closeAllConnections();
  }
});
async function provider(
  handle: (response: ServerResponse, request: IncomingMessage) => void,
) {
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    handle(response, request);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { server, endpoint: `http://127.0.0.1:${port}/v1` };
}
const call = (endpoint: string, timeoutSeconds: number, signal?: AbortSignal) =>
  invokeApiWorker({
    provider: {
      id: "local",
      kind: "local",
      model: "fixture",
      endpoint,
    },
    policy: { ...DEFAULT_POLICY, providers: ["local"], timeoutSeconds },
    context: packet,
    objective: "Fix sum",
    acceptance: ["sum is correct"],
    signal,
  });
async function elapsed(promise: Promise<unknown>) {
  const started = Date.now();
  const outcome = await promise.then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );
  return { ...outcome, ms: Date.now() - started };
}

it("waits for provider headers exactly as long as the policy timeout", async () => {
  const encodings: (string | undefined)[] = [];
  const { endpoint } = await provider((response, request) => {
    encodings.push(request.headers["accept-encoding"]);
    setTimeout(() => {
      response.setHeader("Content-Type", "application/json");
      response.end(completion);
    }, 1500);
  });
  const late = await elapsed(call(endpoint, 1));
  expect((late.error as Error).name).toBe("TimeoutError");
  expect(late.ms).toBeLessThan(1400);
  const result = await call(endpoint, 3);
  expect(result.proposal.summary).toBe("Fix");
  expect(encodings).toEqual(["identity", "identity"]);
});

it("stops reading a stalled or trickling body when cancelled or timed out", async () => {
  const { endpoint: stalled } = await provider((response) => {
    response.setHeader("Content-Type", "application/json");
    response.write(completion.slice(0, 20));
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("Run cancelled")), 200);
  const cancelled = await elapsed(call(stalled, 20, controller.signal));
  expect((cancelled.error as Error).message).toBe("Run cancelled");
  expect(cancelled.ms).toBeLessThan(1500);

  const { endpoint: trickling } = await provider((response) => {
    response.setHeader("Content-Type", "application/json");
    const timer = setInterval(() => response.write(" "), 100);
    response.on("close", () => clearInterval(timer));
  });
  const timedOut = await elapsed(call(trickling, 1));
  expect((timedOut.error as Error).name).toBe("TimeoutError");
  expect(timedOut.ms).toBeLessThan(1500);
});

it("refuses error statuses and redirects and closes their connections", async () => {
  let closed = 0;
  for (const [status, headers] of [
    [500, {}],
    [302, { Location: "http://127.0.0.1:9/v1/chat/completions" }],
  ] as const) {
    const { endpoint } = await provider((response) => {
      response.on("close", () => closed++);
      response.writeHead(status, headers);
      response.write("partial");
    });
    await expect(call(endpoint, 5)).rejects.toThrow(
      `Provider local returned HTTP ${status}`,
    );
  }
  await expect.poll(() => closed).toBe(2);
});

// Node's built-in fetch gives up after 300 s without response headers.
it.runIf(process.env.GRAPH_ENGINE_SLOW_PROVIDER_TIMEOUT === "1")(
  "completes a local provider call whose headers arrive after 305 seconds",
  { timeout: 400_000 },
  async () => {
    const { endpoint } = await provider((response) => {
      setTimeout(() => {
        response.setHeader("Content-Type", "application/json");
        response.end(completion);
      }, 305_000);
    });
    const result = await call(endpoint, 390);
    expect(result.proposal.summary).toBe("Fix");
  },
);
