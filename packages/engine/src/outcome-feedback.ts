import { createHash } from "node:crypto";
import type { RunRecord } from "@graph-engineering/contracts";
import { z } from "zod";
import type { DualConsultEvidence } from "./decision-dual.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:/-]+$/);
export const outcomeFeedbackSchema = z.object({
  schema_version: z.literal(1),
  task: identity,
  task_kind: z.enum(["engineering", "product"]),
  context: z.object({
    write_path_count: z.number().int().min(1).max(100_000),
    acceptance_count: z.number().int().min(1).max(100_000),
    source_dirty: z.boolean(),
    text_only_coverage: z.boolean(),
  }).strict(),
  handoff: identity,
  dispatch_id: identity,
  source_before_sha256: digest,
  candidate_sha256: digest,
  run_id: identity,
  scope_id: identity,
  scope_request_sha256: digest,
  completion_proof_sha256: digest.nullable(),
  dual_consultation_sha256: digest,
  outcome: z.object({
    kind: z.enum(["BRIGHTPATH_COMPLETION_REVIEW", "BRIGHTPATH_SCOPE_REVIEW"]),
    state: z.enum(["CURRENT_ENGINEERING_COMPLETION", "REVIEW_REJECTED", "SCOPE_REVIEW_REJECTED"]),
    request_sha256: digest,
    review_sha256: digest,
    current_source_sha256: digest,
  }).strict(),
  decision_ids: z.array(identity).length(2),
  decision_usage: z.object({ laya: z.unknown(), jev: z.unknown() }).strict(),
  memory_accepted: z.literal(false),
  routing_promoted: z.literal(false),
}).strict().superRefine((value, context) => {
  if (value.outcome.state === "CURRENT_ENGINEERING_COMPLETION" &&
      (!value.completion_proof_sha256 || value.outcome.kind !== "BRIGHTPATH_COMPLETION_REVIEW"))
    context.addIssue({ code: "custom", message: "Completion requires a bound BrightPath completion proof" });
  if (value.outcome.state === "SCOPE_REVIEW_REJECTED" && value.outcome.kind !== "BRIGHTPATH_SCOPE_REVIEW")
    context.addIssue({ code: "custom", message: "Scope rejection requires a scope review" });
});
export type OutcomeFeedback = z.infer<typeof outcomeFeedbackSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const outcomeHash = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");

/** Checks GE's own receipts only; no GE run-to-dual or BrightPath review proof is established. */
export function validateOutcomeFeedback(
  input: unknown,
  consultationBytes: Buffer,
  retained: DualConsultEvidence,
  run: RunRecord,
): OutcomeFeedback {
  const feedback = outcomeFeedbackSchema.parse(input);
  if (createHash("sha256").update(consultationBytes).digest("hex") !== feedback.dual_consultation_sha256)
    throw new Error("Retained consultation bytes changed");
  let supplied: unknown;
  try { supplied = JSON.parse(consultationBytes.toString("utf8")); }
  catch { throw new Error("Retained consultation is invalid JSON"); }
  if (outcomeHash(supplied) !== outcomeHash(retained))
    throw new Error("Consultation differs from the GE decision ledger");
  if (!retained.ready || retained.ownerId !== feedback.dispatch_id ||
      retained.binding.taskId !== feedback.task ||
      retained.binding.sourceSha256 !== feedback.source_before_sha256 ||
      !retained.observations.laya.valid || !retained.observations.jev.valid)
    throw new Error("Feedback is not bound to a completed dual consultation");
  const observations = retained.observations;
  const decisionIds = [observations.laya.records[0]?.id, observations.jev.records[0]?.id];
  if (decisionIds.some((id) => !id) ||
      outcomeHash(decisionIds.slice().sort()) !== outcomeHash(feedback.decision_ids.slice().sort()) ||
      outcomeHash(feedback.decision_usage) !== outcomeHash({ laya: observations.laya.usage, jev: observations.jev.usage }))
    throw new Error("Feedback decision IDs or usage differ from retained observations");
  if (run.id !== feedback.run_id || run.status !== "succeeded" ||
      run.completion?.automatedChecksPassed !== true)
    throw new Error("Feedback requires the retained successful GE run");
  return feedback;
}
