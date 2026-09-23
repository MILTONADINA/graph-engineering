#!/usr/bin/env node
// Host acceptance is independent of candidate CLI output. Source stays inert on
// the host; candidate JavaScript and JSON-schema compilation happen in QuickJS.
import { readFile, lstat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { parseArgs } from "node:util";
import { runCommand } from "./run.mjs";
import {
  localDockerEndpoint,
  parseGuestJson,
  guestEnvelope,
} from "./isolated-candidate.mjs";
import { validateCorpus, exportTask } from "./corpus-history.mjs";
import {
  TEMPLATE_TASK,
  templateCandidateCase,
  validateTemplateCandidateFiles,
  checkTemplateSchemaScope,
  isTemplateObservation,
} from "./candidate-template-invocations.mjs";
import {
  templateHash,
  templateContext,
  pinnedTemplateCandidate,
} from "./template-invocation-runtime/history.mjs";

export { pinnedTemplateCandidate } from "./template-invocation-runtime/history.mjs";
export const TEMPLATE_IMAGE = "graph-template-invocation-guest:local";
const root = fileURLToPath(new URL("../", import.meta.url));
const imagePattern = /^sha256:[a-f0-9]{64}$/;
const hashPattern = /^[a-f0-9]{64}$/;
export async function templateDockerEndpoint() {
  const context = process.env.DOCKER_CONTEXT;
  if (!context && process.env.DOCKER_HOST)
    return localDockerEndpoint(process.env.DOCKER_HOST);
  if (context && (context.length > 256 || !/^[A-Za-z0-9_.-]+$/.test(context)))
    throw new Error("Invalid Docker context");
  const result = await runCommand(
    [
      "docker",
      "context",
      "inspect",
      ...(context ? [context] : []),
      "--format",
      "{{json .Endpoints.docker.Host}}",
    ],
    { timeoutMs: 5000 },
  );
  if (result.code !== 0 || result.terminated)
    throw new Error("Cannot resolve local Docker endpoint");
  return localDockerEndpoint(parseGuestJson(result.stdout));
}
export function templateDockerCommand(
  imageId,
  name,
  endpoint,
  describe = false,
) {
  if (
    !imagePattern.test(imageId) ||
    !/^graph-template-[a-f0-9-]{36}$/.test(name)
  )
    throw new Error(
      "Exact template image and owned container identity required",
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
    "/tmp:rw,noexec,nosuid,nodev,size=16m",
    "--workdir",
    "/opt/template-guest",
    "--env",
    "NODE_OPTIONS=",
    "--entrypoint",
    "/usr/local/bin/node",
    "-i",
    imageId,
    "--max-old-space-size=192",
    "/opt/template-guest/executor.mjs",
    ...(describe ? ["--describe"] : []),
  ];
}
async function invoke(imageId, endpoint, input, describe = false) {
  const name = `graph-template-${randomUUID()}`;
  try {
    const result = await runCommand(
      templateDockerCommand(imageId, name, endpoint, describe),
      {
        cwd: root,
        input: input ?? undefined,
        timeoutMs: 7500,
      },
    );
    if (
      result.code !== 0 ||
      result.terminated ||
      result.stderr ||
      Buffer.byteLength(result.stdout) > 65536
    )
      throw new Error("Template guest infrastructure failure or deadline");
    return result.stdout;
  } finally {
    await runCommand(["docker", "--host", endpoint, "rm", "-f", name], {
      cwd: root,
      timeoutMs: 5000,
      maxOutputBytes: 4096,
    });
  }
}
function keys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...expected].sort().join(",")
  );
}
async function runtimeIdentity(imageId, endpoint, context) {
  const value = parseGuestJson(await invoke(imageId, endpoint, null, true));
  const names = [
    "executor.mjs",
    "fixture.js",
    "build-ajv.mjs",
    "package-lock.json",
    "context.json",
    "ajv-guest.js",
    "wasm",
  ];
  if (
    !keys(value, ["version", "node", "versions", "hashes"]) ||
    value.version !== "1.0.0" ||
    !/^v24\.\d+\.\d+$/.test(value.node) ||
    !keys(value.versions, ["quickjs", "wasm", "ajv", "formats", "esbuild"]) ||
    Object.entries({
      quickjs: "0.32.0",
      wasm: "0.32.0",
      ajv: "8.17.1",
      formats: "3.0.1",
      esbuild: "0.28.2",
    }).some(([name, version]) => value.versions[name] !== version) ||
    !keys(value.hashes, names) ||
    Object.values(value.hashes).some(
      (hash) => typeof hash !== "string" || !hashPattern.test(hash),
    )
  )
    throw new Error("Invalid template runtime identity");
  for (const name of [
    "executor.mjs",
    "fixture.js",
    "build-ajv.mjs",
    "package-lock.json",
  ])
    if (
      value.hashes[name] !==
      templateHash(
        await readFile(
          new URL(`template-invocation-runtime/${name}`, import.meta.url),
        ),
      )
    )
      throw new Error(
        "Provisioned template runtime does not match reviewed local source",
      );
  if (value.hashes["context.json"] !== templateHash(JSON.stringify(context)))
    throw new Error(
      "Provisioned schemas do not match pinned baseline Git bytes",
    );
  return value;
}
export async function verifyTemplateCandidate(files) {
  const source = validateTemplateCandidateFiles(files);
  const context = await templateContext();
  checkTemplateSchemaScope(
    source,
    Object.fromEntries(
      Object.entries(context.schemas).map(([name, value]) => [
        `graph-templates/artifacts/${name}`,
        value,
      ]),
    ),
  );
  const witness = templateCandidateCase();
  // Freeze and bound all serialized packets before opening Docker. Expectations
  // and scenario IDs are deliberately absent from every guest request.
  const packets = witness.scenarios.map((scenario) => {
    const text = JSON.stringify({
      version: "1.0.0",
      files: source,
      input: scenario.input,
    });
    if (Buffer.byteLength(text) > 512 * 1024)
      throw new Error("Template guest input packet limit");
    return text;
  });
  const endpoint = await templateDockerEndpoint();
  const inspected = await runCommand(
    [
      "docker",
      "--host",
      endpoint,
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      TEMPLATE_IMAGE,
    ],
    { timeoutMs: 5000 },
  );
  if (
    inspected.code !== 0 ||
    inspected.terminated ||
    !imagePattern.test(inspected.stdout.trim())
  )
    throw new Error(
      "Explicitly provision the template guest image before offline verification",
    );
  const imageId = inspected.stdout.trim();
  const runtime = await runtimeIdentity(imageId, endpoint, context);
  const results = [];
  for (let index = 0; index < packets.length; index++) {
    const scenario = witness.scenarios[index];
    let status = "infrastructure-error",
      observed = null,
      passed = false;
    try {
      const envelope = guestEnvelope(
        await invoke(imageId, endpoint, packets[index]),
      );
      status = envelope.status;
      if (status === "completed") {
        if (
          !keys(envelope.observations, ["exitCode", "resultText"]) ||
          typeof envelope.observations.resultText !== "string"
        )
          throw new Error("Invalid observed template CLI envelope");
        observed = {
          exitCode: envelope.observations.exitCode,
          result: parseGuestJson(envelope.observations.resultText),
        };
        if (!isTemplateObservation(observed)) {
          status = "candidate-error";
          observed = null;
        } else passed = witness.checkObservation(observed, scenario.expected);
      }
    } catch {
      status = "infrastructure-error";
    }
    results.push({ id: scenario.id, status, passed, observed });
  }
  const verifierHashes = {};
  for (const name of [
    "verify-template-invocations.mjs",
    "candidate-template-invocations.mjs",
    "template-invocation-runtime/history.mjs",
    "run.mjs",
    "isolated-candidate.mjs",
    "corpus-history.mjs",
  ])
    verifierHashes[name] = templateHash(
      await readFile(new URL(name, import.meta.url)),
    );
  return {
    version: "1.0.0",
    taskId: TEMPLATE_TASK,
    fixtureKind: "known-history-quickjs-json-schema-behavior",
    imageId,
    runtime,
    verifierHashes,
    baselineSchemaIdentities: context.identities,
    candidateSources: Object.entries(source).map(([name, value]) => ({
      path: name,
      sha256: templateHash(value),
      bytes: Buffer.byteLength(value),
    })),
    allCompleted: results.every((result) => result.status === "completed"),
    passed: results.every((result) => result.passed),
    results,
    modelCalls: 0,
    actualNetworkCalls: 0,
    promotionEligible: false,
    limitations: [
      "Known historical fixtures, not unseen tasks, independent labels, paired worker measurements or promotion evidence.",
      "Finite fixture coverage rejects specified regressions; it is not a proof of validator correctness for arbitrary graphs.",
      "The operator provisions the reviewed local image. Resource limits and QuickJS reduce exposure but are not a general sandbox guarantee.",
    ],
  };
}
export async function validateTemplateHistory() {
  const base = await pinnedTemplateCandidate("base"),
    repair = await pinnedTemplateCandidate("repair");
  const baseline = await verifyTemplateCandidate(base.files),
    repaired = await verifyTemplateCandidate(repair.files);
  const witness = templateCandidateCase();
  return {
    version: "1.0.0",
    taskId: TEMPLATE_TASK,
    baseCommit: witness.baseCommit,
    repairCommit: witness.repairCommit,
    sourceIdentities: { base: base.identities, repair: repair.identities },
    baseline,
    repaired,
    valid:
      baseline.allCompleted &&
      !baseline.passed &&
      witness.baselineFailureIds.every((id) =>
        baseline.results.some((result) => result.id === id && !result.passed),
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
    !hashPattern.test(values["expected-sha256"] ?? "")
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
  const corpusBytes = await readFile(
    new URL("calibration-corpus.json", import.meta.url),
  );
  const validated = validateCorpus(JSON.parse(corpusBytes.toString("utf8")), {
    expectedSha256: values["expected-sha256"],
  });
  const packet = await exportTask(validated, TEMPLATE_TASK, {
    repository: root,
    audience: "review",
  });
  const witness = templateCandidateCase();
  const corpusTask = validated.tasks.find((task) => task.id === TEMPLATE_TASK);
  if (
    corpusTask.baseCommit !== witness.baseCommit ||
    corpusTask.repairCommit !== witness.repairCommit
  )
    throw new Error("Corpus task differs from the pinned template fixture");
  let receipt;
  if (values["validate-history"]) receipt = await validateTemplateHistory();
  else {
    const info = await lstat(values.candidate);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024)
      throw new Error(
        "Candidate input must be a bounded regular non-symlink file",
      );
    const { templateJson } =
      await import("./candidate-template-invocations.mjs");
    const text = await readFile(values.candidate, "utf8");
    receipt = await verifyTemplateCandidate(templateJson(text, 512 * 1024));
  }
  await writeFile(
    values.output,
    JSON.stringify(
      {
        corpusSha256: values["expected-sha256"],
        taskSha256: packet.taskSha256,
        historyVerified: true,
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
