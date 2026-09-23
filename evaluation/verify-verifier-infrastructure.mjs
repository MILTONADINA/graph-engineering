// Fixed historical acceptance. All candidate code executes only in QuickJS;
// native controllers own SQLite, virtual setup files, counters and output.
import { randomUUID } from "node:crypto";
import { readFile, lstat, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import path from "node:path";
import { validateCorpus, exportTask } from "./corpus-history.mjs";
import { templateJson } from "./candidate-template-invocations.mjs";
import { runCommand } from "./run.mjs";
import {
  guestEnvelope,
  parseGuestJson,
  localDockerEndpoint,
} from "./isolated-candidate.mjs";
import { templateDockerEndpoint } from "./verify-template-invocations.mjs";
import {
  infrastructureCandidateCase,
  validateInfrastructureCandidateFiles,
  checkInfrastructureInventory,
  INFRA_TASK,
} from "./candidate-verifier-infrastructure.mjs";
import {
  infrastructureSetupCases,
  checkInfrastructureSetupObservation,
} from "./candidate-verifier-setup.mjs";
import {
  infrastructureStoreSources,
  infrastructureHash,
  pinnedInfrastructureCandidate,
} from "./infrastructure-runtime/history.mjs";

export { pinnedInfrastructureCandidate } from "./infrastructure-runtime/history.mjs";
export const INFRA_IMAGE = "graph-infrastructure-control-guest:local";
const root = fileURLToPath(new URL("../", import.meta.url));
const sameKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
export function infrastructureCommand(image, name, endpoint, describe = false) {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(image) ||
    !/^graph-infrastructure-[a-f0-9-]{36}$/.test(name)
  )
    throw new Error(
      "Exact infrastructure image and owned container name required",
    );
  return [
    "docker",
    "--host",
    localDockerEndpoint(endpoint),
    "run",
    "--rm",
    "--pull=never",
    "--name",
    name,
    "--network=none",
    "--read-only",
    "--user",
    "65534:65534",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=64",
    "--memory=512m",
    "--memory-swap=512m",
    "--cpus=1",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=32m",
    "--workdir",
    "/opt/infrastructure-guest",
    "--env",
    "NODE_OPTIONS=",
    "--entrypoint",
    "/usr/local/bin/node",
    "-i",
    image,
    "--max-old-space-size=192",
    "/opt/infrastructure-guest/executor.mjs",
    ...(describe ? ["--describe"] : []),
  ];
}
export async function infrastructureImage() {
  const endpoint = await templateDockerEndpoint();
  const result = await runCommand(
    [
      "docker",
      "--host",
      endpoint,
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      INFRA_IMAGE,
    ],
    { timeoutMs: 5000 },
  );
  if (
    result.code !== 0 ||
    result.terminated ||
    !/^sha256:[a-f0-9]{64}$/.test(result.stdout.trim())
  )
    throw new Error("Explicitly provision the infrastructure runtime first");
  return { endpoint, imageId: result.stdout.trim() };
}
async function invoke(imageId, endpoint, input, describe = false) {
  const name = "graph-infrastructure-" + randomUUID();
  try {
    const result = await runCommand(
      infrastructureCommand(imageId, name, endpoint, describe),
      { input, timeoutMs: describe ? 5000 : 12000 },
    );
    if (
      result.code !== 0 ||
      result.terminated ||
      result.stderr ||
      Buffer.byteLength(result.stdout) > 65536
    )
      throw new Error("Infrastructure guest failed or exceeded its deadline");
    return result.stdout;
  } finally {
    await runCommand(["docker", "--host", endpoint, "rm", "-f", name], {
      timeoutMs: 5000,
    });
  }
}
export async function infrastructureRuntimeIdentity(imageId, endpoint) {
  const identity = parseGuestJson(
    await invoke(imageId, endpoint, undefined, true),
  );
  if (
    !sameKeys(identity, ["version", "node", "hashes", "versions"]) ||
    identity.version !== "1.0.0" ||
    !/^v24\.\d+\.\d+$/.test(identity.node ?? "") ||
    !identity.hashes ||
    !identity.versions
  )
    throw new Error("Invalid infrastructure runtime identity");
  const versions = {
    "quickjs-emscripten-core": "0.32.0",
    "@jitl/quickjs-wasmfile-release-sync": "0.32.0",
    typescript: "5.9.3",
    esbuild: "0.28.2",
    "better-sqlite3": "13.0.3",
    picomatch: "4.0.3",
  };
  const names = [
    "executor.mjs",
    "service-controller.mjs",
    "service-fixture.js",
    "service-harness.js",
    "setup-controller.mjs",
    "setup-fixture.js",
    "setup-executor.mjs",
    "build-store.mjs",
    "package-lock.json",
  ];
  if (
    !sameKeys(identity.versions, Object.keys(versions)) ||
    !sameKeys(identity.hashes, [
      ...names,
      "store-bundle.mjs",
      "context.json",
      "wasm",
    ]) ||
    Object.values(identity.hashes).some(
      (hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash),
    )
  )
    throw new Error("Invalid infrastructure dependency/hash inventory");
  for (const [name, version] of Object.entries(versions))
    if (identity.versions[name] !== version)
      throw new Error("Infrastructure runtime dependency mismatch");
  for (const name of names)
    if (
      identity.hashes[name] !==
      infrastructureHash(
        await readFile(
          new URL(`infrastructure-runtime/${name}`, import.meta.url),
        ),
      )
    )
      throw new Error(
        "Infrastructure image is stale relative to reviewed runtime",
      );
  if (
    identity.hashes["context.json"] !==
    infrastructureHash(JSON.stringify(await infrastructureStoreSources()))
  )
    throw new Error("Trusted historical store context mismatch");
  return identity;
}
export async function runInfrastructureServiceFixture(
  files,
  input,
  imageId,
  endpoint,
) {
  const source = validateInfrastructureCandidateFiles(files);
  const packet = JSON.stringify({
    version: "1.0.0",
    mode: "service",
    files: source,
    input,
  });
  if (Buffer.byteLength(packet) > 512 * 1024)
    throw new Error("Infrastructure packet limit");
  return guestEnvelope(await invoke(imageId, endpoint, packet));
}
export async function runInfrastructureSetupFixture(
  files,
  input,
  imageId,
  endpoint,
) {
  const source = validateInfrastructureCandidateFiles(files);
  const packet = JSON.stringify({
    version: "1.0.0",
    mode: "setup",
    files: source,
    input,
  });
  if (Buffer.byteLength(packet) > 512 * 1024)
    throw new Error("Infrastructure packet limit");
  return guestEnvelope(await invoke(imageId, endpoint, packet));
}
export async function verifyInfrastructureCandidate(files) {
  const source = validateInfrastructureCandidateFiles(files);
  const witness = infrastructureCandidateCase();
  // Preflight all source and packet bounds before opening Docker.
  for (const scenario of [
    ...witness.serviceCases,
    ...infrastructureSetupCases(),
  ])
    if (
      Buffer.byteLength(
        JSON.stringify({
          version: "1.0.0",
          mode: "service",
          files: source,
          input: scenario.input,
        }),
      ) >
      512 * 1024
    )
      throw new Error("Infrastructure packet limit");
  const { imageId, endpoint } = await infrastructureImage();
  const runtime = await infrastructureRuntimeIdentity(imageId, endpoint);
  const results = [];
  for (const scenario of witness.serviceCases) {
    let envelope;
    try {
      envelope = await runInfrastructureServiceFixture(
        source,
        scenario.input,
        imageId,
        endpoint,
      );
    } catch {
      envelope = { status: "infrastructure-error", observations: null };
    }
    results.push({
      id: scenario.id,
      status: envelope.status,
      observations: envelope.observations,
      passed:
        envelope.status === "completed" &&
        witness.checkServiceObservation(
          envelope.observations?.service,
          scenario.expected,
        ) &&
        checkInfrastructureInventory(envelope.observations, scenario),
    });
  }
  for (const scenario of infrastructureSetupCases()) {
    let envelope;
    try {
      envelope = await runInfrastructureSetupFixture(
        source,
        scenario.input,
        imageId,
        endpoint,
      );
    } catch {
      envelope = { status: "infrastructure-error", observations: null };
    }
    results.push({
      id: scenario.id,
      status: envelope.status,
      observations: envelope.observations,
      passed:
        envelope.status === "completed" &&
        sameKeys(envelope.observations, ["setup"]) &&
        checkInfrastructureSetupObservation(
          envelope.observations.setup,
          scenario.expected,
        ),
    });
  }
  const verifierHashes = {};
  for (const name of [
    "verify-verifier-infrastructure.mjs",
    "candidate-verifier-infrastructure.mjs",
    "candidate-verifier-setup.mjs",
    "infrastructure-runtime/history.mjs",
    "infrastructure-runtime/provision.mjs",
    "infrastructure-runtime/Dockerfile",
    "verify-template-invocations.mjs",
    "candidate-template-invocations.mjs",
    "run.mjs",
    "isolated-candidate.mjs",
    "corpus-history.mjs",
  ])
    verifierHashes[name] = infrastructureHash(
      await readFile(new URL(name, import.meta.url)),
    );
  return {
    version: "1.0.0",
    taskId: witness.taskId,
    fixtureKind: "known-history-quickjs-native-ledger-and-virtual-setup",
    imageId,
    runtime,
    verifierHashes,
    trustedStoreIdentities: (await infrastructureStoreSources()).identities,
    candidateSources: Object.entries(source).map(([path, value]) => ({
      path,
      sha256: infrastructureHash(value),
      bytes: Buffer.byteLength(value),
    })),
    results,
    allCompleted: results.every((result) => result.status === "completed"),
    passed: results.every((result) => result.passed),
    modelCalls: 0,
    actualNetworkCalls: 0,
    promotionEligible: false,
    limitations: [
      "Known historical fixtures, not held-out tasks, independent labels, paid-provider measurements or promotion evidence.",
      "Full service runs against bounded sequential-workflow capabilities and real historical SQLite RunStore; wider ContextEngine, Git, DAG and publication semantics are not covered.",
      "Setup files and child processes are protected virtual fixtures, including an injected native-cp permission error; no actual npm tests, Docker daemon failure or bind-mount regression is reproduced.",
      "The historical exit-78/stderr marker protocol is unauthenticated: a child can forge the combined pair. The fixture characterizes this limitation, not stronger provenance.",
      "Finite behavioral cases and QuickJS/resource limits are not a proof of arbitrary candidate correctness or a general sandbox guarantee.",
    ],
  };
}

