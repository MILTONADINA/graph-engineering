// Trusted Node controller. Candidate code runs in a separate QuickJS realm and
// receives JSON values only, never this store, its path, methods, or native handles.
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { RunStore } from "./store-bundle.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
export class ServiceCandidateViolation extends Error {}
const PROJECT = "infrastructure-fixture";
const ORIGINAL = "export const value = 1;\n";
const policy = Object.freeze({
  providers: ["local"],
  publication: "none",
  maxWorkers: 1,
  maxTurns: 4,
  maxAttempts: 2,
  maxCostUsd: null,
  maxContextTokens: 10000,
  maxOutputTokens: 1000,
  timeoutSeconds: 10,
  decisionMode: "shadow",
  network: "offline",
});
const provider = Object.freeze({
  id: "local",
  kind: "local",
  model: "fixture",
});
const checks = Object.freeze([{ image: "fixture", argv: ["fixture-check"] }]);
const config = Object.freeze({
  projectId: PROJECT,
  version: "1.0.0",
  policy,
  verification: checks,
});
const methods = new Set([
  "recoverInterrupted",
  "savePlan",
  "plan",
  "saveRun",
  "reserve",
  "reserveResume",
  "claim",
  "run",
  "runs",
  "events",
  "event",
  "decision",
  "decisions",
  "assertResumeAccounting",
  "usage",
  "reserveCall",
  "settleCall",
  "tryAcquireWorker",
  "releaseWorker",
  "accountingSummary",
]);

