import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import type {
  ContextPacket,
  ExecutionPlan,
  ExecutionStep,
  DualPlanPreflight,
  ProjectConfig,
  ProviderConfig,
  RunRecord,
  Usage,
} from "@graph-engineering/contracts";
import { ContextEngine } from "./context/index.js";
import { loadProject, loadProviders, projectDataDir } from "./project.js";
import { RunStore } from "./store.js";
import { assertProvider, isAllowedPath, redact, safePath } from "./policy.js";
import { errorMessage, hash, id, now, readJson, writeJson } from "./util.js";
import { decide, decisionProviders } from "./decisions.js";
import { loadPromotionAuthority } from "./promotion-authority.js";
import {
  invokeApiWorker,
  estimateRequestCost,
  fitWorkerContext,
  type WorkerInput,
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
  createWorkspace,
  workspaceFingerprint,
} from "./execution/workspace.js";
import {
  dockerAvailable,
  verifyInContainer,
  type VerificationResult,
} from "./execution/docker.js";
import { publishRun } from "./execution/publish.js";
import { checkedGit } from "./execution/git.js";
import { requiresSecurityReview, routePlan, WORKFLOWS } from "./planning.js";
import {
  renderTemplateProposal,
  templateRuntimeCapability,
} from "./templates.js";
import {
  runDag,
  validateDag,
  DagReconciliationError,
  type DagCheckpoint,
} from "./execution/dag.js";
import type { DecisionBudget, DecisionBatchResult } from "./decision-batch.js";
import { dualPlanPreflightSchema } from "./decision-dual.js";
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
}
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
    this.context = new ContextEngine({
      projectId: config.projectId,
      root,
      dataDir: this.dataDir,
      policy: config.policy,
    });
    this.store = new RunStore(this.dataDir, config.projectId);
  }
  static async open(
    root: string,
    deps: EngineDependencies = {},
  ): Promise<GraphEngine> {
    const absolute = path.resolve(root);
    const engine = new GraphEngine(absolute, await loadProject(absolute), deps);
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
          estimated: usage.reportedCostUsd === null,
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
    });
  }
  private async invokeWorker(
    input: WorkerInput,
    workspace: string,
    ownerId: string,
  ): Promise<WorkerResult> {
    input = fitWorkerContext(input);
    const callId = `worker-${id()}`;
    const started = Date.now();
    while (
      !(await this.store.tryAcquireWorker(callId, input.policy.maxWorkers))
    ) {
      if (
        input.policy.timeoutSeconds !== null &&
        Date.now() - started > input.policy.timeoutSeconds * 1000
      )
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
    Object.assign(this.config.policy, config.policy);
    this.config = { ...config, policy: this.config.policy };
    this.context.updatePolicy(config.policy);
    return this.config;
  }
  async createPlan(input: {
    objective: string;
    acceptance: string[];
    providerId?: string;
    effort?: string;
    steps?: ExecutionStep[];
    dualPreflight?: Omit<DualPlanPreflight, "version">;
  }): Promise<ExecutionPlan> {
    await this.refresh();
    const hasWorker =
      !input.steps || input.steps.some((step) => step.kind === "worker");
    const dualPreflight = input.dualPreflight
      ? dualPlanPreflightSchema.parse({
          version: "1.0.0",
          ...input.dualPreflight,
        })
      : undefined;
    if (
      this.config.policy.requireDualBeforeWorker &&
      hasWorker &&
      !dualPreflight
    )
      throw new Error(
        "A retained dual preflight is required before worker planning",
      );
    if (dualPreflight && !hasWorker)
      throw new Error(
        "Dual preflight cannot be attached to a template-only plan",
      );
    if (dualPreflight)
      this.store.assertAvailableDualPreflight(
        dualPreflight,
        hash(this.config.policy),
      );
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
          ...(dualPreflight ? { dualPreflight } : {}),
        };
        this.store.savePlan(plan);
        return plan;
      }
    }
    const configured = await this.providers();
    const installed = configured.some((p) =>
      ["codex", "claude", "cursor"].includes(p.kind),
    )
      ? await discoverInstalledWorkers()
      : [];
    const available = configured.filter((p) => {
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
    if (!available.length)
      throw new Error(
        "No permitted worker is configured. Add a local provider or explicitly enable a cloud provider in project policy.",
      );
    let provider = input.providerId
      ? available.find((p) => p.id === input.providerId)
      : available[0];
    if (!provider)
      throw new Error("Selected worker is unavailable under project policy");
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
      steps: input.steps
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
      routing: {
        workflow: routing.workflow,
        contextBudgetTokens: routing.contextBudgetTokens,
        decisionIds: routing.records.map((record) => record.id),
      },
      verification: structuredClone(this.config.verification),
      publication: this.config.policy.publication,
      ...(dualPreflight ? { dualPreflight } : {}),
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
    this.store.savePlan(plan);
    return plan;
  }
  async start(planId: string, scopeSha256?: string): Promise<RunRecord> {
    await this.refresh();
    const plan = this.store.plan(planId);
    if (plan.policyHash !== hash(this.config.policy))
      throw new Error("Policy changed since planning; create a new plan");
    const hasWorker = plan.steps.some((step) => step.kind === "worker");
    if (
      this.config.policy.requireDualBeforeWorker &&
      hasWorker &&
      !plan.dualPreflight
    )
      throw new Error(
        "A retained dual preflight is required before worker dispatch",
      );
    if (plan.dualPreflight) {
      dualPlanPreflightSchema.parse(plan.dualPreflight);
      if (scopeSha256 !== plan.dualPreflight.scopeSha256)
        throw new Error("Selected scope digest does not match the plan");
      this.store.assertBoundDualPlan(plan);
    } else if (scopeSha256)
      throw new Error("Selected scope digest has no dual preflight plan");
    if (this.active.size >= this.config.policy.maxWorkers)
      throw new Error("Project concurrency limit reached");
    if (plan.verification.length === 0)
      throw new Error("Configure verification commands before running work");
    if (!(await (this.deps.dockerAvailable ?? dockerAvailable)()))
      throw new Error("A running Docker-compatible engine is required");
    const snapshot = await this.context.index({ semantic: false });
    if (snapshot.id !== plan.snapshotId)
      throw new Error("Source changed since planning; create a fresh plan");
    if (
      plan.publication !== "none" &&
      (await checkedGit(this.root, ["status", "--porcelain"]))
    )
      throw new Error(
        "Commit your existing changes before a run that publishes; unrelated local work must not enter its commit",
      );
    const run: RunRecord = {
      id: id(),
      plan,
      ...(plan.dualPreflight ? { dualPreflight: plan.dualPreflight } : {}),
      status: "planned",
      createdAt: now(),
      updatedAt: now(),
      usage: this.store.usage(plan.id),
    };
    this.store.reserve(run, this.config.policy.maxWorkers);
    this.launch(run);
    return this.store.run(run.id);
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
  cancel(runId: string): RunRecord {
    const run = this.store.run(runId);
    if (!["planned", "running", "verifying"].includes(run.status))
      throw new Error("Run is not active");
    this.active.get(runId)?.controller.abort();
    this.store.event(runId, "cancel.requested", {});
    return this.store.run(runId);
  }
  async resume(
    runId: string,
    reconciled = false,
    scopeSha256?: string,
  ): Promise<RunRecord> {
    if (this.active.has(runId)) throw new Error("Run is already active");
    const run = this.store.run(runId);
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
    if (
      this.config.policy.requireDualBeforeWorker &&
      run.plan.steps.some((step) => step.kind === "worker") &&
      !run.plan.dualPreflight
    )
      throw new Error(
        "A retained dual preflight is required before worker resume",
      );
    if (run.plan.dualPreflight) {
      if (scopeSha256 !== run.plan.dualPreflight.scopeSha256)
        throw new Error("Selected scope digest does not match the run");
      this.store.assertBoundDualRun(run);
    } else if (scopeSha256)
      throw new Error("Selected scope digest has no dual preflight run");
    if (this.active.size >= this.config.policy.maxWorkers)
      throw new Error("Project concurrency limit reached");
    if (run.plan.verification.length === 0)
      throw new Error("Configure verification commands before running work");
    if (!(await (this.deps.dockerAvailable ?? dockerAvailable)()))
      throw new Error("A running Docker-compatible engine is required");
    if (
      !run.workspace &&
      (await this.context.index({ semantic: false })).id !== run.plan.snapshotId
    )
      throw new Error(
        "Source changed before workspace creation; create a fresh plan",
      );
    const reserved = this.store.reserveResume(
      runId,
      this.config.policy.maxWorkers,
    );
    this.store.event(runId, "recovery.acknowledged", {});
    this.launch(reserved, true);
    return this.store.run(runId);
  }
  private assertWorkerPreflight(run: RunRecord): void {
    if (
      this.config.policy.requireDualBeforeWorker &&
      run.plan.steps.some((step) => step.kind === "worker") &&
      !run.plan.dualPreflight
    )
      throw new Error(
        "A retained dual preflight is required before worker dispatch",
      );
    if (run.plan.dualPreflight) this.store.assertBoundDualRun(run);
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
    try {
      this.assertWorkerPreflight(run);
      const priorEvents = this.store.events(run.id);
      delete run.error;
      save("running");
      this.store.event(run.id, "run.started", { resuming });
      if (!run.workspace) {
        Object.assign(
          run,
          await createWorkspace(
            this.root,
            this.dataDir,
            run.id,
            this.config.policy,
          ),
        );
        save("running");
      }
      const workspace = run.workspace!;
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
          return {
            ...current,
            mandatorySources: originalPacket.mandatorySources,
          };
        } finally {
          await latest.close();
        }
      };
      const packet = resuming ? await currentContext() : originalPacket;
      let feedback = "";
      let verified = false;
      let verifiedHash: string | undefined;
      const verify = async (stepId: string) => {
        if (signal.aborted) throw new Error("Run cancelled");
        save("verifying");
        const proposedPaths = this.store
          .events(run.id)
          .filter((event) =>
            [
              "patch.applied",
              "dag.step.completed",
              "solution.cache_hit",
            ].includes(event.type),
          )
          .flatMap((event) => {
            const paths = event.data.paths;
            if (
              !Array.isArray(paths) ||
              paths.some((item) => typeof item !== "string")
            )
              throw new Error(
                "Retained patch lacks its verification path inventory; explicit source review is required before reuse",
              );
            return paths as string[];
          });
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
        return verified;
      };
      if (
        run.plan.steps.length > 1 ||
        run.plan.steps.some((step) => step.kind === "template")
      ) {
        const checkpointPath = path.join(
          this.dataDir,
          "checkpoints",
          `${run.id}.json`,
        );
        let checkpoint: DagCheckpoint | undefined;
        if (resuming) {
          try {
            checkpoint = await readJson(checkpointPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        await runDag({
          steps: run.plan.steps,
          workspace,
          policy: this.config.policy,
          signal,
          checkpoint,
          // Strict paid reservations are cross-process; each DAG uses the configured bound.
          maxParallel: this.config.policy.maxWorkers,
          saveCheckpoint: (value) => writeJson(checkpointPath, value),
          beforeApply: async () => {
            await this.refresh();
            if (hash(this.config.policy) !== run.plan.policyHash)
              throw new Error("Policy changed before DAG patch application");
          },
          onEvent: (event) => {
            this.store.event(run.id, event.type, event.data, event.stepId);
          },
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
              return renderTemplateProposal({
                templateId: step.templateId!,
                instanceId: step.id,
                inputs,
                targetDirectory,
                workspace,
                policy: this.config.policy,
              });
            }
            const provider = (await this.providers()).find(
              (provider) => provider.id === step.providerId,
            );
            if (!provider)
              throw new Error("DAG worker is no longer configured");
            let stepPacket: ContextPacket = await currentContext();
            const suppliedSourceHashes = new Map<string, string>();
            for (let turn = 0; turn < this.config.policy.maxTurns; turn++) {
              await this.refresh();
              if (hash(this.config.policy) !== run.plan.policyHash)
                throw new Error("Policy changed during DAG execution");
              this.assertWorkerPreflight(run);
              const result = await this.invokeWorker(
                {
                  provider,
                  policy: this.config.policy,
                  context: stepPacket,
                  objective: step.objective,
                  acceptance: run.plan.acceptance,
                  effort: step.effort,
                  signal: state.signal,
                },
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
              if (!result.proposal.requests.length) return result;
              const items: ContextPacket["items"] = [];
              for (const relative of new Set(result.proposal.requests)) {
                if (
                  provider.kind !== "local" &&
                  !isAllowedPath(relative, this.config.policy, true)
                )
                  throw new Error(
                    `Source request is not exportable: ${relative}`,
                  );
                const absolute = await safePath(
                  workspace,
                  relative,
                  this.config.policy,
                );
                let text: string;
                try {
                  text = await readFile(absolute, "utf8");
                } catch {
                  throw new Error(
                    `Requested source is unavailable: ${relative}`,
                  );
                }
                if (Buffer.byteLength(text) > budgetTokens)
                  throw new Error("Requested source exceeds context budget");
                const contentHash = hash(text);
                items.push({
                  id: hash(relative + text),
                  kind: "code",
                  text,
                  score: 1,
                  source: {
                    path: relative,
                    startLine: 1,
                    endLine: text.split("\n").length,
                    contentHash,
                    snapshotId: stepPacket.snapshotId,
                  },
                });
              }
              const requestedPacket = {
                ...stepPacket,
                items,
                estimatedTokens:
                  Buffer.byteLength(JSON.stringify(items)) +
                  Buffer.byteLength(JSON.stringify(stepPacket.mandatory)),
              };
              const suppliedPacket = fitWorkerContext({
                provider,
                policy: this.config.policy,
                context: requestedPacket,
                objective: step.objective,
                acceptance: run.plan.acceptance,
                effort: step.effort,
                signal: state.signal,
              }).context;
              if (!suppliedPacket.items.length)
                throw new Error(
                  "Requested sources yielded no exportable evidence within context budget; stopped to avoid no-progress model turns",
                );
              if (
                !suppliedPacket.items.some(
                  (item) =>
                    item.source &&
                    suppliedSourceHashes.get(item.source.path) !==
                      item.source.contentHash,
                )
              )
                throw new Error(
                  "DAG worker repeated source requests without new evidence; stopped to avoid no-progress model turns",
                );
              stepPacket = suppliedPacket;
              for (const item of suppliedPacket.items)
                if (item.source)
                  suppliedSourceHashes.set(
                    item.source.path,
                    item.source.contentHash,
                  );
            }
            throw new Error(
              "DAG worker exhausted its context-request turn budget",
            );
          },
        });
        if (!(await verify("dag")))
          throw new Error(
            "DAG checks failed; inspect retained per-step evidence and create a repair plan",
          );
      } else
        for (const step of run.plan.steps) {
          verified = false;
          // An acknowledged recovery checks the retained patch first. It never
          // reapplies the original exact-substring patch to an already edited file.
          if (
            resuming &&
            priorEvents.some(
              (event) =>
                event.type === "publication.started" ||
                (event.type === "patch.applied" && event.stepId === step.id),
            )
          ) {
            if (await verify(step.id)) {
              this.store.event(run.id, "step.reconciled", {}, step.id);
              continue;
            }
          }
          let provider = (await this.providers()).find(
            (p) => p.id === step.providerId,
          );
          if (!provider)
            throw new Error("The planned provider is no longer configured");
          let stepPacket: ContextPacket = packet;
          const solutionInput = {
            key: `worker:${hash({ objective: step.objective, acceptance: run.plan.acceptance })}`,
            inputs: {
              provider: provider.id,
              model: provider.model,
              verification: run.plan.verification,
              policy: run.plan.policyHash,
            },
            snapshotId: run.plan.snapshotId,
          };
          const cached = resuming
            ? null
            : await this.context.getSolution(solutionInput);
          let reusableProposal: WorkerResult["proposal"] | undefined;
          if (cached) {
            const proposal = proposalSchema.parse(JSON.parse(cached.value));
            await applyProposal(workspace, proposal, this.config.policy);
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
            let attempt = 1;
            attempt <= this.config.policy.maxAttempts;
            attempt++
          ) {
            if (signal.aborted) throw new Error("Run cancelled");
            await this.refresh();
            if (hash(this.config.policy) !== run.plan.policyHash)
              throw new Error(
                "Policy changed during execution; dispatch stopped",
              );
            assertProvider(provider, this.config.policy, step.effort);
            save("running");
            this.store.event(
              run.id,
              "attempt.started",
              { attempt, providerId: provider.id },
              step.id,
            );
            let proposalApplied = false;
            const suppliedSourceHashes = new Map<string, string>();
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
              this.assertWorkerPreflight(run);
              this.store.event(
                run.id,
                "worker.dispatched",
                {
                  provider: provider.id,
                  model: provider.model,
                  effort: step.effort ?? null,
                  attempt,
                  turn,
                  contextItems: stepPacket.items.length,
                },
                step.id,
              );
              // Test logs may quote private source even when they contain no key-like
              // strings. They stay local; remote workers get only a generic failure.
              const workerFeedback =
                provider.kind === "local"
                  ? feedback
                  : feedback
                    ? "Required verification failed. Request explicitly exportable source to investigate."
                    : "";
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
              const result = await this.invokeWorker(
                input,
                workspace,
                run.plan.id,
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
                const items = [];
                for (const relative of new Set(result.proposal.requests)) {
                  if (
                    provider.kind !== "local" &&
                    !isAllowedPath(relative, this.config.policy, true)
                  )
                    throw new Error(
                      `Source request is not exportable: ${relative}`,
                    );
                  const requestedPath = await safePath(
                    workspace,
                    relative,
                    this.config.policy,
                  );
                  let content: string;
                  try {
                    content = await readFile(requestedPath, "utf8");
                  } catch {
                    throw new Error(
                      `Requested source is unavailable: ${relative}`,
                    );
                  }
                  if (Buffer.byteLength(content) > budgetTokens)
                    throw new Error(
                      `Requested file is too large for the context budget: ${relative}`,
                    );
                  const contentHash = hash(content);
                  items.push({
                    id: hash(relative + content),
                    kind: "code" as const,
                    text: content,
                    score: 1,
                    source: {
                      path: relative,
                      startLine: 1,
                      endLine: content.split("\n").length,
                      contentHash,
                      snapshotId: run.plan.snapshotId,
                    },
                  });
                }
                const requestedPacket = {
                  ...stepPacket,
                  items,
                  estimatedTokens:
                    Buffer.byteLength(JSON.stringify(items)) +
                    Buffer.byteLength(JSON.stringify(stepPacket.mandatory)),
                };
                stepPacket = fitWorkerContext({
                  ...input,
                  context: requestedPacket,
                }).context;
                if (!stepPacket.items.length)
                  throw new Error(
                    "Requested sources yielded no exportable evidence within context budget; stopped to avoid no-progress model turns",
                  );
                if (
                  !stepPacket.items.some(
                    (item) =>
                      item.source &&
                      suppliedSourceHashes.get(item.source.path) !==
                        item.source.contentHash,
                  )
                )
                  throw new Error(
                    "Worker repeated source requests without new evidence; stopped to avoid no-progress model turns",
                  );
                for (const item of stepPacket.items)
                  if (item.source)
                    suppliedSourceHashes.set(
                      item.source.path,
                      item.source.contentHash,
                    );
                continue;
              }
              const changed = await applyProposal(
                workspace,
                result.proposal,
                this.config.policy,
              );
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
              proposalApplied = true;
              break;
            }
            if (!proposalApplied)
              throw new Error(
                "Worker exhausted its turn budget without a patch",
              );
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
            const alternatives = (await this.providers()).filter(
              (candidate) => {
                try {
                  assertProvider(candidate, this.config.policy, step.effort);
                  return candidate.id !== provider!.id;
                } catch {
                  return false;
                }
              },
            );
            const recovery = await controlRecovery({
              ...withState({
                attempt,
                verificationPassed: false,
                repeatedFailure: attempt > 1,
              }),
              attempt,
              maxAttempts: this.config.policy.maxAttempts,
              needsMoreContext: false,
              alternativeProviderAvailable: alternatives.length > 0,
              securityConcern: false,
              repeatedFailure: attempt > 1,
            });
            this.captureDecision(run, "recovery", recovery);
            if (recovery.action === "human" || recovery.action === "stop")
              throw new Error(
                "Required checks failed; recovery controller stopped for review",
              );
            if (recovery.action === "escalate") provider = alternatives[0]!;
            stepPacket = await currentContext();
          }
          if (!verified)
            throw new Error(
              "Required checks failed after the allowed attempts",
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
        ...(await checkedGit(workspace, ["diff", "--name-only", "HEAD"])).split(
          "\n",
        ),
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
      run.completion = {
        automatedChecksPassed: verified,
        humanAcceptance: "pending",
        reviewScope: scope.review,
      };
      this.store.event(run.id, "acceptance.pending_review", {
        automatedChecksPassed: verified,
        reviewScope: scope.review,
        note: "Passing configured checks does not establish arbitrary prose acceptance criteria or authorize a merge.",
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
      Object.assign(
        run,
        await publishRun(this.root, run, this.config, verifiedHash, signal),
      );
      this.store.event(run.id, "publication.completed", {
        commit: run.commit ?? null,
        pullRequest: run.pullRequest ?? null,
      });
      save("succeeded");
      this.store.event(run.id, "run.succeeded", { usage: run.usage });
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
    } catch (error) {
      run.usage = this.store.usage(run.plan.id);
      run.error = redact(errorMessage(error));
      const events = this.store.events(run.id);
      const publishing =
        events.findLastIndex((e) => e.type === "publication.started") >
        events.findLastIndex((e) => e.type === "publication.completed");
      save(
        signal.aborted
          ? "cancelled"
          : publishing || error instanceof DagReconciliationError
            ? "needs_reconciliation"
            : "failed",
      );
      this.store.event(run.id, "run.stopped", {
        status: run.status,
        error: run.error,
      });
    }
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      for (const { controller } of this.active.values()) controller.abort();
      await Promise.all([...this.active.values()].map((a) => a.promise));
      await this.context.close();
      this.store.close();
    })());
  }
}
function compactFailures(checks: VerificationResult[]): string {
  return checks
    .filter((c) => c.code !== 0)
    .map(
      (c) =>
        `${c.argv.join(" ")} exited ${c.code}\n${redact(c.stderr || c.stdout).slice(-6000)}`,
    )
    .join("\n")
    .slice(-12000);
}
