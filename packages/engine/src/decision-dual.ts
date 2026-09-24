import type {
  DecisionRecord,
  DualPlanPreflight,
} from "@graph-engineering/contracts";
import { z } from "zod";
import {
  decideBatch,
  type DecisionBatchOptions,
  type DecisionBatchResult,
  type DecisionCallUsage,
} from "./decision-batch.js";
import { decisionProviderSchema, type DecisionProvider } from "./decisions.js";
import { redact } from "./policy.js";
import { hash } from "./util.js";

export const taskBindingSchema = z
  .object({
    taskId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_.:/-]+$/),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type TaskBinding = z.infer<typeof taskBindingSchema>;
export const dualOwnerSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:/-]+$/);
export const dualConsultVersionSchema = z.enum(["1.0.0", "2.0.0"]);
export type DualConsultVersion = z.infer<typeof dualConsultVersionSchema>;
export const dualPlanPreflightRequestSchema = z
  .object({
    ownerId: dualOwnerSchema,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    binding: taskBindingSchema,
    scopeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const dualPlanPreflightSchema = dualPlanPreflightRequestSchema
  .extend({ version: z.literal("1.0.0") })
  .strict() satisfies z.ZodType<DualPlanPreflight>;
export const dualCloudStateSchema = z
  .object({
    taskBinding: taskBindingSchema,
    writePathCount: z.number().int().nonnegative().max(1_000_000).optional(),
    acceptanceCount: z.number().int().nonnegative().max(1_000_000).optional(),
    sourceDirty: z.boolean().optional(),
    textOnlyCoverage: z.boolean().optional(),
    securityReviewRequired: z.boolean().optional(),
  })
  .strict();
export const dualWorkerQuestionSchema = z
  .object({
    id: z.literal("dispatch"),
    category: z.literal("worker"),
    candidates: z
      .object({
        proceed: z.literal("Proceed with selected scoped task"),
        pause: z.literal("Pause for more evidence"),
      })
      .strict(),
    baseline: z.literal("pause"),
    exportable: z.literal(true),
  })
  .strict();
const contextProfileQuestionSchema = z
  .object({
    id: z.literal("context_profile"),
    category: z.literal("retrieval-scope"),
    candidates: z
      .object({
        lexical: z.literal("Use bounded exact and lexical retrieval"),
        graph: z.literal(
          "Expand bounded indexed relationships from lexical seeds",
        ),
        hybrid: z.literal(
          "Combine available lexical, graph and local semantic retrieval",
        ),
      })
      .strict(),
    baseline: z.literal("hybrid"),
    exportable: z.literal(true),
  })
  .strict();
const workerSuitabilityQuestionSchema = z
  .object({
    id: z.literal("worker_suitability"),
    category: z.literal("worker-suitability"),
    candidates: z
      .object({
        current_worker: z.literal(
          "The reviewed current worker is suitable for this task",
        ),
        specialist_review: z.literal(
          "Ask for an independently reviewed specialist worker",
        ),
        insufficient_context: z.literal(
          "The exported metadata is insufficient to judge worker suitability",
        ),
      })
      .strict(),
    baseline: z.literal("insufficient_context"),
    exportable: z.literal(true),
  })
  .strict();
export const dualV2QuestionsSchema = z.tuple([
  dualWorkerQuestionSchema,
  contextProfileQuestionSchema,
  workerSuitabilityQuestionSchema,
]);
export const dualV2CloudStateSchema = dualCloudStateSchema
  .extend({
    taskClass: z.enum(["engineering", "product"]),
    changeKind: z.enum([
      "feature",
      "bug-fix",
      "refactor",
      "investigate",
      "other",
    ]),
    languageFamilies: z
      .array(
        z.enum([
          "typescript",
          "javascript",
          "python",
          "dart",
          "sql",
          "documentation",
          "other",
        ]),
      )
      .min(1)
      .max(7)
      .refine((value) => new Set(value).size === value.length),
    reviewedTaskSummary: z
      .string()
      .min(12)
      .max(240)
      .refine((value) => value.trim() === value),
    exportReviewSha256: z.string().regex(/^[a-f0-9]{64}$/),
    workerProfile: z
      .object({
        provider: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
        model: z.string().regex(/^[a-zA-Z0-9_.:+/-]{1,160}$/),
        efforts: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/)).max(8),
      })
      .strict(),
  })
  .strict();
export const dualQuestionIds = (
  version: DualConsultVersion,
): readonly string[] =>
  version === "2.0.0"
    ? ["dispatch", "context_profile", "worker_suitability"]
    : ["dispatch"];

