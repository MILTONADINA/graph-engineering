import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { verifyInContainer } from "../src/execution/docker.js";
import * as util from "../src/util.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("retains named check identities in verifier results without changing legacy receipts or command order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-check-identity-"));
  roots.push(root);
  await util.checked("git", ["init", "-b", "dev"], { cwd: root });
  await writeFile(path.join(root, "toy.js"), "export const value = 1;\n");
  const originalChecked = util.checked;
  const originalCommand = util.command;
  vi.spyOn(util, "checked").mockImplementation(
    async (executable, argv, options) =>
      executable === "docker"
        ? `sha256:${"a".repeat(64)}`
        : originalChecked(executable, argv, options),
  );
  const launches: string[][] = [];
  vi.spyOn(util, "command").mockImplementation(
    async (executable, argv, options) => {
      if (executable !== "docker")
        return originalCommand(executable, argv, options);
      if (argv[0] === "run") launches.push(argv);
      return { code: 0, stdout: "synthetic verifier result", stderr: "" };
    },
  );
  const results = await verifyInContainer(
    root,
    [
      {
        id: "area-a",
        optional: true,
        image: "toy",
        argv: ["check-a", "--flag"],
      },
      { image: "toy", argv: ["check-legacy"] },
    ],
    structuredClone(DEFAULT_POLICY),
    "toy-snapshot",
  );
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({
    checkId: "area-a",
    code: 0,
    argv: ["check-a", "--flag"],
  });
  expect(results[1]).not.toHaveProperty("checkId");
  expect(launches[0].slice(-2)).toEqual(["check-a", "--flag"]);
  expect(launches[1].at(-1)).toBe("check-legacy");
  for (const launch of launches) {
    expect(launch).toContain("--network=none");
    expect(launch).toContain("--pull=never");
    expect(launch).not.toContain("area-a");
  }
});
