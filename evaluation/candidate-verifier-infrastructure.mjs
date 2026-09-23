// Pure intake and independent acceptance. Candidate code is never imported here.
import { types } from "node:util";
import { createHash } from "node:crypto";

export const INFRA_TASK = "verifier-infrastructure-stop";
export const INFRA_BASE = "99133f54c992d998fbd40534670755482aca2817";
export const INFRA_REPAIR = "06e16897649bd72baa90a05f3732474a2292ecdc";
export const INFRA_PATHS = Object.freeze([
  "packages/engine/src/service.ts",
  "scripts/verify-project.mjs",
]);
export const SETUP_MARKER = "[graph-verifier:setup-failed]";

export function checkInfrastructureInventory(observed, scenario) {
  if (
    !plain(observed) ||
    Object.keys(observed).sort().join(",") !== "inventory,service" ||
    !plain(observed.inventory) ||
    Object.keys(observed.inventory).sort().join(",") !== "verification,worker"
  )
    return false;
  const expected = scenario.expected,
    { worker, verification } = observed.inventory;
  const count = expected.workerCalls;
  const checks = expected.verificationCalls + (expected.infrastructure ? 1 : 0);
  if (
    !Array.isArray(worker) ||
    worker.length !== count ||
    !Array.isArray(verification) ||
    verification.length !== checks
  )
    return false;
  return (
    worker.every(
      (item, index) =>
        plain(item) &&
        Object.keys(item).sort().join(",") === "contextText,sequence,usage" &&
        item.sequence === index + 1 &&
        item.contextText === "export const value = " + (index + 1) + ";\n" &&
        same(item.usage, scenario.input.usage),
    ) &&
    verification.every((item, index) => {
      const result =
        index === 0
          ? scenario.input.failure
          : { code: 0, stderr: "", stdout: "" };
      const content =
        "export const value = " +
        (expected.infrastructure ? 2 : index + 2) +
        ";\n";
      return (
        plain(item) &&
        Object.keys(item).sort().join(",") ===
          "code,sequence,snapshotHash,stderr,stdout" &&
        item.sequence === index + 1 &&
        item.code === result.code &&
        item.stderr === result.stderr &&
        item.stdout === result.stdout &&
        item.snapshotHash === createHash("sha256").update(content).digest("hex")
      );
    })
  );
}

