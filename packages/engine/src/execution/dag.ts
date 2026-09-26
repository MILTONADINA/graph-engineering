import type {
  ExecutionStep,
  ProjectPolicy,
  Usage,
} from "@graph-engineering/contracts";
import picomatch from "picomatch";
import { z } from "zod";
import { hash, now } from "../util.js";
import { isAllowedPath, safePath } from "../policy.js";
import { proposalSchema, type WorkerResult } from "../workers/api.js";
import {
  applyProposal,
  assertVerificationPaths,
  prepareProposal,
  workspaceFingerprint,
} from "./workspace.js";

export interface ValidatedDag {
  steps: ExecutionStep[];
  ancestors: ReadonlyMap<string, ReadonlySet<string>>;
}
export interface DagCompletedStep {
  id: string;
  proposalHash: string;
  paths: string[];
  completedAt: string;
}
export interface DagCheckpoint {
  version: "1.0.0";
  planHash: string;
  workspaceHash: string;
  completed: DagCompletedStep[];
  pending?: {
    stepId: string;
    proposalHash: string;
    beforeHash: string;
    paths: string[];
  };
}
export interface DagEvent {
  type: string;
  stepId?: string;
  data: Record<string, unknown>;
}
export interface DagOptions {
  steps: ExecutionStep[];
  workspace: string;
  policy: ProjectPolicy;
  maxParallel?: number;
  writeScopes?: Record<string, string[]>;
  signal?: AbortSignal;
  checkpoint?: DagCheckpoint;
  /** Must durably persist before resolving; JSON writes should use atomic rename. */
  saveCheckpoint: (checkpoint: DagCheckpoint) => Promise<void>;
  /** Read/proposal only: a worker is never allowed to edit the workspace. */
  generate: (
    step: ExecutionStep,
    state: { snapshotHash: string; signal: AbortSignal },
  ) => Promise<WorkerResult>;
  /** Recheck live authorization before wave validation and each serialized write. */
  beforeApply?: (step: ExecutionStep) => Promise<void>;
  /** Called for every fulfilled generation, including siblings of a failed step. */
  onUsage?: (usage: Usage, step: ExecutionStep) => Promise<void> | void;
  onEvent?: (event: DagEvent) => Promise<void> | void;
}
export interface DagResult {
  checkpoint: DagCheckpoint;
  appliedStepIds: string[];
}
export class DagReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DagReconciliationError";
  }
}

const stepSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
    kind: z.enum(["worker", "template"]),
    objective: z.string().min(1).max(32000),
    dependsOn: z.array(z.string()).max(100),
    providerId: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    templateId: z.string().min(1).optional(),
    inputs: z.record(z.unknown()).optional(),
    writes: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
  })
  .strict();
const completedSchema = z
  .object({
    id: z.string(),
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    paths: z.array(z.string()).max(50),
    completedAt: z.string().datetime(),
  })
  .strict();
