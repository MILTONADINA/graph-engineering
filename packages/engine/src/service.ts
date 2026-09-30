import { setTimeout as delay } from "node:timers/promises";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ContextPacket,
  ExecutionPlan,
  ExecutionStep,
  ProjectConfig,
  ProjectPolicy,
  ProviderConfig,
  RunEvent,
  RunOutcome,
  RunRecord,
  Usage,
} from "@graph-engineering/contracts";
import { ContextEngine } from "./context/index.js";
import { loadProject, loadProviders, projectDataDir } from "./project.js";
import { planSha256, RunStore, type PlanApproval } from "./store.js";
import {
  assertMandatoryExport,
  assertProvider,
  containsSecret,
  isAllowedPath,
  redact,
  safePath,
  wholeRepository,
} from "./policy.js";
import {
  command,
  errorMessage,
  hash,
  id,
  LocalDetailError,
  now,
  readJson,
  writeJson,
} from "./util.js";
import { decide, decisionProviders } from "./decisions.js";
import { loadPromotionAuthority } from "./promotion-authority.js";
import {
  invokeApiWorker,
  estimateRequestCost,
  fitWorkerContext,
  type WorkerInput,
  type WorkerProposal,
  type WorkerResult,
  proposalSchema,
} from "./workers/api.js";
import {
  invokeInstalledWorker,
  discoverInstalledWorkers,
} from "./workers/installed.js";
import {
  applyProposal,
  assertVerificationPaths,
  captureOriginals,
  createWorkspace,
  recoverBaseCommit,
  removeWorkspace,
  prepareProposal,
  restoreOriginals,
  workspaceFingerprint,
  gitFiles,
  PATH_ALIAS_ERROR,
} from "./execution/workspace.js";
import {
  dockerAvailable,
  verifyInContainer,
  type VerificationResult,
} from "./execution/docker.js";
import { publishRun } from "./execution/publish.js";
import {
  invokeReviewWorker,
  reviewOutcome,
  type ReviewInput,
  type WorkerReview,
} from "./workers/review.js";
import {
  invokePlanWorker,
  type Decomposition,
  type PlanInput,
} from "./workers/plan.js";
import { LOCKFILES, type ProjectProfile } from "./security/catalog.js";
import {
  BASELINE_FILE,
  newFindings,
  OSV_DATABASE_ADVICE,
  osvDatabase,
  readCommittedBaseline,
  runSecurityScan,
  scannerImageId,
  type SecurityScan,
} from "./security/scan.js";
import {
  patchFeedbackFor,
  recordShown,
  RepeatedRequestError,
  REPEATED_REQUEST_FEEDBACK,
  requestedSourcePacket,
  SuppliedLines,
  UnexportableRequestError,
  unexportableRequestFeedback,
  assertExportablePatch,
  UnexportablePatchError,
  unexportablePatchFeedback,
  unseenPatchLocation,
} from "./execution/requested-sources.js";
import {
  checkedGit,
  describeHiddenEntries,
  gitBlob,
  hiddenIndexEntries,
} from "./execution/git.js";
import {
  likelyWorkerTurns,
  requiresSecurityReview,
  routePlan,
  WORKFLOWS,
} from "./planning.js";
import { dagParallelism } from "./scale.js";
import { passedChecksSnapshot, stoppedAtReview } from "./overview.js";
import { TESTER_STEP_ID, testerStep } from "./tester.js";
import { parseSpec, planFromSpec, SPECS_DIR } from "./specs.js";
import {
  renderTemplateProposal,
  templateRuntimeCapability,
} from "./templates.js";
import {
  applyRepair,
  checkpointPaths,
  runDag,
  validateDag,
  untilAborted,
  writeScope,
  DagReconciliationError,
  DAG_REPAIR_STEP,
  type DagCheckpoint,
  type DagEvent,
} from "./execution/dag.js";
import type { DecisionBudget, DecisionBatchResult } from "./decision-batch.js";
import {
  routeRetrieval,
  selectContext,
  routeScopes,
  controlRecovery,
  controlCompletion,
  controlMemoryWrite,
  type DecisionSession,
} from "./decision-controls.js";

export interface EngineDependencies {
  worker?: (input: WorkerInput, workspace: string) => Promise<WorkerResult>;
  verify?: typeof verifyInContainer;
  dockerAvailable?: typeof dockerAvailable;
  /** Reviews a verified change; defaults to the configured reviewer's API. */
  review?: (input: ReviewInput) => Promise<{
    review: WorkerReview;
    model: string;
    usage: Usage;
  }>;
  /** Proposes plan steps; defaults to the planner provider's API. */
  planner?: (input: PlanInput) => Promise<{
    decomposition: Decomposition;
    model: string;
    usage: Usage;
  }>;
  /** Scans a verified run result; defaults to the offline scanner image. */
  securityScan?: (options: {
    root: string;
    profile: ProjectProfile;
    signal?: AbortSignal;
  }) => Promise<SecurityScan>;
}
// The scanner image graph-engine security-scan builds and uses by default.
export const SECURITY_SCAN_IMAGE = "graph-security:local";
// The worker step that repairs a multi-step plan whose combined checks failed.
export { DAG_REPAIR_STEP };
const cloudSignals = (state: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(state).filter(
      ([, value]) =>
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)),
    ),
  );
