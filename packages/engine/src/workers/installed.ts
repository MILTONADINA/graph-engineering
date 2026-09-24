import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import type { ProviderKind, Usage } from "@graph-engineering/contracts";
import {
  assertEndpoint,
  assertProvider,
  containsSecret,
  contextForProvider,
} from "../policy.js";
import { command } from "../util.js";
import {
  proposalJsonSchema,
  proposalSchema,
  WORKER_INSTRUCTIONS,
  type WorkerInput,
  type WorkerResult,
} from "./api.js";

type InstalledKind = Extract<ProviderKind, "codex" | "claude" | "cursor">;
export interface InstalledWorkerCapability {
  kind: InstalledKind;
  executable: string;
  installed: boolean;
  version: string | null;
  available: boolean;
  authentication: "api-key" | "native-login" | "unavailable";
  supportsSubscription: boolean;
  mode: "proposal-only" | "restricted-read" | "unavailable";
  reason: string | null;
  limits: string[];
}

const CLAUDE_REQUIRED_FLAGS = [
  "--bare",
  "--tools",
  "--disallowedTools",
  "--strict-mcp-config",
  "--mcp-config",
  "--setting-sources",
  "--settings",
  "--disable-slash-commands",
  "--no-session-persistence",
  "--system-prompt",
  "--json-schema",
  "--output-format",
  "--restricted",
  "--safe-mode",
];
const CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "shell_snapshot",
  "hooks",
  "multi_agent",
  "apps",
  "plugins",
  "browser_use",
  "computer_use",
  "image_generation",
  "code_mode",
  "code_mode_host",
  "view_image",
  "memories",
  "skill_mcp_dependency_install",
];
const CURSOR_SDK_PIN = "1.0.32";

/** Treat generated protocol schemas as capabilities only when the fields have
 * the expected JSON Schema structure. Descriptions and unrelated definitions
 * must not make an unsupported native client appear safe to launch. */
function supportsRestrictedCodexReads(schema: any): boolean {
  const definitions = schema?.definitions;
  if (!definitions || typeof definitions !== "object") return false;
  const resolve = (entry: any): any => {
    const reference = entry?.$ref;
    if (typeof reference !== "string") return entry;
    if (!reference.startsWith("#/definitions/")) return null;
    const name = reference.slice("#/definitions/".length);
    return definitions[name] ?? null;
  };
  const variants = (entry: any): any[] => {
    const resolved = resolve(entry);
    return Array.isArray(resolved?.oneOf)
      ? resolved.oneOf.map(resolve)
      : Array.isArray(resolved?.anyOf)
        ? resolved.anyOf.map(resolve)
        : [];
  };
  const declares = (entry: any, value: string): boolean => {
    const resolved = resolve(entry);
    return (
      resolved?.const === value ||
      (Array.isArray(resolved?.enum) && resolved.enum.includes(value))
    );
  };
  const readOnly = variants(definitions.SandboxPolicy).find((option) =>
    declares(option?.properties?.type, "readOnly"),
  );
  return variants(readOnly?.properties?.access).some((option) => {
    const properties = option?.properties;
    return (
      declares(properties?.type, "restricted") &&
      resolve(properties?.readableRoots)?.type === "array" &&
      resolve(properties?.includePlatformDefaults)?.type === "boolean"
    );
  });
}

