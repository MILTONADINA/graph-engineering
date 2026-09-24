import path from "node:path";
import { z } from "zod";
import {
  consultBothDecisions,
  DualConsultUnavailable,
  taskBindingSchema,
} from "./decision-dual.js";
import { decisionProviders } from "./decisions.js";
import { loadProject, projectDataDir } from "./project.js";
import { RunStore } from "./store.js";
import { readJson } from "./util.js";

const requestSchema = z
  .object({
    ownerId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_.:/-]+$/),
    binding: taskBindingSchema,
    state: z.record(z.unknown()),
    cloudState: z.record(z.unknown()),
    questions: z.array(z.unknown()).min(1).max(12),
  })
  .strict();

/** CLI bridge entrypoint; every observation and metered call is retained locally. */
export async function runDualConsultCli(root: string, requestFile: string) {
  const project = await loadProject(root);
  const request = requestSchema.parse(
    await readJson(path.resolve(requestFile)),
  );
  const dataDir = projectDataDir(project.projectId);
  const providers = await decisionProviders(dataDir);
  if (
    providers.length !== 2 ||
    providers.filter((provider) => provider.id === "laya").length !== 1 ||
    providers.filter((provider) => provider.id === "jev").length !== 1
  )
    throw new Error(
      "Dual consultation requires exactly one configured Laya and Jev provider",
    );
  const store = new RunStore(dataDir, project.projectId);
  try {
    store.bindDecisionOwner(request.ownerId, request.binding);
    const budget = {
      reserve: async ({
        callId,
        provider,
        amountUsd,
      }: {
        callId: string;
        provider: string;
        amountUsd: number;
      }) =>
        store.reserveCall(
          request.ownerId,
          callId,
          provider,
          amountUsd,
          project.policy.maxCostUsd,
        ),
      settle: async (usage: import("./decision-batch.js").DecisionCallUsage) =>
        store.settleCall(request.ownerId, usage.callId, usage.provider, {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: 0,
          costUsd: usage.chargedUsd,
          estimated: usage.reportedCostUsd === null,
        }),
    };
    let evidence;
    try {
      evidence = await consultBothDecisions({
        projectId: project.projectId,
        binding: request.binding,
        state: request.state,
        cloudState: request.cloudState,
        questions:
          request.questions as import("./decision-batch.js").DecisionQuestion[],
        policy: project.policy,
        providers: {
          laya: providers.find((provider) => provider.id === "laya")!,
          jev: providers.find((provider) => provider.id === "jev")!,
        },
        budget,
      });
    } catch (error) {
      if (!(error instanceof DualConsultUnavailable)) throw error;
      evidence = error.evidence;
    }
    for (const observation of Object.values(evidence.observations))
      for (const record of observation.records) store.decision(record);
    store.event(request.ownerId, "decision.dual-consult", {
      binding: evidence.binding,
      policyVersion: evidence.policyVersion,
      ready: evidence.ready,
      observations: Object.fromEntries(
        Object.entries(evidence.observations).map(([provider, observation]) => [
          provider,
          {
            callId: observation.callId,
            observedModel: observation.observedModel,
            choices: observation.choices,
            valid: observation.valid,
            failure: observation.failure,
          },
        ]),
      ),
    });
    return evidence;
  } finally {
    store.close();
  }
}