const checkpointSchema = z
  .object({
    version: z.literal("1.0.0"),
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    workspaceHash: z.string().regex(/^[a-f0-9]{64}$/),
    completed: z.array(completedSchema).max(100),
    pending: z
      .object({
        stepId: z.string(),
        proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
        beforeHash: z.string().regex(/^[a-f0-9]{64}$/),
        paths: z.array(z.string()).max(50),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Whether a step may write a file: its declared `writes` globs and any
 * scheduler-supplied paths both apply. Undefined means unrestricted.
 */
export function writeScope(
  step: ExecutionStep,
  writeScopes?: Record<string, string[]>,
): ((file: string) => boolean) | undefined {
  const declared = step.writes?.length
    ? picomatch(step.writes, { dot: true })
    : undefined;
  const supplied = writeScopes?.[step.id];
  if (!declared && !supplied) return undefined;
  return (file) =>
    (!declared || declared(file)) && (!supplied || supplied.includes(file));
}
export function validateDag(input: ExecutionStep[]): ValidatedDag {
  const steps = z.array(stepSchema).min(1).max(100).parse(input);
  const byId = new Map(steps.map((step) => [step.id, step]));
  if (byId.size !== steps.length)
    throw new Error("DAG step IDs must be unique");
  for (const step of steps) {
    // Reserved for the engine's repair step after failed combined checks.
    if (step.id === "dag-repair")
      throw new Error("Step ID dag-repair is reserved");
    if (step.kind === "worker" && !step.providerId)
      throw new Error(`Worker step ${step.id} requires a providerId`);
    if (step.kind === "template" && !step.templateId)
      throw new Error(`Template step ${step.id} requires a templateId`);
    if (new Set(step.dependsOn).size !== step.dependsOn.length)
      throw new Error(`Duplicate dependencies for ${step.id}`);
    for (const dependency of step.dependsOn)
      if (!byId.has(dependency))
        throw new Error(`Unknown dependency ${dependency} for ${step.id}`);
  }
  const ancestors = new Map<string, Set<string>>(),
    visiting = new Set<string>();
  const visit = (id: string): Set<string> => {
    if (visiting.has(id)) throw new Error(`Dependency cycle includes ${id}`);
    if (ancestors.has(id)) return ancestors.get(id)!;
    visiting.add(id);
    const all = new Set<string>();
    for (const dependency of byId.get(id)!.dependsOn) {
      all.add(dependency);
      for (const ancestor of visit(dependency)) all.add(ancestor);
    }
    visiting.delete(id);
    ancestors.set(id, all);
    return all;
  };
  for (const step of steps) visit(step.id);
  return { steps, ancestors };
}

const overlaps = (left: string, right: string) => {
  const a = left.normalize("NFC").toLowerCase(),
    b = right.normalize("NFC").toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};

/** Parallelize independent proposal generation; all filesystem mutation is serialized. */
export async function runDag(options: DagOptions): Promise<DagResult> {
  const dag = validateDag(options.steps),
    { workspace, policy } = options;
  const policyHash = hash(policy);
  const maxParallel = options.maxParallel ?? policy.maxWorkers;
  if (
    !Number.isInteger(maxParallel) ||
    maxParallel < 1 ||
    maxParallel > policy.maxWorkers
  )
    throw new Error("DAG concurrency exceeds project worker policy");
  for (const [stepId, paths] of Object.entries(options.writeScopes ?? {})) {
    if (
      !dag.ancestors.has(stepId) ||
      !Array.isArray(paths) ||
      paths.length > 50 ||
      paths.some(
        (file) => typeof file !== "string" || !isAllowedPath(file, policy),
      )
    )
      throw new Error("Invalid DAG write scope");
  }
  const planHash = hash({
    steps: dag.steps,
    policy,
    writeScopes: options.writeScopes ?? {},
  });
  const snapshotHash = await workspaceFingerprint(workspace, policy);
  let checkpoint: DagCheckpoint = options.checkpoint
    ? checkpointSchema.parse(options.checkpoint)
    : {
        version: "1.0.0",
        planHash,
        workspaceHash: snapshotHash,
        completed: [],
      };
  if (checkpoint.planHash !== planHash)
    throw new DagReconciliationError(
      "DAG plan or policy changed since checkpoint",
    );
  if (checkpoint.pending)
    throw new DagReconciliationError(
      `Step ${checkpoint.pending.stepId} was interrupted during patch application; inspect and reconcile the retained workspace before resuming`,
    );
  if (checkpoint.workspaceHash !== snapshotHash)
    throw new DagReconciliationError(
      "DAG workspace differs from its checkpoint",
    );
  const completed = new Set<string>();
  for (const step of checkpoint.completed) {
    if (
      completed.has(step.id) ||
      !dag.ancestors.has(step.id) ||
      [...dag.ancestors.get(step.id)!].some(
        (dependency) => !completed.has(dependency),
      ) ||
      step.paths.some((file) => !isAllowedPath(file, policy))
    )
      throw new DagReconciliationError(
        "DAG checkpoint has invalid completion ordering or paths",
      );
    completed.add(step.id);
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  const checkCancelled = () => {
    if (signal.aborted) throw new Error("DAG execution cancelled");
  };
  const save = async () => options.saveCheckpoint(structuredClone(checkpoint));
  const event = async (
    type: string,
    stepId: string | undefined,
    data: Record<string, unknown>,
  ) => options.onEvent?.({ type, stepId, data });
  const appliedStepIds: string[] = [];
  checkCancelled();
  await save();
  while (completed.size < dag.steps.length) {
    checkCancelled();
    if (hash(policy) !== policyHash)
      throw new DagReconciliationError(
        "Project policy changed during DAG execution",
      );
    const ready = dag.steps
      .filter(
        (step) =>
          !completed.has(step.id) &&
          step.dependsOn.every((id) => completed.has(id)),
      )
      .slice(0, maxParallel);
    if (!ready.length) throw new Error("DAG has no runnable steps");
    const before = await workspaceFingerprint(workspace, policy);
    if (before !== checkpoint.workspaceHash)
      throw new DagReconciliationError(
        "Workspace changed outside the DAG scheduler",
      );
    await event("dag.wave.started", undefined, {
      stepIds: ready.map((step) => step.id),
      snapshotHash: before,
    });
    const generated = await Promise.allSettled(
      ready.map(async (step) => {
        await event("dag.step.started", step.id, {
          providerId: step.providerId ?? null,
          templateId: step.templateId ?? null,
        });
        // Each step's generation has its own policy timeout, so a long plan
        // is not bounded by a single step's allowance.
        return options.generate(structuredClone(step), {
          snapshotHash: before,
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(policy.timeoutSeconds * 1000),
          ]),
        });
      }),
    );
    // Charge fulfilled siblings even if another model failed, before any patch.
    for (let index = 0; index < generated.length; index++) {
      const result = generated[index];
      if (result.status === "fulfilled")
        await options.onUsage?.(result.value.usage, ready[index]);
    }
    checkCancelled();
    if ((await workspaceFingerprint(workspace, policy)) !== before)
      throw new DagReconciliationError(
        "A proposal worker modified the workspace",
      );
    const failure = generated.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    await options.beforeApply?.(structuredClone(ready[0]));
    checkCancelled();
    if (hash(policy) !== policyHash)
      throw new DagReconciliationError(
        "Project policy changed before DAG patch validation",
      );
    const proposals = generated.map((result) =>
      proposalSchema.parse(
        (result as PromiseFulfilledResult<WorkerResult>).value.proposal,
      ),
    );
    const waveWrites: { id: string; paths: string[] }[] = [];
    for (let index = 0; index < ready.length; index++) {
      const step = ready[index],
        proposal = proposals[index];
      if (proposal.requests.length)
        throw new Error(
          `Step ${step.id} still requests source; its generation callback must resolve context requests before returning`,
        );
      const paths = [...new Set(proposal.changes.map((change) => change.path))];
      const scope = writeScope(step, options.writeScopes);
      if (
        paths.some((file, position) =>
          paths.slice(0, position).some((previous) => overlaps(previous, file)),
        )
      )
        throw new Error(`Step ${step.id} has conflicting path aliases`);
      for (const file of paths) {
        await safePath(workspace, file, policy);
        if (scope && !scope(file))
          throw new Error(
            `Step ${step.id} writes outside its declared scope: ${file}`,
          );
        for (const previous of [...checkpoint.completed, ...waveWrites]) {
          if (
            !dag.ancestors.get(step.id)!.has(previous.id) &&
            previous.paths.some((prior) => overlaps(prior, file))
          )
            throw new Error(
              `Independent DAG steps ${previous.id} and ${step.id} collide at ${file}; add an explicit dependency`,
            );
        }
      }
      // Validate every exact-substring precondition before applying the first
      // member of the wave, so a bad sibling cannot leave a partial wave.
      await prepareProposal(workspace, proposal, policy);
      waveWrites.push({ id: step.id, paths });
    }
    for (let index = 0; index < ready.length; index++) {
      await options.beforeApply?.(structuredClone(ready[index]));
      checkCancelled();
      if (hash(policy) !== policyHash)
        throw new DagReconciliationError(
          "Project policy changed before DAG patch application",
        );
      const step = ready[index],
        proposal = proposals[index],
        paths = waveWrites[index].paths;
      if (
        (await workspaceFingerprint(workspace, policy)) !==
        checkpoint.workspaceHash
      )
        throw new DagReconciliationError(
          "Workspace changed before serialized patch application",
        );
      checkpoint.pending = {
        stepId: step.id,
        proposalHash: hash(proposal),
        beforeHash: checkpoint.workspaceHash,
        paths,
      };
      await save(); // A crash from this point is intentionally reconciliation-required.
      await applyProposal(workspace, proposal, policy);
      // Evaluate after application too: this patch may itself change ignore rules
      // that hide a sibling's earlier output. Keep the pending checkpoint on failure.
      await assertVerificationPaths(
        workspace,
        [...checkpoint.completed.flatMap((item) => item.paths), ...paths],
        policy,
      );
      checkpoint = {
        ...checkpoint,
        workspaceHash: await workspaceFingerprint(workspace, policy),
        completed: [
          ...checkpoint.completed,
          {
            id: step.id,
            proposalHash: hash(proposal),
            paths,
            completedAt: now(),
          },
        ],
      };
      delete checkpoint.pending;
      await save();
      completed.add(step.id);
      appliedStepIds.push(step.id);
      await event("dag.step.completed", step.id, {
        paths,
        snapshotHash: checkpoint.workspaceHash,
      });
    }
  }
  return { checkpoint: structuredClone(checkpoint), appliedStepIds };
}

/**
 * Settles with `work`, or rejects as soon as `signal` aborts, so a step that
 * does not observe its signal (such as a template render) still stops at its
 * time limit. The abandoned work's result is discarded.
 */
export function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop));
  });
}