/** Do not pass repository credentials, shell startup hooks, or provider-routing overrides to native clients. */
function baseEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "USERPROFILE",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function probe(
  executable: string,
  argv: string[],
  environment?: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    const result = await command(executable, argv, {
      cwd: os.tmpdir(),
      env: environment ?? {
        ...baseEnvironment(),
        ...(executable === "claude"
          ? {
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
              DISABLE_AUTOUPDATER: "1",
            }
          : {}),
      },
      timeoutMs: 5000,
      maxBytes: 100_000,
    });
    return result.code === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

function claudeEnvironment(
  maxOutputTokens: number,
  key?: string,
  endpoint?: string,
): NodeJS.ProcessEnv {
  return {
    ...baseEnvironment(),
    ...(key ? { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: endpoint } : {}),
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  };
}

async function existsOrCannotInspect(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** OAuth is permitted only when this host can rule out managed Claude policy. */
async function claudeSubscriptionReady(
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  const rawAuth = await probe("claude", ["auth", "status"], environment);
  let auth: Record<string, unknown>;
  try {
    auth = JSON.parse(rawAuth ?? "");
  } catch {
    return false;
  }
  if (
    auth.loggedIn !== true ||
    auth.authMethod !== "claude.ai" ||
    !["pro", "max"].includes(String(auth.subscriptionType).toLowerCase())
  )
    return false;

  // Safe mode still honors administrator-managed hooks. The doctor report is
  // intentionally treated as a version-specific allowlist, not a best-effort
  // warning: an unfamiliar or missing policy status fails closed.
  const doctor = await probe("claude", ["doctor"], environment);
  if (
    !doctor?.includes(
      "Managed settings (remote): not fetched — requires an Enterprise or Team subscription",
    ) ||
    !doctor.includes(
      "Organization policy: not applicable to Pro and Max accounts",
    )
  )
    return false;

  const systemRoot =
    process.platform === "darwin"
      ? "/Library/Application Support/ClaudeCode"
      : process.platform === "linux"
        ? "/etc/claude-code"
        : null;
  if (!systemRoot) return false;
  for (const entry of [
    "managed-settings.json",
    "managed-settings.d",
    "managed-mcp.json",
  ])
    if (await existsOrCannotInspect(path.join(systemRoot, entry))) return false;

  if (process.platform === "darwin") {
    const enrollment = await probe(
      "profiles",
      ["status", "-type", "enrollment"],
      environment,
    );
    if (
      !enrollment?.includes("Enrolled via DEP: No") ||
      !enrollment.includes("MDM enrollment: No")
    )
      return false;
    try {
      const managedDomain = await command(
        "defaults",
        ["read", "com.anthropic.claudecode"],
        {
          cwd: os.tmpdir(),
          env: environment,
          timeoutMs: 5000,
          maxBytes: 100_000,
        },
      );
      if (
        managedDomain.code === 0 ||
        !/Domain ['"]?com\.anthropic\.claudecode['"]? not found\./.test(
          managedDomain.stderr,
        )
      )
        return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function inspect(
  kind: InstalledKind,
  claudeRunEnv?: NodeJS.ProcessEnv,
): Promise<InstalledWorkerCapability> {
  const executable = kind === "cursor" ? process.execPath : kind;
  const rawVersion =
    kind === "cursor"
      ? await (async () => {
          try {
            const entry = fileURLToPath(import.meta.resolve("@cursor/sdk"));
            const metadata = JSON.parse(
              await readFile(
                path.resolve(path.dirname(entry), "../../package.json"),
                "utf8",
              ),
            );
            return metadata.name === "@cursor/sdk"
              ? String(metadata.version)
              : null;
          } catch {
            return null;
          }
        })()
      : await probe(executable, ["--version"]);
  const version = rawVersion?.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
  const result: InstalledWorkerCapability = {
    kind,
    executable,
    installed: rawVersion !== null,
    version,
    available: false,
    authentication: "unavailable",
    supportsSubscription: false,
    mode: "unavailable",
    reason: null,
    limits: [
      "Client availability is not an authentication or paid-inference test.",
      "Native clients do not provide a hard monetary ceiling; cost-capped runs require an API worker.",
    ],
  };
  if (rawVersion === null) {
    result.reason =
      kind === "cursor"
        ? "Cursor SDK is not installed or its package metadata cannot be inspected"
        : `${executable} is not installed or its read-only version probe failed`;
    return result;
  }
  if (kind === "cursor") {
    if (version !== CURSOR_SDK_PIN) {
      result.reason = `Cursor SDK ${version ?? "unknown"} has not passed the ${CURSOR_SDK_PIN} control audit`;
      return result;
    }
    result.available = true;
    result.authentication = "api-key";
    result.mode = "proposal-only";
    result.limits.push(
      "Text-only local SDK worker in an empty scratch directory; file-based project/user/team/MDM/plugin settings and hooks, MCP, and tools are disabled.",
      "Requires an explicitly selected Cursor user API key; desktop login is not reused. User keys may be charged to the Cursor plan.",
      "No hard dollar or token cap is available. Token usage is checked as reported, after it can be incurred; live isolation and billing still require an owner-authorized call.",
    );
    return result;
  }
  if (kind === "codex") {
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), "graph-codex-capabilities-"),
    );
    try {
      const generated = await command(
        "codex",
        [
          "app-server",
          "generate-json-schema",
          "--experimental",
          "--out",
          temporary,
        ],
        {
          cwd: temporary,
          env: baseEnvironment(),
          timeoutMs: 10000,
          maxBytes: 100_000,
        },
      );
      if (generated.code !== 0) throw new Error("schema generation failed");
      const schema = JSON.parse(
        await readFile(
          path.join(temporary, "v2", "TurnStartParams.json"),
          "utf8",
        ),
      );
      if (!supportsRestrictedCodexReads(schema)) {
        result.reason =
          "Installed Codex protocol does not declare restricted readOnly access/readableRoots. Ordinary read-only mode allows reads outside the scratch directory, so this worker is unavailable.";
        return result;
      }
      const flags = await probe("codex", ["features", "list"]);
      const missing = CODEX_DISABLED_FEATURES.filter(
        (feature) =>
          !flags?.split("\n").some((line) => line.startsWith(`${feature} `)),
      );
      if (missing.length) {
        result.reason = `Codex lacks verified feature controls: ${missing.join(", ")}`;
        return result;
      }
      result.available = true;
      result.authentication = "native-login";
      result.supportsSubscription = true;
      result.mode = "restricted-read";
      result.limits.push(
        "Restricted-read App Server worker: some internal tools can remain visible; execution permissions are enforced by Codex, not intercepted by Graph Engineering.",
        "Output/context limits are observed after usage events; no exact provider token cap is available.",
      );
    } catch {
      result.reason =
        "Cannot verify the installed Codex App Server restricted-read protocol";
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    return result;
  }
  const components = version?.split(".").map(Number);
  if (
    !components ||
    components[0] !== 2 ||
    components[1] !== 1 ||
    components[2] < 278
  ) {
    result.reason =
      "The restricted Claude adapter requires Claude Code 2.1.278 or later in the 2.1 series; other versions have not passed its capability gate";
    return result;
  }
  const help = await probe(executable, ["--help"]);
  const missing = CLAUDE_REQUIRED_FLAGS.filter((flag) => !help?.includes(flag));
  if (missing.length) {
    result.reason = `Claude CLI lacks required capability flags: ${missing.join(", ")}`;
    return result;
  }
  result.available = true;
  result.mode = "proposal-only";
  result.supportsSubscription = await claudeSubscriptionReady(
    claudeRunEnv ?? claudeEnvironment(4000),
  );
  result.authentication = result.supportsSubscription
    ? "native-login"
    : "api-key";
  result.limits.push(
    result.supportsSubscription
      ? "A verified Pro/Max login can be used without an API key; apiKeyEnv explicitly selects bare API-key mode."
      : "Subscription mode requires a verified claude.ai Pro/Max login and no managed policy; apiKeyEnv selects bare API-key mode.",
    "Output-token limits apply to each model response; native prompt overhead and retries remain client-controlled.",
  );
  return result;
}

/** Read-only probes only. Does not log in, install clients, or make model requests. */
export async function discoverInstalledWorkers(): Promise<
  InstalledWorkerCapability[]
> {
  return Promise.all(
    (["codex", "claude", "cursor"] as const).map((kind) => inspect(kind)),
  );
}

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function resultUsage(result: Record<string, any>): Usage {
  return {
    inputTokens: finiteCount(result.usage?.input_tokens),
    outputTokens: finiteCount(result.usage?.output_tokens),
    cachedTokens: finiteCount(result.usage?.cache_read_input_tokens),
    costUsd: finiteCount(result.total_cost_usd),
    estimated: false,
  };
}

type CodexMethod =
  | "initialize"
  | "config/read"
  | "configRequirements/read"
  | "experimentalFeature/list"
  | "model/list"
  | "thread/start"
  | "turn/start"
  | "turn/interrupt";

/** Dedicated stdio session. No filesystem, process, shellCommand, or configuration-write RPC exists here. */
class CodexConnection {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (reason: Error) => void }
  >();
  private sequence = 0;
  private closed = false;
  private failure: Error | null = null;
  private watchdog: ReturnType<typeof setTimeout>;
  private hardStop: ReturnType<typeof setTimeout> | undefined;
  private done: Promise<void>;
  private abort: () => void;
  onNotification: (method: string, params: any) => void = () => {};
  onFailure: (error: Error) => void = () => {};

  constructor(
    cwd: string,
    timeoutMs: number,
    private signal?: AbortSignal,
  ) {
    const args = [
      "app-server",
      "--stdio",
      ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
      "-c",
      'web_search="disabled"',
      "-c",
      "project_doc_max_bytes=0",
      "-c",
      "agents.enabled=false",
      "-c",
      'history.persistence="none"',
      "-c",
      "analytics.enabled=false",
      "-c",
      "feedback.enabled=false",
      "-c",
      "check_for_update_on_startup=false",
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_mode="read-only"',
    ];
    const env = {
      ...baseEnvironment(),
      ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
    };
    this.child = spawn("codex", args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.done = new Promise((resolve) =>
      this.child.once("close", () => {
        this.closed = true;
        clearTimeout(this.watchdog);
        clearTimeout(this.hardStop);
        this.signal?.removeEventListener("abort", this.abort);
        this.fail(new Error("Codex App Server connection closed"));
        resolve();
      }),
    );
    this.abort = () => this.stop(new Error("Codex worker cancelled"));
    signal?.addEventListener("abort", this.abort, { once: true });
    this.watchdog = setTimeout(
      () => this.stop(new Error("Codex worker timed out")),
      timeoutMs,
    );
    let bytes = 0;
    const count = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 2_000_000)
        this.stop(new Error("Codex output exceeded the transport limit"));
    };
    this.child.stdout.on("data", count);
    this.child.stderr.on("data", count);
    this.child.once("error", () =>
      this.stop(new Error("Codex App Server could not start")),
    );
    this.child.stdin.on("error", () =>
      this.stop(new Error("Codex App Server input closed")),
    );
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined && message.method) {
          // A request from the server is never forwarded to an executor or approved.
          if (/requestApproval$/.test(message.method))
            this.write({ id: message.id, result: { decision: "decline" } });
          else
            this.write({
              id: message.id,
              error: {
                code: -32601,
                message:
                  "This proposal worker does not authorize tool, permission, or input requests",
              },
            });
          return;
        }
        if (message.id !== undefined) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error)
            pending?.reject(
              new Error(
                `Codex RPC failed (${message.error.code ?? "unknown"})`,
              ),
            );
          else pending?.resolve(message.result);
        } else if (message.method)
          this.onNotification(message.method, message.params);
      } catch {
        this.stop(new Error("Codex returned an invalid protocol message"));
      }
    });
    if (signal?.aborted) this.abort();
  }
  private write(message: unknown): void {
    if (!this.closed && !this.failure)
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method: CodexMethod, params: unknown): Promise<any> {
    if (this.failure || this.closed)
      return Promise.reject(
        this.failure ?? new Error("Codex connection is closed"),
      );
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }
  initialized(): void {
    this.write({ method: "initialized", params: {} });
  }
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.onFailure(error);
  }
  stop(error: Error): void {
    this.fail(error);
    if (this.closed || this.hardStop) return;
    this.child.kill("SIGTERM");
    this.hardStop = setTimeout(() => this.child.kill("SIGKILL"), 1000);
    this.hardStop.unref();
  }
  async dispose(): Promise<void> {
    this.stop(new Error("Codex session finished"));
    await this.done;
  }
}

