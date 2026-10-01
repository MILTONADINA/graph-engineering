import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { VerificationCheck } from "@graph-engineering/contracts";
import { initializeProject } from "../src/project.js";
import { checked, writeJson } from "../src/util.js";
import { planSha256 } from "../src/store.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(verification: VerificationCheck[] = []) {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "graph-check-selection-cli-"),
  );
  directories.push(temporary);
  const root = path.join(temporary, "repo");
  const data = path.join(temporary, "data");
  await mkdir(root);
  await checked("git", ["init", "-q"], { cwd: root });
  const project = await initializeProject(root, "Toy check selection");
  project.verification = verification;
  project.generators = [
    {
      id: "toy-generator",
      revision: "toy-v1",
      image: `sha256:${"a".repeat(64)}`,
      argv: ["generate"],
      outputs: ["src/generated"],
    },
  ];
  await writeJson(path.join(root, ".graph/project.json"), project);
  const stepsFile = path.join(temporary, "steps.json");
  await writeJson(stepsFile, [
    {
      id: "generate",
      kind: "generator",
      generatorId: "toy-generator",
      objective: "Generate toy source",
      dependsOn: [],
    },
  ]);
  const run = (...args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        ["--import", "tsx", CLI, "-C", root, ...args],
        {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          env: {
            ...process.env,
            GRAPH_ENGINE_DATA_DIR: data,
            GRAPH_ENGINE_NO_FEEDBACK: "1",
            CI: "true",
          },
          timeout: 30_000,
          maxBuffer: 1_000_000,
          windowsHide: true,
        },
        (error, stdout, stderr) =>
          resolve({
            code: error ? Number(error.code ?? 1) : 0,
            stdout,
            stderr,
          }),
      );
    });
  const plan = (...options: string[]) =>
    run(
      "plan",
      "Generate toy source",
      "--accept",
      "Source is generated",
      "--steps",
      stepsFile,
      ...options,
    );
  return { root, run, plan, stepsFile };
}
const catalogue: VerificationCheck[] = [
  { id: "lint", image: "toy-verify:local", argv: ["lint"] },
  { id: "unit", optional: true, image: "toy-verify:local", argv: ["unit"] },
  {
    id: "integration",
    optional: true,
    image: "toy-verify:local",
    argv: ["integration"],
  },
];

describe("per-plan check selection CLI", () => {
  it("registers check metadata only before the image and preserves command-owned options", async () => {
    const { root, run } = await fixture();
    const optional = await run(
      "check-add",
      "--id",
      "unit",
      "--optional",
      "toy-verify:local",
      "--",
      "node",
      "--test",
      "--",
      "--id",
      "command-value",
      "--optional",
    );
    expect(optional.code, optional.stderr).toBe(0);
    const mandatory = await run(
      "check-add",
      "--id",
      "lint",
      "toy-verify:local",
      "make",
      "-C",
      "sub",
      "test",
    );
    expect(mandatory.code, mandatory.stderr).toBe(0);
    const legacy = await run(
      "check-add",
      "toy-verify:local",
      "node",
      "--version",
    );
    expect(legacy.code, legacy.stderr).toBe(0);
    expect(
      JSON.parse(await readFile(path.join(root, ".graph/project.json"), "utf8"))
        .verification,
    ).toEqual([
      {
        id: "unit",
        optional: true,
        image: "toy-verify:local",
        argv: ["node", "--test", "--", "--id", "command-value", "--optional"],
      },
      {
        id: "lint",
        image: "toy-verify:local",
        argv: ["make", "-C", "sub", "test"],
      },
      { image: "toy-verify:local", argv: ["node", "--version"] },
    ]);
  });

  it("refuses duplicate IDs and unnamed optional registration without rewriting the catalogue", async () => {
    const { root, run } = await fixture(catalogue);
    const before = await readFile(
      path.join(root, ".graph/project.json"),
      "utf8",
    );
    for (const options of [
      ["--id", "lint"],
      ["--optional"],
      ["--id", "../bad"],
      ["--id", "bad\n"],
    ])
      expect(
        (
          await run(
            "check-add",
            ...options,
            "toy-verify:local",
            "node",
            "--test",
          )
        ).code,
      ).toBe(1);
    expect(await readFile(path.join(root, ".graph/project.json"), "utf8")).toBe(
      before,
    );
  });

  it("forwards repeated check IDs, keeps catalogue execution order and shows the full approval binding", async () => {
    const { run, plan } = await fixture(catalogue);
    const selected = await plan("--check", "unit", "--check", "lint");
    expect(selected.code, selected.stderr).toBe(0);
    const stored = JSON.parse(selected.stdout);
    expect(stored.verification).toEqual(catalogue.slice(0, 2));
    expect(stored.verificationSelection).toMatchObject({
      catalogueSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      checkIds: expect.arrayContaining(["unit", "lint"]),
    });
    expect(stored.verificationSelection.checkIds).toHaveLength(2);
    const shown = await run("plan-approve", stored.id);
    expect(shown.code, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      verification: stored.verification,
      verificationSelection: stored.verificationSelection,
      planSha256: planSha256(stored),
    });
    const status = await run("plan-status", stored.id);
    expect(JSON.parse(status.stdout)).toMatchObject({ approved: false });
  });

  it("omitted selection keeps every check and explicit selection rejects unknown duplicate or omitted mandatory IDs", async () => {
    const { plan } = await fixture(catalogue);
    const all = await plan();
    expect(all.code, all.stderr).toBe(0);
    expect(JSON.parse(all.stdout)).toMatchObject({
      verification: catalogue,
      verificationSelection: { checkIds: null },
    });
    for (const ids of [["unknown", "lint"], ["lint", "lint"], ["unit"]])
      expect((await plan(...ids.flatMap((id) => ["--check", id]))).code).toBe(
        1,
      );
  });

  it("passes the same explicit selection through spec-based planning", async () => {
    const { root, run, stepsFile } = await fixture(catalogue);
    await mkdir(path.join(root, "specs", "toy"), { recursive: true });
    await writeFile(
      path.join(root, "specs", "toy", "generated-source.md"),
      [
        "# Generated toy source",
        "",
        "- ID: generated-source",
        "- Status: ready",
        "- Area: toy",
        "",
        "## Problem",
        "",
        "Generate deterministic toy source.",
        "",
        "## Acceptance criteria",
        "",
        "- AC1: Toy source is generated.",
        "",
        "## Security considerations",
        "",
        "No network or credentials.",
        "",
        "## Non-goals",
        "",
        "No other changes.",
        "",
      ].join("\n"),
    );
    const result = await run(
      "plan",
      "--spec",
      "specs/toy/generated-source.md",
      "--steps",
      stepsFile,
      "--check",
      "lint",
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      spec: { id: "generated-source" },
      verification: [catalogue[0]],
      verificationSelection: { checkIds: ["lint"] },
    });
  });
});
