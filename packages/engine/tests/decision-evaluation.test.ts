import { expect, it } from "vitest";
import type { DecisionRecord } from "@graph-engineering/contracts";
import {
  canPromote,
  evaluateDecisions,
  meetsPromotionMetrics,
  type EvaluationDataset,
} from "../src/decisions.js";
import {
  exportEvaluationDraft,
  importEvaluationLabels,
  type EvaluationLabel,
} from "../src/decision-evaluation.js";

const observed: DecisionRecord = {
  version: "1.0.0",
  id: "observed-decision",
  projectId: "unit-project",
  category: "worker",
  candidates: ["local", "frontier"],
  selected: "local",
  baseline: "frontier",
  provider: "laya",
  modelVersion: "pinned-test-model",
  policyVersion: "policy-hash",
  confidence: 0.99,
  mode: "shadow",
  createdAt: "2026-09-01T00:00:00.000Z",
  evidence: { stateHash: "immutable-state-hash" },
};
const provenance: EvaluationDataset["provenance"] = {
  origin: "synthetic",
  datasetId: "unit-dataset",
  population: "Synthetic records solely exercise evaluator integrity.",
  repositoryIds: ["fixture-repository"],
  riskStrata: ["ordinary"],
  reviewedBy: "unit-test",
  reviewedAt: "2026-09-02T00:00:00.000Z",
  limitations: ["Not production evidence or a measured engineering benchmark."],
};
const annotation: EvaluationLabel = {
  recordId: observed.id,
  split: "held-out",
  expected: "local",
  repositoryId: "fixture-repository",
  risk: "ordinary",
  labeler: "unit-test",
  labelEvidence: ["fixture-review"],
  outcomeEvidence: ["fixture-outcome"],
  baselineSuccess: true,
  candidateSuccess: true,
  baselineCost: 1,
  candidateCost: 0.5,
  policyViolation: false,
};

it("exports only recorded observations, requiring explicit task identity and manual labels", () => {
  expect(() =>
    exportEvaluationDraft([observed], {
      datasetId: "unit-dataset",
      taskIds: {},
    }),
  ).toThrow("originating task");
  const draft = exportEvaluationDraft([observed], {
    datasetId: "unit-dataset",
    taskIds: { [observed.id]: "task-1" },
  });
  expect(draft.observations[0]).not.toHaveProperty("expected");
  expect(draft.observations[0]).not.toHaveProperty("candidateSuccess");
  expect(() =>
    importEvaluationLabels({ draft, provenance, labels: [] }),
  ).toThrow();
  expect(() =>
    importEvaluationLabels({
      draft,
      provenance,
      labels: [{ ...annotation, expected: "not-a-candidate" }],
    }),
  ).toThrow("candidate set");
  const dataset = importEvaluationLabels({
    draft,
    provenance,
    labels: [annotation],
  });
  expect(dataset.rows[0]?.selected).toBe(observed.selected);
  expect(dataset.rows[0]?.expected).toBe(annotation.expected);
  expect(canPromote(evaluateDecisions(dataset).reports[0]!)).toBe(false);
});

it("never substitutes a made-up confidence or permits duplicate labels/observations", () => {
  const draft = exportEvaluationDraft([{ ...observed, confidence: null }], {
    datasetId: "unit-dataset",
    taskIds: { [observed.id]: "task-1" },
  });
  expect(() =>
    importEvaluationLabels({ draft, provenance, labels: [annotation] }),
  ).toThrow("Missing confidence");
  expect(() =>
    importEvaluationLabels({
      draft,
      provenance,
      labels: [annotation, annotation],
    }),
  ).toThrow("duplicate labels");
});

it("requires recorded provenance, explicit evidence, and declared population coverage for promotion", () => {
  const rows = Array.from({ length: 300 }, (_, index) => ({
    ...annotation,
    recordId: `record-${index}`,
    caseId: `case-${index}`,
    taskId: `${index < 60 ? "cal" : "held"}-${index % 60}`,
    split: index < 60 ? ("calibration" as const) : ("held-out" as const),
    category: "worker",
    provider: "laya" as const,
    model: observed.modelVersion,
    selected: "local",
    confidence: 0.99,
    candidates: observed.candidates,
    observedAt: observed.createdAt,
  }));
  const synthetic: EvaluationDataset = { version: "1.0.0", provenance, rows };
  expect(canPromote(evaluateDecisions(synthetic).reports[0]!)).toBe(false);
  // This origin declaration is a unit-test stand-in, never exported as evidence.
  const recorded: EvaluationDataset = {
    ...synthetic,
    provenance: { ...provenance, origin: "recorded" },
  };
  expect(meetsPromotionMetrics(evaluateDecisions(recorded).reports[0]!)).toBe(
    true,
  );
  expect(canPromote(evaluateDecisions(recorded).reports[0]!)).toBe(false);
  expect(
    meetsPromotionMetrics(
      evaluateDecisions({
        ...recorded,
        provenance: {
          ...recorded.provenance,
          riskStrata: ["ordinary", "security"],
        },
      }).reports[0]!,
    ),
  ).toBe(false);
  expect(
    meetsPromotionMetrics(
      evaluateDecisions({
        ...recorded,
        rows: rows.map((row) => ({ ...row, outcomeEvidence: undefined })),
      }).reports[0]!,
    ),
  ).toBe(false);
  expect(() =>
    evaluateDecisions({
      ...recorded,
      rows: [...rows, { ...rows[0]!, caseId: "different-case" }],
    }),
  ).toThrow("Duplicate recorded observation");
});