async function invokeCodexWorker(input: WorkerInput): Promise<WorkerResult> {
  const { provider, policy, signal } = input;
  if (provider.endpoint)
    throw new Error(
      "Installed Codex endpoint overrides are not supported; configure an API worker for a custom endpoint",
    );
  if (provider.apiKeyEnv)
    throw new Error(
      "Installed Codex uses its supported native login; use the OpenAI API worker for apiKeyEnv credentials",
    );
  // Native authentication may use either supported endpoint; both must be explicitly permitted.
  assertEndpoint("https://api.openai.com", policy);
  assertEndpoint("https://chatgpt.com", policy);
  const packet = contextForProvider(input.context, provider, policy);
  const prompt = JSON.stringify({
    task: input.objective,
    acceptance: input.acceptance,
    context: packet,
    feedback: input.feedback ?? null,
  });
  const budget = Math.min(
    policy.maxContextTokens,
    provider.maxContextTokens ?? policy.maxContextTokens,
  );
  if (
    Buffer.byteLength(
      prompt + WORKER_INSTRUCTIONS + JSON.stringify(proposalJsonSchema),
      "utf8",
    ) +
      256 >
    budget
  )
    throw new Error(
      "Installed-worker request exceeds configured context budget",
    );
  const temporary = await mkdtemp(path.join(os.tmpdir(), "graph-worker-"));
  const rpc = new CodexConnection(
    temporary,
    policy.timeoutSeconds * 1000,
    signal,
  );
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "graph_engineering", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.initialized();
    const configResult = await rpc.request("config/read", {
      includeLayers: false,
    });
    const config = configResult.config ?? {};
    if (config.model_providers?.openai?.base_url || config.chatgpt_base_url)
      throw new Error(
        "Native Codex uses custom routing that this adapter cannot validate; use an API worker",
      );
    const requirements = (await rpc.request("configRequirements/read", {}))
      .requirements;
    if (requirements?.hooks && Object.keys(requirements.hooks).length)
      throw new Error("Managed Codex hooks are incompatible with this worker");
    for (const feature of CODEX_DISABLED_FEATURES)
      if (requirements?.featureRequirements?.[feature] === true)
        throw new Error(
          `Managed Codex requires ${feature}; restricted worker unavailable`,
        );
    const flags: any[] = [];
    let flagCursor: string | null = null;
    do {
      const page = await rpc.request("experimentalFeature/list", {
        limit: 100,
        ...(flagCursor ? { cursor: flagCursor } : {}),
      });
      flags.push(...page.data);
      flagCursor = page.nextCursor ?? null;
    } while (flagCursor);
    for (const feature of CODEX_DISABLED_FEATURES)
      if (
        !flags.some((flag) => flag.name === feature && flag.enabled === false)
      )
        throw new Error(`Codex did not disable ${feature}`);
    let model: any;
    let modelCursor: string | null = null;
    do {
      const page = await rpc.request("model/list", {
        limit: 100,
        includeHidden: true,
        ...(modelCursor ? { cursor: modelCursor } : {}),
      });
      model = page.data.find(
        (entry: any) =>
          entry.model === provider.model || entry.id === provider.model,
      );
      modelCursor = page.nextCursor ?? null;
    } while (!model && modelCursor);
    if (!model)
      throw new Error(
        `Installed Codex does not advertise model ${provider.model}`,
      );
    if (
      input.effort &&
      !model.supportedReasoningEfforts?.some(
        (entry: any) => entry.reasoningEffort === input.effort,
      )
    )
      throw new Error(
        `Installed Codex does not advertise effort ${input.effort} for this model`,
      );
    const overrides: Record<string, unknown> = {
      mcp_servers: Object.fromEntries(
        Object.keys(config.mcp_servers ?? {}).map((name) => [
          name,
          { enabled: false },
        ]),
      ),
      web_search: "disabled",
      project_doc_max_bytes: 0,
    };
    const thread = await rpc.request("thread/start", {
      model: provider.model,
      modelProvider: "openai",
      cwd: temporary,
      ephemeral: true,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
      baseInstructions: WORKER_INSTRUCTIONS,
      developerInstructions:
        "Only return the requested structured proposal. Do not call tools or read files.",
      dynamicTools: [],
      environments: [],
      selectedCapabilityRoots: [],
      runtimeWorkspaceRoots: [temporary],
      config: overrides,
      allowProviderModelFallback: false,
    });
    if (
      thread.sandbox?.type !== "readOnly" ||
      thread.sandbox.networkAccess === true ||
      thread.approvalPolicy !== "never" ||
      thread.instructionSources?.length
    )
      throw new Error(
        "Codex effective thread permissions or instruction sources exceed the worker contract",
      );
    const threadId = thread.thread.id;
    let usage: Usage = {
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      costUsd: null,
      estimated: false,
    };
    let finalText = "";
    let resolveCompletion!: () => void,
      rejectCompletion!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    void completion.catch(() => {});
    rpc.onFailure = rejectCompletion;
    rpc.onNotification = (method, params) => {
      if (params?.threadId && params.threadId !== threadId) return;
      if (method === "thread/tokenUsage/updated") {
        const counts = params.tokenUsage?.total;
        usage = {
          inputTokens: finiteCount(counts?.inputTokens),
          outputTokens: finiteCount(counts?.outputTokens),
          cachedTokens: finiteCount(counts?.cachedInputTokens),
          costUsd: null,
          estimated: false,
        };
        if (
          (usage.outputTokens ?? 0) > policy.maxOutputTokens ||
          (usage.inputTokens ?? 0) > budget
        )
          rpc.stop(new Error("Codex exceeded the observed token budget"));
      }
      if (
        method === "item/completed" &&
        params.item?.type === "agentMessage" &&
        params.item.phase !== "commentary"
      )
        finalText = params.item.text;
      if (
        method === "item/started" &&
        [
          "commandExecution",
          "fileChange",
          "mcpToolCall",
          "dynamicToolCall",
          "collabAgentToolCall",
        ].includes(params.item?.type)
      )
        rpc.stop(
          new Error(
            "Codex attempted a tool operation outside the proposal workflow",
          ),
        );
      if (method === "hook/started")
        rpc.stop(new Error("Codex ran a hook incompatible with this worker"));
      if (method === "turn/completed") {
        if (params.turn?.status === "completed") resolveCompletion();
        else
          rejectCompletion(
            new Error("Codex did not complete the proposal turn"),
          );
      }
    };
    await rpc.request("turn/start", {
      threadId,
      cwd: temporary,
      model: provider.model,
      ...(input.effort ? { effort: input.effort } : {}),
      input: [{ type: "text", text: prompt }],
      outputSchema: proposalJsonSchema,
      approvalPolicy: "never",
      environments: [],
      runtimeWorkspaceRoots: [temporary],
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: false,
        access: {
          type: "restricted",
          includePlatformDefaults: true,
          readableRoots: [temporary],
        },
      },
    });
    await completion;
    let proposal: unknown;
    try {
      proposal = JSON.parse(finalText);
    } catch {
      throw new Error("Codex returned no valid structured proposal");
    }
    return {
      proposal: proposalSchema.parse(proposal),
      usage,
      model: thread.model ?? provider.model,
    };
  } finally {
    await rpc.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
}

