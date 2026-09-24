import { realpath } from "node:fs/promises";
import path from "node:path";
import { workspaceFingerprint } from "./execution/workspace.js";
import { loadProject, projectDataDir } from "./project.js";
import { readRunReceipt } from "./store.js";
import { hash } from "./util.js";

/** Recompute the managed workspace hash from a retained run, without recovery. */
export async function readWorkspaceFingerprint(root: string, runId: string) {
  const project = await loadProject(root);
  const dataDir = projectDataDir(project.projectId);
  const { run } = readRunReceipt(dataDir, project.projectId, runId);
  if (!run.workspace || run.branch !== `graph/${runId}`)
    throw new Error("Run receipt has no canonical managed workspace");
  if (run.plan.policyHash !== hash(project.policy))
    throw new Error("Current path policy differs from the run policy");
  const expected = path.join(await realpath(dataDir), "workspaces", runId);
  if (
    path.resolve(run.workspace) !==
      path.resolve(dataDir, "workspaces", runId) ||
    (await realpath(run.workspace)) !== expected
  )
    throw new Error("Run workspace differs from the retained managed path");
  return {
    runId,
    workspace: run.workspace,
    snapshotHash: await workspaceFingerprint(run.workspace, project.policy),
  };
}