export class GraphEngine {
  readonly context: ContextEngine;
  readonly store: RunStore;
  readonly dataDir: string;
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private closing?: Promise<void>;
  private constructor(
    readonly root: string,
    public config: ProjectConfig,
    private deps: EngineDependencies,
  ) {
    this.dataDir = projectDataDir(config.projectId);
    // The run store opens first because it can refuse to open (a database
    // left by a newer engine, or a file that is not a database). The context
    // engine starts a database worker that keeps the process alive until it
    // is closed, and a failed constructor leaves nothing to close it.
    this.store = new RunStore(this.dataDir, config.projectId);
    this.context = new ContextEngine({
      projectId: config.projectId,
      root,
      dataDir: this.dataDir,
      policy: config.policy,
    });
  }
  static async open(
    root: string,
    deps: EngineDependencies = {},
  ): Promise<GraphEngine> {
    const absolute = path.resolve(root);
    const config = await loadProject(absolute);
    // Register configured decision keys before any project subprocess starts.
    await decisionProviders(projectDataDir(config.projectId));
    const engine = new GraphEngine(absolute, config, deps);
    try {
      await engine.store.recoverInterrupted();
      return engine;
    } catch (error) {
      await engine.close();
      throw error;
    }
  }
  async providers(): Promise<ProviderConfig[]> {
    return loadProviders(this.dataDir);
  }
  private decisionBudget(ownerId: string): DecisionBudget {
    return {
      reserve: async ({ callId, provider, amountUsd }) =>
        this.store.reserveCall(
          ownerId,
          callId,
          provider,
          amountUsd,
          this.config.policy.maxCostUsd,
        ),
      settle: async (usage) =>
        this.store.settleCall(ownerId, usage.callId, usage.provider, {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: 0,
          costUsd: usage.chargedUsd,
          // The debit is conservative: a reviewed price or a reservation
          // above the reported charge is an estimate, not a measured cost.
          estimated:
            usage.reportedCostUsd === null ||
            usage.chargedUsd !== usage.reportedCostUsd,
        }),
    };
  }
  private async decisionSession(
    ownerId: string,
    state: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<DecisionSession> {
    const promotion = await loadPromotionAuthority(this.dataDir, {
      projectId: this.config.projectId,
      policyVersion: hash(this.config.policy),
    });
    return {
      projectId: this.config.projectId,
      state,
      // Only non-content operational counters/flags are eligible for hosted
      // routing by default. Source text, paths, objectives and memories stay out.
      cloudState: cloudSignals(state),
      policy: this.config.policy,
      providers: await decisionProviders(this.dataDir),
      evidence: promotion.evidence,
      promotionBinding: promotion.binding,
      signal,
      budget: this.decisionBudget(ownerId),
    };
  }
  private captureDecision(
    run: RunRecord,
    stage: string,
    result: DecisionBatchResult,
  ): void {
    for (const record of result.records) this.store.decision(record);
    run.usage = this.store.usage(run.plan.id);
    this.store.saveRun(run);
    this.store.event(run.id, `decision.${stage}`, {
      selections: result.selections,
      callUsage: result.usage,
      decisionIds: result.records.map((record) => record.id),
    });
  }
  // A configured tester's step comes first: it writes tests for the
  // acceptance criteria, limited to new test files, before the implementing
  // steps run; the combined result is verified, reviewed and scanned like
  // any multi-step plan.
  private async withTester(
    steps: ExecutionStep[],
    acceptance: string[],
    spec?: ExecutionPlan["spec"],
  ): Promise<ExecutionStep[]> {
    const tester = this.config.tester;
    if (!tester) return steps;
    if (steps.some((step) => step.id === TESTER_STEP_ID))
      throw new Error(
        `Step ID ${TESTER_STEP_ID} is reserved for the configured tester; rename that step`,
      );
    if (steps.length >= 100)
      throw new Error(
        "A plan with a tester may have at most 99 other steps; split the work",
      );
    const provider = (await this.availableWorkers()).find(
      (candidate) => candidate.id === tester.providerId,
    );
    if (!provider) {
      // A configured, permitted tester can still be unusable (the cost cap,
      // or an installed client that is missing): name the actual reason.
      const reason = (await this.workerReasons()).find(
        (entry) => entry.id === tester.providerId,
      )?.reason;
      throw new Error(
        reason
          ? `Tester ${tester.providerId} is unavailable: ${reason}`
          : `Tester ${tester.providerId} is not a configured provider the policy permits`,
      );
    }
    // Test first: the tester's step runs before every other step.
    return validateDag([
      testerStep({
        providerId: provider.id,
        acceptance,
        writes: tester.writes,
        spec,
      }),
      ...steps.map((step) =>
        step.dependsOn.length ? step : { ...step, dependsOn: [TESTER_STEP_ID] },
      ),
    ]).steps;
  }
  /**
   * A warning when a plan's roles are likely to need more model calls than
   * policy.maxTurns allows for the whole run, or undefined.
   */
  turnWarning(plan: Pick<ExecutionPlan, "steps">): string | undefined {
    const needed = likelyWorkerTurns(plan, {
      reviewer: Boolean(this.config.review),
      maxAttempts: this.config.policy.maxAttempts,
    });
    return needed > this.config.policy.maxTurns
      ? `This plan may need about ${needed} model calls (its steps, reviews and repair attempts), but policy.maxTurns allows ${this.config.policy.maxTurns} for the whole run. To allow more, raise policy.maxTurns and plan again before starting: a policy change refuses this plan, and once a run starts it voids resume and review-approve for that run.`
      : undefined;
  }
  /**
   * What to tell the person about a plan they just created, before a run
   * refuses it: a plan without verification commands can never run, and
   * one that needs more model calls than policy.maxTurns may stop half way.
   */
  planWarnings(plan: Pick<ExecutionPlan, "steps" | "verification">): string[] {
    const turns = this.turnWarning(plan);
    return [
      ...(plan.verification.length === 0
        ? [
            "This plan has no verification commands, so it cannot run: a plan keeps the commands configured when it was created. Add a check with graph-engine check-add <image> <command...>, then create a new plan.",
          ]
        : []),
      ...(turns ? [turns] : []),
    ];
  }
  // A plan keeps the verification configured when it was created, so adding
  // checks later never makes it runnable; say which of the two to do.
  private assertPlanVerification(plan: Pick<ExecutionPlan, "verification">) {
    if (plan.verification.length > 0) return;
    throw new Error(
      this.config.verification.length > 0
        ? "This plan was created before any verification command was configured; create a new plan"
        : "Configure verification commands with graph-engine check-add, then create a new plan: a plan keeps the commands configured when it was created",
    );
  }
  // Configured workers the policy permits and, for installed agents, that
  // are installed.
  /**
   * Each configured worker and why it cannot be used, if it cannot, so an
   * error can say exactly what to change.
   */
  async workerReasons(): Promise<{ id: string; reason: string | null }[]> {
    const configured = await this.providers();
    const installed = configured.some((p) =>
      ["codex", "claude", "cursor"].includes(p.kind),
    )
      ? await discoverInstalledWorkers()
      : [];
    return configured.map((p) => {
      try {
        assertProvider(p, this.config.policy);
      } catch (error) {
        return {
          id: p.id,
          reason: `${(error as Error).message}${
            (error as Error).message.startsWith(
              "Project policy does not allow provider",
            )
              ? ` (add it to policy.providers with graph-engine provider-enable ${p.id})`
              : ""
          }`,
        };
      }
      if (
        ["codex", "claude", "cursor"].includes(p.kind) &&
        !installed.some((c) => c.kind === p.kind && c.available)
      )
        return {
          id: p.id,
          reason: `the installed ${p.kind} client is not available (see graph-engine capabilities)`,
        };
      return { id: p.id, reason: null };
    });
  }
  private async unavailableWorkersMessage(prefix: string): Promise<string> {
    const reasons = (await this.workerReasons()).filter(
      (entry) => entry.reason,
    );
    return reasons.length
      ? `${prefix} Configured workers that cannot be used: ${reasons
          .map((entry) => `${entry.id}: ${entry.reason}`)
          .join("; ")}.`
      : `${prefix} No worker is configured; add one with graph-engine provider-add.`;
  }
  private async availableWorkers(): Promise<ProviderConfig[]> {
    const configured = await this.providers();
    const installed = configured.some((p) =>
      ["codex", "claude", "cursor"].includes(p.kind),
    )
      ? await discoverInstalledWorkers()
      : [];
    return configured.filter((p) => {
      try {
        assertProvider(p, this.config.policy);
        return (
          !["codex", "claude", "cursor"].includes(p.kind) ||
          installed.some(
            (capability) => capability.kind === p.kind && capability.available,
          )
        );
      } catch {
        return false;
      }
    });
  }
  /**
   * Asks a planner to break an objective into dependency-ordered steps. The
   * result is only a proposal: nothing runs until a person creates a plan
   * from the steps (`graph-engine plan --steps`), which validates them again.
   */
  async proposeSteps(input: {
    objective: string;
    acceptance: string[];
    plannerId: string;
    providerId?: string;
    effort?: string;
    /** Use only exportable context and return only exportable text. */
    exportOnly?: boolean;
    signal?: AbortSignal;
  }): Promise<{
    steps: ExecutionStep[];
    rationale: string;
    planner: { id: string; model: string };
    usage: Usage;
    snapshotId: string;
  }> {
    await this.refresh();
    if (
      !input.objective.trim() ||
      input.acceptance.length === 0 ||
      input.acceptance.some((a) => !a.trim())
    )
      throw new Error(
        "An objective and explicit acceptance criteria are required",
      );
    const policy = this.config.policy;
    const planner = (await this.providers()).find(
      (provider) => provider.id === input.plannerId,
    );
    if (!planner)
      throw new Error(
        `Planner ${input.plannerId} is not a configured provider`,
      );
    if (!["openai", "anthropic", "local"].includes(planner.kind))
      throw new Error(
        `Planner ${planner.id} must be an API or local provider; installed agents cannot plan yet`,
      );
    assertProvider(planner, policy);
    const available = await this.availableWorkers();
    const implementer = input.providerId
      ? available.find((provider) => provider.id === input.providerId)
      : available[0];
    if (!implementer)
      throw new Error(
        input.providerId
          ? `Selected worker ${input.providerId} is unavailable under project policy: ${
              (await this.workerReasons()).find(
                (entry) => entry.id === input.providerId,
              )?.reason ??
              "it is not configured; add it with graph-engine provider-add"
            }`
          : await this.unavailableWorkersMessage(
              "No permitted worker is available to implement the steps.",
            ),
      );
    assertProvider(implementer, policy, input.effort);
    // The planner's step text becomes a cloud implementer's objective, so a
    // cloud implementer limits a local planner to exportable context too.
    const exportOnly =
      input.exportOnly === true ||
      planner.kind !== "local" ||
      implementer.kind !== "local";
    const snapshot = await this.context.index({ semantic: false });
    const context = await this.context.getContext({
      query: input.objective,
      snapshotId: snapshot.id,
      mandatory: input.acceptance,
      exportOnly,
      budgetTokens: Math.min(
        policy.maxContextTokens,
        planner.maxContextTokens ?? policy.maxContextTokens,
      ),
    });
    if (exportOnly) {
      // As for cloud context_get: only authorized memory and exportable,
      // secret-free excerpts, whichever planner reads them.
      assertMandatoryExport(context, policy, { attributedOnly: false });
      context.items = context.items.filter(
        (item) =>
          item.source &&
          isAllowedPath(item.source.path, policy, true) &&
          !containsSecret(item.text),
      );
    }
    // Decompositions share one cost owner per project and UTC day, so
    // maxCostUsd and maxTurns bound a day's planner calls, however many.
    const ownerId = `decompose-${now().slice(0, 10)}`;
    const callId = `worker-plan-${id()}`;
    const started = Date.now();
    while (!(await this.store.tryAcquireWorker(callId, policy.maxWorkers))) {
      if (Date.now() - started > policy.timeoutSeconds * 1000)
        throw new Error("Worker concurrency wait timed out");
      await delay(50, undefined, { signal: input.signal });
    }
    let result: Awaited<ReturnType<typeof invokePlanWorker>>;
    try {
      if (input.signal?.aborted) throw new Error("Decomposition cancelled");
      try {
        this.store.reserveCall(
          ownerId,
          callId,
          planner.id,
          estimateRequestCost(
            planner,
            policy.maxContextTokens,
            policy.maxOutputTokens,
          ),
          policy.maxCostUsd,
          policy.maxTurns,
        );
      } catch (error) {
        throw new Error(
          `Today's decompositions have reached the project's limits (policy.maxTurns planner calls, policy.maxCostUsd estimated cost): ${errorMessage(error)}`,
          { cause: error },
        );
      }
      result = await (this.deps.planner ?? invokePlanWorker)({
        provider: planner,
        policy,
        objective: input.objective,
        acceptance: input.acceptance,
        context,
        signal: input.signal,
      });
      this.store.settleCall(ownerId, callId, planner.id, result.usage);
    } finally {
      this.store.releaseWorker(callId);
    }
    if (
      exportOnly &&
      [
        result.decomposition.rationale,
        ...result.decomposition.steps.map((step) => step.objective),
      ].some(containsSecret)
    )
      throw new Error(
        "The proposed steps contain a potential secret and cannot be returned",
      );
    const steps = validateDag(
      result.decomposition.steps.map((step) => ({
        id: step.id,
        kind: "worker" as const,
        objective: step.objective,
        dependsOn: step.dependsOn,
        providerId: implementer.id,
        ...(input.effort ? { effort: input.effort } : {}),
      })),
    ).steps;
    return {
      steps,
      rationale: result.decomposition.rationale,
      planner: { id: planner.id, model: result.model },
      usage: result.usage,
      snapshotId: snapshot.id,
    };
  }
  // The project's configured reviewer, which must be an API or local worker.
  private async reviewer(
    providerId = this.config.review?.providerId,
  ): Promise<ProviderConfig> {
    const reviewer = (await this.providers()).find(
      (provider) => provider.id === providerId,
    );
    if (!providerId || !reviewer)
      throw new Error(
        `Configured reviewer ${providerId} is not a configured provider`,
      );
    if (!["openai", "anthropic", "local"].includes(reviewer.kind))
      throw new Error(
        `Reviewer ${reviewer.id} must be an API or local provider; installed agents cannot review yet`,
      );
    assertProvider(reviewer, this.config.policy);
    return reviewer;
  }
  // The reviewer a run was started with, or the configured one for a run
  // that has not recorded it yet.
  private runReviewerId(runId: string): string | undefined {
    const recorded = this.store
      .events(runId)
      .find((event) => event.type === "review.configured");
    if (!recorded) return this.config.review?.providerId;
    return typeof recorded.data.providerId === "string"
      ? recorded.data.providerId
      : undefined;
  }
  // Reviews share the run's worker slots, turn budget and cost reservations.
  private async invokeReviewer(input: ReviewInput, ownerId: string) {
    const callId = `worker-review-${id()}`;
    const started = Date.now();
    while (
      !(await this.store.tryAcquireWorker(callId, input.policy.maxWorkers))
    ) {
      if (Date.now() - started > input.policy.timeoutSeconds * 1000)
        throw new Error("Worker concurrency wait timed out");
      await delay(50, undefined, { signal: input.signal });
    }
    try {
      if (input.signal?.aborted) throw new Error("Run cancelled");
      this.store.reserveCall(
        ownerId,
        callId,
        input.provider.id,
        estimateRequestCost(
          input.provider,
          input.policy.maxContextTokens,
          input.policy.maxOutputTokens,
        ),
        input.policy.maxCostUsd,
        input.policy.maxTurns,
      );
      const result = await (this.deps.review ?? invokeReviewWorker)(input);
      this.store.settleCall(ownerId, callId, input.provider.id, result.usage);
      return result;
    } finally {
      this.store.releaseWorker(callId);
    }
  }
  /**
   * `onReserved` runs once the call holds a slot and its reservation, just
   * before the request is sent: a dispatch recorded any earlier (a cancel or
   * timeout while waiting for a slot, or a refused reservation) would count
   * a worker turn the ledger never reserved, and resume would refuse it.
   */
  private async invokeWorker(
    input: WorkerInput,
    workspace: string,
    ownerId: string,
    onReserved?: () => void,
  ): Promise<WorkerResult> {
    // A run's packet is built once; consent withdrawn since then must stop
    // the next cloud turn, so authorization is read again at each dispatch.
    if (input.provider.kind !== "local")
      input = {
        ...input,
        context: await this.context.withCurrentExportAuthorization(
          input.context,
        ),
      };
    input = fitWorkerContext(input);
    const callId = `worker-${id()}`;
    const started = Date.now();
    while (
      !(await this.store.tryAcquireWorker(callId, input.policy.maxWorkers))
    ) {
      if (Date.now() - started > input.policy.timeoutSeconds * 1000)
        throw new Error("Worker concurrency wait timed out");
      await delay(50, undefined, { signal: input.signal });
    }
    try {
      if (input.signal?.aborted) throw new Error("Run cancelled");
      this.store.reserveCall(
        ownerId,
        callId,
        input.provider.id,
        estimateRequestCost(
          input.provider,
          input.policy.maxContextTokens,
          input.policy.maxOutputTokens,
        ),
        input.policy.maxCostUsd,
        input.policy.maxTurns,
      );
      onReserved?.();
      const result = this.deps.worker
        ? await this.deps.worker(input, workspace)
        : ["codex", "claude", "cursor"].includes(input.provider.kind)
          ? await invokeInstalledWorker(input, workspace)
          : await invokeApiWorker(input);
      this.store.settleCall(ownerId, callId, input.provider.id, result.usage);
      return result;
    } finally {
      this.store.releaseWorker(callId);
    }
  }
  async refresh(): Promise<ProjectConfig> {
    const config = await loadProject(this.root);
    if (config.projectId !== this.config.projectId)
      throw new Error("Project identity changed; restart the engine");
    // A running DAG holds this object, so it keeps its identity, but its
    // contents become the file's exactly: a key removed from the file is
    // removed here, and keys keep the file's order, which the policy hash
    // depends on.
    const policy: Partial<ProjectPolicy> = this.config.policy;
    for (const key of Object.keys(policy) as (keyof ProjectPolicy)[])
      delete policy[key];
    Object.assign(this.config.policy, config.policy);
    this.config = { ...config, policy: this.config.policy };
    this.context.updatePolicy(config.policy);
    return this.config;
  }
  /**
   * Plans a feature from its spec: the objective comes from the spec's title,
   * problem, security considerations and non-goals, and the acceptance
   * criteria are the spec's, in order.
   */
  async createPlanFromSpec(
    specPath: string,
    options: {
      providerId?: string;
      effort?: string;
      steps?: ExecutionStep[];
    } = {},
  ): Promise<ExecutionPlan> {
    await this.refresh();
    const relative = specPath.split(path.sep).join("/");
    if (!relative.startsWith(`${SPECS_DIR}/`) || !relative.endsWith(".md"))
      throw new Error(`A spec is a Markdown file under ${SPECS_DIR}/`);
    const text = await readFile(
      await safePath(this.root, relative, wholeRepository(this.config.policy)),
      "utf8",
    );
    const spec = parseSpec(relative, text);
    const { objective, acceptance } = planFromSpec(spec);
    return this.createPlan({
      ...options,
      objective,
      acceptance,
      spec: { id: spec.id, path: relative, sha256: hash(text) },
    });
  }
  async createPlan(input: {
    objective: string;
    acceptance: string[];
    providerId?: string;
    effort?: string;
    steps?: ExecutionStep[];
    spec?: ExecutionPlan["spec"];
    /**
     * Written by a cloud-backed MCP client: its workers, the tester and the
     * reviewer must then all run locally or all run elsewhere.
     */
    cloudAuthored?: boolean;
  }): Promise<ExecutionPlan> {
    await this.refresh();
    if (
      !input.objective.trim() ||
      input.acceptance.length === 0 ||
      input.acceptance.some((a) => !a.trim())
    )
      throw new Error(
        "An objective and explicit acceptance criteria are required",
      );
    const snapshot = await this.context.index({ semantic: false });
    const planId = id();
    if (input.steps) {
      const validated = validateDag(input.steps).steps;
      if (validated.every((step) => step.kind === "template")) {
        for (const step of validated)
          if (!templateRuntimeCapability(step.templateId!).executable)
            throw new Error(`Template ${step.templateId} is not executable`);
        const plan: ExecutionPlan = {
          version: "1.0.0",
          id: planId,
          projectId: this.config.projectId,
          snapshotId: snapshot.id,
          policyHash: hash(this.config.policy),
          createdAt: now(),
          objective: input.objective,
          acceptance: input.acceptance,
          steps: validated,
          verification: structuredClone(this.config.verification),
          publication: this.config.policy.publication,
          ...(input.spec ? { spec: input.spec } : {}),
          cloudAuthored: input.cloudAuthored === true,
        };
        // Template steps run locally, so a cloud-backed client's plan of
        // template steps alone keeps the reviewer local too.
        if (input.cloudAuthored) {
          const side = await this.assertOneSideOfExport(plan);
          if (side) plan.exportSide = side;
        }
        this.store.savePlan(plan);
        return plan;
      }
    }
    const available = await this.availableWorkers();
    if (!available.length)
      throw new Error(
        await this.unavailableWorkersMessage(
          "No permitted worker is available.",
        ),
      );
    let provider = input.providerId
      ? available.find((p) => p.id === input.providerId)
      : available[0];
    if (!provider) {
      const reason = (await this.workerReasons()).find(
        (entry) => entry.id === input.providerId,
      )?.reason;
      throw new Error(
        `Selected worker ${input.providerId} is unavailable under project policy: ${reason ?? "it is not configured; add it with graph-engine provider-add"}`,
      );
    }
    const workerDecisionIds: string[] = [];
    if (!input.providerId) {
      const promotion = await loadPromotionAuthority(this.dataDir, {
        projectId: this.config.projectId,
        policyVersion: hash(this.config.policy),
      });
      const records = await decide({
        projectId: this.config.projectId,
        category: "worker",
        state: {
          objective: input.objective.slice(0, 800),
          languages: snapshot.languages,
          fileCount: snapshot.fileCount,
        },
        candidates: Object.fromEntries(
          available.map((p) => [p.id, `${p.kind} ${p.model}`]),
        ),
        baseline: provider.id,
        policy: this.config.policy,
        providers: await decisionProviders(this.dataDir),
        evidence: promotion.evidence,
        promotionBinding: promotion.binding,
        budget: this.decisionBudget(planId),
        cloudState: {
          fileCount: snapshot.fileCount,
          workerCount: available.length,
        },
        exportable: true,
      });
      records.forEach((record) => this.store.decision(record));
      workerDecisionIds.push(...records.map((record) => record.id));
      const selected = records.find(
        (r) => r.mode === "promoted" && r.selected,
      )?.selected;
      if (selected) provider = available.find((p) => p.id === selected)!;
    }
    assertProvider(provider, this.config.policy, input.effort);
    const routingPromotion = await loadPromotionAuthority(this.dataDir, {
      projectId: this.config.projectId,
      policyVersion: hash(this.config.policy),
    });
    const routing = await routePlan({
      projectId: this.config.projectId,
      objective: input.objective,
      provider,
      explicitEffort: input.effort,
      policy: this.config.policy,
      providers: await decisionProviders(this.dataDir),
      evidence: routingPromotion.evidence,
      promotionBinding: routingPromotion.binding,
      budget: this.decisionBudget(planId),
      cloudState: {
        fileCount: snapshot.fileCount,
        maxContextTokens: this.config.policy.maxContextTokens,
      },
    });
    routing.records.forEach((record) => this.store.decision(record));
    assertProvider(provider, this.config.policy, routing.effort);
    const plan: ExecutionPlan = {
      version: "1.0.0",
      id: planId,
      projectId: this.config.projectId,
      snapshotId: snapshot.id,
      policyHash: hash(this.config.policy),
      createdAt: now(),
      objective: input.objective,
      acceptance: input.acceptance,
      steps: await this.withTester(
        input.steps
          ? validateDag(input.steps).steps
          : [
              {
                id: "implement",
                kind: "worker",
                objective: `${input.objective}\n\nWorkflow: ${WORKFLOWS[routing.workflow]}`,
                dependsOn: [],
                providerId: provider.id,
                effort: routing.effort,
              },
            ],
        input.acceptance,
        input.spec,
      ),
      routing: {
        workflow: routing.workflow,
        contextBudgetTokens: routing.contextBudgetTokens,
        decisionIds: [
          ...workerDecisionIds,
          ...routing.records.map((record) => record.id),
        ],
      },
      verification: structuredClone(this.config.verification),
      publication: this.config.policy.publication,
      ...(input.spec ? { spec: input.spec } : {}),
      cloudAuthored: input.cloudAuthored === true,
    };
    for (const step of plan.steps) {
      if (step.kind === "worker") {
        const worker = available.find(
          (candidate) => candidate.id === step.providerId,
        );
        if (!worker)
          throw new Error(`Step ${step.id} uses an unavailable worker`);
        assertProvider(worker, this.config.policy, step.effort);
      } else if (!templateRuntimeCapability(step.templateId!).executable)
        throw new Error(`Template ${step.templateId} is not executable`);
    }
    if (input.cloudAuthored) {
      // Stored with the plan, so recovery keeps an escalating step there,
      // and start and resume refuse a role that has since moved sides.
      const side = await this.assertOneSideOfExport(plan);
      if (side) plan.exportSide = side;
    }
    this.store.savePlan(plan);
    return plan;
  }
  /**
   * Refuses a plan whose model roles straddle the export boundary. A local
   * worker, tester or template step may read files the export policy keeps from cloud
   * models and write them under exported paths, where a later cloud step or
   * a cloud reviewer receives them. Path filters cannot tell such a copy
   * from the project's own source, so a plan a cloud-backed client wrote
   * keeps every role on one side; a person's own plan may mix them.
   * Returns that side, or nothing when the plan runs no model or template.
   */
  private async assertOneSideOfExport(
    plan: ExecutionPlan,
  ): Promise<ExecutionPlan["exportSide"]> {
    // start() refuses a reviewer that is not configured.
    const roles = modelRoles(
      plan,
      await this.providers(),
      this.config.review?.providerId,
    );
    const local = roles.filter((entry) => entry.local);
    const remote = roles.filter((entry) => !entry.local);
    if (local.length && remote.length)
      throw new Error(
        `A cloud-backed client can create a plan only when its worker steps, the configured tester and the configured reviewer all run locally or all run on non-local providers, and template steps count as local: a local model or template may read files the export policy keeps from cloud models and write them where a cloud model receives them. This plan runs ${local.map((entry) => entry.role).join(", ")} locally and ${remote.map((entry) => entry.role).join(", ")} on non-local providers. Choose providers on one side, or have a person create the plan with graph-engine plan.`,
      );
    return local.length ? "local" : remote.length ? "non-local" : undefined;
  }
  /**
   * Refuses to run a cloud-backed client's plan once a model role it would
   * run with is on the other side of the export boundary from the plan. The
   * reviewer is read from the project when a run first executes, and steps
   * find their providers by ID, so a reviewer configured after planning, or
   * a planned provider ID redefined as another kind, would otherwise
   * straddle the boundary the plan was checked against. `reviewerId` is the
   * reviewer the run will use: the configured one for a new run, the one a
   * resumed run recorded. This is the early refusal: a run also checks each
   * provider when it reaches it (see assertOnPlanSide), since either can
   * change while the run is in progress. A plan stored before plans
   * recorded their author is refused while its roles straddle the
   * boundary, whoever wrote it.
   */
  private async assertPlanSide(
    plan: ExecutionPlan,
    reviewerId: string | undefined,
  ): Promise<void> {
    if (!plan.exportSide) {
      if (plan.cloudAuthored !== undefined) return;
      // A plan stored before plans recorded who wrote them may be a
      // cloud-backed client's that the one-side check at planning let
      // through: one of template steps alone got no side before template
      // steps counted as local. Its author cannot be told, so it runs
      // only while its roles are all on one side.
      const roles = modelRoles(plan, await this.providers(), reviewerId);
      const local = roles.filter((entry) => entry.local);
      const remote = roles.filter((entry) => !entry.local);
      if (local.length && remote.length)
        throw new Error(
          `This plan was stored before plans recorded whether a cloud-backed client wrote them, and it runs ${local.map((entry) => entry.role).join(", ")} locally and ${remote.map((entry) => entry.role).join(", ")} on non-local providers: a local model or template may read files the export policy keeps from cloud models and write them where a cloud model receives them. Create a fresh plan, which records its author, or configure providers on one side.`,
        );
      return;
    }
    const local = plan.exportSide === "local";
    const moved = modelRoles(plan, await this.providers(), reviewerId).filter(
      (entry) => entry.local !== local,
    );
    if (moved.length)
      throw new Error(
        movedRolesMessage(
          local,
          moved.map((entry) => entry.role),
        ),
      );
  }
  /**
   * The stored approval of exactly this plan content: the plan a run will
   * start with, or the one a run holds when it resumes. Undefined when the
   * plan has no approval, or its approval was given for other content.
   */
  private approvalOf(plan: ExecutionPlan): PlanApproval | undefined {
    const { approval } = this.store.planApproval(plan.id);
    return approval?.planSha256 === planSha256(plan) ? approval : undefined;
  }
  /**
   * Starts a run. A plan that publishes (commit or draft PR) needs a person's
   * approval first; the CLI's `run` counts as that person's approval and
   * records it, while MCP and dashboard API callers need `plan-approve`.
   * Under `policy.requirePlanApproval` every plan needs a stored approval of
   * its exact content, whoever starts it, and `approvedByPerson` does not
   * count. The approval a run starts under is recorded as its
   * `plan.approval_used` event.
   */
  async start(
    planId: string,
    options: { approvedByPerson?: boolean } = {},
  ): Promise<RunRecord> {
    await this.refresh();
    const plan = this.store.plan(planId);
    const policyChanged = plan.policyHash !== hash(this.config.policy);
    let approval: PlanApproval | undefined;
    if (this.config.policy.requirePlanApproval) {
      // A plan made under another policy can never start, so it is refused
      // as changed below rather than sent to a person for approval.
      if (!policyChanged) {
        approval = this.approvalOf(plan);
        if (!approval)
          throw new Error(
            `This project requires a person to approve every plan before a run of it starts (requirePlanApproval), and plan ${planId} ${this.store.planApproval(planId).approval ? "changed after it was approved" : "is not approved"}. A person reviews it with graph-engine plan-approve ${planId} and approves it with graph-engine plan-approve ${planId} --yes; graph-engine run does not count as approval here`,
          );
      }
    } else if (plan.publication !== "none") {
      // A stored approval of this exact plan is kept, so starting it from
      // the command line does not replace how a person approved it (in a
      // terminal, say) with how this command happened to run.
      if (options.approvedByPerson)
        approval = this.approvalOf(plan) ?? this.store.approvePlan(planId);
      else {
        approval = this.approvalOf(plan);
        if (!approval)
          throw new Error(
            `This plan publishes (${plan.publication}); a person must approve it first with graph-engine plan-approve ${planId} --yes`,
          );
      }
    }
    if (policyChanged)
      throw new Error("Policy changed since planning; create a new plan");
    if (this.active.size >= this.config.policy.maxWorkers)
      throw new Error("Project concurrency limit reached");
    this.assertPlanVerification(plan);
    if (!(await (this.deps.dockerAvailable ?? dockerAvailable)()))
      throw new Error("A running Docker-compatible engine is required");
    await this.assertSecurityScanner();
    const missingDatabase = await this.missingDependencyDatabase();
    if (this.config.review) await this.reviewer();
    // The run records the configured reviewer when it first executes.
    await this.assertPlanSide(plan, this.config.review?.providerId);
    const snapshot = await this.context.index({ semantic: false });
    if (snapshot.id !== plan.snapshotId)
      throw new Error("Source changed since planning; create a fresh plan");
    await this.assertCleanForPublication(plan.publication);
    await this.assertVerificationImages(plan, "start the run");
    // A run whose process died stops counting against the concurrency limit.
    await this.store.recoverInterrupted();
    this.assertOpen("started");
    const run: RunRecord = {
      id: id(),
      plan,
      status: "planned",
      createdAt: now(),
      updatedAt: now(),
      usage: this.store.usage(plan.id),
    };
    this.store.reserve(run, this.config.policy.maxWorkers);
    if (approval) this.recordApprovalUsed(run.id, approval);
    // Recorded before any worker is paid; `graph-engine run` prints it.
    if (missingDatabase)
      this.store.event(run.id, "security.database_missing", missingDatabase);
    this.launch(run);
    return this.store.run(run.id);
  }
  // Which approval authorized this start or resume, so `inspect` and
  // `run-receipt` show it: the content hash it binds, when it was given, and
  // whether its command ran in an interactive terminal (null for an approval
  // stored before that was recorded).
  private recordApprovalUsed(runId: string, approval: PlanApproval): void {
    this.store.event(runId, "plan.approval_used", {
      planSha256: approval.planSha256,
      approvedAt: approval.approvedAt,
      approvedVia: approval.approvedVia,
    });
  }
  // A run that publishes copies the checkout into its workspace and commits
  // every change there, so the checkout must be clean when the workspace is
  // created. The source snapshot cannot stand in for this: it leaves out
  // binary, large and credential-like files. Untracked files count whatever
  // status.showUntrackedFiles says, since the workspace copies them;
  // `normal` answers that as well as `all` while listing an untracked
  // directory as one line. Files Git skips checking for changes are refused,
  // since status cannot vouch for them and the workspace copies them too.
  private async assertCleanForPublication(
    publication: RunRecord["plan"]["publication"],
  ): Promise<void> {
    if (publication === "none") return;
    if (
      await checkedGit(this.root, [
        "status",
        "--porcelain",
        "--untracked-files=normal",
      ])
    )
      throw new Error(
        "Commit your existing changes before a run that publishes; unrelated local work must not enter its commit",
      );
    const hidden = await hiddenIndexEntries(this.root);
    // The message gives only the count: a cloud-backed MCP client can start
    // a run, and these may be files the export policy keeps from it. The CLI
    // and a local client also get the names.
    if (hidden.length)
      throw new LocalDetailError(
        `Git skips checking ${hidden.length === 1 ? "1 file" : `${hidden.length} files`} in this checkout for changes (assume-unchanged or skip-worktree; git ls-files -v tags them with a lowercase letter or S). Clear the marks with git update-index --no-assume-unchanged or --no-skip-worktree (core.ignoreStat=true sets them on checkout) before a run that publishes, so unrelated local work cannot enter its commit`,
        `Files Git skips checking: ${describeHiddenEntries(hidden)}`,
      );
  }
  // start and resume check the checkout is clean, but the run creates its
  // workspace later, copying whatever the checkout holds then. Local work
  // saved, or a commit made, in between would enter a publishing run's
  // commit without review, so the new workspace must be the planned commit
  // and nothing else. Checked before any decision or worker call. The
  // message names no file: a cloud-backed client can start a run. A refused
  // workspace and its branch are removed (no worker ran there and nothing
  // was committed), so a reconciled resume creates a clean one from the
  // checkout instead of adopting the stale copy or its later base commit.
  private async assertWorkspaceMatchesPlan(
    plan: ExecutionPlan,
    created: { workspace: string; branch: string; baseCommit: string },
  ): Promise<void> {
    if (plan.publication === "none") return;
    const planned = (await this.context.snapshotById(plan.snapshotId)).revision;
    // Content, not `git status`: with core.autocrlf the new worktree checks
    // files out with CRLF, and the copied LF bytes then read as modified
    // though they normalize to the committed blob (seen on Windows runners).
    if (
      !(planned && planned !== created.baseCommit) &&
      !(await checkedGit(created.workspace, ["diff", "HEAD", "--name-only"])) &&
      !(await checkedGit(created.workspace, [
        "ls-files",
        "--others",
        "--exclude-standard",
      ]))
    )
      return;
    const removed = await removeWorkspace(this.root, created).then(
      () => true,
      () => false,
    );
    // A plan starts only one run, so the way back is a reconciled resume
    // of this run, or a fresh plan.
    throw new Error(
      `The checkout changed after the run checked it was clean (a commit, or local work saved while its workspace was created), so its commit could include unreviewed work. Nothing was sent to a model${
        removed
          ? ", and the run's workspace was removed"
          : // Names no local path: a cloud-backed client can read it.
            `, but the run's workspace could not be removed; remove the worktree git worktree list shows on branch ${created.branch} (git worktree remove --force) and the branch (git branch -D ${created.branch}) before resuming`
      }. Remove the changes and resume the run with reconciliation acknowledged (--reconciled), or commit them and create a fresh plan`,
    );
  }
  // A cloud worker's proposal that changes a path the project does not
  // export to it is refused before any file it names is read: feedback the
  // first time in a row (returned here), and an error that stops the step
  // the second. Undefined for a proposal that may be prepared.
  private async unexportablePatch(
    workspace: string,
    proposal: WorkerProposal,
    provider: WorkerInput["provider"],
    inARow: number,
  ): Promise<string | undefined> {
    try {
      await assertExportablePatch(
        workspace,
        proposal,
        provider,
        this.config.policy,
      );
      return undefined;
    } catch (error) {
      if (!(error instanceof UnexportablePatchError) || inARow > 1) throw error;
      return unexportablePatchFeedback(error.paths);
    }
  }
  // start and resume call this after their last await. A close() that began
  // during their checks (a person's Ctrl-C, say) found no run to abort, so a
  // run launched now would execute on an engine whose stores are closing,
  // and be left running. Nothing between this check and launch() awaits, so
  // a later close() finds the run and cancels it. launch() carries no check
  // of its own: the run is reserved by then, and refusing it there would
  // leave it planned with no owner.
  private assertOpen(action: "started" | "resumed"): void {
    if (this.closing)
      throw new Error(`The engine is closing, so the run was not ${action}`);
  }
  private launch(run: RunRecord, resuming = false): void {
    const controller = new AbortController();
    const initialEvents = this.store.events(run.id).length;
    this.store.claim(run.id);
    const timer = setInterval(() => {
      if (
        this.store
          .events(run.id)
          .slice(initialEvents)
          .some((e) => e.type === "cancel.requested")
      )
        controller.abort();
    }, 500);
    const promise = this.execute(run, controller.signal, resuming).finally(
      () => {
        clearInterval(timer);
        this.active.delete(run.id);
      },
    );
    this.active.set(run.id, { controller, promise });
  }
  async wait(runId: string): Promise<RunRecord> {
    await this.active.get(runId)?.promise;
    return this.store.run(runId);
  }
  /**
   * Requests that an unfinished run stop. A run executing in this process
   * is aborted at once; one another process is executing stops when that
   * process reads the request. A run whose process died is recorded as
   * needing reconciliation instead, since nothing would read the request.
   */
  async cancel(runId: string): Promise<RunRecord> {
    const run = await this.recoverDeadOwner(runId);
    if (!unfinished(run.status))
      throw new Error(
        run.status === "needs_reconciliation"
          ? "Run is not active: it needs reconciliation. Inspect its workspace and events, then resume it with explicit reconciliation acknowledgement"
          : "Run is not active",
      );
    this.active.get(runId)?.controller.abort();
    this.store.event(runId, "cancel.requested", {});
    return this.store.run(runId);
  }
  /**
   * An engine recovers dead-owner runs when it opens; a long-lived one (the
   * dashboard or MCP server) checks again before it acts on a run another
   * process left unfinished, with the same owner proof. A run executing in
   * this process, or whose owner is alive or cannot be checked, is returned
   * as stored. Nothing awaits for a run executing in this process, so a
   * cancel reaches it at once.
   */
  private async recoverDeadOwner(runId: string): Promise<RunRecord> {
    const run = this.store.run(runId);
    if (this.active.has(runId) || !unfinished(run.status)) return run;
    await this.store.recoverInterrupted(runId);
    return this.store.run(runId);
  }
  // Checks run only in images already on this machine (see
  // verifyInContainer), which first looks after the worker and tester have
  // been paid. start and resume find a missing image after their cheaper
  // checks and before the run launches instead. Injected verification runs
  // no image.
  private async assertVerificationImages(
    plan: ExecutionPlan,
    then: string,
  ): Promise<void> {
    if (this.deps.verify) return;
    for (const image of new Set(
      plan.verification.map((check) => check.image),
    )) {
      const result = await command(
        "docker",
        ["image", "inspect", "--format", "{{.Id}}", image],
        { timeoutMs: 10000 },
      );
      if (
        result.code !== 0 ||
        !/^sha256:[a-f0-9]{64}$/.test(result.stdout.trim())
      )
        // The image name comes from the operator's configuration (a
        // private registry path, say), which a cloud-backed client that
        // can start a run otherwise never sees, so only the CLI and a
        // local client get it.
        throw new LocalDetailError(
          `A verification image one of the plan's checks runs in is not on this machine, so no check could run. Pull it with docker pull, or build it with docker build -t, then ${then}; the plan is still valid`,
          `Verification image ${image} is not on this machine: docker pull ${image}, or docker build -t ${image} <directory>`,
        );
    }
  }
  // A project with a committed security baseline scans every run; check the
  // scanner before any worker spend rather than after verification.
  private async assertSecurityScanner(checkout = this.root, revision = "HEAD") {
    if (
      !this.deps.securityScan &&
      (await readCommittedBaseline(checkout, revision))
    )
      await scannerImageId(SECURITY_SCAN_IMAGE);
  }
  /**
   * A warning when a run may stop at the security gate for want of a
   * downloaded OSV database: the project commits a baseline, has lockfiles
   * and has no database, so a run that changes a lockfile fails
   * unscanned after its checks pass. Only a warning: a run that changes no
   * lockfile passes the gate without one. The gate itself reports any error
   * reading the baseline.
   */
  private async missingDependencyDatabase(): Promise<
    { tool: string; lockfiles: string[]; message: string } | undefined
  > {
    try {
      if (!(await readCommittedBaseline(this.root))) return undefined;
      const names = new Set(LOCKFILES.map((name) => name.toLowerCase()));
      const lockfiles = (await gitFiles(this.root)).filter((file) =>
        names.has(path.posix.basename(file).toLowerCase()),
      );
      if (!lockfiles.length || (await osvDatabase(this.dataDir)))
        return undefined;
      return {
        tool: "osv-scanner",
        lockfiles: lockfiles.slice(0, 20),
        message: `This project gates runs on its committed security baseline, but no OSV vulnerability database has been downloaded for its lockfiles (${lockfiles.slice(0, 5).join(", ")}), so a run that changes one stops at the security gate after its checks pass. To scan them, ${OSV_DATABASE_ADVICE}. A run stopped there resumes with graph-engine resume <run-id> --reconciled once the database is downloaded.`,
      };
    } catch {
      return undefined;
    }
  }
  /** Whether a run is still executing in this process. */
  isActive(runId: string): boolean {
    return this.active.has(runId);
  }
  /**
   * Records a person's decision on a succeeded run's verified result. Only
   * a person may call this (the CLI or the local dashboard); it is never
   * offered to a connected AI client, which would be approving its own work.
   */
  async recordAcceptance(
    runId: string,
    decision: { accepted: boolean; note?: string },
  ): Promise<RunOutcome> {
    if (this.isActive(runId))
      throw new Error(
        "Only a succeeded run's result can be accepted or rejected",
      );
    const raw = decision.note?.trim();
    if (!decision.accepted && !raw)
      throw new Error("A rejection needs a note saying what is wrong");
    // Checked before anything is recorded, so a rejection is never stored
    // without the lesson it carries.
    if (raw && containsSecret(raw))
      throw new Error("The note contains a potential secret; rephrase it");
    const note = raw ? redact(raw) : undefined;
    const { run, outcome } = this.store.recordAcceptance(
      runId,
      decision.accepted ? "accepted" : "rejected",
      note,
    );
    // A rejection's reason may be a lesson for later work; it stays a
    // private proposal until a person accepts it as project memory.
    if (!decision.accepted && note)
      try {
        await this.context.createMemory({
          kind: "observation",
          text: `A person rejected the result of: ${run.plan.objective}. Run ${run.id}. Reason: ${note}`,
        });
      } catch (error) {
        this.store.event(runId, "memory.capture_failed", {
          error: errorMessage(error),
        });
      }
    return outcome;
  }
  /**
   * A person approves a run's change in place of the AI reviewer, as a
   * senior reviewer would. Only for a run that stopped at the review gate
   * after its required checks passed, and only for that exact snapshot: the
   * retained workspace must still match it. Resume the run to complete it;
   * its review is then recorded as approved by a person.
   */
  async approveReview(runId: string, note: string): Promise<void> {
    if (this.active.has(runId)) throw new Error("Run is active");
    const run = this.store.run(runId);
    const reason = note.trim();
    if (!reason) throw new Error("Say why you approve the change");
    if (containsSecret(reason))
      throw new Error("The note contains a potential secret; rephrase it");
    if (run.status !== "failed")
      throw new Error("Only a run that stopped at code review can be approved");
    await this.refresh();
    if (hash(this.config.policy) !== run.plan.policyHash)
      throw new Error(
        "Policy changed since this run was planned; a review approval could not be applied",
      );
    const events = this.store.events(runId);
    // The run's latest attempt must have stopped at review, on a snapshot
    // whose required checks passed; the project board offers this command
    // by the same test. An earlier attempt's review is not where a resume
    // that stopped before review again stopped.
    if (!this.runReviewerId(runId) || !stoppedAtReview(events))
      throw new Error("This run's latest attempt did not stop at code review");
    const snapshotHash = passedChecksSnapshot(events);
    if (snapshotHash === undefined)
      throw new Error(
        "The run's last required checks did not pass; a review cannot stand in for them",
      );
    if (
      !run.workspace ||
      (await workspaceFingerprint(run.workspace, this.config.policy)) !==
        snapshotHash
    )
      throw new Error(
        "The retained workspace no longer matches the snapshot whose checks passed",
      );
    this.store.event(runId, "review.person_approved", {
      snapshotHash,
      note: redact(reason),
    });
  }
  async resume(runId: string, reconciled = false): Promise<RunRecord> {
    if (this.active.has(runId)) throw new Error("Run is already active");
    const run = await this.recoverDeadOwner(runId);
    if (!["failed", "cancelled", "needs_reconciliation"].includes(run.status))
      throw new Error("Run does not need resumption");
    if (!reconciled)
      throw new Error(
        "Inspect the retained workspace and events, then resume with explicit reconciliation acknowledgement",
      );
    // Legacy aggregate usage is not a call ledger. Validate before any recovery
    // work can replace those counters or regain historical cost/turn headroom.
    this.store.assertResumeAccounting(runId);
    await this.refresh();
    if (hash(this.config.policy) !== run.plan.policyHash)
      throw new Error("Policy changed; create a fresh plan");
    // Under the policy the plan this run holds must still be approved as it
    // is: an approval removed, or replaced by one of other content, since
    // the run started does not let it go on.
    const approval = this.config.policy.requirePlanApproval
      ? this.approvalOf(run.plan)
      : undefined;
    if (this.config.policy.requirePlanApproval && !approval)
      throw new Error(
        `This project requires a person to approve every plan before a run of it starts or resumes (requirePlanApproval), and ${this.store.planApproval(run.plan.id).approval ? `the approval of plan ${run.plan.id} is for other content than the plan this run holds` : `plan ${run.plan.id} is not approved`}. A person reviews it with graph-engine plan-approve ${run.plan.id} and approves it with graph-engine plan-approve ${run.plan.id} --yes; only an approval of the exact plan this run holds counts`,
      );
    if (this.active.size >= this.config.policy.maxWorkers)
      throw new Error("Project concurrency limit reached");
    this.assertPlanVerification(run.plan);
    if (!(await (this.deps.dockerAvailable ?? dockerAvailable)()))
      throw new Error("A running Docker-compatible engine is required");
    await this.assertSecurityScanner(
      run.workspace ?? this.root,
      (run.workspace && run.baseCommit) || "HEAD",
    );
    const pinnedReviewer = this.runReviewerId(runId);
    if (pinnedReviewer) await this.reviewer(pinnedReviewer);
    await this.assertPlanSide(run.plan, pinnedReviewer);
    if (
      !run.workspace &&
      (await this.context.index({ semantic: false })).id !== run.plan.snapshotId
    )
      throw new Error(
        "Source changed before workspace creation; create a fresh plan",
      );
    // The resumed run creates its workspace from the checkout, as start does.
    if (!run.workspace)
      await this.assertCleanForPublication(run.plan.publication);
    await this.assertVerificationImages(
      run.plan,
      `resume it with graph-engine resume ${runId} --reconciled`,
    );
    // As in start, a run whose process died stops counting against the
    // concurrency limit.
    await this.store.recoverInterrupted();
    this.assertOpen("resumed");
    const reserved = this.store.reserveResume(
      runId,
      this.config.policy.maxWorkers,
    );
    this.store.event(runId, "recovery.acknowledged", {});
    if (approval) this.recordApprovalUsed(runId, approval);
    this.launch(reserved, true);
    return this.store.run(runId);
  }
  private async execute(
    run: RunRecord,
    signal: AbortSignal,
    resuming = false,
  ): Promise<void> {
    const save = (status: RunRecord["status"]) => {
      run.status = status;
      run.updatedAt = now();
      this.store.saveRun(run);
    };
    // Whether this attempt has started publishing and not finished. An
    // earlier attempt's unfinished publication was acknowledged on resume.
    let publishing = false;
    try {
      const priorEvents = this.store.events(run.id);
      delete run.error;
      // Checks, review and acceptance describe one attempt's result.
      delete run.completion;
      save("running");
      this.store.event(run.id, "run.started", { resuming });
      if (!run.workspace) {
        const created = await createWorkspace(
          this.root,
          this.dataDir,
          run.id,
          this.config.policy,
        );
        // Checked before the run records the workspace, so a refused run
        // has none and a reconciled resume checks the checkout again.
        await this.assertWorkspaceMatchesPlan(run.plan, created);
        Object.assign(run, created);
        save("running");
      } else if (!run.baseCommit) {
        run.baseCommit = await recoverBaseCommit(run.workspace, run.id);
        save("running");
      }
      const workspace = run.workspace!;
      // Reviews and gates compare against the commit the run started from;
      // the workspace HEAD moves once publication commits.
      const baseCommit = run.baseCommit!;
      const budgetTokens =
        run.plan.routing?.contextBudgetTokens ??
        Math.floor(this.config.policy.maxContextTokens * 0.7);
      const session = await this.decisionSession(
        run.plan.id,
        {
          objective: run.plan.objective.slice(0, 700),
          stepCount: run.plan.steps.length,
        },
        signal,
      );
      const withState = (state: Record<string, unknown>) => ({
        ...session,
        state,
        cloudState: cloudSignals(state),
      });
      const retrieval = await routeRetrieval({
        ...session,
        graphAvailable: true,
        semanticAvailable: true,
      });
      this.captureDecision(run, "retrieval", retrieval);
      const scope = await routeScopes({
        ...session,
        allowedTools: ["context.get", "symbols.search", "graph.neighbors"],
        focusedTools: ["context.get"],
        requiredTools: ["context.get"],
        requiredChecks: run.plan.verification.map((_, i) => String(i)),
        focusedChecks: [],
        availableChecks: run.plan.verification.map((_, i) => String(i)),
        securityReviewRequired: requiresSecurityReview(run.plan.objective),
        architectureReviewRequired: /\b(architecture|migration|schema)\b/i.test(
          run.plan.objective,
        ),
      });
      this.captureDecision(run, "scopes", scope);
      const toolEvidence: { symbols: string[]; edges: string[] } = {
        symbols: [],
        edges: [],
      };
      if (scope.tools.includes("symbols.search")) {
        const terms = [
          ...new Set(
            run.plan.objective.match(/[A-Za-z_][A-Za-z_0-9]{3,}/g) ?? [],
          ),
        ].slice(0, 4);
        for (const term of terms) {
          const symbols = (
            await this.context.searchSymbols(term, run.plan.snapshotId)
          ).slice(0, 4);
          toolEvidence.symbols.push(...symbols.map((symbol) => symbol.id));
          if (scope.tools.includes("graph.neighbors"))
            for (const symbol of symbols.slice(0, 2))
              toolEvidence.edges.push(
                ...(
                  await this.context.neighbors(
                    symbol.id,
                    run.plan.snapshotId,
                    1,
                  )
                )
                  .slice(0, 10)
                  .map((edge) => edge.id),
              );
        }
      }
      this.store.event(run.id, "context.tools_completed", {
        tools: scope.tools,
        evidence: toolEvidence,
        reviewRequired: scope.review,
      });
      const originalPacket = await this.context.getContext({
        query: run.plan.objective,
        snapshotId: run.plan.snapshotId,
        budgetTokens,
        mandatory: run.plan.acceptance,
        retrieval: retrieval.scope,
      });
      const selection = await selectContext({
        ...session,
        candidates: originalPacket.items.map((item) => ({
          id: item.id,
          kind:
            item.kind === "memory" ? ("memory" as const) : ("file" as const),
          label: item.source
            ? `${item.source.path}:${item.source.startLine}-${item.source.endLine}`
            : item.text.slice(0, 160),
          baselineInclude: true,
        })),
      });
      this.captureDecision(run, "context_selection", selection);
      originalPacket.items = originalPacket.items.filter((item) =>
        selection.selectedIds.includes(item.id),
      );
      const currentContext = async () => {
        const latest = new ContextEngine({
          projectId: this.config.projectId,
          root: workspace,
          dataDir: path.join(this.dataDir, "run-context", run.id),
          policy: this.config.policy,
        });
        try {
          await latest.index();
          const current = await latest.getContext({
            query: run.plan.objective,
            budgetTokens,
            mandatory: originalPacket.mandatory,
            retrieval: retrieval.scope,
          });
          // Provenance and export authorization come from the main context
          // database each time the run executes. Text that only the run
          // workspace's knowledge import adds (a stale or edited committed
          // file) stays mandatory for local workers but is recorded as
          // unreviewed, so cloud dispatch refuses the packet.
          const unreviewed = current.mandatory.filter(
            (text) => !originalPacket.mandatory.includes(text),
          );
          return {
            ...current,
            mandatorySources: [
              ...(originalPacket.mandatorySources ?? []),
              ...unreviewed.map((text) => ({
                text,
                visibility: "private" as const,
                sources: [],
                exportAuthorized: false,
              })),
            ],
          };
        } finally {
          await latest.close();
        }
      };
      const packet = resuming ? await currentContext() : originalPacket;
      // Which memories shaped this run's work, for its recorded outcome.
      this.store.event(run.id, "context.memories", {
        memoryIds: [
          ...new Set(
            [
              ...packet.items.map((item) => item.memoryId),
              ...(packet.mandatorySources ?? []).map((source) =>
                "memoryId" in source ? source.memoryId : undefined,
              ),
            ].filter((memoryId): memoryId is string => Boolean(memoryId)),
          ),
        ],
      });
      let feedback = "";
      let verified = false;
      let verifiedHash: string | undefined;
      // The snapshot the last verification in this execution checked.
      let checkedHash: string | undefined;
      let reviewFeedback = "";
      let reviewFeedbackExportable = false;
      // New security findings in a verified result go back to the worker as
      // feedback within the attempt budget, like a review's requested changes.
      let securityFeedback = "";
      let securityFeedbackExportable = false;
      let securityFindings = 0;
      let securityPassedHash: string | undefined;
      // The baseline of the commit this run started from; changing the
      // project checkout later cannot turn the gate off for this run.
      const securityBaseline = await readCommittedBaseline(
        workspace,
        baseCommit,
      );
      // Recorded when the run first executes, so changing the configuration
      // cannot add or remove the review gate for a run in progress, even
      // across a resume.
      const reviewerId = this.runReviewerId(run.id);
      if (
        !this.store
          .events(run.id)
          .some((event) => event.type === "review.configured")
      ) {
        // The configuration may have changed since start() or resume()
        // checked it; a reviewer on the other side of a cloud-backed
        // client's plan is never recorded as the run's.
        const reviewer = (await this.providers()).find(
          (provider) => provider.id === reviewerId,
        );
        if (reviewer)
          assertOnPlanSide(run.plan, reviewer, reviewerRole(reviewer.id));
        this.store.event(run.id, "review.configured", {
          providerId: reviewerId ?? null,
        });
      }
      // The DAG checkpoint this run last saved, the record of the files its
      // steps and repairs wrote (see checkpointPaths).
      let dagCheckpointPath: string | undefined;
      let dagCheckpoint: DagCheckpoint | undefined;
      const saveDagCheckpoint = async (value: DagCheckpoint) => {
        await writeJson(dagCheckpointPath!, value);
        dagCheckpoint = value;
      };
      const recordDagEvent = (event: DagEvent) => {
        this.store.event(run.id, event.type, event.data, event.stepId);
      };
      // Every file this run's workers wrote: patches, cached solutions and
      // the DAG's steps and repairs, including one an acknowledged resume
      // recorded as applied. A single-step or cached patch counts from the
      // moment it is recorded as applying, before its first write, so one
      // the process died during, or whose rollback failed, is still the
      // run's: each of its files still in the workspace (one it never
      // reached, or one the rollback removed, has nothing to review or
      // publish). A patch whose rollback restored the workspace wrote
      // nothing. The operator's own uncommitted files in the workspace are
      // not the worker's change.
      const runWrittenPaths = async () => {
        const events = this.store.events(run.id);
        const inventory = (event: RunEvent) => {
          const paths = event.data.paths;
          if (
            !Array.isArray(paths) ||
            paths.some((item) => typeof item !== "string")
          )
            throw new Error(
              "Retained patch lacks its verification path inventory; explicit source review is required before reuse",
            );
          return paths as string[];
        };
        const rolledBack = new Set(
          events
            .filter((event) => event.type === "patch.rolled_back")
            .map((event) => event.data.applying),
        );
        const inWorkspace = async (file: string) => {
          try {
            await stat(path.join(workspace, file));
            return true;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? "";
            if (["ENOENT", "ENOTDIR"].includes(code)) return false;
            throw error;
          }
        };
        const applying: string[] = [];
        for (const event of events)
          if (event.type === "patch.applying" && !rolledBack.has(event.id))
            for (const file of inventory(event))
              if (await inWorkspace(file)) applying.push(file);
        return [
          ...new Set([
            ...events
              .filter((event) =>
                [
                  "patch.applied",
                  "dag.step.completed",
                  "solution.cache_hit",
                ].includes(event.type),
              )
              .flatMap(inventory),
            ...applying,
            ...(dagCheckpoint ? checkpointPaths(dagCheckpoint) : []),
          ]),
        ];
      };
      const recordPatch = (stepId: string): PatchRecorder => ({
        applying: (paths) =>
          this.store.event(run.id, "patch.applying", { paths }, stepId),
        rolledBack: (applying, paths, error) => {
          this.store.event(
            run.id,
            "patch.rolled_back",
            { applying: applying.id, paths, error },
            stepId,
          );
        },
        writtenPaths: runWrittenPaths,
      });
      const reviewChange = async (
        stepId: string,
        checks: Awaited<ReturnType<typeof verifyInContainer>>,
        snapshotHash: string,
      ) => {
        // A person's approval of this exact verified snapshot stands in for
        // the AI reviewer, and is recorded as a person's, never as the AI's.
        const approval = this.store
          .events(run.id)
          .filter((event) => event.type === "review.person_approved")
          .at(-1);
        if (approval && approval.data.snapshotHash === snapshotHash) {
          this.store.event(
            run.id,
            "review.completed",
            {
              by: "person",
              passed: true,
              verdict: "approved-by-person",
              summary: String(approval.data.note ?? ""),
              note: "A person approved this snapshot in place of the reviewer; human acceptance is recorded separately.",
            },
            stepId,
          );
          return { passed: true, feedback: "", exportable: true };
        }
        const policy = this.config.policy;
        let reviewer: ProviderConfig;
        let diff: string;
        let exportable: boolean;
        try {
          reviewer = await this.reviewer(reviewerId);
          // Before the diff is built: the reviewer is found by ID here.
          assertOnPlanSide(run.plan, reviewer, reviewerRole(reviewer.id));
          // Only files this run's workers wrote.
          const written = (await runWrittenPaths()).sort();
          exportable = written.every((file) =>
            isAllowedPath(file, policy, true),
          );
          if (reviewer.kind !== "local" && !exportable) {
            // Nothing is sent, so no review started; the run still stopped
            // at code review after its checks passed, where a person can
            // review this snapshot in the reviewer's place.
            const reason =
              "the change touches paths a cloud reviewer may not receive";
            this.store.event(
              run.id,
              "review.blocked",
              { providerId: reviewer.id, reason },
              stepId,
            );
            throw new Error(reason);
          }
          // Diff raw bytes outside the repository: the original from the
          // object store with no conversion, the new file from disk. Neither
          // the change's .gitattributes (-diff, working-tree-encoding, ident,
          // eol) nor any diff driver or configuration can alter what the
          // reviewer sees.
          const scratch = await mkdtemp(
            path.join(os.tmpdir(), "graph-review-"),
          );
          const parts: string[] = [];
          try {
            // Empty stand-ins for Git configuration, attributes and absent
            // files: null device names differ across platforms.
            const empty = path.join(scratch, "empty");
            await writeFile(empty, "");
            await mkdir(path.join(scratch, "a"));
            await mkdir(path.join(scratch, "b"));
            for (const [index, file] of written.entries()) {
              const before = `a/${index}`;
              const after = `b/${index}`;
              const original = await gitBlob(workspace, baseCommit, file, {
                signal,
              });
              await writeFile(path.join(scratch, before), original ?? "");
              const current = await safePath(workspace, file, policy);
              const exists = await stat(current).then(
                () => true,
                () => false,
              );
              if (exists) await copyFile(current, path.join(scratch, after));
              else await writeFile(path.join(scratch, after), "");
              const result = await command(
                "git",
                [
                  "-c",
                  "core.attributesFile=empty",
                  "diff",
                  "--no-index",
                  "--no-ext-diff",
                  "--no-textconv",
                  "--text",
                  "--no-color",
                  `--src-prefix=a/${file}#`,
                  `--dst-prefix=b/${file}#`,
                  "--",
                  before,
                  after,
                ],
                {
                  cwd: scratch,
                  signal,
                  timeoutMs: 60000,
                  maxBytes: 20_000_000,
                  env: {
                    ...process.env,
                    GIT_CONFIG_NOSYSTEM: "1",
                    GIT_CONFIG_GLOBAL: empty,
                  },
                },
              );
              // --no-index exits 0 for identical files and 1 when they differ.
              if (result.code !== 0 && result.code !== 1)
                throw new Error(
                  `git could not show the change to ${file}: ${result.stderr.trim().slice(0, 500)}`,
                );
              const status =
                original === undefined
                  ? " (new file)"
                  : exists
                    ? ""
                    : " (deleted)";
              parts.push(`File ${file}${status}:\n${result.stdout}`);
            }
          } finally {
            await rm(scratch, { recursive: true, force: true });
          }
          diff = parts.join("\n");
        } catch (error) {
          if (signal.aborted) throw error;
          throw new Error(
            `Code review did not complete: ${redact(errorMessage(error))}`,
            { cause: error },
          );
        }
        this.store.event(
          run.id,
          "review.started",
          { providerId: reviewer.id },
          stepId,
        );
        let result: Awaited<ReturnType<typeof invokeReviewWorker>>;
        try {
          result = await this.invokeReviewer(
            {
              provider: reviewer,
              policy,
              objective: run.plan.objective,
              acceptance: run.plan.acceptance,
              diff,
              checks: checks
                .map((check) => `${check.argv.join(" ")}: exit ${check.code}`)
                .join("\n"),
              signal,
            },
            run.plan.id,
          );
        } catch (error) {
          if (signal.aborted) throw error;
          throw new Error(
            `Code review did not complete: ${redact(errorMessage(error))}`,
            { cause: error },
          );
        }
        run.usage = this.store.usage(run.plan.id);
        const outcome = reviewOutcome(result.review, run.plan.acceptance);
        this.store.event(
          run.id,
          "review.completed",
          {
            providerId: reviewer.id,
            model: result.model,
            passed: outcome.passed,
            verdict: result.review.verdict,
            summary: redact(result.review.summary),
            criteria: result.review.criteria.map((criterion) => ({
              met: criterion.met,
              evidence: redact(criterion.evidence),
            })),
            findings: result.review.findings.map((finding) => ({
              ...finding,
              message: redact(finding.message),
            })),
            note: "A reviewer can hold a change back but not accept it; human acceptance stays pending.",
          },
          stepId,
        );
        return {
          ...outcome,
          exportable: exportable && !containsSecret(outcome.feedback),
        };
      };
      // Scans the verified workspace against the committed baseline. An
      // incomplete scan, or a worker-written file no scanner could read,
      // stops the run; new findings are returned for the next attempt.
      const securityGate = async (): Promise<{
        passed: boolean;
        count: number;
        feedback: string;
        exportable: boolean;
      }> => {
        this.store.event(run.id, "security.scan_started", {
          snapshotHash: verifiedHash,
        });
        const database = await osvDatabase(this.dataDir);
        const scan = await (
          this.deps.securityScan ??
          ((options) =>
            runSecurityScan({
              ...options,
              image: SECURITY_SCAN_IMAGE,
              timeoutMs: this.config.policy.timeoutSeconds * 1000,
              ...(database ? { osvDatabase: database.path } : {}),
            }))
        )({
          root: workspace,
          profile: {
            files: await gitFiles(workspace),
            // Named for the tool selection only: live-target tools are never
            // runnable here, so a managed run never scans a live target.
            authorizedTargets: (this.config.security?.liveTargets ?? []).map(
              (target) => target.id,
            ),
            configuredTools: [],
            databases: database ? ["osv-scanner"] : [],
          },
          signal,
        });
        // A file this run's workers wrote that no scanner could read (for
        // example one made "binary" by a NUL byte) is not accepted unseen.
        const workerPaths = new Set(await runWrittenPaths());
        // Dependency scanning reads a downloaded database. Without one, a
        // run that changed a lockfile is not passed unscanned, and a skipped
        // dependency scan is always recorded.
        // Case-insensitive on both sides: Cargo.lock, Gemfile.lock and
        // Pipfile.lock are capitalized on disk.
        const lockfileNames = new Set(
          LOCKFILES.map((name) => name.toLowerCase()),
        );
        const lockfiles = (await gitFiles(workspace)).filter((file) =>
          lockfileNames.has(path.posix.basename(file).toLowerCase()),
        );
        if (!database && lockfiles.length) {
          const changed = lockfiles.filter((file) => workerPaths.has(file));
          this.store.event(run.id, "security.tool_not_run", {
            tool: "osv-scanner",
            reason: `no downloaded OSV database; ${OSV_DATABASE_ADVICE}`,
            lockfiles: lockfiles.slice(0, 20),
          });
          // The download needs a policy change, and a changed policy voids
          // this run: say how to keep it rather than plan and pay again.
          if (changed.length)
            throw new Error(
              `This run changed ${changed.slice(0, 5).join(", ")}, but no OSV vulnerability database has been downloaded, so its dependencies were not scanned. To keep this run, ${OSV_DATABASE_ADVICE}. Then resume it with graph-engine resume ${run.id} --reconciled; planning it again would pay for its work again`,
            );
        }
        const unreviewed = newFindings(scan, securityBaseline!);
        // A newly published advisory about a dependency the run did not
        // touch is not this change's doing: it is recorded, not gated.
        const fresh = unreviewed.filter(
          (finding) =>
            finding.tool !== "osv-scanner" || workerPaths.has(finding.path),
        );
        const advisory = unreviewed.filter(
          (finding) => !fresh.includes(finding),
        );
        this.store.event(run.id, "security.scan_completed", {
          tools: scan.tools,
          findings: scan.findings.length,
          new: fresh
            .slice(0, 200)
            .map(({ tool, rule, path, line, message }) => ({
              tool,
              rule,
              path,
              line,
              message: redact(message),
            })),
          errors: scan.errors.map(redact),
          unscanned: scan.unscanned,
          ...(advisory.length
            ? {
                advisory: advisory
                  .slice(0, 200)
                  .map(({ tool, rule, path, message }) => ({
                    tool,
                    rule,
                    path,
                    message: redact(message),
                  })),
              }
            : {}),
        });
        if (scan.errors.length)
          throw new Error(
            `Security scan was incomplete, so the result cannot be accepted: ${redact(scan.errors.join("; "))}`,
          );
        const unscannedChanges = scan.unscanned.filter(({ path }) =>
          workerPaths.has(path),
        );
        if (unscannedChanges.length)
          throw new Error(
            `Security scan could not read ${unscannedChanges.length} file(s) this run wrote (${unscannedChanges
              .slice(0, 5)
              .map(({ path, reason }) => `${path}: ${reason}`)
              .join("; ")}); a person must review them`,
          );
        if (!fresh.length) {
          securityPassedHash = verifiedHash;
          this.store.event(run.id, "security.gate_passed", {
            snapshotHash: verifiedHash,
          });
          return { passed: true, count: 0, feedback: "", exportable: true };
        }
        return {
          passed: false,
          count: fresh.length,
          feedback: [
            `The security scan found ${fresh.length} finding(s) that are not in the project's reviewed baseline. Fix each one without weakening checks or adding suppressions:`,
            ...fresh
              .slice(0, 20)
              .map(
                ({ tool, rule, path, line, message }) =>
                  `- ${path}${line ? `:${line}` : ""} [${tool} ${rule}] ${redact(message).slice(0, 300)}`,
              ),
          ].join("\n"),
          exportable: fresh.every((finding) =>
            isAllowedPath(finding.path, this.config.policy, true),
          ),
        };
      };
      // Files the plan's tester step wrote in this run. Its checkpoint
      // completion counts even without an event, as for runWrittenPaths.
      const testerWrittenFiles = () => [
        ...new Set([
          ...this.store
            .events(run.id)
            .filter(
              (event) =>
                event.type === "dag.step.completed" &&
                event.stepId === TESTER_STEP_ID,
            )
            .flatMap((event) =>
              Array.isArray(event.data.paths)
                ? (event.data.paths as string[])
                : [],
            ),
          ...(dagCheckpoint?.completed.find(
            (item) => item.id === TESTER_STEP_ID,
          )?.paths ?? []),
        ]),
      ];
      // Why a worker's proposal went back to it, for people reading the
      // run's events: a reason code, never the proposal.
      const returned = (stepId: string, reason: string) =>
        this.store.event(run.id, "proposal.returned", { reason }, stepId);
      let repairedByTester = false;
      // The exact files a tester repair may change. Membership, never
      // globs: a path such as app/[id]/page.test.tsx is not a pattern.
      let testerRepairFiles: string[] | undefined;
      let implementerRepair: ExecutionStep | undefined;
      let testerRepairPlan: ExecutionStep | undefined;
      // Why the implementer believes a tester's test is wrong, when it
      // proposed no change; the tester answers it on the next attempt.
      let implementerDispute: string | undefined;
      let unresolvedDispute: string | undefined;
      const verify = async (stepId: string) => {
        if (signal.aborted) throw new Error("Run cancelled");
        save("verifying");
        const proposedPaths = await runWrittenPaths();
        await assertVerificationPaths(
          workspace,
          proposedPaths,
          this.config.policy,
        );
        const before = await workspaceFingerprint(
          workspace,
          this.config.policy,
        );
        this.store.event(
          run.id,
          "verification.started",
          { snapshotHash: before },
          stepId,
        );
        const checks = await (this.deps.verify ?? verifyInContainer)(
          workspace,
          run.plan.verification,
          this.config.policy,
          before,
          signal,
        );
        const after = await workspaceFingerprint(workspace, this.config.policy);
        this.store.event(
          run.id,
          "verification.completed",
          {
            checks: checks.map((c) => ({
              ...c,
              stdout: redact(c.stdout).slice(-16000),
              stderr: redact(c.stderr).slice(-16000),
            })),
            snapshotHash: after,
          },
          stepId,
        );
        if (before !== after)
          throw new Error(
            "Verification modified project source; review the retained workspace before retrying",
          );
        checkedHash = after;
        const infrastructureFailure = checks.find(
          (check) =>
            check.code === 125 ||
            (check.code === 78 &&
              check.stderr.startsWith("[graph-verifier:setup-failed]")),
        );
        if (infrastructureFailure) {
          this.store.event(
            run.id,
            "verification.infrastructure_blocked",
            { code: infrastructureFailure.code, snapshotHash: after },
            stepId,
          );
          throw new Error(
            "Verification infrastructure failed. Inspect and repair the verifier, then explicitly reconcile and resume the retained patch. No model retry was attempted.",
          );
        }
        verified =
          checks.length === run.plan.verification.length &&
          checks.every((c) => c.code === 0);
        verifiedHash = verified ? after : undefined;
        feedback = compactFailures(checks);
        // Checks passing is not enough when the project has a reviewer: the
        // reviewer must approve, or its findings become the next attempt's
        // feedback. It can only hold a change back, never accept one.
        // Stale review feedback must not describe a later check failure.
        reviewFeedback = "";
        if (verified && reviewerId) {
          const outcome = await reviewChange(stepId, checks, after);
          reviewFeedback = outcome.passed ? "" : outcome.feedback;
          reviewFeedbackExportable = outcome.exportable;
          if (!outcome.passed) {
            verified = false;
            verifiedHash = undefined;
          }
        }
        securityFeedback = "";
        if (verified && securityBaseline) {
          const outcome = await securityGate();
          if (!outcome.passed) {
            securityFeedback = outcome.feedback;
            securityFeedbackExportable = outcome.exportable;
            securityFindings = outcome.count;
            verified = false;
            verifiedHash = undefined;
          }
        }
        return verified;
      };
      let singleSteps: ExecutionStep[] = run.plan.steps;
      let firstAttempt = 1;
      if (
        run.plan.steps.length > 1 ||
        run.plan.steps.some((step) => step.kind === "template")
      ) {
        const checkpointPath = path.join(
          this.dataDir,
          "checkpoints",
          `${run.id}.json`,
        );
        dagCheckpointPath = checkpointPath;
        let checkpoint: DagCheckpoint | undefined;
        if (resuming) {
          try {
            checkpoint = await readJson(checkpointPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        // Only the explicit installed-worker override needs this extra
        // binding. Keep default dispatch behavior unchanged. A provider kind
        // changed before generation may not reuse another kind's envelope.
        const workerKinds =
          this.config.policy.installedWorkerTimeoutSeconds === undefined
            ? undefined
            : new Map(
                (await this.providers()).map((provider) => [
                  provider.id,
                  provider.kind,
                ]),
              );
        await runDag({
          steps: run.plan.steps,
          workspace,
          policy: this.config.policy,
          signal,
          checkpoint,
          workerProviderKind: workerKinds
            ? (step) => workerKinds.get(step.providerId!)
            : undefined,
          // resume() refuses without the operator's reconciliation
          // acknowledgement, so a resumed run may resolve a pending patch.
          reconcilePending: resuming,
          // Strict paid reservations are cross-process; each DAG stays within
          // the configured bound, and small repositories use at most two.
          maxParallel: dagParallelism(
            (await this.context.snapshotById(run.plan.snapshotId)).fileCount,
            this.config.policy,
          ),
          saveCheckpoint: saveDagCheckpoint,
          beforeApply: async () => {
            await this.refresh();
            if (hash(this.config.policy) !== run.plan.policyHash)
              throw new Error("Policy changed before DAG patch application");
          },
          onEvent: recordDagEvent,
          generate: async (step, state) => {
            await this.refresh();
            if (hash(this.config.policy) !== run.plan.policyHash)
              throw new Error("Policy changed during DAG execution");
            if (step.kind === "template") {
              const { targetDirectory, ...inputs } = step.inputs ?? {};
              if (
                targetDirectory !== undefined &&
                typeof targetDirectory !== "string"
              )
                throw new Error("Template targetDirectory must be a string");
              return untilAborted(
                renderTemplateProposal({
                  templateId: step.templateId!,
                  instanceId: step.id,
                  inputs,
                  targetDirectory,
                  workspace,
                  policy: this.config.policy,
                }),
                state.signal,
              );
            }
            const provider = (await this.providers()).find(
              (provider) => provider.id === step.providerId,
            );
            if (!provider)
              throw new Error("DAG worker is no longer configured");
            if (workerKinds && provider.kind !== state.workerProviderKind)
              throw new Error(
                "DAG worker kind changed after its deadline was selected; create a new plan",
              );
            assertOnPlanSide(
              run.plan,
              provider,
              stepRole(step.id, provider.id),
            );
            let stepPacket: ContextPacket = await currentContext();
            const supplied = new SuppliedLines();
            const shown = new SuppliedLines();
            let patchFeedback = "";
            let repeatedRequests = 0;
            let unexportablePatches = 0;
            // Tests the tester wrote earlier in this plan, which implementing
            // steps must make pass and may not change.
            const testsWritten =
              step.id === TESTER_STEP_ID ? [] : testerWrittenFiles();
            // A cloud worker is told only of the tests it may request: the
            // others' names were chosen by a tester that may have seen
            // private context, and requesting them is refused.
            const testsListed =
              provider.kind === "local"
                ? testsWritten
                : testsWritten.filter((file) =>
                    isAllowedPath(file, this.config.policy, true),
                  );
            for (let turn = 0; turn < this.config.policy.maxTurns; turn++) {
              await this.refresh();
              if (hash(this.config.policy) !== run.plan.policyHash)
                throw new Error("Policy changed during DAG execution");
              const stepInput: WorkerInput = {
                provider,
                policy: this.config.policy,
                context: stepPacket,
                objective: testsListed.length
                  ? `${step.objective}\n\nThe tester has written tests for the acceptance criteria in ${testsListed.join(", ")}. Request them, and make them pass without changing them.`
                  : step.objective,
                acceptance: run.plan.acceptance,
                effort: step.effort,
                ...(patchFeedback ? { feedback: patchFeedback } : {}),
                signal: state.signal,
              };
              recordShown(shown, fitWorkerContext(stepInput).context);
              const result = await this.invokeWorker(
                stepInput,
                workspace,
                run.plan.id,
              );
              run.usage = this.store.usage(run.plan.id);
              save("running");
              this.store.event(
                run.id,
                "worker.completed",
                { model: result.model, usage: result.usage },
                step.id,
              );
              await this.refresh();
              if (hash(this.config.policy) !== run.plan.policyHash)
                throw new Error("Policy changed before DAG patch application");
              if (result.proposal.requests.length) {
                try {
                  stepPacket = await requestedSourcePacket({
                    workspace,
                    input: stepInput,
                    requests: result.proposal.requests,
                    snapshotId: stepPacket.snapshotId,
                    supplied,
                    worker: "DAG worker",
                    routedBudget: run.plan.routing?.contextBudgetTokens,
                  });
                  patchFeedback = "";
                  repeatedRequests = 0;
                  unexportablePatches = 0;
                  continue;
                } catch (error) {
                  // A repeated or unexportable request with changes is a
                  // proposal; a bare one is told so once before it stops the
                  // step.
                  const refused = refusedRequest(error);
                  if (!refused) throw error;
                  if (!result.proposal.changes.length) {
                    if (++repeatedRequests > 1) throw error;
                    returned(step.id, refused.reason);
                    patchFeedback = refused.feedback;
                    continue;
                  }
                }
              }
              {
                // Before anything reads the files it names (below, or
                // prepareProposal): see assertExportablePatch.
                const unexportable = await this.unexportablePatch(
                  workspace,
                  result.proposal,
                  provider,
                  ++unexportablePatches,
                );
                if (unexportable) {
                  returned(step.id, "not-exportable");
                  patchFeedback = unexportable;
                  continue;
                }
                unexportablePatches = 0;
                const unseen = await unseenPatchLocation(
                  workspace,
                  result.proposal,
                  shown,
                  supplied.partial,
                  this.config.policy,
                );
                // A step limited to some files (a tester writes only tests)
                // gets its out-of-scope edits back as feedback.
                const outside = outsideWriteScope(step, result.proposal);
                if (outside.length) {
                  returned(step.id, "outside-write-scope");
                  patchFeedback = writeScopeFeedback(step, outside);
                  continue;
                }
                const testerFeedback = testFirstFeedback(
                  step,
                  result.proposal,
                  testsWritten,
                );
                if (testerFeedback) {
                  returned(step.id, "test-first");
                  patchFeedback = testerFeedback;
                  continue;
                }
                if (!unseen) {
                  // A patch that cannot apply goes back to the worker, as in
                  // single-step runs, instead of failing the whole plan.
                  try {
                    await prepareProposal(
                      workspace,
                      result.proposal,
                      this.config.policy,
                    );
                  } catch (error) {
                    const returnedPatch = patchErrorFeedback(
                      errorMessage(error),
                      step.id,
                    );
                    if (!returnedPatch) throw error;
                    returned(step.id, returnedPatch.reason);
                    patchFeedback = patchFeedbackFor(
                      returnedPatch.feedback,
                      result.proposal,
                      provider,
                      this.config.policy,
                    );
                    continue;
                  }
                  return result;
                }
                returned(step.id, "unseen-or-ambiguous-edit");
                patchFeedback = patchFeedbackFor(
                  unseen,
                  result.proposal,
                  provider,
                  this.config.policy,
                );
                continue;
              }
            }
            throw new Error(
              "DAG worker exhausted its context-request turn budget",
            );
          },
        });
        if (await verify("dag")) singleSteps = [];
        else {
          // Iterate like a single-step run: a repair worker gets the combined
          // result and the failure feedback, within the remaining attempts.
          const worker = run.plan.steps.find(
            (step) =>
              step.kind === "worker" &&
              step.providerId &&
              step.id !== TESTER_STEP_ID,
          );
          if (!worker || this.config.policy.maxAttempts < 2)
            throw new Error(
              securityFeedback
                ? `Security scan found ${securityFindings} finding(s) not in the reviewed baseline in the combined result; inspect them and create a repair plan`
                : reviewFeedback
                  ? "Code review requested changes on the combined result; inspect the review and create a repair plan"
                  : "DAG checks failed; inspect retained per-step evidence and create a repair plan",
            );
          // The implementer repairs first: the tester's tests are the
          // criteria. If it disputes one of those tests by proposing no
          // change, the next attempt goes to the tester (see below).
          testerRepairPlan = run.plan.steps.find(
            (step) => step.id === TESTER_STEP_ID,
          );
          repairedByTester = false;
          implementerRepair = {
            id: DAG_REPAIR_STEP,
            kind: "worker",
            objective: [
              "Repair the combined result of this plan so every required check passes, keeping the work its steps completed.",
              "First decide from the failure whether the code or a test is wrong: fix the code when it misses an acceptance criterion; fix a test's expectation only when the test is wrong and the tester did not write it.",
              ...(testerRepairPlan
                ? [
                    "If a test the tester wrote is itself wrong, propose no changes and explain exactly why in your summary; the tester will review it.",
                  ]
                : []),
              `The plan's objective: ${run.plan.objective}`,
            ].join(" "),
            dependsOn: [],
            providerId: worker.providerId,
            ...(worker.effort ? { effort: worker.effort } : {}),
            // Repair keeps the selected implementer's authority, including
            // exclusions; it does not inherit other steps' write scopes.
            ...(worker.writes ? { writes: [...worker.writes] } : {}),
          };
          singleSteps = [{ ...implementerRepair }];
          firstAttempt = 2;
          this.store.event(
            run.id,
            "dag.repair_started",
            { providerId: singleSteps[0]!.providerId },
            DAG_REPAIR_STEP,
          );
        }
      }
      for (const step of singleSteps) {
        verified = false;
        // An acknowledged recovery checks the retained patch first. It never
        // reapplies the original exact-substring patch to an already edited file.
        if (
          resuming &&
          priorEvents.some(
            (event) =>
              event.type === "publication.started" ||
              ((event.type === "patch.applied" ||
                event.type === "solution.cache_hit") &&
                event.stepId === step.id),
          )
        ) {
          // A resumed plan reaches its repair only after verify("dag") found
          // the unchanged workspace wanting; checking the retained repair
          // again would repeat the checks and a paid review of that snapshot.
          const justChecked =
            step.id === DAG_REPAIR_STEP &&
            checkedHash !== undefined &&
            checkedHash ===
              (await workspaceFingerprint(workspace, this.config.policy));
          if (!justChecked && (await verify(step.id))) {
            this.store.event(run.id, "step.reconciled", {}, step.id);
            continue;
          }
        }
        let provider = (await this.providers()).find(
          (p) => p.id === step.providerId,
        );
        if (!provider)
          throw new Error("The planned provider is no longer configured");
        let stepPacket: ContextPacket =
          step.id === DAG_REPAIR_STEP ? await currentContext() : packet;
        const solutionInput = {
          key: `worker:${hash({ objective: step.objective, acceptance: run.plan.acceptance })}`,
          inputs: {
            provider: provider.id,
            model: provider.model,
            verification: run.plan.verification,
            policy: run.plan.policyHash,
            // A solution verified under a wider scope is not reused here.
            writes: step.writes ?? null,
          },
          snapshotId: run.plan.snapshotId,
        };
        const stored =
          resuming || step.id === DAG_REPAIR_STEP
            ? null
            : await this.context.getSolution(solutionInput);
        const storedProposal = stored
          ? proposalSchema.parse(JSON.parse(stored.value))
          : undefined;
        // The write scope applies to a cached proposal as to a worker's.
        const cached =
          storedProposal && !outsideWriteScope(step, storedProposal).length
            ? storedProposal
            : undefined;
        let reusableProposal: WorkerResult["proposal"] | undefined;
        if (cached) {
          const proposal = cached;
          await applyWholePatch(
            workspace,
            proposal,
            this.config.policy,
            recordPatch(step.id),
          );
          this.store.event(
            run.id,
            "solution.cache_hit",
            {
              key: solutionInput.key,
              paths: proposal.changes.map((change) => change.path),
            },
            step.id,
          );
          if (await verify(step.id)) continue;
          stepPacket = await currentContext();
        }
        for (
          let attempt = firstAttempt;
          attempt <= this.config.policy.maxAttempts;
          attempt++
        ) {
          if (signal.aborted) throw new Error("Run cancelled");
          await this.refresh();
          if (hash(this.config.policy) !== run.plan.policyHash)
            throw new Error(
              "Policy changed during execution; dispatch stopped",
            );
          // The tester gets one attempt at its own tests; if the checks
          // still fail, the implementer repairs the code.
          if (
            step.id === DAG_REPAIR_STEP &&
            repairedByTester &&
            attempt > firstAttempt &&
            implementerRepair
          ) {
            repairedByTester = false;
            testerRepairFiles = undefined;
            delete step.writes;
            Object.assign(step, implementerRepair);
            const implementer = (await this.providers()).find(
              (candidate) => candidate.id === step.providerId,
            );
            if (!implementer)
              throw new Error("The planned provider is no longer configured");
            provider = implementer;
            this.store.event(
              run.id,
              "dag.repair_handoff",
              { providerId: provider.id, role: "implementer" },
              step.id,
            );
          } else if (
            step.id === DAG_REPAIR_STEP &&
            !repairedByTester &&
            implementerDispute !== undefined &&
            testerRepairPlan &&
            attempt > firstAttempt
          ) {
            const own = testerWrittenFiles();
            const tester = (await this.providers()).find(
              (candidate) => candidate.id === testerRepairPlan!.providerId,
            );
            if (own.length && tester) {
              repairedByTester = true;
              // Only the files the tester wrote, never other tests.
              testerRepairFiles = own;
              delete step.writes;
              Object.assign(step, {
                providerId: tester.id,
                objective: [
                  `Act as the team's tester. The implementer believes a test you wrote (${own.join(", ")}) is wrong${
                    tester.kind === "local"
                      ? `: "${implementerDispute}"`
                      : "; recheck every expectation you wrote"
                  }.`,
                  "Check the expectations against the acceptance criteria and fix any that are wrong, keeping a test that proves every criterion. Change only those files; if your tests are right, propose no changes and explain why.",
                  `The plan's objective: ${run.plan.objective}`,
                ].join(" "),
              });
              delete step.effort;
              provider = tester;
              this.store.event(
                run.id,
                "dag.repair_handoff",
                { providerId: provider.id, role: "tester" },
                step.id,
              );
            }
            implementerDispute = undefined;
          }
          assertProvider(provider, this.config.policy, step.effort);
          // Before every attempt's dispatch, after the step's provider was
          // found by ID, a repair handed to the implementer or tester, or an
          // escalation: any of them may have been redefined since start().
          assertOnPlanSide(
            run.plan,
            provider,
            repairedByTester
              ? `the tester (${provider.id})`
              : stepRole(step.id, provider.id),
          );
          save("running");
          this.store.event(
            run.id,
            "attempt.started",
            { attempt, providerId: provider.id },
            step.id,
          );
          let proposalApplied = false;
          const supplied = new SuppliedLines();
          const shown = new SuppliedLines();
          let patchFeedback = "";
          let repeatedRequests = 0;
          let unexportablePatches = 0;
          for (let turn = 0; turn < this.config.policy.maxTurns; turn++) {
            await this.refresh();
            if (hash(this.config.policy) !== run.plan.policyHash)
              throw new Error("Policy changed during execution");
            const estimate = estimateRequestCost(
              provider,
              this.config.policy.maxContextTokens,
              this.config.policy.maxOutputTokens,
            );
            if (
              this.config.policy.maxCostUsd !== null &&
              (estimate === null ||
                run.usage.costUsd === null ||
                run.usage.costUsd + estimate > this.config.policy.maxCostUsd)
            )
              throw new Error(
                "The next call exceeds the configured estimated cost budget",
              );
            const dispatched = {
              provider: provider.id,
              model: provider.model,
              effort: step.effort ?? null,
              attempt,
              turn,
              contextItems: stepPacket.items.length,
            };
            // Test logs may quote private source even when they contain no key-like
            // strings. They stay local; remote workers get only a generic failure.
            const workerFeedback = [
              provider.kind === "local"
                ? feedback
                : feedback
                  ? "Required verification failed. Request explicitly exportable source to investigate."
                  : "",
              patchFeedback,
              reviewFeedback &&
                (provider.kind === "local" || reviewFeedbackExportable
                  ? reviewFeedback
                  : "Code review requested changes. Request the exportable source you need and address them."),
              securityFeedback &&
                (provider.kind === "local" || securityFeedbackExportable
                  ? securityFeedback
                  : "The security scan found new findings in files you may not receive. Request the exportable source you need and fix them."),
            ]
              .filter(Boolean)
              .join("\n\n");
            const input: WorkerInput = {
              provider,
              policy: this.config.policy,
              context: stepPacket,
              objective: step.objective,
              acceptance: run.plan.acceptance,
              effort: step.effort,
              feedback: workerFeedback,
              signal,
            };
            recordShown(shown, fitWorkerContext(input).context);
            const result = await this.invokeWorker(
              input,
              workspace,
              run.plan.id,
              () =>
                this.store.event(
                  run.id,
                  "worker.dispatched",
                  dispatched,
                  step.id,
                ),
            );
            run.usage = this.store.usage(run.plan.id);
            save("running");
            this.store.event(
              run.id,
              "worker.completed",
              {
                usage: result.usage,
                model: result.model,
                summary: result.proposal.summary,
              },
              step.id,
            );
            if (signal.aborted) throw new Error("Run cancelled");
            await this.refresh();
            if (hash(this.config.policy) !== run.plan.policyHash)
              throw new Error("Policy changed before patch application");
            if (result.proposal.requests.length) {
              try {
                stepPacket = await requestedSourcePacket({
                  workspace,
                  input,
                  requests: result.proposal.requests,
                  snapshotId: run.plan.snapshotId,
                  supplied,
                  worker: "Worker",
                  routedBudget: run.plan.routing?.contextBudgetTokens,
                });
                patchFeedback = "";
                repeatedRequests = 0;
                unexportablePatches = 0;
                continue;
              } catch (error) {
                const refused = refusedRequest(error);
                if (!refused) throw error;
                if (!result.proposal.changes.length) {
                  if (++repeatedRequests > 1) throw error;
                  returned(step.id, refused.reason);
                  patchFeedback = refused.feedback;
                  continue;
                }
              }
            }
            // Before anything reads the files it names (below, or when the
            // patch is prepared): see assertExportablePatch.
            const unexportable = await this.unexportablePatch(
              workspace,
              result.proposal,
              provider,
              ++unexportablePatches,
            );
            if (unexportable) {
              returned(step.id, "not-exportable");
              patchFeedback = unexportable;
              continue;
            }
            unexportablePatches = 0;
            const unseen = await unseenPatchLocation(
              workspace,
              result.proposal,
              shown,
              supplied.partial,
              this.config.policy,
            );
            // A step limited to some files never applies an edit outside them.
            const exact =
              repairedByTester && testerRepairFiles
                ? { [step.id]: testerRepairFiles }
                : undefined;
            const outside = outsideWriteScope(step, result.proposal, exact);
            if (outside.length) {
              returned(step.id, "outside-write-scope");
              patchFeedback = writeScopeFeedback(step, outside, exact);
              continue;
            }
            // A repair must fix the implementation, never weaken the tests
            // the tester wrote for the acceptance criteria.
            if (step.id === DAG_REPAIR_STEP && !repairedByTester) {
              // Case-insensitive: macOS and Windows file systems treat
              // First.test.js and first.test.js as one file.
              const testerFiles = new Set(
                testerWrittenFiles().map((file) => file.toLowerCase()),
              );
              const touched = [
                ...new Set(
                  result.proposal.changes
                    .map((change) => change.path)
                    .filter((file) => testerFiles.has(file.toLowerCase())),
                ),
              ];
              if (touched.length) {
                returned(step.id, "tester-files");
                patchFeedback = `The tester wrote ${touched.join(", ")} to prove the acceptance criteria. Do not change those tests; fix the implementation so they pass.`;
                continue;
              }
            }
            if (unseen) {
              returned(step.id, "unseen-or-ambiguous-edit");
              patchFeedback = patchFeedbackFor(
                unseen,
                result.proposal,
                provider,
                this.config.policy,
              );
              continue;
            }
            let changed: string[];
            try {
              // A repair patch keeps a DAG step's crash discipline (a pending
              // marker, rollback on failure) and moves the checkpoint with
              // it, so a resume passes the checkpoint's workspace check.
              changed =
                step.id === DAG_REPAIR_STEP && dagCheckpoint
                  ? (
                      await applyRepair({
                        workspace,
                        policy: this.config.policy,
                        checkpoint: dagCheckpoint,
                        proposal: result.proposal,
                        saveCheckpoint: saveDagCheckpoint,
                        onEvent: recordDagEvent,
                      })
                    ).paths
                  : await applyWholePatch(
                      workspace,
                      result.proposal,
                      this.config.policy,
                      recordPatch(step.id),
                    );
            } catch (error) {
              // A patch that could not be rolled back needs reconciliation.
              if (error instanceof DagReconciliationError) throw error;
              const message = errorMessage(error);
              const returnedPatch = patchErrorFeedback(message, step.id);
              if (!returnedPatch) throw error;
              returned(step.id, returnedPatch.reason);
              patchFeedback = patchFeedbackFor(
                returnedPatch.feedback,
                result.proposal,
                provider,
                this.config.policy,
              );
              continue;
            }
            reusableProposal =
              attempt === 1 && !cached && !resuming
                ? result.proposal
                : undefined;
            this.store.event(
              run.id,
              "patch.applied",
              { paths: changed },
              step.id,
            );
            // An implementer repair that changes nothing disputes the
            // tester's tests; the tester answers on the next attempt.
            if (
              step.id === DAG_REPAIR_STEP &&
              !repairedByTester &&
              testerRepairPlan &&
              !changed.length
            ) {
              implementerDispute = redact(result.proposal.summary).slice(
                0,
                1500,
              );
              unresolvedDispute = implementerDispute;
              this.store.event(
                run.id,
                "dag.repair_dispute",
                { summary: implementerDispute },
                step.id,
              );
            } else if (repairedByTester && changed.length)
              unresolvedDispute = undefined;
            proposalApplied = true;
            break;
          }
          if (!proposalApplied)
            throw new Error("Worker exhausted its turn budget without a patch");
          if (await verify(step.id)) {
            if (reusableProposal) {
              try {
                await this.context.putSolution({
                  ...solutionInput,
                  value: JSON.stringify(reusableProposal),
                  sources: originalPacket.items.flatMap((item) =>
                    item.source ? [item.source] : [],
                  ),
                });
              } catch (error) {
                this.store.event(run.id, "solution.capture_failed", {
                  error: errorMessage(error),
                });
              }
            }
            break;
          }
          save("running");
          const alternatives = (await this.providers()).filter((candidate) => {
            try {
              assertProvider(candidate, this.config.policy, step.effort);
              // A repair escalates only to providers the plan already uses,
              // and a cloud-backed client's plan only to its own side of the
              // export boundary: a local model could otherwise read private
              // files for a cloud plan, or a cloud model receive what a
              // local plan's step copied under an exported path.
              return (
                candidate.id !== provider!.id &&
                (step.id !== DAG_REPAIR_STEP ||
                  run.plan.steps.some(
                    (planned) => planned.providerId === candidate.id,
                  )) &&
                onPlanSide(run.plan, candidate)
              );
            } catch {
              return false;
            }
          });
          const recovery = await controlRecovery({
            ...withState({
              attempt,
              verificationPassed: false,
              repeatedFailure: attempt > firstAttempt,
            }),
            attempt,
            maxAttempts: this.config.policy.maxAttempts,
            needsMoreContext: false,
            alternativeProviderAvailable: alternatives.length > 0,
            securityConcern: false,
            repeatedFailure: attempt > firstAttempt,
          });
          this.captureDecision(run, "recovery", recovery);
          if (recovery.action === "human" || recovery.action === "stop")
            throw new Error(
              securityFeedback
                ? `Security scan found ${securityFindings} finding(s) not in the reviewed baseline; recovery controller stopped for review`
                : reviewFeedback
                  ? "Code review requested changes; recovery controller stopped for review"
                  : unresolvedDispute
                    ? `Required checks failed and the implementer disputes the tester's tests: ${unresolvedDispute}; a person should decide`
                    : "Required checks failed; recovery controller stopped for review",
            );
          if (recovery.action === "escalate") provider = alternatives[0]!;
          stepPacket = await currentContext();
        }
        if (!verified)
          throw new Error(
            securityFeedback
              ? `Security scan found ${securityFindings} finding(s) not in the reviewed baseline after the allowed attempts; fix them, or have a person review them and update ${BASELINE_FILE}`
              : reviewFeedback
                ? "Code review still requested changes after the allowed attempts"
                : "Required checks failed after the allowed attempts",
          );
      }
      if (signal.aborted) throw new Error("Run cancelled");
      await this.refresh();
      if (hash(this.config.policy) !== run.plan.policyHash)
        throw new Error("Policy changed before publication");
      if (!verifiedHash)
        throw new Error(
          "No verified source snapshot is available for publication",
        );
      const changedPaths = [
        ...(
          await checkedGit(workspace, [
            "diff",
            "--name-only",
            "--no-renames",
            baseCommit,
          ])
        ).split("\n"),
        ...(
          await checkedGit(workspace, [
            "ls-files",
            "--others",
            "--exclude-standard",
          ])
        ).split("\n"),
      ].filter(Boolean);
      const sensitivePaths = changedPaths.some((file) =>
        /(?:^|\/)(?:auth\w*|security\w*|crypt\w*|permissions?\w*|polic(?:y|ies)|secrets?\w*|credentials?\w*)(?:[./_-]|$)/i.test(
          file,
        ),
      );
      const architecturePaths = changedPaths.some((file) =>
        /(?:^|\/)(?:migrations?|schema|infrastructure|infra)(?:[./_-]|$)/i.test(
          file,
        ),
      );
      if (sensitivePaths)
        scope.review = scope.review.includes("architecture")
          ? "security-and-architecture"
          : "security";
      if (architecturePaths)
        scope.review = scope.review.includes("security")
          ? "security-and-architecture"
          : "architecture";
      // Acceptance belongs to a succeeded run, so the record carries it only
      // once publication has succeeded.
      const acceptance: NonNullable<RunRecord["completion"]> = {
        automatedChecksPassed: verified,
        humanAcceptance: "pending",
        reviewScope: scope.review,
      };
      this.store.event(run.id, "acceptance.pending_review", {
        automatedChecksPassed: verified,
        reviewScope: scope.review,
        note: "Passing configured checks does not establish arbitrary prose acceptance criteria or authorize a merge.",
      });
      // A project that keeps a reviewed security baseline gates every run on
      // it: the verified result may not add findings the team has not seen.
      if (securityBaseline) {
        if (securityPassedHash !== verifiedHash) {
          const outcome = await securityGate();
          if (!outcome.passed)
            throw new Error(
              `Security scan found ${outcome.count} finding(s) not in the reviewed baseline; fix them, or have a person review them and update ${BASELINE_FILE}`,
            );
        }
      } else if (scope.review.includes("security"))
        this.store.event(run.id, "security.scan_recommended", {
          reason:
            "This change needs security review and the project keeps no reviewed security baseline; run graph-engine security-scan",
        });
      const completion = await controlCompletion({
        ...withState({
          verificationPassed: true,
          securityReview: scope.review.includes("security"),
          architectureReview: scope.review.includes("architecture"),
        }),
        acceptanceSatisfied: false,
        requiredTestsPassed: verified,
        requiredReviewsPassed: false,
        completionScope: "automated-run",
        policyValid: true,
      });
      this.captureDecision(run, "completion", completion);
      if (completion.action !== "complete")
        throw new Error(
          "Automated checks passed; additional review is required before completing this managed run",
        );
      this.store.event(run.id, "publication.started", {
        mode: run.plan.publication,
        snapshotHash: verifiedHash,
      });
      publishing = true;
      Object.assign(
        run,
        await publishRun(this.root, run, this.config, verifiedHash, signal),
      );
      this.store.event(run.id, "publication.completed", {
        commit: run.commit ?? null,
        pullRequest: run.pullRequest ?? null,
      });
      publishing = false;
      // Memory capture awaits a decision provider, so it finishes before the
      // run is saved as succeeded: a person's decision can be recorded only
      // on a succeeded run, and no later save of this record may revert it.
      // Capturing its decision saves the run, still verifying, so the
      // pending acceptance is set only with the succeeded status: a process
      // that dies here leaves a run that needs reconciliation and awaits no
      // acceptance.
      try {
        const memory = await controlMemoryWrite({
          ...withState({ completed: true, committed: Boolean(run.commit) }),
          durable: Boolean(run.commit),
          requiredAuditRecord: false,
        });
        this.captureDecision(run, "memory", memory);
        if (memory.action === "propose")
          await this.context.createMemory({
            kind: "observation",
            text: `Completed task: ${run.plan.objective}. Required automated checks passed. Run ${run.id}${run.commit ? `, commit ${run.commit}` : ""}. Acceptance still receives human PR review.`,
          });
      } catch (error) {
        this.store.event(run.id, "memory.capture_failed", {
          error: errorMessage(error),
        });
      }
      run.completion = acceptance;
      run.status = "succeeded";
      run.updatedAt = now();
      this.store.completeRun(run);
    } catch (error) {
      run.usage = this.store.usage(run.plan.id);
      run.error = redact(errorMessage(error));
      // Only a succeeded run awaits a person's acceptance.
      delete run.completion;
      // Publication may have committed, pushed or opened a PR before a
      // cancellation took effect, so that state outranks a plain cancel.
      run.status =
        publishing || error instanceof DagReconciliationError
          ? "needs_reconciliation"
          : signal.aborted
            ? "cancelled"
            : "failed";
      run.updatedAt = now();
      this.store.stopRun(run);
    }
  }
  // The run store closes last: a command that Ctrl-C closes while it waits
  // on a run reads that run's record and events once the run has stopped.
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      for (const { controller } of this.active.values()) controller.abort();
      await Promise.all([...this.active.values()].map((a) => a.promise));
      await this.context.close();
      this.store.close();
    })());
  }
}
const unfinished = (status: RunRecord["status"]) =>
  ["planned", "running", "verifying"].includes(status);