async function invokeCursorWorker(input: WorkerInput): Promise<WorkerResult> {
  const { provider, policy, signal } = input;
  if (provider.endpoint)
    throw new Error(
      "Cursor SDK endpoint overrides are not supported; use a metered API worker for a custom endpoint",
    );
  if (input.effort)
    throw new Error(
      "Cursor SDK proposal mode cannot enforce a selected reasoning effort",
    );
  // Model validation and agent execution use separate first-party origins in
  // the audited SDK build. Both must be explicitly approved before launch.
  assertEndpoint("https://api.cursor.com", policy);
  assertEndpoint("https://api2.cursor.sh", policy);
  if (!provider.apiKeyEnv)
    throw new Error(
      "Cursor SDK requires an explicit apiKeyEnv; it does not reuse the desktop login",
    );
  const key = process.env[provider.apiKeyEnv];
  if (!key)
    throw new Error(
      `Cursor SDK requires ${provider.apiKeyEnv}; no browser login or paid call is started`,
    );
  const packet = contextForProvider(input.context, provider, policy);
  const budget = Math.min(
    policy.maxContextTokens,
    provider.maxContextTokens ?? policy.maxContextTokens,
  );
  const prompt = `${WORKER_INSTRUCTIONS}\n\nRequired JSON schema:\n${JSON.stringify(proposalJsonSchema)}\n\nTask packet:\n${JSON.stringify(
    {
      task: input.objective,
      acceptance: input.acceptance,
      context: packet,
      feedback: input.feedback ?? null,
    },
  )}`;
  if (Buffer.byteLength(prompt, "utf8") + 256 > budget)
    throw new Error(
      "Installed-worker request exceeds configured context budget",
    );

  const temporary = await mkdtemp(path.join(os.tmpdir(), "graph-cursor-"));
  const workspace = path.join(temporary, "workspace");
  try {
    await mkdir(workspace, { mode: 0o700 });
    signal?.throwIfAborted();
    const environment = baseEnvironment();
    // The explicit key and scratch-local SDK store do not need the user's
    // home/config environment. Do not expose unrelated account overrides.
    delete environment.HOME;
    delete environment.USERPROFILE;
    delete environment.XDG_CONFIG_HOME;
    const native = await command(
      process.execPath,
      [fileURLToPath(new URL("./cursor-runner.js", import.meta.url))],
      {
        cwd: workspace,
        env: { ...environment, CURSOR_API_KEY: key, NO_OPEN_BROWSER: "1" },
        input: JSON.stringify({
          workspace,
          model: provider.model,
          prompt,
          maxInputTokens: budget,
          maxOutputTokens: policy.maxOutputTokens,
        }),
        signal,
        timeoutMs: policy.timeoutSeconds * 1000,
        maxBytes: 2_000_000,
      },
    );
    if (native.code !== 0)
      throw new Error(
        `Cursor worker exited with code ${native.code}; native diagnostics are withheld because they may contain context or credentials`,
      );
    let result: Record<string, any>;
    try {
      result = JSON.parse(native.stdout);
    } catch {
      throw new Error("Cursor returned invalid worker JSON");
    }
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("Cursor returned invalid worker result");
    return {
      proposal: proposalSchema.parse(result.proposal),
      model:
        typeof result.model === "string" && result.model.length > 0
          ? result.model
          : provider.model,
      usage: {
        inputTokens: finiteCount(result.usage?.inputTokens),
        outputTokens: finiteCount(result.usage?.outputTokens),
        cachedTokens: finiteCount(result.usage?.cachedTokens),
        costUsd: null,
        estimated: false,
      },
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/**
 * The optional run workspace is deliberately never opened or passed to a native client.
 * Native clients can only propose edits against the explicitly exported context packet.
 */
export async function invokeInstalledWorker(
  input: WorkerInput,
  _workspace?: string,
): Promise<WorkerResult> {
  const { provider, policy, signal } = input;
  signal?.throwIfAborted();
  if (!["codex", "claude", "cursor"].includes(provider.kind))
    throw new Error("Provider is not an installed-agent worker");
  assertProvider(provider, policy, input.effort);
  if (policy.maxCostUsd !== null)
    throw new Error(
      "Installed agents cannot enforce this run’s monetary cap; choose a metered API worker",
    );
  if (
    [input.objective, ...input.acceptance, input.feedback ?? ""].some(
      containsSecret,
    )
  )
    throw new Error("Worker instructions contain a potential secret");
  if (provider.kind !== "claude") {
    const capability = await inspect(provider.kind as InstalledKind);
    if (!capability.available)
      throw new Error(capability.reason ?? "Installed worker is unavailable");
    if (provider.kind === "codex") return invokeCodexWorker(input);
    return invokeCursorWorker(input);
  }
  const subscription = provider.apiKeyEnv === undefined;
  if (subscription && provider.endpoint)
    throw new Error(
      "Claude subscription mode does not allow endpoint overrides",
    );
  const endpoint = provider.endpoint ?? "https://api.anthropic.com";
  assertEndpoint(endpoint, policy);
  if (subscription) assertEndpoint("https://claude.ai", policy);
  const key = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
  if (!subscription && !key)
    throw new Error(
      `Claude bare mode requires ${provider.apiKeyEnv}; it cannot reuse subscription authentication`,
    );
  const env = claudeEnvironment(
    policy.maxOutputTokens,
    subscription ? undefined : key,
    endpoint,
  );
  const capability = await inspect("claude", env);
  if (!capability.available)
    throw new Error(capability.reason ?? "Installed worker is unavailable");
  if (subscription && !capability.supportsSubscription)
    throw new Error(
      "Claude subscription mode requires a verified claude.ai Pro/Max login and no managed policy",
    );
  const packet = contextForProvider(input.context, provider, policy);
  const prompt = JSON.stringify({
    task: input.objective,
    acceptance: input.acceptance,
    context: packet,
    feedback: input.feedback ?? null,
  });
  const budget = Math.min(
    policy.maxContextTokens,
    provider.maxContextTokens ?? policy.maxContextTokens,
  );
  if (
    Buffer.byteLength(
      prompt + WORKER_INSTRUCTIONS + JSON.stringify(proposalJsonSchema),
      "utf8",
    ) +
      256 >
    budget
  )
    throw new Error(
      "Installed-worker request exceeds configured context budget",
    );
  if (
    input.effort &&
    !["low", "medium", "high", "xhigh", "max"].includes(input.effort)
  )
    throw new Error(`Claude CLI cannot represent effort ${input.effort}`);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "graph-worker-"));
  try {
    signal?.throwIfAborted();
    const argv = [
      ...(!subscription ? ["--bare"] : []),
      "--restricted",
      "--safe-mode",
      "--print",
      "--output-format",
      "json",
      "--model",
      provider.model,
      "--tools",
      "",
      "--disallowedTools",
      "mcp__*",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--setting-sources",
      "",
      "--settings",
      '{"disableAllHooks":true,"autoMemoryEnabled":false}',
      "--disable-slash-commands",
      "--no-session-persistence",
      "--no-chrome",
      "--max-turns",
      String(Math.min(policy.maxTurns, 2)),
      "--system-prompt",
      WORKER_INSTRUCTIONS,
      "--json-schema",
      JSON.stringify(proposalJsonSchema),
      ...(input.effort ? ["--effort", input.effort] : []),
    ];
    const response = await command(capability.executable, argv, {
      cwd: temporary,
      env,
      input: prompt,
      signal,
      timeoutMs: policy.timeoutSeconds * 1000,
      maxBytes: 2_000_000,
    });
    if (response.code !== 0)
      throw new Error(
        `Claude worker exited with code ${response.code}; native error output is withheld because it can contain credentials or context`,
      );
    let result: Record<string, any>;
    try {
      result = JSON.parse(response.stdout);
    } catch {
      throw new Error("Claude returned invalid JSON");
    }
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      result.is_error ||
      result.type !== "result" ||
      result.subtype !== "success"
    ) {
      throw new Error(
        "Claude did not complete a successful structured proposal",
      );
    }
    let proposal: unknown = result.structured_output;
    if (proposal === undefined && typeof result.result === "string") {
      try {
        proposal = JSON.parse(result.result);
      } catch {
        throw new Error("Claude returned no structured proposal");
      }
    }
    const usage = resultUsage(result);
    if (subscription) usage.costUsd = null;
    // Detect a client that ignored the requested response budget; never label its output successful.
    if (
      usage.outputTokens !== null &&
      usage.outputTokens > policy.maxOutputTokens * Math.min(policy.maxTurns, 2)
    ) {
      throw new Error("Claude exceeded the requested output-token budget");
    }
    return {
      proposal: proposalSchema.parse(proposal),
      usage,
      model: provider.model,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
