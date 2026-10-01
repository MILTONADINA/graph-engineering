import {
  assertProjectPolicy,
  type DecisionRecord,
  type ProjectPolicy,
} from "@graph-engineering/contracts";
import { z } from "zod";
import {
  decisionProviderSchema,
  meetsPromotionMetrics,
  promotionEvidenceSchema,
  type DecisionProvider,
  type PromotionEvidence,
} from "./decisions.js";
import { assertEndpoint, containsSecret } from "./policy.js";
import { hash, id, now } from "./util.js";
import {
  authorizesPromotionFromBinding,
  type PromotionDispatchBinding,
} from "./promotion-authority.js";
import {
  checkPromotionRoute,
  type PromotionRouteVerdict,
} from "./promotion-route.js";

export interface DecisionQuestion {
  id: string;
  category: string;
  candidates: Record<string, string>;
  baseline: string;
  instructions?: string;
  /** Caller has verified candidate names/descriptions are eligible for cloud export. */
  exportable?: boolean;
}
export interface DecisionReservation {
  callId: string;
  provider: string;
  amountUsd: number;
}
export interface DecisionCallUsage {
  callId: string;
  provider: string;
  model: string;
  questionCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  reportedCostUsd: number | null;
  estimatedCostUsd: number | null;
  /** Conservative debit; ambiguous dispatched failures retain their reservation. */
  chargedUsd: number | null;
  reservedUsd: number | null;
  priceVersion: string | null;
  costUnknown: boolean;
  outcome: "completed" | "failed";
}
export interface DecisionBudget {
  /** Must atomically reserve against the enclosing task/project budget and persist it. */
  reserve(reservation: DecisionReservation): Promise<void>;
  /** Persist once per callId, never once per question; unknown costs must not become zero. */
  settle(usage: DecisionCallUsage): Promise<void>;
}
export interface DecisionBatchOptions {
  projectId: string;
  state: Record<string, unknown>;
  /** Separate reviewed state: omitted means no hosted decision request. */
  cloudState?: Record<string, unknown>;
  questions: DecisionQuestion[];
  policy: ProjectPolicy;
  providers: DecisionProvider[];
  evidence?: PromotionEvidence[];
  /** Opaque loader-issued binding; raw caller identity/authority is never accepted. */
  promotionBinding?: PromotionDispatchBinding;
  signal?: AbortSignal;
  budget?: DecisionBudget;
}
export interface DecisionBatchResult {
  records: DecisionRecord[];
  /** Always contains a permitted baseline, even after abstention or provider failure. */
  selections: Record<string, string>;
  usage: DecisionCallUsage[];
}
const identifier = z.string().regex(/^[A-Za-z0-9_.:+/-]{1,100}$/);
const questionSchema = z
  .object({
    id: identifier,
    category: identifier,
    candidates: z
      .record(identifier, z.string().max(500))
      .refine(
        (value) =>
          Object.keys(value).length >= 1 && Object.keys(value).length <= 12,
      ),
    baseline: identifier,
    instructions: z.string().min(1).max(1000).optional(),
    exportable: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => Object.hasOwn(value.candidates, value.baseline),
    "Decision baseline must belong to the allowed candidate set",
  );
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
const money = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) => [
      key,
      ...strings(item),
    ]);
  return [];
}
async function readDecisionResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  if (!response.body)
    throw new Error("Decision provider returned an empty response");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  let abortRead: (() => void) | undefined;
  try {
    signal?.throwIfAborted();
    const aborted = signal
      ? new Promise<never>((_resolve, reject) => {
          abortRead = () => reject(signal.reason);
          signal.addEventListener("abort", abortRead, { once: true });
          if (signal.aborted) abortRead();
        })
      : undefined;
    const readBody = (async () => {
      while (true) {
        const next = await reader.read();
        signal?.throwIfAborted();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 1_000_000)
          throw new Error("Decision response exceeds size limit");
        chunks.push(next.value);
      }
    })();
    // One race for the bounded body, not one retained abort reaction per
    // chunk. This also handles streams that do not honor fetch's signal.
    if (aborted) await Promise.race([readBody, aborted]);
    else await readBody;
  } finally {
    if (abortRead) signal?.removeEventListener("abort", abortRead);
    // Cancellation is best-effort local cleanup, not proof that remote work
    // stopped. An arbitrary asynchronous cancel hook must not hold up abort.
    try {
      void reader.cancel().catch(() => {});
    } catch {
      // A stream may already have released or failed its reader.
    }
    try {
      reader.releaseLock();
    } catch {
      // Cleanup failure must not replace the response or cancellation error.
    }
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Decision provider returned an invalid response");
  return value;
}