// The model roles a plan runs with, each marked by whether it runs locally:
// its worker steps, the tester's among them, with the providers their IDs
// name now, its non-worker steps, which always run locally, and the given
// reviewer. A provider no longer configured has no
// role here; a run refuses it when it reaches that step.
export function modelRoles(
  plan: ExecutionPlan,
  providers: ProviderConfig[],
  reviewerId: string | undefined,
): { role: string; local: boolean }[] {
  const roles: { role: string; local: boolean }[] = [];
  for (const step of plan.steps) {
    // Non-worker steps execute on this machine. In particular, a template or
    // future generator may read files the export policy keeps from cloud
    // models; treating an unfamiliar non-worker kind as local fails closed.
    if (step.kind !== "worker") {
      roles.push({ role: `${step.kind} step ${step.id}`, local: true });
      continue;
    }
    const worker = providers.find(
      (candidate) => candidate.id === step.providerId,
    );
    if (worker)
      roles.push({
        role: stepRole(step.id, worker.id),
        local: worker.kind === "local",
      });
  }
  const reviewer = providers.find((provider) => provider.id === reviewerId);
  if (reviewer)
    roles.push({
      role: reviewerRole(reviewer.id),
      local: reviewer.kind === "local",
    });
  return roles;
}
// How a refusal names a model role and the provider it runs on.
function stepRole(stepId: string, providerId: string): string {
  return stepId === TESTER_STEP_ID
    ? `the tester (${providerId})`
    : `step ${stepId} (${providerId})`;
}
function reviewerRole(providerId: string): string {
  return `the reviewer (${providerId})`;
}
function movedRolesMessage(local: boolean, moved: string[]): string {
  return `A cloud-backed client created this plan with every model role ${local ? "running locally" : "on non-local providers"}, but ${moved.join(", ")} now ${moved.length === 1 ? "runs" : "run"} ${local ? "on a non-local provider" : "locally"}: a local model may read files the export policy keeps from cloud models and write them where a cloud model receives them. Configure the reviewer and providers the plan was created with again, or create a fresh plan.`;
}
// Whether a provider is on a cloud-backed client's plan's side of the
// export boundary; any provider is for a person's own plan.
function onPlanSide(plan: ExecutionPlan, provider: ProviderConfig): boolean {
  return (
    plan.exportSide === undefined ||
    (provider.kind === "local") === (plan.exportSide === "local")
  );
}
// Refuses a provider a run is about to send work to when it is on the other
// side of the export boundary from its cloud-backed client's plan. start()
// and resume() check every role first, but a run finds its reviewer and
// each step's provider by ID when it reaches them, so a reviewer changed
// or a provider ID redefined with provider-add while it runs would
// otherwise receive what its earlier steps wrote.
function assertOnPlanSide(
  plan: ExecutionPlan,
  provider: ProviderConfig,
  role: string,
): void {
  if (!onPlanSide(plan, provider))
    throw new Error(movedRolesMessage(plan.exportSide === "local", [role]));
}
// Files a proposal changes outside its step's declared write scope.
function outsideWriteScope(
  step: ExecutionStep,
  proposal: { changes: { path: string }[] },
  exact?: Record<string, string[]>,
): string[] {
  const scope = writeScope(step, exact);
  return scope
    ? [
        ...new Set(
          proposal.changes
            .map((change) => change.path)
            .filter((file) => !scope(file)),
        ),
      ]
    : [];
}
function writeScopeFeedback(
  step: ExecutionStep,
  outside: string[],
  exact?: Record<string, string[]>,
): string {
  const allowed = exact?.[step.id];
  return `This step may only write ${allowed ? `the files ${allowed.join(", ")}` : `files matching ${step.writes!.join(", ")}`}. Your proposal also changed ${outside.join(", ")}; propose only changes within that scope.`;
}
// Stack traces can fill the output; keep the first two frames of each so
// the error messages around them survive the size limit.
function collapseStackFrames(text: string): string {
  const frame = /^\s*(?:at |File "|\.\.\. \d+ more)/;
  const lines: string[] = [];
  let run = 0;
  for (const line of text.split("\n")) {
    if (frame.test(line)) {
      run++;
      if (run <= 2) lines.push(line);
      else if (run === 3) lines.push("    (more stack frames omitted)");
    } else {
      run = 0;
      lines.push(line);
    }
  }
  return lines.join("\n");
}

// Both streams: many build tools print errors on stdout and unrelated
// warnings on stderr, so either alone can hide the failure.
function compactFailures(checks: VerificationResult[]): string {
  return checks
    .filter((c) => c.code !== 0)
    .map((c) =>
      [
        `${c.argv.join(" ")} exited ${c.code}`,
        c.stdout.trim() &&
          `stdout:\n${redact(collapseStackFrames(c.stdout)).slice(-6000)}`,
        c.stderr.trim() &&
          `stderr:\n${redact(collapseStackFrames(c.stderr)).slice(-3000)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n")
    .slice(-12000);
}

// A source request answered with feedback instead of evidence: one that
// added nothing new, or one naming paths this worker may not receive. Any
// other error is not the worker's to fix.
function refusedRequest(
  error: unknown,
): { reason: string; feedback: string } | undefined {
  if (error instanceof UnexportableRequestError)
    return {
      reason: "not-exportable",
      feedback: unexportableRequestFeedback(error.paths),
    };
  if (error instanceof RepeatedRequestError)
    return { reason: "no-new-evidence", feedback: REPEATED_REQUEST_FEEDBACK };
  return undefined;
}

// Test first: the tester only creates new test files, and writes at least
// one; implementing steps make those tests pass without changing them.
function testFirstFeedback(
  step: ExecutionStep,
  proposal: WorkerResult["proposal"],
  testsWritten: readonly string[],
): string | undefined {
  if (step.id === TESTER_STEP_ID) {
    if (!proposal.changes.length)
      return "Write at least one new test file that proves the acceptance criteria before anyone implements them.";
    // Editing a file this same proposal creates is still creating it.
    const created = new Set(
      proposal.changes
        .filter((change) => change.before === null)
        .map((change) => change.path.toLowerCase()),
    );
    const edits = proposal.changes
      .filter(
        (change) =>
          change.before !== null && !created.has(change.path.toLowerCase()),
      )
      .map((change) => change.path);
    return edits.length
      ? `As the tester, create new test files only; do not edit existing files (${[...new Set(edits)].join(", ")}). Put your tests in a new file.`
      : undefined;
  }
  const written = new Set(testsWritten.map((file) => file.toLowerCase()));
  const touched = [
    ...new Set(
      proposal.changes
        .map((change) => change.path)
        .filter((file) => written.has(file.toLowerCase())),
    ),
  ];
  return touched.length
    ? `The tester wrote ${touched.join(", ")} to prove the acceptance criteria. Do not change those tests; change the implementation so they pass.`
    : undefined;
}

// How applyWholePatch records a patch in the run's events.
interface PatchRecorder {
  // Before the first write: from here the patch's files count as the run's
  // (see runWrittenPaths), even if the process dies before it completes.
  applying(paths: string[]): RunEvent;
  // After a rollback that restored the pre-patch workspace.
  rolledBack(applying: RunEvent, paths: string[], error: string): void;
  // Every file the run has written so far, this patch's included once it
  // is recorded as applying.
  writtenPaths(): Promise<string[]>;
}

// Applies a single-step patch as a whole, as a DAG step's is: it is
// validated first, so a patch that cannot apply goes back to the worker with
// nothing written, and a write that fails partway (a full disk, say) is
// undone. A file left behind would be missing from the run's record, so
// review would skip it and publication would still commit it: the patch is
// recorded as applying before its first write, and only a rollback that
// brings the workspace back to its pre-patch fingerprint records it as
// rolled back. One that cannot needs reconciliation. As for a DAG step or a
// repair, a patch that leaves any file the run wrote outside the
// verification inventory (a new Git-ignored file, or a .gitignore that hides
// an earlier file) is rolled back too, so a resume regenerates it instead of
// failing on the same file again.
async function applyWholePatch(
  workspace: string,
  proposal: WorkerProposal,
  policy: ProjectPolicy,
  record: PatchRecorder,
): Promise<string[]> {
  await prepareProposal(workspace, proposal, policy);
  const paths = [...new Set(proposal.changes.map((change) => change.path))];
  if (!paths.length) return applyProposal(workspace, proposal, policy);
  const originals = await captureOriginals(workspace, paths, policy);
  const before = await workspaceFingerprint(workspace, policy);
  const applying = record.applying(paths);
  try {
    const changed = await applyProposal(workspace, proposal, policy);
    await assertVerificationPaths(
      workspace,
      [...(await record.writtenPaths()), ...paths],
      policy,
    );
    return changed;
  } catch (error) {
    try {
      await restoreOriginals(originals);
      if ((await workspaceFingerprint(workspace, policy)) !== before)
        throw new Error("the workspace does not match its pre-patch state", {
          cause: error,
        });
    } catch (restoreError) {
      throw new DagReconciliationError(
        `A patch failed while its files were written (${errorMessage(error)}) and could not be rolled back (${errorMessage(restoreError)}); inspect ${paths.join(", ")} in the retained workspace, then resume with reconciliation acknowledgement or create a new plan`,
        { cause: restoreError },
      );
    }
    record.rolledBack(applying, paths, errorMessage(error));
    throw new Error(
      `${errorMessage(error)} The patch was rolled back; the workspace is at its state before the patch.`,
      { cause: error },
    );
  }
}

// What a worker is told when its patch cannot apply, and the reason code
// recorded for it, or undefined for errors that are not the worker's to fix.
function patchErrorFeedback(
  message: string,
  stepId: string,
): { feedback: string; reason: string } | undefined {
  if (message.startsWith("Patch precondition failed"))
    return {
      feedback: `${message}. Include enough surrounding lines in before to match exactly once in the whole file.`,
      reason: "patch-did-not-match",
    };
  if (message.startsWith("Refusing to replace existing file"))
    return {
      // The tester may only create files, so it can only rename.
      feedback:
        stepId === TESTER_STEP_ID
          ? `${message}: that file already exists. Put your tests in a new file with a different name.`
          : `${message}: that file already exists. Request it first, then edit it with a before that matches its content, or create a file with a different name.`,
      reason: "file-exists",
    };
  if (message.startsWith(PATH_ALIAS_ERROR))
    return {
      feedback: `${message}. Spell each file one way, and do not use one path as both a file and a directory in a patch.`,
      reason: "path-alias",
    };
  return undefined;
}