function plain(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !types.isProxy(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}
export function validateInfrastructureCandidateFiles(files) {
  if (!plain(files) || Reflect.ownKeys(files).length !== INFRA_PATHS.length)
    throw new Error(
      "Exactly the historical service and verifier script are required",
    );
  const output = {};
  let total = 0;
  for (const key of Reflect.ownKeys(files)) {
    const descriptor = Object.getOwnPropertyDescriptor(files, key);
    if (
      !INFRA_PATHS.includes(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    )
      throw new Error("Unsupported infrastructure candidate path or accessor");
    const source = descriptor.value;
    if (
      typeof source !== "string" ||
      !source.trim() ||
      !source.isWellFormed() ||
      Buffer.byteLength(source) > 100000
    )
      throw new Error("Invalid or oversized infrastructure candidate source");
    total += Buffer.byteLength(source);
    if (total > 150000)
      throw new Error("Infrastructure candidate source limit");
    Object.defineProperty(output, key, { value: source, enumerable: true });
  }
  return Object.freeze(output);
}

const profiles = {
  measured: {
    inputTokens: 17,
    outputTokens: 7,
    cachedTokens: 3,
    costUsd: 0.375,
    estimated: false,
  },
  unknownCost: {
    inputTokens: 17,
    outputTokens: 7,
    cachedTokens: 3,
    costUsd: null,
    estimated: true,
  },
  unknownUsage: {
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    costUsd: null,
    estimated: true,
  },
};
const serviceCases = [];
function addService(
  id,
  code,
  stderr,
  stdout,
  infrastructure,
  profile = "measured",
) {
  serviceCases.push({
    id,
    input: { failure: { code, stderr, stdout }, usage: profiles[profile] },
    expected: {
      infrastructure,
      workerCalls: infrastructure ? 1 : code === 0 ? 1 : 2,
      verificationCalls: infrastructure ? 1 : code === 0 ? 1 : 2,
      usage: profiles[profile],
    },
  });
}
for (const profile of Object.keys(profiles)) {
  addService(
    `docker-125-${profile}`,
    125,
    "Docker daemon could not create the container",
    "",
    true,
    profile,
  );
  addService(
    `setup-78-${profile}`,
    78,
    `${SETUP_MARKER}\nDependency image cannot be prepared`,
    "",
    true,
    profile,
  );
}
addService(
  "ordinary-eacces",
  1,
  "EACCES in authorization test assertion",
  "",
  false,
);
addService(
  "ordinary-78-without-marker",
  78,
  "Test assertion failed",
  "",
  false,
);
addService(
  "marker-with-wrong-status",
  1,
  `${SETUP_MARKER}\nThis is ordinary test output`,
  "",
  false,
);
addService(
  "marker-in-stdout-only",
  78,
  "Test assertion failed",
  SETUP_MARKER,
  false,
);
addService(
  "marker-not-at-stderr-start",
  78,
  `Test output before marker\n${SETUP_MARKER}`,
  "",
  false,
);
addService("passing-check-ignores-marker", 0, SETUP_MARKER, "", false);
addService(
  "ordinary-unknown-usage",
  1,
  "Ordinary assertion failure",
  "",
  false,
  "unknownUsage",
);

function multiplyUsage(usage, calls) {
  return Object.fromEntries(
    Object.entries(usage).map(([key, value]) => [
      key,
      key === "estimated" ? value : value === null ? null : value * calls,
    ]),
  );
}
function same(left, right) {
  if (
    !plain(left) ||
    !plain(right) ||
    Object.keys(left).sort().join(",") !== Object.keys(right).sort().join(",")
  )
    return false;
  return Object.entries(right).every(([key, value]) => left[key] === value);
}
/** Check only protected controller observations; never candidate-returned flags. */
export function checkInfrastructureServiceObservation(observed, expected) {
  if (
    !plain(observed) ||
    Object.keys(observed).sort().join(",") !==
      "first,reconciliationDenied,resumed"
  )
    return false;
  const phase = (
    value,
    calls,
    verifications,
    status,
    usage,
    blocked,
    recoveries,
    content,
  ) =>
    plain(value) &&
    Object.keys(value).sort().join(",") ===
      "accounting,blockedEvents,content,publicationCalls,recoveryEvents,status,usage,verificationCalls,workerCalls" &&
    value.status === status &&
    value.workerCalls === calls &&
    value.verificationCalls === verifications &&
    value.blockedEvents === blocked &&
    value.recoveryEvents === recoveries &&
    value.publicationCalls === (status === "succeeded" ? 1 : 0) &&
    value.content === content &&
    same(value.usage, usage) &&
    plain(value.accounting) &&
    value.accounting.callCount === calls &&
    value.accounting.settledCallCount === calls &&
    value.accounting.unresolvedCallCount === 0 &&
    value.accounting.unknownCostCallCount ===
      (usage.costUsd === null ? calls : 0) &&
    same(value.accounting.totals, usage);
  const calls = expected.workerCalls;
  const usage = multiplyUsage(expected.usage, calls);
  if (
    !phase(
      observed.first,
      calls,
      expected.verificationCalls,
      expected.infrastructure ? "failed" : "succeeded",
      usage,
      expected.infrastructure ? 1 : 0,
      expected.infrastructure ? 0 : Math.max(0, calls - 1),
      `export const value = ${calls + 1};\n`,
    )
  )
    return false;
  if (!expected.infrastructure)
    return observed.reconciliationDenied === null && observed.resumed === null;
  return (
    observed.reconciliationDenied === true &&
    phase(
      observed.resumed,
      calls,
      expected.verificationCalls + 1,
      "succeeded",
      usage,
      1,
      0,
      "export const value = 2;\n",
    )
  );
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
freeze(serviceCases);
export function infrastructureCandidateCase() {
  return Object.freeze({
    taskId: INFRA_TASK,
    baseCommit: INFRA_BASE,
    repairCommit: INFRA_REPAIR,
    serviceCases,
    checkServiceObservation: checkInfrastructureServiceObservation,
  });
}
