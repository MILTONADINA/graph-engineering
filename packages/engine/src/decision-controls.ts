import {
  decideBatch,
  type DecisionBatchOptions,
  type DecisionBatchResult,
  type DecisionQuestion,
} from "./decision-batch.js";
import { hash } from "./util.js";

export type DecisionSession = Omit<DecisionBatchOptions, "questions">;
export interface SelectionCandidate {
  id: string;
  kind: "context" | "file" | "memory";
  /** Compact index metadata, never a source-file dump. */
  label: string;
  required?: boolean;
  baselineInclude?: boolean;
  exportable?: boolean;
}
const promoted = (result: DecisionBatchResult, id: string, baseline: string) =>
  result.selections[id] ?? baseline;

/** Ranking is advisory until category promotion; mandatory evidence cannot be removed. */
export async function selectContext(
  options: DecisionSession & { candidates: SelectionCandidate[] },
): Promise<DecisionBatchResult & { selectedIds: string[] }> {
  if (
    new Set(options.candidates.map((candidate) => candidate.id)).size !==
    options.candidates.length
  )
    throw new Error("Context candidate IDs must be unique");
  const selectedIds: string[] = [],
    records: DecisionBatchResult["records"] = [],
    usage: DecisionBatchResult["usage"] = [],
    selections: Record<string, string> = {};
  for (let offset = 0; offset < options.candidates.length; offset += 12) {
    const group = options.candidates.slice(offset, offset + 12);
    const questions = group.map<DecisionQuestion>((candidate) => ({
      id: `item-${hash(candidate.id).slice(0, 16)}`,
      category: `${candidate.kind}-selection`,
      instructions: `Relevance of ${candidate.label.slice(0, 220)}`,
      candidates: Object.fromEntries(
        candidate.required
          ? [["include", "Required evidence"]]
          : [
              ["include", "Relevant evidence"],
              ["exclude", "Not relevant"],
            ],
      ),
      baseline:
        candidate.required || candidate.baselineInclude !== false
          ? "include"
          : "exclude",
      exportable: candidate.exportable === true,
    }));
    const result = await decideBatch({ ...options, questions });
    records.push(...result.records);
    usage.push(...result.usage);
    Object.assign(selections, result.selections);
    group.forEach((candidate, index) => {
      if (
        candidate.required ||
        result.selections[questions[index]!.id] === "include"
      )
        selectedIds.push(candidate.id);
    });
  }
  return { selectedIds, records, usage, selections };
}

export async function routeRetrieval(
  options: DecisionSession & {
    graphAvailable: boolean;
    semanticAvailable: boolean;
  },
): Promise<DecisionBatchResult & { scope: "lexical" | "graph" | "hybrid" }> {
  const candidates: Record<string, string> = {
    lexical: "Exact code and document search",
    hybrid: "Combine available retrieval indexes",
  };
  if (options.graphAvailable) candidates.graph = "Follow indexed relationships";
  const result = await decideBatch({
    ...options,
    questions: [
      {
        id: "retrieval",
        category: "retrieval-scope",
        candidates,
        baseline: "hybrid",
        exportable: true,
      },
    ],
  });
  return {
    ...result,
    scope: result.selections.retrieval as "lexical" | "graph" | "hybrid",
  };
}

export type ReviewScope =
  "normal" | "security" | "architecture" | "security-and-architecture";
export async function routeScopes(
  options: DecisionSession & {
    allowedTools: string[];
    focusedTools: string[];
    requiredTools?: string[];
    requiredChecks: string[];
    focusedChecks: string[];
    availableChecks: string[];
    securityReviewRequired: boolean;
    architectureReviewRequired: boolean;
  },
): Promise<
  DecisionBatchResult & {
    tools: string[];
    checks: string[];
    review: ReviewScope;
  }
> {
  if (
    [...options.focusedTools, ...(options.requiredTools ?? [])].some(
      (tool) => !options.allowedTools.includes(tool),
    )
  )
    throw new Error("Tool scope exceeds permitted tools");
  if (
    [...options.requiredChecks, ...options.focusedChecks].some(
      (check) => !options.availableChecks.includes(check),
    )
  )
    throw new Error(
      "Check scope references an unavailable verification command",
    );
  const review: ReviewScope = options.securityReviewRequired
    ? options.architectureReviewRequired
      ? "security-and-architecture"
      : "security"
    : options.architectureReviewRequired
      ? "architecture"
      : "normal";
  const reviewCandidates: Record<string, string> = {
    [review]: "Required review floor",
  };
  if (review !== "security-and-architecture")
    reviewCandidates["security-and-architecture"] =
      "Additional security and architecture review";
  const result = await decideBatch({
    ...options,
    questions: [
      {
        id: "tools",
        category: "tool-scope",
        candidates: {
          focused: "Relevant permitted tools",
          all: "All permitted tools",
        },
        baseline: "all",
        exportable: true,
      },
      {
        id: "tests",
        category: "test-scope",
        candidates: {
          required: "Mandatory checks only",
          focused: "Mandatory and affected checks",
          full: "All configured checks",
        },
        baseline: "full",
        exportable: true,
      },
      {
        id: "review",
        category: "review-scope",
        candidates: reviewCandidates,
        baseline: review,
        exportable: true,
      },
    ],
  });
  const tools =
    result.selections.tools === "focused"
      ? options.focusedTools
      : options.allowedTools;
  const checks =
    result.selections.tests === "required"
      ? []
      : result.selections.tests === "focused"
        ? options.focusedChecks
        : options.availableChecks;
  return {
    ...result,
    tools: [...new Set([...(options.requiredTools ?? []), ...tools])],
    checks: [...new Set([...options.requiredChecks, ...checks])],
    review: promoted(result, "review", review) as ReviewScope,
  };
}