function completeObservation(
  observation: DualConsultObservation,
  questions: DualConsultOptions["questions"],
): boolean {
  return (
    observation.valid &&
    observation.records.length === questions.length &&
    observation.usage?.questionCount === questions.length &&
    Object.keys(observation.choices).length === questions.length &&
    questions.every((question) => {
      const records = observation.records.filter(
        (record) => record.evidence.questionId === question.id,
      );
      return (
        records.length === 1 &&
        records[0]?.selected === observation.choices[question.id] &&
        typeof records[0]?.selected === "string" &&
        Object.hasOwn(question.candidates, records[0].selected)
      );
    })
  );
}

export interface DualConsultAttemptMeta {
  projectId: string;
  ownerId: string;
  binding: TaskBinding;
  policyVersion: string;
  requestHash: string;
}
export interface DualConsultAttemptLedger {
  /** Atomically start once, or return the previously completed evidence. */
  begin(
    meta: DualConsultAttemptMeta,
  ): Promise<DualConsultEvidence | null> | DualConsultEvidence | null;
  /** Persist both records and the terminal evidence before it can authorize dispatch. */
  finish(evidence: DualConsultEvidence): Promise<void> | void;
  /** Preserve an interrupted or unclassifiable attempt for reconciliation. */
  fail(meta: DualConsultAttemptMeta, reason: string): Promise<void> | void;
}

export interface DualConsultOptions extends Omit<
  DecisionBatchOptions,
  | "providers"
  | "evidence"
  | "promotionBinding"
  | "cloudState"
  | "budget"
  | "requestTimeoutMs"
  | "strictResponse"