export async function createServiceController(input) {
  const directory = await mkdtemp("/tmp/graph-infrastructure-store-");
  let store;
  let violated = false;
  let workerCalls = 0,
    verificationCalls = 0,
    publicationCalls = 0,
    operations = 0;
  let content = ORIGINAL;
  const workerInventory = [],
    verificationInventory = [];
  const planId = randomUUID();
  const plan = {
    version: "1.0.0",
    id: planId,
    projectId: PROJECT,
    snapshotId: "fixture-snapshot",
    policyHash: digest(JSON.stringify(policy)),
    createdAt: new Date().toISOString(),
    objective: "Update fixture value",
    acceptance: ["Configured checks pass"],
    steps: [
      {
        id: "implement",
        kind: "worker",
        objective: "Update fixture value",
        dependsOn: [],
        providerId: "local",
      },
    ],
    verification: checks,
    publication: "none",
  };
  const open = () => (store ??= new RunStore(directory, PROJECT));
  open().savePlan(plan);
  store.close();
  store = undefined;
  const refuse = () => {
    violated = true;
    throw new Error("Unsupported infrastructure fixture capability");
  };
  const requireStore = () => store ?? refuse();
  function dispatch(operation, args) {
    if (++operations > 1500) return refuse();
    if (operation === "id" && args.length === 0) return randomUUID();
    if (operation === "now" && args.length === 0)
      return new Date().toISOString();
    if (
      operation === "hash" &&
      args.length === 1 &&
      typeof args[0] === "string"
    )
      return digest(args[0]);
    if (
      operation === "byteLength" &&
      args.length === 1 &&
      typeof args[0] === "string"
    )
      return Buffer.byteLength(args[0]);
    if (
      operation === "store.open" &&
      JSON.stringify(args) === JSON.stringify(["/data", PROJECT])
    ) {
      if (store) return refuse();
      open();
      return null;
    }
    if (operation === "store.close" && args.length === 0) {
      requireStore().close();
      store = undefined;
      return null;
    }
    if (
      operation.startsWith("store.") &&
      methods.has(operation.slice(6)) &&
      args.length <= 6
    )
      return requireStore()[operation.slice(6)](...args);
    if (operation === "loadProject" && JSON.stringify(args) === '["/project"]')
      return config;
    if (operation === "loadProviders" && JSON.stringify(args) === '["/data"]')
      return [provider];
    if (
      operation === "readJson" &&
      JSON.stringify(args) === '["/data/promotions.json"]'
    )
      throw Object.assign(new Error("Missing optional fixture promotions"), {
        code: "ENOENT",
      });
    if (
      operation === "context.index" &&
      args.length === 1 &&
      ["/project", "/workspace"].includes(args[0])
    )
      return {
        id: args[0] === "/project" ? "fixture-snapshot" : digest(content),
        projectId: PROJECT,
        fileCount: 1,
        languages: ["javascript"],
      };
    if (
      operation === "context.getContext" &&
      args.length === 2 &&
      ["/project", "/workspace"].includes(args[0])
    ) {
      const source = args[0] === "/project" ? ORIGINAL : content;
      return {
        version: "1.0.0",
        id: "fixture-packet",
        projectId: PROJECT,
        snapshotId: "fixture-snapshot",
        estimatedTokens: 100,
        mandatory: args[1].mandatory ?? plan.acceptance,
        mandatorySources: [],
        items: [
          {
            id: digest(source),
            kind: "code",
            text: source,
            score: 1,
            source: {
              path: "value.js",
              startLine: 1,
              endLine: 2,
              contentHash: digest(source),
              snapshotId: "fixture-snapshot",
            },
          },
        ],
      };
    }
    if (
      operation === "readFile" &&
      args.length === 2 &&
      ["/project/value.js", "/workspace/value.js"].includes(args[0]) &&
      args[1] === "utf8"
    )
      return args[0].startsWith("/project/") ? ORIGINAL : content;
    if (
      operation === "createWorkspace" &&
      args.length === 3 &&
      args[0] === "/project" &&
      args[1] === "/data" &&
      typeof args[2] === "string"
    )
      return { workspace: "/workspace" };
    if (
      operation === "workspaceFingerprint" &&
      JSON.stringify(args) === '["/workspace"]'
    )
      return digest(content);
    if (
      operation === "worker" &&
      args.length === 2 &&
      args[1] === "/workspace" &&
      args[0]?.provider?.id === "local"
    ) {
      if (workerCalls >= 3) return refuse();
      workerCalls++;
      workerInventory.push({
        sequence: workerCalls,
        usage: structuredClone(input.usage),
        contextText: args[0].context?.items?.[0]?.text ?? null,
      });
      return {
        model: "fixture",
        usage: input.usage,
        proposal: {
          summary: "Update fixture value",
          requests: [],
          changes: [
            {
              path: "value.js",
              before: `= ${workerCalls}`,
              after: `= ${workerCalls + 1}`,
            },
          ],
        },
      };
    }
    if (
      operation === "applyProposal" &&
      args.length === 2 &&
      args[0] === "/workspace"
    ) {
      const proposal = args[1];
      if (
        !Array.isArray(proposal?.changes) ||
        proposal.changes.length !== 1 ||
        proposal.requests?.length !== 0
      )
        return refuse();
      const change = proposal.changes[0];
      if (
        change.path !== "value.js" ||
        typeof change.before !== "string" ||
        typeof change.after !== "string" ||
        !change.before ||
        content.split(change.before).length !== 2 ||
        change.after.length > 1000
      )
        return refuse();
      content = content.replace(change.before, change.after);
      return ["value.js"];
    }
    if (
      operation === "verify" &&
      args.length === 3 &&
      args[0] === "/workspace" &&
      JSON.stringify(args[1]) === JSON.stringify(checks) &&
      args[2] === digest(content)
    ) {
      if (verificationCalls >= 4) return refuse();
      const failure =
        verificationCalls++ === 0
          ? input.failure
          : { code: 0, stderr: "", stdout: "" };
      verificationInventory.push({
        sequence: verificationCalls,
        ...failure,
        snapshotHash: digest(content),
      });
      return checks.map((check) => ({
        ...check,
        ...failure,
        snapshotHash: digest(content),
      }));
    }
    if (
      operation === "checkedGit" &&
      args.length === 2 &&
      ["/project", "/workspace"].includes(args[0])
    ) {
      if (JSON.stringify(args[1]) === '["status","--porcelain"]') return "";
      if (JSON.stringify(args[1]) === '["diff","--name-only","HEAD"]')
        return content === ORIGINAL ? "" : "value.js\n";
      if (
        JSON.stringify(args[1]) ===
        '["ls-files","--others","--exclude-standard"]'
      )
        return "";
      return refuse();
    }
    if (
      operation === "publish" &&
      args.length === 3 &&
      args[0] === "/project" &&
      typeof args[1] === "string" &&
      args[2] === digest(content)
    ) {
      publicationCalls++;
      return {};
    }
    return refuse();
  }
  function capability(text) {
    if (typeof text !== "string" || Buffer.byteLength(text) > 65536)
      return refuse();
    let request;
    try {
      request = JSON.parse(text);
      let nodes = 0;
      const visit = (value, depth) => {
        if (++nodes > 10000 || depth > 30) return refuse();
        if (value && typeof value === "object")
          for (const [key, child] of Object.entries(value)) {
            if (["__proto__", "constructor", "prototype"].includes(key))
              return refuse();
            visit(child, depth + 1);
          }
      };
      visit(request, 0);
      if (
        !request ||
        Object.keys(request).sort().join(",") !== "args,operation" ||
        typeof request.operation !== "string" ||
        request.operation.length > 80 ||
        !Array.isArray(request.args)
      )
        return refuse();
      const value = dispatch(request.operation, request.args);
      const output = JSON.stringify({ ok: true, value: value ?? null });
      if (Buffer.byteLength(output) > 65536) return refuse();
      return output;
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: {
          message: String(error.message).slice(0, 2000),
          ...(error.code === "ENOENT" ? { code: "ENOENT" } : {}),
        },
      });
    }
  }
  function inspect() {
    if (violated)
      throw new Error("Candidate requested a refused controller capability");
    // New SQLite connection reads actual persisted state independently of any
    // candidate-returned run object and of the candidate's Store wrapper.
    const reader = new RunStore(directory, PROJECT);
    try {
      const runs = reader.runs();
      if (runs.length !== 1 || runs[0].plan?.id !== planId)
        throw new ServiceCandidateViolation(
          "Unexpected durable fixture run inventory",
        );
      const run = runs[0];
      const events = reader.events(run.id);
      return {
        runId: run.id,
        phase: {
          status: run.status,
          usage: reader.usage(planId),
          accounting: reader.accountingSummary(),
          workerCalls,
          verificationCalls,
          publicationCalls,
          content,
          blockedEvents: events.filter(
            (event) => event.type === "verification.infrastructure_blocked",
          ).length,
          recoveryEvents: events.filter(
            (event) => event.type === "decision.recovery",
          ).length,
        },
      };
    } finally {
      reader.close();
    }
  }
  return {
    planId,
    capability,
    inspect,
    get violated() {
      return violated;
    },
    inventory: () => ({
      worker: structuredClone(workerInventory),
      verification: structuredClone(verificationInventory),
    }),
    async close() {
      store?.close();
      store = undefined;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
