import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  infrastructureCommand,
  infrastructureImage,
  infrastructureRuntimeIdentity,
  pinnedInfrastructureCandidate,
  runInfrastructureServiceFixture,
  runInfrastructureSetupFixture,
  validateInfrastructureHistory,
  verifyInfrastructureCandidate,
} from "./verify-verifier-infrastructure.mjs";
import {
  INFRA_PATHS,
  infrastructureCandidateCase,
  checkInfrastructureInventory,
} from "./candidate-verifier-infrastructure.mjs";
import {
  infrastructureSetupCases,
  checkInfrastructureSetupObservation,
} from "./candidate-verifier-setup.mjs";

const native = process.env.GRAPH_ENGINE_INFRASTRUCTURE_GUEST_TESTS === "1";
test("infrastructure transport is local offline unprivileged immutable and bounded", () => {
  const image = "sha256:" + "a".repeat(64),
    name = "graph-infrastructure-" + randomUUID();
  const command = infrastructureCommand(
    image,
    name,
    "unix:///fixture/docker.sock",
  );
  for (const option of [
    "--network=none",
    "--read-only",
    "--pull=never",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=64",
    "--memory=512m",
    "--memory-swap=512m",
    "--cpus=1",
    "65534:65534",
    "NODE_OPTIONS=",
    "--max-old-space-size=192",
  ])
    assert.ok(command.includes(option), option);
  for (const option of ["--volume", "--mount", "--privileged"])
    assert.equal(command.includes(option), false);
  for (const endpoint of [
    "tcp://127.0.0.1:2375",
    "ssh://remote",
    "unix://relative",
    "npipe:////remote/pipe/docker_engine",
  ])
    assert.throws(() => infrastructureCommand(image, name, endpoint));
  assert.throws(() =>
    infrastructureCommand("node:latest", name, "unix:///fixture/docker.sock"),
  );
  assert.throws(() =>
    infrastructureCommand(image, "unowned", "unix:///fixture/docker.sock"),
  );
});

test("candidate source shape is refused before runtime access", async () => {
  await assert.rejects(
    verifyInfrastructureCandidate({ "../../service.ts": "x" }),
    /required/,
  );
  const files = Object.fromEntries(
    INFRA_PATHS.map((name) => [name, "\u0000".repeat(70000)]),
  );
  await assert.rejects(verifyInfrastructureCandidate(files), /packet limit/);
});

test(
  "historical full service and setup script reproduce exactly twelve intended baseline failures",
  { skip: !native },
  async () => {
    const receipt = await validateInfrastructureHistory();
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
    assert.equal(receipt.baseline.results.length, 25);
    assert.equal(
      receipt.baseline.results.filter((item) => !item.passed).length,
      12,
    );
    assert.equal(receipt.modelCalls, 0);
    assert.equal(receipt.promotionEligible, false);
  },
);

test(
  "candidate code cannot access Node modules, raw bridges, real files, or unbounded loops",
  { skip: !native },
  async () => {
    const { imageId, endpoint } = await infrastructureImage();
    await infrastructureRuntimeIdentity(imageId, endpoint);
    const repair = await pinnedInfrastructureCandidate("repair");
    const scenario = infrastructureCandidateCase().serviceCases[0];
    const files = repair.files;
    for (const code of [
      'import fs from "node:fs"; fs.readFileSync("/etc/passwd");',
      'await import("node:child_process");',
      'globalThis.constructor.constructor("return process")().exit(1);',
      '__graphServiceCapability("{}");',
      "while (true) {}",
      "await new Promise(() => {});",
    ]) {
      const result = await runInfrastructureServiceFixture(
        { ...files, [INFRA_PATHS[0]]: code },
        scenario.input,
        imageId,
        endpoint,
      );
      assert.equal(result.status, "candidate-error", code);
      assert.equal(result.observations, null);
    }
    for (const code of [
      'import fs from "node:fs"; try { fs.readFileSync("/etc/passwd"); } catch {}',
      'await import("node:net");',
      '__graphSetupCapability("{}");',
      "while (true) {}",
      "await new Promise(() => {});",
    ]) {
      const result = await runInfrastructureSetupFixture(
        { ...files, [INFRA_PATHS[1]]: code },
        infrastructureSetupCases()[0].input,
        imageId,
        endpoint,
      );
      assert.equal(result.status, "candidate-error", code);
      assert.equal(result.observations, null);
    }
  },
);