> {
  /** V1 is the default for historical callers; V2 requires a reviewed export. */
  consultationVersion?: DualConsultVersion;
  ownerId: string;
  binding: TaskBinding;
  /** Both states must carry this exact task/source binding. */
  cloudState: Record<string, unknown>;
  providers: { laya: DecisionProvider; jev: DecisionProvider };
  /** A durable ledger is mandatory, even when the project has no cost cap. */
  budget: NonNullable<DecisionBatchOptions["budget"]>;
  attempt: DualConsultAttemptLedger;
}
export interface DualConsultObservation {
  provider: "laya" | "jev";
  requestEndpoint: string;
  configuredModel: string;
  observedModel: string | null;
  callId: string | null;
  choices: Record<string, string | null>;
  records: DecisionRecord[];
  usage: DecisionCallUsage | null;
  valid: boolean;
  failure: string | null;
}
export interface DualConsultEvidence {
  version: DualConsultVersion;
  projectId: string;
  ownerId: string;
  binding: TaskBinding;
  policyVersion: string;
  requestHash: string;
  ready: boolean;
  observations: { laya: DualConsultObservation; jev: DualConsultObservation };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

export class DualConsultUnavailable extends Error {
  constructor(readonly evidence: DualConsultEvidence) {
    super(
      "Both Laya and Jev must return valid typed decisions before worker dispatch",
    );
    this.name = "DualConsultUnavailable";
  }
}

function bound(state: Record<string, unknown>, binding: TaskBinding): boolean {
  const parsed = taskBindingSchema.safeParse(state.taskBinding);
  return (
    parsed.success &&
    parsed.data.taskId === binding.taskId &&
    parsed.data.sourceSha256 === binding.sourceSha256
  );
}

const safeProviderFailures = new Set([
  "Decision provider returned an empty response",
  "Decision response exceeds size limit",
  "Decision provider returned an invalid response",
  "Decision response model or typed answer set did not match the request",
  "Decision provider returned an invalid choice",
  "Decision provider returned invalid probabilities",
  "Jev input-token usage was not reported; reservation retained",
  "Reported Jev input usage exceeded the reviewed request envelope",
  "Reported decision cost exceeded its configured reservation",
  "Decision accounting could not be persisted; baseline retained",
  "Decision request exceeds the configured cost ceiling",
  "Decision state or question contains a potential secret",
  "Compact decision state exceeds the configured model limit; abstaining",
  "Decision request exceeds the complete batch byte limit",
  "Jev is disabled by offline policy",
]);
function safeProviderFailure(value: unknown): string {
  if (typeof value !== "string") return "Decision provider failed";
  if (safeProviderFailures.has(value)) return value;
  const http = /^Decision provider HTTP ([1-5][0-9]{2})$/.exec(value);
  return http
    ? `Decision provider HTTP ${http[1]}`
    : "Decision provider failed";
}
function safeModel(model: string, configured: string): string {
  return model === configured
    ? model
    : model === "unreported"
      ? model
      : "mismatched";
}

function observation(
  provider: DecisionProvider & { id: "laya" | "jev" },
  questions: DualConsultOptions["questions"],
  policyVersion: string,
  result: PromiseSettledResult<DecisionBatchResult>,
): DualConsultObservation {
  const batch = result.status === "fulfilled" ? result.value : null;
  const records: DecisionRecord[] = (batch?.records ?? []).map((record) => {
    const evidence: Record<string, unknown> = { ...record.evidence };
    if (typeof evidence.failure === "string")
      evidence.failure = safeProviderFailure(evidence.failure);
    if (evidence.usage !== undefined) {
      const rawUsage = evidence.usage;
      evidence.usage =
        rawUsage && typeof rawUsage === "object" && !Array.isArray(rawUsage)
          ? {
              ...rawUsage,
              model: safeModel(
                String((rawUsage as Record<string, unknown>).model),
                provider.model,
              ),
            }
          : null;
    }
    return {
      ...record,
      modelVersion: safeModel(record.modelVersion, provider.model),
      evidence,
    };
  });
  const usage =
    batch?.usage.length === 1
      ? {
          ...batch.usage[0]!,
          model: safeModel(batch.usage[0]!.model, provider.model),
        }
      : null;
  const callId = usage?.callId ?? null;
  const observedModel = records[0]?.modelVersion ?? null;
  const choices = Object.fromEntries(
    records.map((record) => [
      String(record.evidence.questionId),
      record.selected,
    ]),
  );
  let failure: string | null =
    result.status === "rejected"
      ? safeProviderFailure(
          result.reason instanceof Error
            ? result.reason.message
            : result.reason,
        )
      : null;
  if (!failure) {
    const recordedFailure = records.find(
      (record) => typeof record.evidence.failure === "string",
    )?.evidence.failure;
    if (typeof recordedFailure === "string") failure = recordedFailure;
  }
  if (!failure && (!usage || usage.outcome !== "completed"))
    failure = "Decision call did not complete with retained usage";
  if (
    !failure &&
    (usage!.provider !== provider.id ||
      usage!.model !== provider.model ||
      usage!.questionCount !== questions.length)
  )
    failure = "Decision call identity or question count did not match";
  if (!failure && (records.length !== questions.length || !callId))
    failure = "Decision provider did not answer every question";
  if (!failure && observedModel !== provider.model)
    failure = "Decision provider did not report the configured model identity";
  if (!failure) {
    const answered = new Set<string>();
    for (const record of records) {
      const question = questions.find(
        (item) => item.id === record.evidence.questionId,
      );
      if (
        !question ||
        answered.has(question.id) ||
        record.provider !== provider.id ||
        record.modelVersion !== provider.model ||
        record.policyVersion !== policyVersion ||
        record.mode !== "shadow" ||
        record.evidence.callId !== callId ||
        record.evidence.failure !== undefined ||
        typeof record.selected !== "string" ||
        !Object.hasOwn(question.candidates, record.selected) ||
        typeof record.confidence !== "number" ||
        !Number.isFinite(record.confidence) ||
        record.confidence < 0 ||
        record.confidence > 1
      ) {
        failure = "Decision provider returned an invalid typed answer";
        break;
      }
      answered.add(question.id);
    }
  }
  return {
    provider: provider.id,
    requestEndpoint: provider.endpoint,
    configuredModel: provider.model,
    observedModel,
    callId,
    choices,
    records,
    usage,
    valid: failure === null,
    failure,
  };
}

/** Independent, advisory consultations. A valid pair is a prerequisite, never approval. */
export async function consultBothDecisions(
  options: DualConsultOptions,
): Promise<DualConsultEvidence> {
  const consultationVersion = dualConsultVersionSchema.parse(
    options.consultationVersion ?? "1.0.0",
  );
  const ownerId = dualOwnerSchema.parse(options.ownerId);
  const binding = taskBindingSchema.parse(options.binding);
  const providers = {
    laya: decisionProviderSchema.parse(options.providers.laya),
    jev: decisionProviderSchema.parse(options.providers.jev),
  };
  if (providers.laya.id !== "laya" || providers.jev.id !== "jev")
    throw new Error(
      "Dual consultation requires exactly Laya and Jev providers",
    );
  for (const provider of Object.values(providers)) {
    const endpoint = new URL(provider.endpoint);
    if (endpoint.search || endpoint.hash)
      throw new Error(
        "Dual consultation endpoints cannot contain query or fragment data",
      );
  }
  if (providers.jev.endpoint !== "https://api.typesafe.ai/v1/systemone")
    throw new Error(
      "Dual consultation requires the reviewed direct TypeSafe Jev endpoint",
    );
  if (
    providers.jev.model !== "jev-1.13.0" ||
    providers.jev.pricing?.unit !== "input-token" ||
    providers.jev.pricing.inputTokenReserve !== 64000 ||
    providers.jev.pricing.usdPerMillionInputTokens !== 0.042
  )
    throw new Error(
      "Mandatory Jev consultation requires the reviewed 1.13 input-token price and full 64k reservation",
    );
  if (!options.budget?.reserve || !options.budget?.settle)
    throw new Error("Dual consultation requires a durable decision ledger");
  if (
    !options.attempt?.begin ||
    !options.attempt?.finish ||
    !options.attempt?.fail
  )
    throw new Error("Dual consultation requires a durable attempt ledger");
  const state = structuredClone(options.state);
  const cloudState = (
    consultationVersion === "2.0.0"
      ? dualV2CloudStateSchema
      : dualCloudStateSchema
  ).parse(structuredClone(options.cloudState));
  const questions = (
    consultationVersion === "2.0.0"
      ? dualV2QuestionsSchema
      : z.array(dualWorkerQuestionSchema).length(1)
  ).parse(structuredClone(options.questions));
  if (!bound(state, binding) || !bound(cloudState, binding))
    throw new Error(
      "Both decision states must carry the exact task/source binding",
    );
  if (
    consultationVersion === "2.0.0" &&
    (
      [
        "taskClass",
        "changeKind",
        "languageFamilies",
        "reviewedTaskSummary",
        "workerProfile",
      ] as const
    ).some(
      (key) =>
        JSON.stringify(canonical(state[key])) !==
        JSON.stringify(canonical((cloudState as Record<string, unknown>)[key])),
    )
  )
    throw new Error(
      "Both V2 decision states must carry the same reviewed task metadata",
    );
  const policy = structuredClone(options.policy);
  const policyVersion = hash(policy);
  const requestHash = hash(
    canonical({
      projectId: options.projectId,
      ownerId,
      binding,
      state,
      cloudState,
      questions,
      policy,
      providers,
      ...(consultationVersion === "2.0.0" ? { consultationVersion } : {}),
    }),
  );
  const meta: DualConsultAttemptMeta = {
    projectId: options.projectId,
    ownerId,
    binding,
    policyVersion,
    requestHash,
  };
  const replay = await options.attempt.begin(meta);
  if (replay) {
    if (
      !replay.ready ||
      replay.version !== consultationVersion ||
      replay.projectId !== options.projectId ||
      replay.ownerId !== ownerId ||
      replay.binding.taskId !== binding.taskId ||
      replay.binding.sourceSha256 !== binding.sourceSha256 ||
      replay.requestHash !== requestHash ||
      replay.policyVersion !== policyVersion ||
      !completeObservation(replay.observations.laya, questions) ||
      !completeObservation(replay.observations.jev, questions) ||
      !replay.observations.laya.callId ||
      !replay.observations.jev.callId ||
      replay.observations.laya.callId === replay.observations.jev.callId
    )
      throw new Error(
        "Decision attempt ledger returned mismatched replay evidence",
      );
    return replay;
  }
  const common = {
    projectId: options.projectId,
    state,
    cloudState,
    questions,
    policy,
    evidence: [],
    signal: options.signal,
    requestTimeoutMs: null,
    strictResponse: true,
    budget: options.budget,
  };
  let finished = false;
  try {
    if (hash(options.policy) !== policyVersion)
      throw new Error("Decision policy changed before dual dispatch");
    // Separate single-provider batches prevent cascade or shadow fallback from
    // satisfying the second observation. Both are awaited even if one fails.
    const [local, hosted] = await Promise.allSettled([
      decideBatch({ ...common, providers: [providers.laya] }),
      decideBatch({ ...common, providers: [providers.jev] }),
    ]);
    const laya = observation(providers.laya, questions, policyVersion, local);
    const jev = observation(providers.jev, questions, policyVersion, hosted);
    if (hash(options.policy) !== policyVersion) {
      laya.valid = false;
      jev.valid = false;
      laya.failure = "Decision policy changed during consultation";
      jev.failure = "Decision policy changed during consultation";
    }
    if (laya.callId && jev.callId && laya.callId === jev.callId) {
      laya.valid = false;
      jev.valid = false;
      laya.failure = "Decision calls did not have distinct identities";
      jev.failure = "Decision calls did not have distinct identities";
    }
    const evidence: DualConsultEvidence = {
      version: consultationVersion,
      projectId: options.projectId,
      ownerId,
      binding,
      policyVersion,
      requestHash,
      ready: laya.valid && jev.valid,
      observations: { laya, jev },
    };
    await options.attempt.finish(evidence);
    finished = true;
    if (!evidence.ready) throw new DualConsultUnavailable(evidence);
    return evidence;
  } catch (error) {
    if (!finished) {
      try {
        await options.attempt.fail(
          meta,
          redact(
            error instanceof Error ? error.message : "Decision attempt failed",
          ),
        );
      } catch {
        // The pre-dispatch attempt still blocks replay if failure recording fails.
      }
    }
    throw error;
  }
}
