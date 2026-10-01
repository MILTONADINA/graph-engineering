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
  | "dart"
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
  /**
   * Globs of the files cloud consumers may receive. A `!pattern` entry is an
   * exclusion: a path is exportable when some other entry matches it and no
   * exclusion does. Inclusions are case-sensitive; exclusions ignore case and,
   * when slash-free, apply at any depth. Names compare in Unicode NFC, and a
   * file is exported only when its name on disk matches and is exportable.
   */
  exportPaths: string[];
  /**
   * Globs of paths never indexed, read or written. Each entry is matched on
   * its own, case-insensitively, so a `!pattern` entry excludes everything
   * outside that pattern; nothing here ever re-includes a path.
   */
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
  /**
   * Every plan, including one that does not publish, needs a person's
   * approval (`graph-engine plan-approve <id> --yes`) before a run of it
   * starts or resumes, whoever starts it; `graph-engine run` alone does not
   * count as that approval. Absent means false. It is part of the policy
   * hash and not in DEFAULT_POLICY, so any change to it, turning it on or
   * off or writing `false` where it was absent, voids every existing plan.
   */
  requirePlanApproval?: boolean;
  /**
   * Require reviewed native executable identities for installed workers.
   * Absent means false; changing its presence or value changes the policy
   * hash. Existing plans never refresh executable or provider-profile pins.
   */
  requireInstalledWorkerIdentity?: boolean;
  maxWorkers: number;
  maxAttempts: number;
  maxContextTokens: number;
  maxOutputTokens: number;
  maxTurns: number;
  timeoutSeconds: number;
  /**
   * Installed coding workers only: absent inherits timeoutSeconds; null
   * waits for terminal completion or cancellation; a number sets their
   * wall-clock limit. Other tools retain timeoutSeconds. Explicitly setting
   * or changing this field changes the policy hash and requires a new plan.
   */
  installedWorkerTimeoutSeconds?: number | null;
  /**
   * Built-in verification container runs only, independently for each check:
   * absent inherits timeoutSeconds; null waits for terminal completion or
   * cancellation; an integer sets the wall-clock limit. Image probes and
   * cleanup retain fixed bounds. Changing this field requires a fresh plan.
   */
  verificationTimeoutSeconds?: number | null;
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
/** An operator-registered verification command; omitted optional means mandatory. */
export interface VerificationCheck {
  image: string;
  argv: string[];
  /** Stable operator-assigned catalogue ID, never an array position. */
  id?: string;
  /** True allows omission by an explicit plan selection; selected checks must pass. */
  optional?: boolean;
}
/** Frozen selection of a complete reviewed catalogue; null selects all checks. */
export interface VerificationSelection {
  catalogueSha256: string;
  checkIds: string[] | null;
}
export interface ProjectConfig {
  version: typeof SCHEMA_VERSION;
  projectId: string;
  name: string;
  policy: ProjectPolicy;
  verification: VerificationCheck[];
  /** Commands only a local operator can register for generator plan steps. */
  generators?: GeneratorRegistration[];
  github?: { repository: string; baseBranch: string; remote: string };
  /** A reviewer worker that must approve a run before it completes. */
  review?: { providerId: string };
  /**
   * A tester worker that runs first, before the implementation, and writes
   * tests for each acceptance criterion as new test files only (default globs
   * unless `writes`), which implementing steps may not change. See
   * specs/quality/tester-role.md.
   */
  tester?: { providerId: string; writes?: string[] };
  /** Security settings a person records for the project. */
  security?: { liveTargets?: LiveTarget[] };
}
/**
 * A target a person has authorized, in writing, for dynamic security testing.
 * It is a container image the live scan starts itself, with no network,
 * never a URL: a scan cannot be pointed at a system the project does not run.
 */
export interface LiveTarget {
  /** Lowercase slug named on the command line. */
  id: string;
  /**
   * `name@sha256:<digest>` for a registry image, or a local image ID
   * `sha256:<digest>` built from a committed Dockerfile.
   */
  image: string;
  /** The port the container serves HTTP on. */
  port: number;
  /** The path the scan starts from; defaults to "/". */
  path?: string;
  /** Who authorized scanning this target. */
  authorizedBy: string;
  /** When, as an ISO date (YYYY-MM-DD). */
  authorizedOn: string;
  /** What was authorized and on whose instruction. */
  note: string;
}
/** A digest-pinned registry image, or a local image ID. */
export const PINNED_IMAGE =
  /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$|^sha256:[a-f0-9]{64}$/;
