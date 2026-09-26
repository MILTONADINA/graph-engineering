import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const SCHEMA_VERSION = "1.0.0" as const;
export type Language =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "csharp"
  | "text";
export type MemoryKind =
  "observation" | "decision" | "requirement" | "constraint" | "solution";
export type ProviderKind =
  "local" | "openai" | "anthropic" | "codex" | "claude" | "cursor";
export type RunStatus =
  | "planned"
  | "running"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "needs_reconciliation";

export interface ProjectPolicy {
  version: typeof SCHEMA_VERSION;
  inference: "local" | "allowlisted";
  providers: string[];
  network: "deny" | "allowlisted";
  allowedHosts: string[];
  exportPaths: string[];
  excludedPaths: string[];
  /** Explicit opt-in for the public root template ledger; never private engine state. */
  allowPublicTemplateLedger?: boolean;
  /**
   * Repository-relative directories or files the graph indexes, reads and
   * writes. Absent means the whole repository; required checks and security
   * scans still cover the whole repository either way.
   */
  workingSet?: string[];
  publication: "none" | "commit" | "draft-pr";
  maxWorkers: number;
  maxAttempts: number;
  maxContextTokens: number;
  maxOutputTokens: number;
  maxTurns: number;
  timeoutSeconds: number;
  maxCostUsd: number | null;
  decisionMode: "shadow" | "promoted";
  promotedCategories: string[];
}
export const DEFAULT_POLICY: ProjectPolicy = {
  version: SCHEMA_VERSION,
  inference: "local",
  providers: [],
  network: "deny",
  allowedHosts: [],
  exportPaths: [],
  excludedPaths: [
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "**/credentials*",
    "**/secrets*",
  ],
  publication: "none",
  maxWorkers: 2,
  maxAttempts: 3,
  maxContextTokens: 16000,
  // Thinking counts toward this per-response cap on always-thinking models;
  // the API worker does not stream, so keep it near 16K.
  maxOutputTokens: 16000,
  maxTurns: 12,
  timeoutSeconds: 600,
  maxCostUsd: null,
  decisionMode: "shadow",
  promotedCategories: [],
};
export interface ProjectConfig {
  version: typeof SCHEMA_VERSION;
  projectId: string;
  name: string;
  policy: ProjectPolicy;
  verification: { argv: string[]; image: string }[];
  github?: { repository: string; baseBranch: string; remote: string };
  /** A reviewer worker that must approve a run before it completes. */
  review?: { providerId: string };
}
export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  model: string;
  endpoint?: string;
  apiKeyEnv?: string;
  efforts?: string[];
  defaultEffort?: string;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
  maxContextTokens?: number;
  localOptions?: { enableThinking?: boolean; thinkingBudget?: number };
}
export interface RepositorySnapshot {
  version: typeof SCHEMA_VERSION;
  id: string;
  projectId: string;
  worktreeId: string;
  revision: string | null;
  contentHash: string;
  createdAt: string;
  fileCount: number;
  languages: string[];
  coverage: { parsed: number; textOnly: number; errors: string[] };
}
export interface SourceReference {
  path: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  snapshotId: string;
}
export interface CodeSymbol {
  id: string;
  name: string;
  kind: string;
  language: Language;
  source: SourceReference;
  signature: string;
}
export interface GraphEdge {
  id: string;
  from: string;
  to: string | null;
  target: string;
  kind: "imports" | "calls" | "references" | "contains";
  evidence: "syntactic" | "resolved" | "heuristic";
  /** Static compiler binding, not proof of runtime dispatch. */
  resolution?: {
    kind: "static";
    engine:
      | "typescript"
      | "cpython"
      | "go-types"
      | "javac"
      | "roslyn"
      | "rust-analyzer";
    version: string;
    /** Additional indexed evidence: configuration, package metadata, or intermediate import/re-export sources. */
    sources?: SourceReference[];
  };
  source: SourceReference;
}
export interface ContextItem {
  id: string;
  // An outline lists a file's symbols and line ranges, not its code.
  kind: "code" | "memory" | "document" | "outline";
  text: string;
  score: number;
  source?: SourceReference;
  memoryId?: string;
}
export interface ContextPacket {
  version: typeof SCHEMA_VERSION;
  projectId: string;
  snapshotId: string;
  query: string;
  mandatory: string[];
  mandatorySources?: {
    memoryId?: string;
    text: string;
    textSha256?: string;
    visibility: "private" | "shared";
    sources: SourceReference[];
    /** An operator authorized cloud export of this exact text before the packet was built. */
    exportAuthorized?: boolean;
  }[];
  items: ContextItem[];
  estimatedTokens: number;
  budgetTokens: number;
  coverage: { semantic: boolean; graph: string; warnings: string[] };
}
export type MemoryAssertionValue =
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "string-set"; value: string[] };
export interface MemoryAssertion {
  subject: string;
  predicate: string;
  scope: Record<string, string>;
  value: MemoryAssertionValue;
  exclusive: boolean;
  validFrom?: string;
  validUntil?: string;
}
export interface ReviewedMemoryAssertions {
  version: "1.0.0";
  claims: MemoryAssertion[];
  review: { reviewer: string; reviewedAt: string; evidence: string[] };
}
export interface MemoryRecord {
  version: typeof SCHEMA_VERSION;
  id: string;
  projectId: string;
  kind: MemoryKind;
  text: string;
  visibility: "private" | "shared";
  status: "proposed" | "accepted" | "superseded" | "conflicted" | "rejected";
  createdAt: string;
  sources: SourceReference[];
  supersedes?: string;
  assertions?: ReviewedMemoryAssertions;
  /** Why a person rejected this proposal (status "rejected" only). */
  rejectionReason?: string;
}
export interface ExecutionStep {
  id: string;
  kind: "worker" | "template";
  objective: string;
  dependsOn: string[];
  providerId?: string;
  effort?: string;
  templateId?: string;
  inputs?: Record<string, unknown>;
  /**
   * Glob patterns (like exportPaths) limiting the files this step may write,
   * for example a tester limited to test files. Absent means any allowed path.
   */
  writes?: string[];
}
export interface ExecutionPlan {
  version: typeof SCHEMA_VERSION;
  id: string;
  projectId: string;
  snapshotId: string;
  policyHash: string;
  createdAt: string;
  objective: string;
  acceptance: string[];
  steps: ExecutionStep[];
  verification: ProjectConfig["verification"];
  publication: ProjectPolicy["publication"];
  routing?: {
    workflow: string;
    contextBudgetTokens: number;
    decisionIds: string[];
  };
}
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
  estimated: boolean;
}
export interface RunEvent {
  version: typeof SCHEMA_VERSION;
  id: string;
  runId: string;
  projectId: string;
  at: string;
  type: string;
  stepId?: string;
  data: Record<string, unknown>;
}
export interface RunRecord {
  id: string;
  plan: ExecutionPlan;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  workspace?: string;
  branch?: string;
  error?: string;
  usage: Usage;
  commit?: string;
  pullRequest?: string;
  completion?: {
    automatedChecksPassed: boolean;
    /** Changes only when a person records a decision on this result. */
    humanAcceptance: "pending" | "accepted" | "rejected";
    reviewScope:
      "normal" | "security" | "architecture" | "security-and-architecture";
  };
}
/**
 * A recorded fact about how a run ended, appended at every terminal
 * transition and every human acceptance decision; a resumed run has several.
 * Engine-recorded outcomes feed analysis only and never promotion evidence.
 */
