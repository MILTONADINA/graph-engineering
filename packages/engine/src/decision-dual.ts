import type { DecisionRecord } from "@graph-engineering/contracts";
import { z } from "zod";
import {
  decideBatch,
  type DecisionBatchOptions,
  type DecisionBatchResult,
  type DecisionCallUsage,
} from "./decision-batch.js";
import { decisionProviderSchema, type DecisionProvider } from "./decisions.js";
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
  binding: TaskBinding;
  /** Both states must carry this exact task/source binding. */
  cloudState: Record<string, unknown>;
  providers: { laya: DecisionProvider; jev: DecisionProvider };
  /** A durable ledger is mandatory, even when the project has no cost cap. */
  budget: NonNullable<DecisionBatchOptions["budget"]>;
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
  version: "1.0.0";
  projectId: string;
  binding: TaskBinding;
  policyVersion: string;
  ready: boolean;
  observations: { laya: DualConsultObservation; jev: DualConsultObservation };
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

function observation(
  provider: DecisionProvider & { id: "laya" | "jev" },
  questions: DualConsultOptions["questions"],
  policyVersion: string,
  result: PromiseSettledResult<DecisionBatchResult>,
): DualConsultObservation {
  const batch = result.status === "fulfilled" ? result.value : null;
  const records = batch?.records ?? [];
  const usage = batch?.usage.length === 1 ? batch.usage[0]! : null;
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
      ? result.reason instanceof Error
        ? result.reason.message
        : "Decision provider failed"
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
  if (!options.budget?.reserve || !options.budget?.settle)
    throw new Error("Dual consultation requires a durable decision ledger");
  const state = structuredClone(options.state);
  const cloudState = structuredClone(options.cloudState);
  const questions = structuredClone(options.questions);
  if (!bound(state, binding) || !bound(cloudState, binding))
    throw new Error(
      "Both decision states must carry the exact task/source binding",
    );
  if (
    !questions.length ||
    !questions.some((question) => question.category === "worker")
  )
    throw new Error("Dual consultation requires a worker question");
  if (questions.some((question) => question.exportable !== true))
    throw new Error("Every dual consultation question requires export review");
  const policyVersion = hash(options.policy);
  const common = {
    projectId: options.projectId,
    state,
    cloudState,
    questions,
    policy: options.policy,
    evidence: [],
    signal: options.signal,
    requestTimeoutMs: null,
    strictResponse: true,
    budget: options.budget,
  };
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
    version: "1.0.0",
    projectId: options.projectId,
    binding,
    policyVersion,
    ready: laya.valid && jev.valid,
    observations: { laya, jev },
  };
  if (!evidence.ready) throw new DualConsultUnavailable(evidence);
  return evidence;
}