function confidenceFor(
  answer: Record<string, unknown>,
  question: DecisionQuestion,
): number | null {
  if (!answer.probabilities)
    return money(answer.confidence) !== null && Number(answer.confidence) <= 1
      ? Number(answer.confidence)
      : null;
  const probabilities = answer.probabilities;
  if (
    !probabilities ||
    typeof probabilities !== "object" ||
    Array.isArray(probabilities)
  )
    throw new Error("Decision provider returned invalid probabilities");
  const keys = Object.keys(probabilities),
    values = Object.values(probabilities);
  if (
    keys.length !== Object.keys(question.candidates).length ||
    keys.some((key) => !Object.hasOwn(question.candidates, key)) ||
    values.some(
      (value) =>
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1,
    ) ||
    Math.abs(values.reduce((sum, value) => sum + Number(value), 0) - 1) > 0.01
  )
    throw new Error("Decision provider returned invalid probabilities");
  return (probabilities as Record<string, number>)[String(answer.choice)]!;
}

/** One request per provider per independent batch, not one request per question. */
export async function decideBatch(
  options: DecisionBatchOptions,
): Promise<DecisionBatchResult> {
  // Record and enforce the dispatch policy, not a mutable caller object that
  // could change while reservation, inference, or accounting is awaited.
  const policy = structuredClone(options.policy);
  assertProjectPolicy(policy);
  const policyVersion = hash(policy);
  const timeoutMs =
    policy.decisionTimeoutSeconds === null
      ? null
      : (policy.decisionTimeoutSeconds ?? 10) * 1000;
  const callerSignal = options.signal;
  const assertNotCancelled = () => {
    if (callerSignal?.aborted)
      throw new Error("Decision request cancelled; baseline retained");
  };
  const questions = z
    .array(questionSchema)
    .min(1)
    .max(12)
    .parse(options.questions);
  if (
    new Set(questions.map((question) => question.id)).size !== questions.length
  )
    throw new Error("Decision question IDs must be unique");
  const evidence = z
    .array(promotionEvidenceSchema)
    .parse(options.evidence ?? []);
  const selections = Object.fromEntries(
    questions.map((question) => [question.id, question.baseline]),
  );
  const resolved = new Set<string>(),
    records: DecisionRecord[] = [],
    usages: DecisionCallUsage[] = [];
  const providers = z.array(decisionProviderSchema).parse(options.providers);
  // Shadow short-circuit: only a promoted category under decisionMode
  // "promoted" reaches the per-route check; nothing else does trust, grant
  // or witness work.
  const promotedScope = (question: DecisionQuestion) =>
    policy.decisionMode === "promoted" &&
    policy.promotedCategories.includes(question.category);
  for (const provider of providers) {
    const pending = questions.filter((question) => !resolved.has(question.id));
    if (!pending.length) break;
    // Recompute each promoted route's live identity before dispatch. A refusal
    // keeps the baseline and is recorded; the provider is still asked so its
    // answer stays in shadow, and nothing is retried under weaker checks.
    const routeVerdicts = new Map<string, PromotionRouteVerdict>();
    for (const question of pending)
      if (promotedScope(question))
        routeVerdicts.set(
          question.id,
          checkPromotionRoute("before-dispatch", {
            projectId: options.projectId,
            policy,
            category: question.category,
            provider,
            providers,
          }),
        );
    const callId = id();
    const stateObject =
      provider.id === "jev" ? options.cloudState : options.state;
    const state = JSON.stringify(stateObject ?? {});
    const questionMap = Object.fromEntries(
      pending.map((question) => [
        question.id,
        {
          type: "choice",
          instructions:
            question.instructions ??
            `Choose a permitted ${question.category} action.`,
          criteria: question.candidates,
        },
      ]),
    );
    let result: Record<string, any> | null = null;
    let failure: string | undefined,
      dispatched = false,
      reservedUsd: number | null = null;
    let accountingFailure = false;
    let callUsage: DecisionCallUsage | undefined;
    try {
      assertNotCancelled();
      if (!policy.providers.includes(provider.id))
        throw new Error(`Decision provider ${provider.id} is not permitted`);
      assertEndpoint(provider.endpoint, policy, provider.id === "laya");
      if (
        provider.id === "jev" &&
        (policy.inference === "local" || policy.network === "deny")
      )
        throw new Error("Jev is disabled by offline policy");
      if (
        provider.id === "jev" &&
        (!options.cloudState ||
          pending.some((question) => !question.exportable))
      )
        throw new Error(
          "Hosted decisions require explicitly exportable state and questions",
        );
      // Inspect raw text, not JSON-escaped strings which can hide assignment patterns.
      const rawStrings = [
        state,
        ...strings(stateObject),
        ...pending.flatMap((question) => [
          question.instructions ?? "",
          ...Object.keys(question.candidates),
          ...Object.values(question.candidates),
        ]),
      ];
      if (rawStrings.some(containsSecret))
        throw new Error(
          "Decision state or question contains a potential secret",
        );
      if (state.length > provider.maxStateChars)
        throw new Error(
          "Compact decision state exceeds the configured model limit; abstaining",
        );
      const body = JSON.stringify({
        model: provider.model,
        state,
        questions: questionMap,
      });
      const bodyBytes = Buffer.byteLength(body, "utf8");
      if (bodyBytes > 64 * 1024)
        throw new Error(
          "Decision request exceeds the complete batch byte limit",
        );
      const price = provider.pricing;
      if (price?.unit === "input-token" && bodyBytes > price.inputTokenReserve)
        throw new Error(
          "Decision request exceeds the reviewed input-token reservation",
        );
      const estimate =
        provider.id === "laya"
          ? 0
          : price
            ? price.unit === "input-token"
              ? (price.usdPerMillionInputTokens * price.inputTokenReserve) /
                1_000_000
              : price.usdPerUnit *
                (price.unit === "question" ? pending.length : 1)
            : null;
      if (policy.maxCostUsd !== null && provider.id === "jev") {
        if (estimate === null || !options.budget)
          throw new Error(
            "Unknown Jev pricing or missing reservation ledger; cost-capped projects abstain",
          );
        // Jev is metered: a zero price is not proof of zero cost, so a
        // capped project needs a positive reviewed price. A zero cap therefore
        // admits no Jev call at all.
        if (!(estimate > 0))
          throw new Error(
            "Jev pricing must be a positive reviewed price; cost-capped projects abstain",
          );
        if (estimate > policy.maxCostUsd)
          throw new Error(
            "Decision request exceeds the configured cost ceiling",
          );
      }
      const key = provider.apiKeyEnv
        ? process.env[provider.apiKeyEnv]
        : undefined;
      if (provider.apiKeyEnv && !key)
        throw new Error(`Missing ${provider.apiKeyEnv}`);
      if (provider.id === "jev" && estimate !== null && options.budget) {
        await options.budget.reserve({
          callId,
          provider: provider.id,
          amountUsd: estimate,
        });
        reservedUsd = estimate;
      }
      if (hash(options.policy) !== policyVersion)
        throw new Error(
          "Decision policy changed before dispatch; baseline retained",
        );
      // A reservation may await durable storage. Cancellation during that
      // await never dispatches a new request or invents a refund.
      assertNotCancelled();
      const requestSignal =
        timeoutMs === null
          ? callerSignal
          : AbortSignal.any([
              ...(callerSignal ? [callerSignal] : []),
              AbortSignal.timeout(timeoutMs),
            ]);
      dispatched = true;
      const response = await fetch(provider.endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body,
        signal: requestSignal,
      });
      requestSignal?.throwIfAborted();
      if (!response.ok)
        throw new Error(`Decision provider HTTP ${response.status}`);
      result = await readDecisionResponse(response, requestSignal);
      requestSignal?.throwIfAborted();
    } catch (error) {
      failure =
        error instanceof Error ? error.message : "Decision provider failed";
    }
    if (dispatched) {
      const rawUsage =
        result?.usage && typeof result.usage === "object" ? result.usage : {};
      const inputTokens = count(rawUsage.input_tokens);
      const outputTokens = count(rawUsage.output_tokens);
      const reportedCostUsd = money(rawUsage.cost_usd ?? result?.cost_usd);
      const price = provider.pricing;
      const tokenPriced = price?.unit === "input-token";
      const estimatedCostUsd =
        provider.id === "laya"
          ? 0
          : price
            ? tokenPriced
              ? (price.usdPerMillionInputTokens *
                  (inputTokens ?? price.inputTokenReserve)) /
                1_000_000
              : price.usdPerUnit *
                (price.unit === "question" ? pending.length : 1)
            : null;
      const chargedUsd =
        provider.id === "laya"
          ? 0
          : tokenPriced && estimatedCostUsd !== null
            ? Math.max(reportedCostUsd ?? 0, estimatedCostUsd)
            : reportedCostUsd === null
              ? estimatedCostUsd
              : Math.max(reportedCostUsd, reservedUsd ?? 0);
      callUsage = {
        callId,
        provider: provider.id,
        // A failed or model-less response is never attributed to the
        // configured model; the record's modelVersion says the same.
        model: typeof result?.model === "string" ? result.model : "unreported",
        questionCount: pending.length,
        inputTokens,
        outputTokens,
        reportedCostUsd,
        estimatedCostUsd,
        chargedUsd,
        reservedUsd,
        priceVersion: provider.pricing?.version ?? null,
        costUnknown:
          chargedUsd === null || (tokenPriced && inputTokens === null),
        outcome: failure ? "failed" : "completed",
      };
      usages.push(callUsage);
      if (tokenPriced && result !== null && inputTokens === null) {
        failure = "Decision provider omitted billable input-token usage";
        accountingFailure = true;
      }
      if (
        reservedUsd !== null &&
        chargedUsd !== null &&
        chargedUsd > reservedUsd
      ) {
        failure = "Reported decision cost exceeded its configured reservation";
        accountingFailure = true;
      }
      if (options.budget) {
        try {
          await options.budget.settle(callUsage);
        } catch {
          failure =
            "Decision accounting could not be persisted; baseline retained";
          accountingFailure = true;
        }
      }
    }
    let policyChanged = hash(options.policy) !== policyVersion;
    if (policyChanged)
      failure = "Decision policy changed during the request; baseline retained";
    let cancelled = callerSignal?.aborted === true;
    if (cancelled) failure = "Decision request cancelled; baseline retained";
    for (const question of pending) {
      const proof = evidence.find(
        (item) =>
          item.category === question.category &&
          item.provider === provider.id &&
          item.model === provider.model,
      );
      let routeVerdict = routeVerdicts.get(question.id);
      // Re-check after the response only for a route admitted before dispatch.
      if (routeVerdict?.admitted)
        routeVerdict = checkPromotionRoute(
          "after-response",
          {
            projectId: options.projectId,
            policy,
            category: question.category,
            provider,
            providers,
          },
          typeof result?.model === "string" ? result.model : null,
        );
      const eligible =
        !failure &&
        !cancelled &&
        !policyChanged &&
        promotedScope(question) &&
        routeVerdict?.admitted === true &&
        !!proof &&
        meetsPromotionMetrics(proof) &&
        (await authorizesPromotionFromBinding(options.promotionBinding, proof, {
          projectId: options.projectId,
          policyVersion,
        }));
      if (hash(options.policy) !== policyVersion) {
        policyChanged = true;
        failure =
          "Decision policy changed during authorization; baseline retained";
      }
      if (callerSignal?.aborted) {
        cancelled = true;
        failure = "Decision request cancelled; baseline retained";
      }
      const promoted = eligible && !policyChanged && !cancelled;
      let selected: string | null,
        confidence: number | null = null,
        questionFailure = failure;
      const modelVersion =
        typeof result?.model === "string" ? result.model : "unreported";
      try {
        if (failure) throw new Error(failure);
        const answer = result?.answers?.[question.id];
        if (
          !answer ||
          typeof answer !== "object" ||
          typeof answer.choice !== "string" ||
          !Object.hasOwn(question.candidates, answer.choice)
        )
          throw new Error("Decision provider returned an invalid choice");
        selected = answer.choice;
        confidence = confidenceFor(answer, question);
        if (
          promoted &&
          (modelVersion !== provider.model ||
            confidence === null ||
            confidence < proof!.minimumConfidence)
        )
          selected = null;
      } catch (error) {
        selected = null;
        questionFailure =
          error instanceof Error ? error.message : "Decision answer failed";
      }
      if (promoted && selected) {
        selections[question.id] = selected;
        resolved.add(question.id);
      }
      records.push({
        version: "1.0.0",
        id: id(),
        projectId: options.projectId,
        category: question.category,
        candidates: Object.keys(question.candidates),
        selected,
        baseline: question.baseline,
        provider: provider.id,
        modelVersion,
        policyVersion,
        confidence,
        mode: promoted ? "promoted" : "shadow",
        createdAt: now(),
        evidence: {
          questionId: question.id,
          callId,
          stateHash: hash(state),
          promotionVersion: proof?.version ?? null,
          promotionAuthority: promoted ? "verified" : "unverified",
          ...(routeVerdict && !routeVerdict.admitted
            ? {
                promotionRefusal: routeVerdict.refusal,
                promotionRefusalPhase: routeVerdict.phase,
              }
            : {}),
          ...(questionFailure ? { failure: questionFailure } : {}),
          ...(question.id === pending[0]?.id && callUsage
            ? { usage: callUsage }
            : {}),
        },
      });
    }
    if (policyChanged || cancelled) {
      for (const question of questions)
        selections[question.id] = question.baseline;
      resolved.clear();
      for (const record of records) {
        if (!cancelled && record.mode !== "promoted") continue;
        record.mode = "shadow";
        record.evidence.promotionAuthority = "unverified";
        record.evidence.failure = cancelled
          ? "Decision request cancelled; baseline retained"
          : "Decision policy changed during authorization; baseline retained";
        if (cancelled) record.selected = null;
      }
    }
    // No cascading spend after cancellation, a failed accounting write or
    // exceeded price bound. Dispatched calls still use the existing ledger.
    if (accountingFailure || policyChanged || cancelled) break;
  }
  return { records, selections, usage: usages };
}
