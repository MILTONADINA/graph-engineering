import type {
  ExecutionStep,
  ProjectPolicy,
  Usage,
} from "@graph-engineering/contracts";
import {
  mkdir,
  readFile,
  realpath,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hash, now } from "../util.js";
import {
  globAllowlist,
  isAllowedPath,
  safePath,
  validGlobEntry,
} from "../policy.js";
import {
  proposalSchema,
  type WorkerProposal,
  type WorkerResult,
} from "../workers/api.js";
import {
  applyProposal,
  assertVerificationPaths,
  prepareProposal,
  workspaceFingerprint,
} from "./workspace.js";

/** The engine's repair step after a plan's combined checks fail; plans may not use its ID. */
export const DAG_REPAIR_STEP = "dag-repair";
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
  /** Every file an applied repair patch wrote; repairs run once every step completed. */
  repairPaths?: string[];
  pending?: {
    /** A plan step, or DAG_REPAIR_STEP for a repair patch. */
    stepId: string;
    proposalHash: string;
    beforeHash: string;
    /** Workspace fingerprint once the patch is on disk, before its checks. */
    afterHash?: string;
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
  /**
   * The operator acknowledged the retained state (`resume --reconciled`), so a
   * pending patch application is resolved by fingerprint: a workspace at its
   * pre-patch state re-runs the step, one at its post-patch state records it
   * as applied, and anything else still refuses.
   */
  reconcilePending?: boolean;
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
    // `!pattern` entries exclude from the positive entries; a list of only
    // exclusions would otherwise read as "everything else".
    writes: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(50)
      .refine((writes) => writes.every(validGlobEntry), {
        message: 'A writes entry must not be "!" alone or start with "!!"',
      })
      .refine((writes) => writes.some((entry) => !entry.startsWith("!")), {
        message: "writes needs at least one pattern that is not an exclusion",
      })
      .optional(),
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
    // At most policy.maxTurns (100) repair patches of 50 files each.
    repairPaths: z.array(z.string()).max(5000).optional(),
    pending: z
      .object({
        stepId: z.string(),
        proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
        beforeHash: z.string().regex(/^[a-f0-9]{64}$/),
        afterHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        paths: z.array(z.string()).max(50),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Whether a step may write a file: its declared `writes` globs (where a
 * `!pattern` entry excludes) and any scheduler-supplied paths both apply.
 * Undefined means unrestricted.
 */
export function writeScope(
  step: ExecutionStep,
  writeScopes?: Record<string, string[]>,
): ((file: string) => boolean) | undefined {
  const declared = step.writes?.length ? globAllowlist(step.writes) : undefined;
  const supplied = writeScopes?.[step.id]?.map(exactPath);
  if (!declared && !supplied) return undefined;
  return (file) =>
    (!declared || declared(file)) &&
    (!supplied || supplied.includes(exactPath(file)));
}
// One spelling per relative path for exact-list membership, so `./a.ts`,
// `a\b.ts` and `a//b.ts` match the file listed as `a.ts` or `a/b.ts`.
// Brackets and other glob characters stay literal; case is kept.
function exactPath(file: string): string {
  return path.posix
    .normalize(file.normalize("NFC").replaceAll("\\", "/"))
    .replace(/^(\.\/)+/, "");
}
export function validateDag(input: ExecutionStep[]): ValidatedDag {
  const steps = z.array(stepSchema).min(1).max(100).parse(input);
  const byId = new Map(steps.map((step) => [step.id, step]));
  if (byId.size !== steps.length)
    throw new Error("DAG step IDs must be unique");
  for (const step of steps) {
    // Reserved for the engine's repair step after failed combined checks.
    if (step.id === DAG_REPAIR_STEP)
      throw new Error(`Step ID ${DAG_REPAIR_STEP} is reserved`);
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

/**
 * Every file a checkpoint records as written: its completed steps' and its
 * applied repairs'. A crash can stop a run after a completion is saved but
 * before its event is recorded, and an acknowledged resume records an
 * interrupted patch as applied without one, so the checkpoint, not the
 * run's events, is the record of what the DAG wrote.
 */
export function checkpointPaths(checkpoint: DagCheckpoint): string[] {
  return [
    ...checkpoint.completed.flatMap((item) => item.paths),
    ...(checkpoint.repairPaths ?? []),
  ];
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
  const save = async () => options.saveCheckpoint(structuredClone(checkpoint));
  const event = async (
    type: string,
    stepId: string | undefined,
    data: Record<string, unknown>,
  ) => options.onEvent?.({ type, stepId, data });
  if (checkpoint.pending) {
    const pending = checkpoint.pending;
    // A repair patch follows every completed step and is recorded in
    // repairPaths, never as a completed step.
    const repair = pending.stepId === DAG_REPAIR_STEP;
    if (!options.reconcilePending)
      throw new DagReconciliationError(
        `Step ${pending.stepId} was interrupted during patch application; inspect the retained workspace, then resume with explicit reconciliation acknowledgement`,
      );
    const unresolved = (reason: string) =>
      new DagReconciliationError(
        `Step ${pending.stepId} was interrupted during patch application and ${reason}. ` +
          `Restore ${pending.paths.join(", ") || "its files"} in the retained workspace to their content before the step ` +
          `(the step then runs again)${pending.afterHash ? " or to the step's complete patch (the step is then recorded as applied)" : ""}, ` +
          `and resume with reconciliation acknowledgement again; or leave this run and create a new plan to start a fresh run.`,
      );
    const done = (id: string) =>
      checkpoint.completed.some((item) => item.id === id);
    if (
      pending.beforeHash !== checkpoint.workspaceHash ||
      (repair
        ? dag.steps.some((step) => !done(step.id))
        : !dag.ancestors.has(pending.stepId) ||
          done(pending.stepId) ||
          [...dag.ancestors.get(pending.stepId)!].some(
            (dependency) => !done(dependency),
          )) ||
      pending.paths.some((file) => !isAllowedPath(file, policy))
    )
      throw unresolved("its checkpoint record is inconsistent with the plan");
    if (snapshotHash === pending.beforeHash) {
      delete checkpoint.pending;
      await save();
      await event("dag.step.reconciled", pending.stepId, {
        outcome: "not_applied",
        paths: pending.paths,
      });
    } else if (pending.afterHash && snapshotHash === pending.afterHash) {
      try {
        await assertVerificationPaths(
          workspace,
          [...checkpointPaths(checkpoint), ...pending.paths],
          policy,
        );
      } catch (error) {
        throw unresolved(
          `its applied patch fails the verification inventory check (${(error as Error).message})`,
        );
      }
      checkpoint = repair
        ? {
            ...checkpoint,
            workspaceHash: pending.afterHash,
            repairPaths: withRepairPaths(checkpoint, pending.paths),
          }
        : {
            ...checkpoint,
            workspaceHash: pending.afterHash,
            completed: [
              ...checkpoint.completed,
              {
                id: pending.stepId,
                proposalHash: pending.proposalHash,
                paths: pending.paths,
                completedAt: now(),
              },
            ],
          };
      delete checkpoint.pending;
      await save();
      await event("dag.step.reconciled", pending.stepId, {
        outcome: "applied",
        paths: pending.paths,
        snapshotHash: checkpoint.workspaceHash,
      });
    } else
      throw unresolved(
        pending.afterHash
          ? "the retained workspace matches neither its state before the patch nor after it"
          : "the retained workspace no longer matches its state before the patch, and no complete patch was recorded",
      );
  }
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
  if (
    checkpoint.repairPaths?.length &&
    (completed.size < dag.steps.length ||
      checkpoint.repairPaths.some((file) => !isAllowedPath(file, policy)))
  )
    throw new DagReconciliationError(
      "DAG checkpoint has invalid completion ordering or paths",
    );
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  const checkCancelled = () => {
    if (signal.aborted) throw new Error("DAG execution cancelled");
  };
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
      // A crash from this point is reconciliation-required: a resume matches
      // the workspace against the pre-patch and post-patch fingerprints.
      await save();
      const originals = await captureOriginals(workspace, paths, policy);
      let afterHash: string;
      try {
        await applyProposal(workspace, proposal, policy);
        afterHash = await workspaceFingerprint(workspace, policy);
        checkpoint.pending = { ...checkpoint.pending, afterHash };
        await save();
        // Evaluate after application too: this patch may itself change ignore
        // rules that hide a sibling's earlier output.
        await assertVerificationPaths(
          workspace,
          [...checkpointPaths(checkpoint), ...paths],
          policy,
        );
      } catch (error) {
        // Undo it, so the run stops cleanly at its pre-step state instead
        // of leaving a pending marker.
        await rollBack(checkpoint, originals, error, {
          workspace,
          policy,
          save,
          event,
        });
        throw new Error(
          `${(error as Error)?.message ?? String(error)} Step ${step.id}'s patch was rolled back; the workspace is at its pre-step state, and resuming with reconciliation acknowledgement runs the step again.`,
          { cause: error },
        );
      }
      checkpoint = {
        ...checkpoint,
        workspaceHash: afterHash,
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

export interface RepairOptions {
  workspace: string;
  policy: ProjectPolicy;
  /** The plan's checkpoint, with every step completed. */
  checkpoint: DagCheckpoint;
  proposal: WorkerProposal;
  /** Must durably persist before resolving; JSON writes should use atomic rename. */
  saveCheckpoint: (checkpoint: DagCheckpoint) => Promise<void>;
  onEvent?: (event: DagEvent) => Promise<void> | void;
}
/**
 * Applies a repair patch to a plan's completed result with a step's crash
 * discipline. The patch is validated first, so a precondition failure
 * records nothing. A pending marker with the pre-patch fingerprint is saved
 * before any write and the post-patch fingerprint once the patch is on disk;
 * a failed application is rolled back; completion moves the checkpoint to
 * the post-patch fingerprint and records the files in `repairPaths`. An
 * acknowledged resume reconciles an interrupted repair like a step.
 */
export async function applyRepair(
  options: RepairOptions,
): Promise<{ checkpoint: DagCheckpoint; paths: string[] }> {
  const { workspace, policy, proposal } = options;
  let checkpoint: DagCheckpoint = checkpointSchema.parse(options.checkpoint);
  if (checkpoint.pending)
    throw new DagReconciliationError(
      `Step ${checkpoint.pending.stepId} still has an unresolved patch application`,
    );
  await prepareProposal(workspace, proposal, policy);
  const paths = [...new Set(proposal.changes.map((change) => change.path))];
  if (!paths.length) return { checkpoint, paths };
  if (
    (await workspaceFingerprint(workspace, policy)) !== checkpoint.workspaceHash
  )
    throw new DagReconciliationError(
      "Workspace changed before the repair patch was applied",
    );
  const save = async () => options.saveCheckpoint(structuredClone(checkpoint));
  const originals = await captureOriginals(workspace, paths, policy);
  checkpoint.pending = {
    stepId: DAG_REPAIR_STEP,
    proposalHash: hash(proposal),
    beforeHash: checkpoint.workspaceHash,
    paths,
  };
  await save();
  let afterHash: string;
  try {
    await applyProposal(workspace, proposal, policy);
    afterHash = await workspaceFingerprint(workspace, policy);
    checkpoint.pending = { ...checkpoint.pending, afterHash };
    await save();
  } catch (error) {
    await rollBack(checkpoint, originals, error, {
      workspace,
      policy,
      save,
      event: (type, stepId, data) => options.onEvent?.({ type, stepId, data }),
    });
    throw new Error(
      `${(error as Error)?.message ?? String(error)} The repair patch was rolled back; the workspace is at its state before the repair.`,
      { cause: error },
    );
  }
  checkpoint = {
    ...checkpoint,
    workspaceHash: afterHash,
    repairPaths: withRepairPaths(checkpoint, paths),
  };
  delete checkpoint.pending;
  await save();
  return { checkpoint: structuredClone(checkpoint), paths };
}
function withRepairPaths(checkpoint: DagCheckpoint, paths: string[]) {
  return [...new Set([...(checkpoint.repairPaths ?? []), ...paths])];
}

/**
 * Undoes a patch that failed during or after application: restores each
 * file it touched, removes directories it created, confirms the pre-patch
 * fingerprint, clears the pending marker and records the rollback. If the
 * workspace cannot be restored, the marker stays and the run needs
 * reconciliation.
 */
async function rollBack(
  checkpoint: DagCheckpoint,
  originals: Originals,
  cause: unknown,
  context: {
    workspace: string;
    policy: ProjectPolicy;
    save: () => Promise<void>;
    event: (
      type: string,
      stepId: string | undefined,
      data: Record<string, unknown>,
    ) => Promise<void> | void;
  },
): Promise<void> {
  const pending = checkpoint.pending!;
  const reason = (cause as Error)?.message ?? String(cause);
  try {
    await restoreOriginals(originals);
    if (
      (await workspaceFingerprint(context.workspace, context.policy)) !==
      pending.beforeHash
    )
      throw new Error("the workspace does not match its pre-patch state");
    delete checkpoint.pending;
    await context.save();
  } catch (error) {
    throw new DagReconciliationError(
      `Step ${pending.stepId} failed after patch application (${reason}) and could not be rolled back (${(error as Error).message}); inspect the retained workspace, then resume with reconciliation acknowledgement or create a new plan`,
    );
  }
  await context.event("dag.step.rolled_back", pending.stepId, {
    error: reason,
    paths: pending.paths,
  });
}

interface Originals {
  files: { absolute: string; content: Buffer | null }[];
  /** Directories the patch may create, deepest first. */
  directories: string[];
}
async function captureOriginals(
  workspace: string,
  paths: string[],
  policy: ProjectPolicy,
): Promise<Originals> {
  const files: Originals["files"] = [],
    directories = new Set<string>();
  const root = await realpath(workspace); // safePath resolves from here
  for (const file of paths) {
    const absolute = await safePath(workspace, file, policy);
    let content: Buffer | null = null;
    try {
      content = await readFile(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    files.push({ absolute, content });
    for (
      let directory = path.dirname(absolute);
      directory.startsWith(`${root}${path.sep}`);
      directory = path.dirname(directory)
    ) {
      try {
        await stat(directory);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        directories.add(directory);
      }
    }
  }
  return {
    files,
    directories: [...directories].sort((a, b) => b.length - a.length),
  };
}
async function restoreOriginals(originals: Originals): Promise<void> {
  for (const { absolute, content } of originals.files) {
    if (content === null) {
      try {
        await unlink(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else {
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    }
  }
  for (const directory of originals.directories) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (
        !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  }
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