export async function validateInfrastructureHistory() {
  const base = await pinnedInfrastructureCandidate("base"),
    repair = await pinnedInfrastructureCandidate("repair");
  const baseline = await verifyInfrastructureCandidate(base.files),
    repaired = await verifyInfrastructureCandidate(repair.files);
  const witness = infrastructureCandidateCase();
  const baselineFailures = [
    ...witness.serviceCases
      .filter((item) => item.expected.infrastructure)
      .map((item) => item.id),
    "setup-native-cp-eacces-workaround",
    "setup-root-metadata-mismatch",
    "setup-late-metadata-before-any-copy",
    "setup-copy-file-denied",
    "setup-destination-symlink-refused",
    "setup-npm-launch-enoent",
  ];
  return {
    version: "1.0.0",
    taskId: INFRA_TASK,
    baseCommit: witness.baseCommit,
    repairCommit: witness.repairCommit,
    sourceIdentities: { base: base.identities, repair: repair.identities },
    baseline,
    repaired,
    valid:
      baseline.allCompleted &&
      baseline.results.every(
        (item) => item.passed === !baselineFailures.includes(item.id),
      ) &&
      repaired.allCompleted &&
      repaired.passed,
    modelCalls: 0,
    promotionEligible: false,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "validate-history": { type: "boolean" },
      candidate: { type: "string" },
      output: { type: "string" },
      "expected-sha256": { type: "string" },
    },
    allowPositionals: false,
  });
  if (
    Boolean(values["validate-history"]) === Boolean(values.candidate) ||
    !values.output ||
    !/^[a-f0-9]{64}$/.test(values["expected-sha256"] ?? "")
  )
    throw new Error(
      "Choose --validate-history or --candidate FILE and supply --output NEW_FILE --expected-sha256 CORPUS_SHA",
    );
  try {
    await lstat(values.output);
    throw new Error("Output already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const corpus = validateCorpus(
    JSON.parse(
      await readFile(
        new URL("calibration-corpus.json", import.meta.url),
        "utf8",
      ),
    ),
    { expectedSha256: values["expected-sha256"] },
  );
  const packet = await exportTask(corpus, INFRA_TASK, {
    repository: root,
    audience: "review",
  });
  const task = corpus.tasks.find((item) => item.id === INFRA_TASK),
    witness = infrastructureCandidateCase();
  if (
    task.baseCommit !== witness.baseCommit ||
    task.repairCommit !== witness.repairCommit
  )
    throw new Error("Corpus differs from pinned infrastructure fixture");
  let receipt;
  if (values["validate-history"])
    receipt = await validateInfrastructureHistory();
  else {
    const info = await lstat(values.candidate);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024)
      throw new Error("Candidate must be a bounded regular non-symlink file");
    receipt = await verifyInfrastructureCandidate(
      templateJson(await readFile(values.candidate, "utf8"), 512 * 1024),
    );
  }
  await writeFile(
    values.output,
    JSON.stringify(
      {
        corpusSha256: values["expected-sha256"],
        taskSha256: packet.taskSha256,
        historyVerified: Boolean(values["validate-history"]),
        ...receipt,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      output: values.output,
      valid: receipt.valid ?? receipt.passed,
      modelCalls: 0,
      promotionEligible: false,
    }),
  );
  if (!(receipt.valid ?? receipt.passed)) process.exitCode = 1;
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
)
  await main();
