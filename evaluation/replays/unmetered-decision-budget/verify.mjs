import { historicalDecisionAdapter } from "./adapter.mjs";

// Independent acceptance checks; neither historical tests nor a generated success marker is trusted.
export async function verifyHistoricalDecisionBudget(files) {
  const decide = historicalDecisionAdapter(
    files["packages/engine/src/decisions.ts"],
  );
  const checks = [];
  const make = (provider, cap, offline = false) => ({
    projectId: "historical-fixture-only",
    category: "worker",
    state: { task: "Fixture routing observation, not calibration evidence" },
    candidates: { local: "Local action", frontier: "Frontier action" },
    baseline: "local",
    policy: {
      inference: offline ? "local" : "allowlisted",
      network: offline ? "deny" : "allowlisted",
      allowedHosts: ["api.typesafe.ai"],
      providers: [provider],
      maxCostUsd: cap,
      decisionMode: "shadow",
      promotedCategories: [],
    },
    providers: [
      {
        id: provider,
        endpoint:
          provider === "laya"
            ? "http://127.0.0.1:7337/v1/decide"
            : "https://api.typesafe.ai/v1/systemone",
        model: "fixture-input-only",
        maxStateChars: 1200,
      },
    ],
    evidence: [],
  });
  for (const cap of [0, 0.25, 1]) {
    const observed = await decide(make("jev", cap));
    checks.push({
      id: `capped-unmetered-${cap}`,
      passed:
        observed.requests.length === 0 &&
        observed.selected === null &&
        !!observed.failure,
      observed: {
        dispatches: observed.requests.length,
        abstained: observed.selected === null,
        auditedFailure: !!observed.failure,
      },
    });
  }
  for (const [provider, cap, offline, expectedDispatches] of [
    ["jev", null, false, 1],
    ["laya", 0, false, 1],
    ["jev", null, true, 0],
  ]) {
    const observed = await decide(make(provider, cap, offline));
    checks.push({
      id: `${provider}-${cap}-${offline ? "offline" : "allowed"}`,
      passed:
        observed.requests.length === expectedDispatches &&
        (expectedDispatches
          ? observed.selected === "frontier"
          : observed.selected === null) &&
        observed.baseline === "local" &&
        observed.mode === "shadow",
      observed: {
        dispatches: observed.requests.length,
        abstained: observed.selected === null,
        baselinePreserved: observed.baseline === "local",
        shadow: observed.mode === "shadow",
      },
    });
  }
  return {
    success: checks.every((check) => check.passed),
    checks,
    actualNetworkCalls: 0,
    modelCalls: 0,
    limitations: [
      "All provider responses and endpoint policy checks are controlled fixtures, not Jev/Laya measurements.",
      "Historical source is trusted and instrumented in-process; this is not an arbitrary generated-code verifier.",
      "The historical unmetered adapter differs from the current priced/reserved implementation.",
    ],
  };
}