export interface RunOutcome {
  version: typeof SCHEMA_VERSION;
  runId: string;
  planId: string;
  projectId: string;
  recordedAt: string;
  kind: "terminal" | "acceptance";
  status: RunStatus;
  automatedChecksPassed: boolean | null;
  review: { verdict: string; passed: boolean } | null;
  security: "not-run" | "passed" | "failed";
  humanAcceptance: "pending" | "accepted" | "rejected" | null;
  /** The verified workspace snapshot the outcome refers to, if any. */
  verifiedHash: string | null;
  commit: string | null;
  pullRequest: string | null;
  usage: Usage;
  /** Decision records this run's plan and stages wrote. */
  decisionIds: string[];
  /** Memories present in the context the run's workers received. */
  memoryIds: string[];
  error: string | null;
}
export interface DecisionRecord {
  version: typeof SCHEMA_VERSION;
  id: string;
  projectId: string;
  category: string;
  candidates: string[];
  selected: string | null;
  baseline: string;
  provider: string;
  modelVersion: string;
  policyVersion: string;
  confidence: number | null;
  mode: "shadow" | "promoted";
  createdAt: string;
  evidence: Record<string, unknown>;
}

const nonempty = { type: "string", minLength: 1 };
const strings = { type: "array", items: nonempty, uniqueItems: true };
export const policySchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: Object.keys(DEFAULT_POLICY),
  properties: {
    version: { const: SCHEMA_VERSION },
    inference: { enum: ["local", "allowlisted"] },
    providers: strings,
    network: { enum: ["deny", "allowlisted"] },
    allowedHosts: strings,
    exportPaths: strings,
    excludedPaths: strings,
    allowPublicTemplateLedger: { type: "boolean" },
    workingSet: {
      type: "array",
      minItems: 1,
      maxItems: 1000,
      uniqueItems: true,
      items: {
        type: "string",
        minLength: 1,
        maxLength: 1000,
        // Plain relative paths: no globs, backslashes, drive letters, empty,
        // "." or ".." segments, or leading and trailing slashes.
        pattern:
          "^(?!/)(?!.*//)(?!.*/$)(?!(?:.*/)?\\.{1,2}(?:/|$))[^*?\\[\\]{}!\\\\:\\u0000-\\u001f]+$",
      },
    },
    publication: { enum: ["none", "commit", "draft-pr"] },
    maxWorkers: { type: "integer", minimum: 1, maximum: 8 },
    maxAttempts: { type: "integer", minimum: 1, maximum: 10 },
    maxContextTokens: { type: "integer", minimum: 256, maximum: 1000000 },
    maxOutputTokens: { type: "integer", minimum: 64, maximum: 128000 },
    maxTurns: { type: "integer", minimum: 1, maximum: 100 },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 86400 },
    maxCostUsd: {
      anyOf: [{ type: "null" }, { type: "number", minimum: 0 }],
    },
    decisionMode: { enum: ["shadow", "promoted"] },
    promotedCategories: strings,
  },
};
export const projectSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["version", "projectId", "name", "policy", "verification"],
  properties: {
    version: { const: SCHEMA_VERSION },
    projectId: { type: "string", pattern: "^[a-zA-Z0-9_-]{8,80}$" },
    name: nonempty,
    policy: policySchema,
    verification: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["argv", "image"],
        properties: {
          argv: { type: "array", minItems: 1, items: nonempty },
          image: nonempty,
        },
      },
    },
    github: {
      type: "object",
      additionalProperties: false,
      required: ["repository", "baseBranch", "remote"],
      properties: {
        repository: {
          type: "string",
          pattern: "^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$",
        },
        baseBranch: nonempty,
        remote: nonempty,
      },
    },
    review: {
      type: "object",
      additionalProperties: false,
      required: ["providerId"],
      properties: { providerId: nonempty },
    },
  },
};
const Ajv = Ajv2020 as unknown as typeof import("ajv").default;
const ajv = new Ajv({ allErrors: true, strict: false, strictNumbers: true });
(addFormats as unknown as (a: typeof ajv) => void)(ajv);
const validateProject = ajv.compile(projectSchema);
export function assertProjectConfig(
  value: unknown,
): asserts value is ProjectConfig {
  if (!validateProject(value))
    throw new Error(
      `Invalid project configuration: ${ajv.errorsText(validateProject.errors)}`,
    );
}
