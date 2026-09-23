// Fixed capability adapters, evaluated only inside QuickJS. No Node objects or
// native database handles enter the candidate realm.
const nativeParse = JSON.parse;
const nativeStringify = JSON.stringify;
const nativeError = Error;
const nativeDefine = Object.defineProperty;
const nativeCreate = Object.create;
const capability = globalThis.__graphInfrastructureCapability;
delete globalThis.__graphInfrastructureCapability;

function call(operation, args = []) {
  const request = nativeCreate(null);
  nativeDefine(request, "operation", { value: operation, enumerable: true });
  nativeDefine(request, "args", { value: args, enumerable: true });
  const response = nativeParse(capability(nativeStringify(request)));
  if (!response.ok) {
    const error = new nativeError(response.error.message);
    if (response.error.code) error.code = response.error.code;
    throw error;
  }
  return response.value;
}
export const id = () => call("id");
export const now = () => call("now");
export const hash = (value) =>
  call("hash", [typeof value === "string" ? value : nativeStringify(value)]);
export const readJson = async (file) => call("readJson", [file]);
export const writeJson = async () => call("forbidden", ["writeJson"]);
export const errorMessage = (error) =>
  error instanceof Error ? error.message : String(error);
export const redact = (value) => String(value);
export const readFile = async (file, encoding) =>
  call("readFile", [file, encoding]);
export const delay = async () => undefined;

const normalize = (name) => {
  const parts = [];
  for (const part of name.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return "/" + parts.join("/");
};
export const path = Object.freeze({
  join: (...parts) => normalize(parts.join("/")),
  resolve: (...parts) => normalize(parts.join("/")),
});
export const projectDataDir = () => "/data";
export const loadProject = async (root) => call("loadProject", [root]);
export const loadProviders = async (root) => call("loadProviders", [root]);

export class ContextEngine {
  constructor(options) {
    this.root = options.root;
  }
  updatePolicy() {}
  async index() {
    return call("context.index", [this.root]);
  }
  async getContext(options) {
    return call("context.getContext", [this.root, options]);
  }
  async searchSymbols() {
    return [];
  }
  async neighbors() {
    return [];
  }
  async getSolution() {
    return null;
  }
  async putSolution() {}
  async createMemory() {}
  async close() {}
}

export class RunStore {
  constructor(directory, projectId) {
    call("store.open", [directory, projectId]);
  }
}
for (const name of [
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
  "close",
])
  nativeDefine(RunStore.prototype, name, {
    value: function (...args) {
      return call("store." + name, args);
    },
  });

export const assertProvider = (provider, policy) => {
  if (
    provider.id !== "local" ||
    provider.kind !== "local" ||
    !policy.providers.includes("local")
  )
    throw new nativeError("Fixture provider refused");
};
export const contextForProvider = (packet) => packet;
export const isAllowedPath = (name) => name === "value.js";
export const safePath = async (root, name) => {
  if (name !== "value.js") throw new nativeError("Fixture source path refused");
  return path.join(root, name);
};
export const decide = async () => [];
export const decisionProviders = async () => [];
export const fitWorkerContext = (input) => input;
export const estimateRequestCost = () => 0;
export const proposalSchema = Object.freeze({ parse: (value) => value });
export const invokeApiWorker = async () => call("forbidden", ["api-worker"]);
export const invokeInstalledWorker = async () =>
  call("forbidden", ["installed-worker"]);
export const discoverInstalledWorkers = async () => [];
export const fixtureWorker = async (input, workspace) =>
  call("worker", [input, workspace]);
export const applyProposal = async (workspace, proposal) =>
  call("applyProposal", [workspace, proposal]);
export const createWorkspace = async (root, directory, runId) =>
  call("createWorkspace", [root, directory, runId]);
export const workspaceFingerprint = async (workspace) =>
  call("workspaceFingerprint", [workspace]);
export const dockerAvailable = async () => true;
export const verifyInContainer = async (
  workspace,
  checks,
  policy,
  snapshotHash,
) => call("verify", [workspace, checks, snapshotHash]);
export const publishRun = async (root, run, config, snapshotHash) =>
  call("publish", [root, run.id, snapshotHash]);
export const checkedGit = async (workspace, args) =>
  call("checkedGit", [workspace, args]);
export const routePlan = async () => call("forbidden", ["routePlan"]);
export const WORKFLOWS = Object.freeze({});
export const renderTemplateProposal = async () =>
  call("forbidden", ["template"]);
export const templateRuntimeCapability = () => ({ executable: false });
export class DagReconciliationError extends Error {}
export const runDag = async () => call("forbidden", ["DAG"]);
export const validateDag = () => call("forbidden", ["DAG"]);
const emptyDecision = () => ({ records: [], usage: [], selections: {} });
export const routeRetrieval = async () => ({
  ...emptyDecision(),
  scope: "graph",
});
export const selectContext = async (input) => ({
  ...emptyDecision(),
  selectedIds: input.candidates.map((item) => item.id),
});
export const routeScopes = async () => ({
  ...emptyDecision(),
  tools: ["context.get"],
  review: "normal",
  checks: ["0"],
});
export const controlRecovery = async (input) => ({
  ...emptyDecision(),
  action: input.attempt < input.maxAttempts ? "retry" : "stop",
});
export const controlCompletion = async () => ({
  ...emptyDecision(),
  action: "complete",
});
export const controlMemoryWrite = async () => ({
  ...emptyDecision(),
  action: "skip",
});

// The historical engine's cancellation polling is inert in this synchronous
// finite fixture. Interpreter/container deadlines remain outside this realm.
nativeDefine(globalThis, "setInterval", { value: () => 1 });
nativeDefine(globalThis, "clearInterval", { value: () => {} });
nativeDefine(globalThis, "AbortController", {
  value: class {
    constructor() {
      this.signal = { aborted: false };
    }
    abort() {
      this.signal.aborted = true;
    }
  },
});
nativeDefine(globalThis, "Buffer", {
  value: Object.freeze({ byteLength: (text) => call("byteLength", [text]) }),
});
nativeDefine(globalThis, "structuredClone", {
  value: (value) => nativeParse(nativeStringify(value)),
});
nativeDefine(globalThis, "console", {
  value: Object.freeze({
    log: () => call("forbidden", ["console"]),
    error: () => call("forbidden", ["console"]),
  }),
});