export const GENERATOR_MAX_FILES = 50;
export const GENERATOR_MAX_FILE_BYTES = 1_048_576;
export const GENERATOR_MAX_TOTAL_BYTES = 8_388_608;
/** Optional per-generator ceilings. Each narrows the engine's ceiling. */
export interface GeneratorLimits {
  timeoutSeconds?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}
/** The complete operator registration copied into a plan when it is created. */
export interface GeneratorRegistration {
  id: string;
  /** A fresh opaque value on every add, including replacement under one ID. */
  revision: string;
  image: string;
  argv: string[];
  /** Exact repository-relative files or directory roots, never globs. */
  outputs: string[];
  /** Optional allowlist globs for source files in the offline view. */
  reads?: string[];
  limits?: GeneratorLimits;
}
/** Exact native executable selected by an operator, not a command in PATH. */
export interface InstalledWorkerIdentity {
  realpath: string;
  sha256: string;
}
/** Frozen provider profile and executable identity included in plan approval. */
export interface InstalledWorkerBinding {
  providerId: string;
  providerProfileSha256: string;
  identity: InstalledWorkerIdentity;
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
  /** Opt-in native executable pin, usable only by installed worker kinds. */
  installedIdentity?: InstalledWorkerIdentity;
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
      | "rust-analyzer"
      | "dart-analyzer";
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
  kind: "worker" | "template" | "generator";
  objective: string;
  dependsOn: string[];
  providerId?: string;
  effort?: string;
  templateId?: string;
  generatorId?: string;
  inputs?: Record<string, unknown>;
  /**
   * Glob patterns (like exportPaths) limiting the files this step may write,
   * for example a tester limited to test files. A `!pattern` entry excludes
   * from the others, and at least one entry must not be an exclusion. Absent
   * means any allowed path.
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
  /** All new plans bind their complete catalogue; absent only on legacy plans. */
  verificationSelection?: VerificationSelection;
  /** Frozen registrations for its generator steps; absent on older plans. */
  generators?: GeneratorRegistration[];
  /** Frozen installed-worker pins; absent on legacy, unpinned plans. */
  installedWorkers?: InstalledWorkerBinding[];
  publication: ProjectPolicy["publication"];
  routing?: {
    workflow: string;
    contextBudgetTokens: number;
    decisionIds: string[];
  };
  /** The feature spec this plan implements, as read when planning. */
  spec?: { id: string; path: string; sha256: string };
  /**
   * Set on a plan a cloud-backed MCP client wrote: its model roles all run
   * on local providers or all on non-local ones, and a step that escalates
   * after repeated failures moves only to a provider on the same side.
   */
  exportSide?: "local" | "non-local";
  /**
   * Whether a cloud-backed MCP client wrote the plan. Every plan created
   * since this was recorded carries it; a plan without it predates it, so
   * a missing exportSide cannot show that a person wrote it.
   */
  cloudAuthored?: boolean;
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
  /**
   * The commit the run workspace was created from. Reviews and gates compare
   * against it, since the workspace HEAD moves once publication commits.
   */
  baseCommit?: string;
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
  /** `by: "person"` when a person approved in place of the AI reviewer. */
  review: { verdict: string; passed: boolean; by?: "person" } | null;
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
export const VERIFICATION_CHECK_ID_PATTERN =
  "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$(?![\\s\\S])";
export const MAX_VERIFICATION_SELECTION = 1000;
const verificationCheckIdSchema = {
  type: "string",
  minLength: 1,
  maxLength: 80,
  pattern: VERIFICATION_CHECK_ID_PATTERN,
};
export const verificationCheckIdsSchema = {
  type: "array",
  minItems: 1,
  maxItems: MAX_VERIFICATION_SELECTION,
  uniqueItems: true,
  items: verificationCheckIdSchema,
};
export const verificationCatalogueSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["argv", "image"],
    properties: {
      argv: { type: "array", minItems: 1, items: nonempty },
      image: nonempty,
      id: verificationCheckIdSchema,
      optional: { type: "boolean" },
    },
    if: { required: ["optional"], properties: { optional: { const: true } } },
    then: { required: ["id"] },
  },
};
export const verificationSelectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["catalogueSha256", "checkIds"],
  properties: {
    catalogueSha256: {
      type: "string",
      minLength: 64,
      maxLength: 64,
      pattern: "^[a-f0-9]{64}$",
    },
    checkIds: { anyOf: [{ type: "null" }, verificationCheckIdsSchema] },
  },
};
export const installedWorkerIdentitySchema = {
  type: "object",
  additionalProperties: false,
  required: ["realpath", "sha256"],
  properties: {
    realpath: {
      type: "string",
      minLength: 2,
      maxLength: 32768,
      not: { pattern: "[\\u0000-\\u001f\\u007f]" },
      // Lexical absolute POSIX, drive-qualified Windows, or UNC path.
      // Filesystem existence, canonical spelling and native format are
      // checked locally before this identity can be used for execution.
      pattern:
        "^(?:/|[A-Za-z]:[\\\\/]|\\\\\\\\[^\\\\/]+[\\\\/][^\\\\/]+[\\\\/])[^\\u0000-\\u001f\\u007f]+$(?![\\s\\S])",
    },
    sha256: {
      type: "string",
      minLength: 64,
      maxLength: 64,
      pattern: "^[a-f0-9]{64}$",
    },
  },
};
export const installedWorkerBindingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["providerId", "providerProfileSha256", "identity"],
  properties: {
    providerId: { type: "string", pattern: "^[a-zA-Z0-9_-]+$(?![\\s\\S])" },
    providerProfileSha256: {
      type: "string",
      minLength: 64,
      maxLength: 64,
      pattern: "^[a-f0-9]{64}$",
    },
    identity: installedWorkerIdentitySchema,
  },
};
// An allowlist glob: `!pattern` excludes; `!` alone and `!!` are refused.
const globEntry = { type: "string", minLength: 1, pattern: "^(?!!$)(?!!!)" };
const generatorRoot = {
  type: "string",
  minLength: 1,
  maxLength: 1000,
  // One exact relative path spelling; no glob, traversal, drive or separator aliases.
  pattern:
    "^(?!/)(?!.*//)(?!.*/$)(?!(?:.*/)?\\.{1,2}(?:/|$))[^*?\\[\\]{}!\\\\:\\u0000-\\u001f]+$",
};
export const generatorSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["id", "revision", "image", "argv", "outputs"],
  properties: {
    id: {
      type: "string",
      pattern: "^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$",
    },
    revision: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9_-]+$",
    },
    image: { type: "string", pattern: PINNED_IMAGE.source },
    argv: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "string",
        minLength: 1,
        maxLength: 4096,
        pattern: "^[^\\u0000]*$",
      },
    },
    outputs: {
      type: "array",
      minItems: 1,
      maxItems: GENERATOR_MAX_FILES,
      uniqueItems: true,
      items: generatorRoot,
    },
    reads: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      uniqueItems: true,
      items: { ...globEntry, maxLength: 200 },
      contains: { type: "string", pattern: "^[^!]" },
    },
    limits: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: {
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 86400 },
        maxFiles: {
          type: "integer",
          minimum: 1,
          maximum: GENERATOR_MAX_FILES,
        },
        maxFileBytes: {
          type: "integer",
          minimum: 1,
          maximum: GENERATOR_MAX_FILE_BYTES,
        },
        maxTotalBytes: {
          type: "integer",
          minimum: 1,
          maximum: GENERATOR_MAX_TOTAL_BYTES,
        },
      },
    },
  },
};
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
    exportPaths: { type: "array", items: globEntry, uniqueItems: true },
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
    requirePlanApproval: { type: "boolean" },
    requireInstalledWorkerIdentity: { type: "boolean" },
    maxWorkers: { type: "integer", minimum: 1, maximum: 8 },
    maxAttempts: { type: "integer", minimum: 1, maximum: 10 },
    maxContextTokens: { type: "integer", minimum: 256, maximum: 1000000 },
    maxOutputTokens: { type: "integer", minimum: 64, maximum: 128000 },
    maxTurns: { type: "integer", minimum: 1, maximum: 100 },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 86400 },
    installedWorkerTimeoutSeconds: {
      anyOf: [
        { type: "null" },
        { type: "integer", minimum: 1, maximum: 86400 },
      ],
    },
    verificationTimeoutSeconds: {
      anyOf: [
        { type: "null" },
        { type: "integer", minimum: 1, maximum: 86400 },
      ],
    },
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
    verification: verificationCatalogueSchema,
    generators: {
      type: "array",
      maxItems: 100,
      items: generatorSchema,
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
    tester: {
      type: "object",
      additionalProperties: false,
      required: ["providerId"],
      properties: {
        providerId: nonempty,
        writes: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: { ...globEntry, maxLength: 200 },
          // At least one entry that is not an exclusion.
          contains: { type: "string", pattern: "^[^!]" },
        },
      },
    },
    security: {
      type: "object",
      additionalProperties: false,
      properties: {
        liveTargets: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "id",
              "image",
              "port",
              "authorizedBy",
              "authorizedOn",
              "note",
            ],
            properties: {
              id: {
                type: "string",
                pattern: "^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$",
              },
              image: { type: "string", pattern: PINNED_IMAGE.source },
              port: { type: "integer", minimum: 1, maximum: 65535 },
              path: {
                type: "string",
                pattern: "^/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$",
                maxLength: 500,
              },
              authorizedBy: {
                type: "string",
                minLength: 1,
                maxLength: 200,
                pattern: "\\S",
              },
              authorizedOn: { type: "string", format: "date" },
              note: {
                type: "string",
                minLength: 1,
                maxLength: 2000,
                pattern: "\\S",
              },
            },
          },
        },
      },
    },
  },
};
const Ajv = Ajv2020 as unknown as typeof import("ajv").default;
const ajv = new Ajv({ allErrors: true, strict: false, strictNumbers: true });
(addFormats as unknown as (a: typeof ajv) => void)(ajv);
const validateProject = ajv.compile(projectSchema);
const validateGenerator = ajv.compile(generatorSchema);
const validateVerificationCatalogue = ajv.compile(verificationCatalogueSchema);
const validateVerificationSelection = ajv.compile(verificationSelectionSchema);
export function assertVerificationCatalogue(
  value: unknown,
): asserts value is VerificationCheck[] {
  if (!validateVerificationCatalogue(value))
    throw new Error(
      `Invalid verification catalogue: ${ajv.errorsText(validateVerificationCatalogue.errors)}`,
    );
  const ids = (value as VerificationCheck[])
    .map((check) => check.id)
    .filter((id): id is string => id !== undefined);
  if (new Set(ids).size !== ids.length)
    throw new Error("Invalid verification catalogue: duplicate check IDs");
}
export function assertVerificationSelection(
  value: unknown,
): asserts value is VerificationSelection {
  if (!validateVerificationSelection(value))
    throw new Error(
      `Invalid verification selection: ${ajv.errorsText(validateVerificationSelection.errors)}`,
    );
}
const validateInstalledWorkerIdentity = ajv.compile(
  installedWorkerIdentitySchema,
);
const validateInstalledWorkerBinding = ajv.compile(
  installedWorkerBindingSchema,
);
export function assertInstalledWorkerIdentity(
  value: unknown,
): asserts value is InstalledWorkerIdentity {
  if (!validateInstalledWorkerIdentity(value))
    throw new Error(
      `Invalid installed worker identity: ${ajv.errorsText(validateInstalledWorkerIdentity.errors)}`,
    );
}
export function assertInstalledWorkerBinding(
  value: unknown,
): asserts value is InstalledWorkerBinding {
  if (!validateInstalledWorkerBinding(value))
    throw new Error(
      `Invalid installed worker binding: ${ajv.errorsText(validateInstalledWorkerBinding.errors)}`,
    );
}
/** Credential-shaped paths may not be declared or emitted as generator output. */
export function isGeneratorCredentialPath(relative: string): boolean {
  const parts = relative.toLowerCase().split("/");
  return (
    parts.some((segment) =>
      /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.azure|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.gitconfig|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx)|(?:credentials?|secrets?|passwords?|api[-_]?keys?|access[-_]?tokens?|private[-_]?keys?)(?:[._-].*)?)$/.test(
        segment,
      ),
    ) ||
    relative.toLowerCase().startsWith(".config/gh/") ||
    relative.toLowerCase().includes("/.config/gh/") ||
    relative.toLowerCase().startsWith(".config/gcloud/") ||
    relative.toLowerCase().includes("/.config/gcloud/")
  );
}
function validGeneratorOutputRoot(root: string): boolean {
  return (
    !isGeneratorCredentialPath(root) &&
    !root
      .split("/")
      .some(
        (segment) =>
          segment === "." ||
          segment === ".." ||
          /[. ]$/.test(segment) ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment) ||
          [".graph", ".git", "node_modules"].includes(segment.toLowerCase()),
      ) &&
    root === root.normalize("NFC")
  );
}
function validGeneratorReadGlob(entry: string): boolean {
  const glob = entry.startsWith("!") ? entry.slice(1) : entry;
  return (
    !!glob &&
    !glob.startsWith("/") &&
    !glob.includes("\\") &&
    !glob.includes(":") &&
    !/[\u0000-\u001f]/.test(glob) &&
    !glob.split("/").some((part) => part === "." || part === "..")
  );
}
/** Validate a registration even when it came from a stored plan. */
export function assertGeneratorRegistration(
  value: unknown,
): asserts value is GeneratorRegistration {
  if (!validateGenerator(value))
    throw new Error(
      `Invalid generator registration: ${ajv.errorsText(validateGenerator.errors)}`,
    );
  const registration = value as unknown as GeneratorRegistration;
  if (registration.outputs.some((root) => !validGeneratorOutputRoot(root)))
    throw new Error(
      "Invalid generator registration: output roots must be safe exact relative paths",
    );
  const roots = registration.outputs.map((root) => root.toLowerCase());
  if (
    roots.some((root, index) =>
      roots.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          (root === other || root.startsWith(`${other}/`)),
      ),
    )
  )
    throw new Error("Invalid generator registration: output roots overlap");
  if (registration.reads?.some((glob) => !validGeneratorReadGlob(glob)))
    throw new Error(
      "Invalid generator registration: read globs must be safe relative patterns",
    );
}
/** Compare all canonical fields, including the revision and optional-field presence. */
export function sameGeneratorRegistration(
  left: GeneratorRegistration,
  right: GeneratorRegistration,
): boolean {
  const canonical = (value: GeneratorRegistration) =>
    JSON.stringify([
      value.id,
      value.revision,
      value.image,
      value.argv,
      value.outputs,
      Object.hasOwn(value, "reads"),
      value.reads ?? null,
      Object.hasOwn(value, "limits"),
      value.limits
        ? [
            value.limits.timeoutSeconds ?? null,
            value.limits.maxFiles ?? null,
            value.limits.maxFileBytes ?? null,
            value.limits.maxTotalBytes ?? null,
          ]
        : null,
    ]);
  return canonical(left) === canonical(right);
}
export function assertProjectConfig(
  value: unknown,
): asserts value is ProjectConfig {
  if (!validateProject(value))
    throw new Error(
      `Invalid project configuration: ${ajv.errorsText(validateProject.errors)}`,
    );
  const ids = (
    (value as unknown as ProjectConfig).security?.liveTargets ?? []
  ).map((target) => target.id);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated)
    throw new Error(
      `Invalid project configuration: live target ${repeated} is declared twice`,
    );
  const project = value as unknown as ProjectConfig;
  assertVerificationCatalogue(project.verification);
  const generators = project.generators ?? [];
  const generatorIds = generators.map((generator) => generator.id);
  const duplicateGenerator = generatorIds.find(
    (id, index) => generatorIds.indexOf(id) !== index,
  );
  if (duplicateGenerator)
    throw new Error(
      `Invalid project configuration: generator ${duplicateGenerator} is declared twice`,
    );
  for (const generator of generators) {
    assertGeneratorRegistration(generator);
    if (
      generator.limits?.timeoutSeconds !== undefined &&
      generator.limits.timeoutSeconds > project.policy.timeoutSeconds
    )
      throw new Error(
        `Invalid project configuration: generator ${generator.id} timeout exceeds policy.timeoutSeconds`,
      );
  }
}
