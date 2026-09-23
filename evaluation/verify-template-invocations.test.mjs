import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runCommand } from "./run.mjs";
import { guestEnvelope, parseGuestJson } from "./isolated-candidate.mjs";
import {
  TEMPLATE_PATHS,
  templateCandidateCase,
} from "./candidate-template-invocations.mjs";
import {
  TEMPLATE_IMAGE,
  templateDockerCommand,
  templateDockerEndpoint,
  pinnedTemplateCandidate,
  validateTemplateHistory,
  verifyTemplateCandidate,
} from "./verify-template-invocations.mjs";

const native = process.env.GRAPH_ENGINE_TEMPLATE_GUEST_TESTS === "1";
const image = "sha256:" + "a".repeat(64);
test("template Docker commands are local offline immutable and resource-bounded", () => {
  const command = templateDockerCommand(
    image,
    "graph-template-" + randomUUID(),
    "unix:///fixture/docker.sock",
  );
  for (const value of [
    "--network=none",
    "--read-only",
    "--pull=never",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--memory=512m",
    "--memory-swap=512m",
    "--pids-limit=64",
    "--cpus=1",
    "65534:65534",
    "NODE_OPTIONS=",
    "--max-old-space-size=192",
  ])
    assert.ok(command.includes(value), value);
  assert.equal(command.includes("--volume"), false);
  assert.equal(command.includes("--mount"), false);
  assert.equal(command.includes("--privileged"), false);
  for (const endpoint of [
    "tcp://127.0.0.1:2375",
    "ssh://remote",
    "unix://relative",
    "npipe:////remote/pipe/docker_engine",
  ])
    assert.throws(() =>
      templateDockerCommand(image, "graph-template-" + randomUUID(), endpoint),
    );
  assert.throws(() =>
    templateDockerCommand(
      "node:latest",
      "graph-template-" + randomUUID(),
      "unix:///fixture/docker.sock",
    ),
  );
  assert.throws(() =>
    templateDockerCommand(image, "unowned", "unix:///fixture/docker.sock"),
  );
});

test("unsafe source maps are refused before Docker is opened", async () => {
  await assert.rejects(
    verifyTemplateCandidate({ "../../index.js": "x" }),
    /required/,
  );
});