export type RecoveryAction =
  "retry" | "retrieve" | "escalate" | "stop" | "human";
export async function controlRecovery(
  options: DecisionSession & {
    attempt: number;
    maxAttempts: number;
    needsMoreContext: boolean;
    alternativeProviderAvailable: boolean;
    securityConcern: boolean;
    repeatedFailure: boolean;
  },
): Promise<DecisionBatchResult & { action: RecoveryAction }> {
  if (
    !Number.isSafeInteger(options.attempt) ||
    options.attempt < 0 ||
    !Number.isSafeInteger(options.maxAttempts) ||
    options.maxAttempts < 1
  )
    throw new Error("Invalid retry budget");
  const exhausted =
    options.attempt >=
    Math.min(options.maxAttempts, options.policy.maxAttempts);
  const candidates: Record<string, string> = {
    human: "Pause for review",
    stop: "Stop without claiming success",
  };
  if (!exhausted && !options.securityConcern) {
    candidates.retry = "Retry inside remaining attempt budget";
    candidates.retrieve = "Retrieve missing evidence then retry";
    if (options.alternativeProviderAvailable)
      candidates.escalate = "Ask an already permitted stronger worker";
  }
  const baseline: RecoveryAction =
    exhausted || options.securityConcern
      ? "human"
      : options.needsMoreContext
        ? "retrieve"
        : options.repeatedFailure
          ? options.alternativeProviderAvailable
            ? "escalate"
            : "human"
          : "retry";
  const result = await decideBatch({
    ...options,
    questions: [
      {
        id: "recovery",
        category: "retry-escalation",
        candidates,
        baseline,
        exportable: true,
      },
    ],
  });
  return {
    ...result,
    action: promoted(result, "recovery", baseline) as RecoveryAction,
  };
}

export async function controlCompletion(
  options: DecisionSession & {
    acceptanceSatisfied: boolean;
    requiredTestsPassed: boolean;
    requiredReviewsPassed: boolean;
    policyValid: boolean;
    completionScope?: "full-acceptance" | "automated-run";
  },
): Promise<
  DecisionBatchResult & { action: "complete" | "continue" | "human" }
> {
  const automatedRun = options.completionScope === "automated-run";
  const eligible =
    options.requiredTestsPassed &&
    options.policyValid &&
    (automatedRun ||
      (options.acceptanceSatisfied && options.requiredReviewsPassed));
  const candidates: Record<string, string> = eligible
    ? {
        complete: automatedRun
          ? "Stop the automated worker loop; required checks passed, human acceptance and review remain pending"
          : "All deterministic acceptance gates passed; no publication or merge authorization is granted",
        continue: "Further useful investigation",
        human: "Ask for review",
      }
    : {
        continue: "Required evidence or checks remain",
        human: "Ask for review",
      };
  const baseline = !options.policyValid
    ? "human"
    : eligible
      ? "complete"
      : "continue";
  const result = await decideBatch({
    ...options,
    questions: [
      {
        id: "completion",
        category: "stop",
        instructions: automatedRun
          ? "This decision only stops automated execution. It does not approve human acceptance, required human review, publication, or merge."
          : "Completion requires all acceptance, verification, review, and policy gates. Completion never grants publication or merge authorization.",
        candidates,
        baseline,
        exportable: true,
      },
    ],
  });
  return {
    ...result,
    action: promoted(result, "completion", baseline) as
      "complete" | "continue" | "human",
  };
}

export async function controlMemoryWrite(
  options: DecisionSession & { durable: boolean; requiredAuditRecord: boolean },
): Promise<DecisionBatchResult & { action: "propose" | "discard" }> {
  const baseline =
    options.requiredAuditRecord || options.durable ? "propose" : "discard";
  const candidates: Record<string, string> = options.requiredAuditRecord
    ? { propose: "Retain required audit evidence" }
    : {
        propose: "Save a private unaccepted proposal",
        discard: "Do not add to durable memory",
      };
  const result = await decideBatch({
    ...options,
    questions: [
      {
        id: "memory-write",
        category: "memory-write",
        candidates,
        baseline,
        exportable: true,
      },
    ],
  });
  // This never accepts/shares a memory or discards the append-only run log.
  return {
    ...result,
    action: options.requiredAuditRecord
      ? "propose"
      : (promoted(result, "memory-write", baseline) as "propose" | "discard"),
  };
}
