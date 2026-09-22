import type { DecisionRecord } from "@graph-engineering/contracts";
import { z } from "zod";
import {
  evaluationDatasetSchema,
  evaluationProvenanceSchema,
  evaluateDecisions,
  type EvaluationDataset,
} from "./decisions.js";

const label = z.string().min(1).max(256);
const observationSchema = z
  .object({
    recordId: label,
    caseId: label,
    taskId: label,
    category: label,
    provider: z.enum(["laya", "jev"]),
    model: label,
    selected: label.nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    candidates: z.array(label).min(1),
    observedAt: z.string().datetime(),
    stateHash: label,
  })
  .strict();
export const evaluationDraftSchema = z
  .object({
    version: z.literal("1.0.0"),
    datasetId: label,
    observations: z.array(observationSchema).min(1),
  })
  .strict();
export type EvaluationDraft = z.infer<typeof evaluationDraftSchema>;

/** Export observations only. There are intentionally no generated expected labels/outcomes. */
export function exportEvaluationDraft(
  records: DecisionRecord[],
  options: { datasetId: string; taskIds: Record<string, string> },
): EvaluationDraft {
  return evaluationDraftSchema.parse({
    version: "1.0.0",
    datasetId: options.datasetId,
    observations: records.map((record) => {
      const taskId = options.taskIds[record.id];
      if (!taskId)
        throw new Error(
          `Assign an originating task to decision ${record.id} before evaluation export`,
        );
      return {
        recordId: record.id,
        caseId: record.id,
        taskId,
        category: record.category,
        provider: record.provider,
        model: record.modelVersion,
        selected: record.selected,
        confidence: record.confidence,
        candidates: record.candidates,
        observedAt: record.createdAt,
        stateHash: record.evidence.stateHash,
      };
    }),
  });
}

export const evaluationLabelSchema = z
  .object({
    recordId: label,
    split: z.enum(["calibration", "held-out"]),
    expected: label,
    repositoryId: label,
    risk: label,
    labeler: label,
    labelEvidence: z.array(label).min(1),
    outcomeEvidence: z.array(label).min(1),
    baselineSuccess: z.boolean(),
    candidateSuccess: z.boolean(),
    policyViolation: z.boolean(),
    baselineCost: z.number().finite().nonnegative(),
    candidateCost: z.number().finite().nonnegative(),
  })
  .strict();
export type EvaluationLabel = z.infer<typeof evaluationLabelSchema>;

/** Join externally reviewed labels to immutable exported observations; incomplete data fails closed. */
export function importEvaluationLabels(input: {
  draft: EvaluationDraft;
  provenance: z.infer<typeof evaluationProvenanceSchema>;
  labels: EvaluationLabel[];
}): EvaluationDataset {
  const draft = evaluationDraftSchema.parse(input.draft),
    provenance = evaluationProvenanceSchema.parse(input.provenance);
  if (draft.datasetId !== provenance.datasetId)
    throw new Error("Evaluation dataset identities do not match");
  const labels = z.array(evaluationLabelSchema).min(1).parse(input.labels);
  if (new Set(labels.map((item) => item.recordId)).size !== labels.length)
    throw new Error("A decision observation has duplicate labels");
  if (
    labels.length !== draft.observations.length ||
    labels.some(
      (item) =>
        !draft.observations.some(
          (observation) => observation.recordId === item.recordId,
        ),
    )
  )
    throw new Error(
      "Every observation needs exactly one explicit reviewed label",
    );
  const rows = draft.observations.map((observation) => {
    if (observation.confidence === null)
      throw new Error(
        "Missing confidence cannot be fabricated for evaluation; export a separate scorable subset",
      );
    const annotation = labels.find(
      (item) => item.recordId === observation.recordId,
    )!;
    const { stateHash: _stateHash, ...observed } = observation;
    return { ...observed, confidence: observation.confidence, ...annotation };
  });
  const dataset = evaluationDatasetSchema.parse({
    version: "1.0.0",
    provenance,
    rows,
  });
  evaluateDecisions(dataset); // Check split leakage, duplicates, candidate validity, and repeated task cost consistency.
  return dataset;
}