async function guest(files, input) {
  const endpoint = await templateDockerEndpoint();
  const inspect = await runCommand(
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
  assert.equal(
    inspect.code,
    0,
    "Explicitly provision the template runtime first",
  );
  const name = "graph-template-" + randomUUID();
  try {
    const result = await runCommand(
      templateDockerCommand(inspect.stdout.trim(), name, endpoint),
      {
        input: JSON.stringify({ version: "1.0.0", files, input }),
        timeoutMs: 7500,
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.terminated, false);
    assert.equal(result.stderr, "");
    return guestEnvelope(result.stdout);
  } finally {
    await runCommand(["docker", "--host", endpoint, "rm", "-f", name], {
      timeoutMs: 5000,
    });
  }
}

test(
  "real QuickJS baseline fails and repaired historical CLI passes every independent fixture",
  { skip: !native },
  async () => {
    const receipt = await validateTemplateHistory();
    assert.equal(
      receipt.baseline.allCompleted,
      true,
      JSON.stringify(
        receipt.baseline.results.filter((item) => item.status !== "completed"),
      ),
    );
    assert.equal(
      receipt.repaired.allCompleted,
      true,
      JSON.stringify(
        receipt.repaired.results.filter((item) => item.status !== "completed"),
      ),
    );
    assert.equal(
      receipt.repaired.passed,
      true,
      JSON.stringify(receipt.repaired.results.filter((item) => !item.passed)),
    );
    assert.equal(receipt.valid, true);
    assert.equal(receipt.modelCalls, 0);
    assert.equal(receipt.promotionEligible, false);
    assert.equal(
      receipt.baseline.results.length,
      templateCandidateCase().scenarios.length,
    );
  },
);

test(
  "candidate code has no Node host modules or real filesystem/network",
  { skip: !native },
  async () => {
    const input = templateCandidateCase().scenarios[0].input;
    const log =
      "console.log(JSON.stringify({valid:true,errors:[],warnings:[],repairs:[]}));";
    for (const source of [
      `try { require('node:child_process'); } catch {} ${log}`,
      `try { require('node:fs').readFileSync('/etc/passwd','utf8'); } catch {} ${log}`,
      `require('node:http'); ${log}`,
      `globalThis.constructor.constructor('return process')().exit(9); ${log}`,
      "while (true) {}",
      "Promise.resolve().then(() => {});" + log,
    ]) {
      const result = await guest({ [TEMPLATE_PATHS[0]]: source }, input);
      assert.deepEqual(
        result,
        { version: "1.0.0", status: "candidate-error", observations: null },
        source,
      );
    }
  },
);

test(
  "constant acceptance and rejected duplicate keys cannot manufacture fixture success",
  { skip: !native },
  async () => {
    const witness = templateCandidateCase();
    const negative = witness.scenarios.find(
      (item) => item.id === "duplicate-instance",
    );
    const output = await guest(
      {
        [TEMPLATE_PATHS[0]]:
          "console.log(JSON.stringify({valid:true,errors:[],warnings:[],repairs:[]}));",
      },
      negative.input,
    );
    assert.equal(output.status, "completed");
    assert.equal(
      witness.checkObservation(
        {
          exitCode: output.observations.exitCode,
          result: parseGuestJson(output.observations.resultText),
        },
        negative.expected,
      ),
      false,
    );
    const duplicate = await guest(
      {
        [TEMPLATE_PATHS[0]]:
          'console.log(\'{"valid":false,"valid":true,"errors":[],"warnings":[],"repairs":[]}\');',
      },
      negative.input,
    );
    assert.throws(
      () => parseGuestJson(duplicate.observations.resultText),
      /Duplicate/,
    );
  },
);

test(
  "missing supplementary schema repair fails actual schema validation",
  { skip: !native },
  async () => {
    const repair = await pinnedTemplateCandidate("repair");
    delete repair.files[TEMPLATE_PATHS[3]];
    delete repair.files[TEMPLATE_PATHS[4]];
    const scenario = templateCandidateCase().scenarios[0];
    const output = await guest(repair.files, scenario.input);
    assert.equal(output.status, "completed");
    const result = parseGuestJson(output.observations.resultText);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((item) => item.check === "invalid-schemas"));
  },
);

test(
  "candidate prototype hooks cannot rewrite the captured CLI exit status",
  { skip: !native },
  async () => {
    const scenario = templateCandidateCase().scenarios[0];
    const source = `
    const text = '{"valid":true,"errors":[],"warnings":[],"repairs":[]}';
    Object.prototype.toJSON = () => ({ exitCode: 0, resultText: text });
    Array.prototype.includes = () => true;
    console.log(text);
    process.exitCode = 1;
  `;
    const output = await guest({ [TEMPLATE_PATHS[0]]: source }, scenario.input);
    assert.equal(output.status, "completed");
    assert.equal(output.observations.exitCode, 1);
    assert.equal(
      templateCandidateCase().checkObservation(
        {
          exitCode: output.observations.exitCode,
          result: parseGuestJson(output.observations.resultText),
        },
        scenario.expected,
      ),
      false,
    );
  },
);

test(
  "candidate schema recursion executes only in the bounded interpreter",
  { skip: !native },
  async () => {
    const repair = await pinnedTemplateCandidate("repair");
    const schema = JSON.parse(repair.files[TEMPLATE_PATHS[3]]);
    schema.allOf = [{ $ref: "architecture.schema.json" }];
    repair.files[TEMPLATE_PATHS[3]] = JSON.stringify(schema);
    const output = await guest(
      repair.files,
      templateCandidateCase().scenarios[0].input,
    );
    // A caught schema recursion error may be a normal invalid-schemas finding;
    // uncaught resource/stack limits are candidate-error. Neither can pass.
    if (output.status === "completed") {
      const result = parseGuestJson(output.observations.resultText);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((item) => item.check === "invalid-schemas"));
    } else assert.equal(output.status, "candidate-error");
  },
);

test(
  "malformed candidate output never counts as completed baseline behavior",
  { skip: !native },
  async () => {
    const receipt = await verifyTemplateCandidate({
      [TEMPLATE_PATHS[0]]:
        "console.log(JSON.stringify({valid:true,errors:[],warnings:[],repairs:[],passed:true}));",
    });
    assert.equal(receipt.passed, false);
    assert.equal(receipt.allCompleted, false);
    assert.ok(
      receipt.results.every(
        (item) =>
          item.status === "candidate-error" &&
          item.observed === null &&
          !item.passed,
      ),
    );
  },
);
