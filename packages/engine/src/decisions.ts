import type {
  DecisionRecord,
  ProjectPolicy,
} from "@graph-engineering/contracts";
import { z } from "zod";
import path from "node:path";
import { assertEndpoint, containsSecret } from "./policy.js";
import { hash, id, now, readJson } from "./util.js";
import { decideBatch, type DecisionBudget } from "./decision-batch.js";
import {
  authorizesPromotion,
  type PromotionScope,
  type PromotionDispatchBinding,
} from "./promotion-authority.js";
export { decideBatch } from "./decision-batch.js";
export type {
  DecisionQuestion,
  DecisionBatchOptions,
  DecisionBatchResult,
  DecisionBudget,
  DecisionCallUsage,
  DecisionReservation,
} from "./decision-batch.js";

export interface DecisionProvider {
  id: "laya" | "jev";
  endpoint: string;
  model: string;
  apiKeyEnv?: string;
  maxStateChars: number;
  /** Reviewed provider price; hosted calls never infer a rate from request text. */
  pricing?:
    | { unit: "request" | "question"; usdPerUnit: number; version: string }
    | {
        unit: "input-token";
        usdPerMillionInputTokens: number;
        /** Mandatory BrightPath Jev consultation reserves this full envelope. */
        maxInputTokens?: 64000;
        /** Other hosted decisions may use a smaller reviewed reservation. */
        inputTokenReserve?: number;
        version: string;
      };
}
export interface PromotionEvidence {
  version: string;
  category: string;
  provider: string;
  model: string;
  calibrationCount: number;
  heldOutCount: number;
  taskCount: number;
  policyViolations: number;
  additionalFailures: number;
  baselineCost: number;
  candidateCost: number;
  calibrationError: number;
  minimumConfidence: number;
  dataOrigin?: "recorded" | "synthetic" | "unverified";
  provenanceComplete?: boolean;
  datasetId?: string | null;
}
const labelSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x1f]+$/);
const countSchema = z.number().finite().int().nonnegative().max(1_000_000_000);
const costSchema = z.number().finite().nonnegative().max(1_000_000_000_000);
export const promotionEvidenceSchema = z
  .object({
    version: z.string().regex(/^[a-f0-9]{64}$/),
    category: labelSchema,
    provider: z.enum(["laya", "jev"]),
    model: labelSchema,
    calibrationCount: countSchema,
    heldOutCount: countSchema,
    taskCount: countSchema,
    policyViolations: countSchema,
    additionalFailures: countSchema,
    baselineCost: costSchema,
    candidateCost: costSchema,
    calibrationError: z.number().finite().min(0).max(1),
    minimumConfidence: z.number().finite().min(0.5).max(1),
    dataOrigin: z
      .enum(["recorded", "synthetic", "unverified"])
      .default("unverified"),
    provenanceComplete: z.boolean().default(false),
    datasetId: labelSchema.nullable().default(null),
  })
  .strict()
  .refine(
    (value) => value.taskCount <= value.heldOutCount,
    "Accepted task count exceeds accepted decisions",
  );
/** Numerical/provenance-field eligibility only; this never establishes authority. */
export function meetsPromotionMetrics(e: PromotionEvidence): boolean {
  const valid = promotionEvidenceSchema.safeParse(e);
  if (!valid.success) return false;
  return (
    valid.data.dataOrigin === "recorded" &&
    valid.data.provenanceComplete &&
    valid.data.datasetId !== null &&
    e.calibrationCount >= 50 &&
    e.heldOutCount >= 200 &&
    e.taskCount >= 60 &&
    e.policyViolations === 0 &&
    e.additionalFailures === 0 &&
    e.candidateCost < e.baselineCost &&
    e.calibrationError <= 0.05
  );
}
/** Production eligibility additionally requires a verified, process-local grant. */
export function canPromote(
  evidence: PromotionEvidence,
  authorization?: PromotionScope & { authority: unknown },
): boolean {
  const valid = promotionEvidenceSchema.safeParse(evidence);
  return (
    valid.success &&
    meetsPromotionMetrics(valid.data) &&
    !!authorization &&
    authorizesPromotion(authorization.authority, valid.data, authorization)
  );
}
export const decisionProviderSchema = z
  .object({
    id: z.enum(["laya", "jev"]),
    endpoint: z.string().url(),
    model: z.string().min(1),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    maxStateChars: z.number().int().min(64).max(100000),
    pricing: z
      .discriminatedUnion("unit", [
        z
          .object({
            unit: z.literal("request"),
            usdPerUnit: costSchema,
            version: labelSchema,
          })
          .strict(),
        z
          .object({
            unit: z.literal("question"),
            usdPerUnit: costSchema,
            version: labelSchema,
          })
          .strict(),
        z
          .object({
            unit: z.literal("input-token"),
            usdPerMillionInputTokens: costSchema.positive(),
            maxInputTokens: z.literal(64000).optional(),
            inputTokenReserve: z
              .number()
              .int()
              .positive()
              .max(1_000_000)
              .optional(),
            version: labelSchema,
          })
          .strict(),
      ])
      .optional(),
  })
  .strict()
  .refine(
    (provider) =>
      provider.pricing?.unit !== "input-token" ||
      (provider.pricing.maxInputTokens !== undefined) !==
        (provider.pricing.inputTokenReserve !== undefined),
    "Token pricing requires exactly one reviewed reservation",
  );
