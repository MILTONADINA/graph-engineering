import { pathToFileURL } from "node:url";
import path from "node:path";
import type * as CursorSdk from "@cursor/sdk";

export interface CursorRunnerRequest {
  workspace: string;
  model: string;
  prompt: string;
  maxInputTokens: number;
  maxOutputTokens: number;
}

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * The only model input is the already export-filtered prompt. No ambient
 * project/user/team/MDM/plugin settings, MCP, hooks, custom tools, or built-in
 * tools are loaded. Keep this in a short-lived, sanitized child process.
 */
export async function runCursorTextProposal(
  request: CursorRunnerRequest,
  apiKey: string,
  sdk: typeof CursorSdk,
): Promise<Record<string, unknown>> {
  if (!apiKey) throw new Error("Cursor user key is required");
  if (!path.isAbsolute(request.workspace))
    throw new Error("Cursor scratch workspace must be absolute");
  if (
    !Number.isSafeInteger(request.maxInputTokens) ||
    request.maxInputTokens <= 0 ||
    !Number.isSafeInteger(request.maxOutputTokens) ||
    request.maxOutputTokens <= 0
  )
    throw new Error("Cursor token bounds are invalid");
  if (Buffer.byteLength(request.prompt, "utf8") > request.maxInputTokens)
    throw new Error("Cursor prompt exceeds the configured input bound");

  const agent = await sdk.Agent.create({
    apiKey,
    model: { id: request.model },
    tools: [],
    disallowedTools: ["shell", "mcp", "task"],
    mcpServers: {},
    local: {
      cwd: request.workspace,
      settingSources: [],
      sandboxOptions: { enabled: true },
      autoReview: false,
      customTools: {},
      enableAgentRetries: false,
      store: new sdk.JsonlLocalAgentStore(
        path.join(request.workspace, "store"),
      ),
    },
  });
  try {
    const run = await agent.send(request.prompt, { mcpServers: {} });
    for await (const event of run.stream()) {
      if (event.type === "tool_call") {
        await run.cancel();
        throw new Error("Cursor attempted a tool operation in text-only mode");
      }
      if (
        event.type === "usage" &&
        ((finiteCount(event.usage.inputTokens) ?? 0) > request.maxInputTokens ||
          (finiteCount(event.usage.outputTokens) ?? 0) >
            request.maxOutputTokens)
      ) {
        await run.cancel();
        throw new Error("Cursor exceeded the observed token bound");
      }
    }
    const result = await run.wait();
    if (result.status !== "finished" || typeof result.result !== "string")
      throw new Error("Cursor did not finish a proposal response");
    if (Buffer.byteLength(result.result, "utf8") > 1_000_000)
      throw new Error("Cursor proposal exceeded the response byte limit");
    const inputTokens = finiteCount(result.usage?.inputTokens);
    const outputTokens = finiteCount(result.usage?.outputTokens);
    if (
      (inputTokens !== null && inputTokens > request.maxInputTokens) ||
      (outputTokens !== null && outputTokens > request.maxOutputTokens)
    )
      throw new Error("Cursor exceeded the observed token bound");
    const resolvedModel = result.model?.id ?? request.model;
    if (request.model !== "auto" && resolvedModel !== request.model)
      throw new Error("Cursor changed the selected worker model");
    let proposal: unknown;
    try {
      proposal = JSON.parse(result.result);
    } catch {
      throw new Error("Cursor returned no valid JSON proposal");
    }
    return {
      proposal,
      model: resolvedModel,
      usage: {
        inputTokens,
        outputTokens,
        cachedTokens: finiteCount(result.usage?.cacheReadTokens),
        costUsd: null,
        estimated: false,
      },
    };
  } finally {
    agent.close();
  }
}

async function readRequest(): Promise<CursorRunnerRequest> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.byteLength;
    if (bytes > 2_000_000)
      throw new Error("Cursor runner input exceeded the transport limit");
    chunks.push(data);
  }
  return JSON.parse(
    Buffer.concat(chunks).toString("utf8"),
  ) as CursorRunnerRequest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.env.CURSOR_BACKEND_URL || process.env.CURSOR_WEBSITE_URL)
      throw new Error("Cursor endpoint overrides are not supported");
    const request = await readRequest();
    const sdk = await import("@cursor/sdk");
    const result = await runCursorTextProposal(
      request,
      process.env.CURSOR_API_KEY ?? "",
      sdk,
    );
    process.stdout.write(JSON.stringify(result));
  } catch {
    // The parent withholds native stderr and never prints prompt, key, or SDK
    // diagnostics, which may contain exported source or credentials.
    process.exitCode = 1;
  }
}