test(
  "native worker/verification trace and ledger reject candidate-owned success or hidden second call",
  { skip: !native },
  async () => {
    const { imageId, endpoint } = await infrastructureImage();
    const repair = await pinnedInfrastructureCandidate("repair"),
      base = await pinnedInfrastructureCandidate("base");
    const witness = infrastructureCandidateCase(),
      scenario = witness.serviceCases[0];
    const original = await runInfrastructureServiceFixture(
      repair.files,
      scenario.input,
      imageId,
      endpoint,
    );
    assert.equal(original.status, "completed");
    assert.equal(
      checkInfrastructureInventory(original.observations, scenario),
      true,
    );
    assert.equal(
      witness.checkServiceObservation(
        original.observations.service,
        scenario.expected,
      ),
      true,
    );
    const altered = structuredClone(original.observations);
    altered.inventory.worker[0].usage.costUsd = 0;
    assert.equal(checkInfrastructureInventory(altered, scenario), false);
    const unrepaired = await runInfrastructureServiceFixture(
      { ...repair.files, [INFRA_PATHS[0]]: base.files[INFRA_PATHS[0]] },
      scenario.input,
      imageId,
      endpoint,
    );
    assert.equal(unrepaired.status, "completed");
    assert.equal(unrepaired.observations.inventory.worker.length, 2);
    assert.equal(
      checkInfrastructureInventory(unrepaired.observations, scenario),
      false,
    );
    const fake = await runInfrastructureServiceFixture(
      {
        ...repair.files,
        [INFRA_PATHS[0]]:
          "export class GraphEngine { static async open(){ return new GraphEngine(); } async start(){ return {id:'fake',status:'succeeded'}; } async wait(){return {status:'succeeded'};} close(){} }",
      },
      scenario.input,
      imageId,
      endpoint,
    );
    assert.notEqual(fake.status, "completed");
  },
);

test(
  "setup half-repair, constant exit and prototype hooks cannot forge protected observations",
  { skip: !native },
  async () => {
    const { imageId, endpoint } = await infrastructureImage();
    const repair = await pinnedInfrastructureCandidate("repair"),
      base = await pinnedInfrastructureCandidate("base");
    const scenario = infrastructureSetupCases().find(
      (item) => item.id === "setup-late-metadata-before-any-copy",
    );
    const stale = await runInfrastructureSetupFixture(
      { ...repair.files, [INFRA_PATHS[1]]: base.files[INFRA_PATHS[1]] },
      scenario.input,
      imageId,
      endpoint,
    );
    assert.equal(stale.status, "completed");
    assert.equal(stale.observations.setup.exitCode, 1);
    assert.ok(stale.observations.setup.destination.length > 0);
    assert.equal(
      checkInfrastructureSetupObservation(
        stale.observations.setup,
        scenario.expected,
      ),
      false,
    );
    const control = infrastructureSetupCases()[0];
    const fake = await runInfrastructureSetupFixture(
      {
        ...repair.files,
        [INFRA_PATHS[1]]:
          "process.exitCode = 1; Object.prototype.toJSON = () => ({ exitCode:0,passed:true });",
      },
      control.input,
      imageId,
      endpoint,
    );
    assert.equal(fake.status, "completed");
    assert.equal(fake.observations.setup.exitCode, 1);
    assert.equal(
      checkInfrastructureSetupObservation(
        fake.observations.setup,
        control.expected,
      ),
      false,
    );
  },
);