export async function decisionProviders(
  dataDir: string,
): Promise<DecisionProvider[]> {
  try {
    return z
      .array(decisionProviderSchema)
      .parse(await readJson(path.join(dataDir, "decisions.json")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
export async function decide(options: {
  projectId: string;
  category: string;
  state: Record<string, unknown>;
  cloudState?: Record<string, unknown>;
  exportable?: boolean;
  candidates: Record<string, string>;
  baseline: string;
  policy: ProjectPolicy;
  providers: DecisionProvider[];
  evidence?: PromotionEvidence[];
  promotionBinding?: PromotionDispatchBinding;
  signal?: AbortSignal;
  budget?: DecisionBudget;
}): Promise<DecisionRecord[]> {
  const result = await decideBatch({
    ...options,
    questions: [
      {
        id: "action",
        category: options.category,
        candidates: options.candidates,
        baseline: options.baseline,
        exportable: options.exportable,
      },
    ],
  });
  return result.records;
}

export interface EvaluationRow {
  split: "calibration" | "held-out";
  category: string;
  provider: string;
  model: string;
  selected: string | null;
  expected: string;
  confidence: number;
  caseId: string;
  taskId: string;
  baselineSuccess: boolean;
  candidateSuccess: boolean;
  baselineCost: number;
  candidateCost: number;
  policyViolation: boolean;
  recordId?: string;
  candidates?: string[];
  repositoryId?: string;
  risk?: string;
  observedAt?: string;
  labeler?: string;
  labelEvidence?: string[];
  outcomeEvidence?: string[];
}
export const evaluationRowSchema = z
  .object({
    split: z.enum(["calibration", "held-out"]),
    category: labelSchema,
    provider: z.enum(["laya", "jev"]),
    model: labelSchema,
    selected: labelSchema.nullable(),
    expected: labelSchema,
    confidence: z.number().finite().min(0).max(1),
    caseId: labelSchema,
    taskId: labelSchema,
    baselineSuccess: z.boolean(),
    candidateSuccess: z.boolean(),
    baselineCost: costSchema,
    candidateCost: costSchema,
    policyViolation: z.boolean(),
    recordId: labelSchema.optional(),
    candidates: z.array(labelSchema).min(1).max(1000).optional(),
    repositoryId: labelSchema.optional(),
    risk: labelSchema.optional(),
    observedAt: z.string().datetime().optional(),
    labeler: labelSchema.optional(),
    labelEvidence: z.array(labelSchema).min(1).optional(),
    outcomeEvidence: z.array(labelSchema).min(1).optional(),
  })
  .strict()
  .refine(
    (row) =>
      !row.candidates ||
      (row.candidates.includes(row.expected) &&
        (row.selected === null || row.candidates.includes(row.selected))),
    "Evaluation labels must belong to the observed candidate set",
  );
export const evaluationProvenanceSchema = z
  .object({
    origin: z.enum(["recorded", "synthetic"]),
    datasetId: labelSchema,
    population: z.string().min(20).max(4000),
    repositoryIds: z.array(labelSchema).min(1),
    riskStrata: z.array(labelSchema).min(1),
    reviewedBy: labelSchema,
    reviewedAt: z.string().datetime(),
    limitations: z.array(z.string().min(1).max(2000)).min(1),
  })
  .strict();
export const evaluationDatasetSchema = z
  .object({
    version: z.literal("1.0.0"),
    provenance: evaluationProvenanceSchema,
    rows: z.array(evaluationRowSchema).min(1).max(1_000_000),
  })
  .strict();
export type EvaluationDataset = z.infer<typeof evaluationDatasetSchema>;
export function evaluateDecisions(input: EvaluationRow[] | EvaluationDataset): {
  reports: PromotionEvidence[];
  sampleCount: number;
} {
  const dataset = Array.isArray(input)
    ? null
    : evaluationDatasetSchema.parse(input);
  const rows =
    dataset?.rows ??
    z.array(evaluationRowSchema).min(1).max(1_000_000).parse(input);
  const splits = new Map<string, string>(),
    observations = new Set<string>(),
    recordIds = new Set<string>(),
    cases = new Map<string, string>();
  for (const row of rows) {
    if (row.recordId) {
      const key = JSON.stringify([row.provider, row.model, row.recordId]);
      if (recordIds.has(key))
        throw new Error("Duplicate recorded observation in evaluation data");
      recordIds.add(key);
    }
    const previousSplit = splits.get(row.taskId);
    if (previousSplit && previousSplit !== row.split)
      throw new Error("Calibration and held-out task IDs must be disjoint");
    splits.set(row.taskId, row.split);
    const observation = JSON.stringify([
      row.category,
      row.provider,
      row.model,
      row.caseId,
    ]);
    if (observations.has(observation))
      throw new Error("Duplicate decision case in an evaluation group");
    observations.add(observation);
    const caseKey = JSON.stringify([row.category, row.caseId]),
      identity = JSON.stringify([row.taskId, row.expected]);
    if (cases.has(caseKey) && cases.get(caseKey) !== identity)
      throw new Error(
        "A decision case has inconsistent task identity or expected label",
      );
    cases.set(caseKey, identity);
  }
  const reports: PromotionEvidence[] = [];
  for (const key of new Set(
    rows.map((r) => `${r.category}\0${r.provider}\0${r.model}`),
  )) {
    const group = rows.filter(
      (r) => `${r.category}\0${r.provider}\0${r.model}` === key,
    );
    const calibration = group.filter((r) => r.split === "calibration");
    const held = group.filter((r) => r.split === "held-out");
    const taskResults = new Map<string, EvaluationRow>();
    for (const row of held) {
      const previous = taskResults.get(row.taskId);
      if (
        previous &&
        (previous.baselineSuccess !== row.baselineSuccess ||
          previous.candidateSuccess !== row.candidateSuccess ||
          previous.baselineCost !== row.baselineCost ||
          previous.candidateCost !== row.candidateCost)
      )
        throw new Error(
          "End-to-end outcomes and costs must be consistent within a task",
        );
      taskResults.set(row.taskId, row);
    }
    const thresholds = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99];
    const fittedThreshold = thresholds.find((t) => {
      const selected = calibration.filter(
        (r) => r.confidence >= t && r.selected !== null,
      );
      return (
        selected.length >= 50 &&
        selected.filter((r) => r.selected === r.expected).length /
          selected.length >=
          0.95
      );
    });
    const threshold = fittedThreshold ?? 1;
    const calibrationCount =
      fittedThreshold === undefined
        ? 0
        : calibration.filter(
            (row) => row.selected !== null && row.confidence >= threshold,
          ).length;
    const accepted =
      fittedThreshold === undefined
        ? []
        : held.filter((r) => r.confidence >= threshold && r.selected !== null);
    let calibrationError = accepted.length ? 0 : 1;
    for (let bin = 0; bin < 10; bin++) {
      const items = accepted.filter(
        (row) => Math.min(9, Math.floor(row.confidence * 10)) === bin,
      );
      if (items.length)
        calibrationError +=
          (items.length / accepted.length) *
          Math.abs(
            items.reduce((sum, row) => sum + row.confidence, 0) / items.length -
              items.filter((row) => row.selected === row.expected).length /
                items.length,
          );
    }
    const taskIds = new Set(accepted.map((row) => row.taskId));
    const [category, provider, model] = key.split("\0");
    reports.push({
      version: hash({ rows: group, provenance: dataset?.provenance ?? null }),
      dataOrigin: dataset?.provenance.origin ?? "unverified",
      datasetId: dataset?.provenance.datasetId ?? null,
      provenanceComplete:
        !!dataset &&
        group.every(
          (row) =>
            row.recordId &&
            row.candidates?.length &&
            row.repositoryId &&
            row.risk &&
            row.observedAt &&
            row.labeler &&
            row.labelEvidence?.length &&
            row.outcomeEvidence?.length &&
            dataset.provenance.repositoryIds.includes(row.repositoryId) &&
            dataset.provenance.riskStrata.includes(row.risk),
        ) &&
        dataset.provenance.repositoryIds.every((repository) =>
          group.some((row) => row.repositoryId === repository),
        ) &&
        dataset.provenance.riskStrata.every((risk) =>
          group.some((row) => row.risk === risk),
        ),
      category,
      provider,
      model,
      calibrationCount,
      heldOutCount: accepted.length,
      taskCount: taskIds.size,
      policyViolations: new Set(
        held.filter((r) => r.policyViolation).map((row) => row.taskId),
      ).size,
      additionalFailures: [...taskResults.values()].filter(
        (r) => r.baselineSuccess && !r.candidateSuccess,
      ).length,
      baselineCost: [...taskResults.values()].reduce(
        (s, r) => s + r.baselineCost,
        0,
      ),
      candidateCost: [...taskResults.values()].reduce(
        (s, r) => s + r.candidateCost,
        0,
      ),
      calibrationError,
      minimumConfidence: threshold,
    });
  }
  return { reports, sampleCount: rows.length };
}
