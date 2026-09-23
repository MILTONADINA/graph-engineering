import { GraphEngine } from "candidate:service";
import { fixtureWorker, verifyInContainer } from "graph:fixture";

export async function start(planId) {
  const engine = await GraphEngine.open("/project", {
    worker: fixtureWorker,
    verify: verifyInContainer,
    dockerAvailable: async () => true,
  });
  try {
    await engine.wait((await engine.start(planId)).id);
  } finally {
    await engine.close();
  }
}
export async function resume(runId, acknowledged) {
  const engine = await GraphEngine.open("/project", {
    worker: fixtureWorker,
    verify: verifyInContainer,
    dockerAvailable: async () => true,
  });
  try {
    await engine.resume(runId, acknowledged);
    await engine.wait(runId);
    return "resumed";
  } catch (error) {
    if (
      !acknowledged &&
      error.message.includes("explicit reconciliation acknowledgement")
    )
      return "reconciliation-required";
    throw error;
  } finally {
    await engine.close();
  }
}
