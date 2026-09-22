import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import {
  canPromote,
  decide,
  decideBatch,
  meetsPromotionMetrics,
  type PromotionEvidence,
} from "../src/decisions.js";
import {
  authorizesPromotion,
  loadPromotionAuthority,
  type VerifiedPromotionAuthority,
} from "../src/promotion-authority.js";
import { hash } from "../src/util.js";

const execute = promisify(execFile);
const directories: string[] = [];
const temporary = async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "graph-promotion-authority-"),
  );
  directories.push(directory);
  return directory;
};
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const report = (): PromotionEvidence => ({
  version: "a".repeat(64),
  category: "worker",
  provider: "laya",
  model: "fixture-only",
  calibrationCount: 60,
  heldOutCount: 240,
  taskCount: 60,
  policyViolations: 0,
  additionalFailures: 0,
  baselineCost: 60,
  candidateCost: 30,
  calibrationError: 0.01,
  minimumConfidence: 0.95,
  dataOrigin: "recorded",
  provenanceComplete: true,
  datasetId: "forged-fixture-not-real-evidence",
});
const scope = {
  projectId: "test-project",
  policyVersion: hash(DEFAULT_POLICY),
};

it("ideal unsigned reports retain metric eligibility but JSON, flags, casts and proxies cannot authorize them", () => {
  const evidence = report();
  expect(meetsPromotionMetrics(evidence)).toBe(true);
  expect(canPromote(evidence)).toBe(false);
  let traps = 0;
  const proxy = new Proxy(
    {},
    {
      get() {
        traps++;
        throw new Error("must not read forged claims");
      },
    },
  );
  for (const authority of [
    undefined,
    null,
    true,
    "verified",
    {},
    evidence,
    {
      verified: true,
      provenanceComplete: true,
      independentlyAttested: true,
      ...scope,
    },
    JSON.parse(JSON.stringify({ authority: "verified", evidence })),
    proxy,
  ]) {
    expect(authorizesPromotion(authority, evidence, scope)).toBe(false);
    expect(canPromote(evidence, { ...scope, authority })).toBe(false);
  }
  expect(traps).toBe(0);
  for (const changed of [
    { calibrationCount: 49 },
    { heldOutCount: 199 },
    { taskCount: 59 },
    { policyViolations: 1 },
    { additionalFailures: 1 },
    { candidateCost: 60 },
    { calibrationError: 0.051 },
    { baselineCost: Infinity },
    { candidateCost: -1 },
  ])
    expect(meetsPromotionMetrics({ ...evidence, ...changed })).toBe(false);
});

it("promotion files are loaded as advisory evidence without mutating or manufacturing authority", async () => {
  const directory = await temporary();
  expect(await loadPromotionAuthority(directory, scope)).toEqual({
    evidence: [],
    authority: undefined,
    status: "absent",
  });
  const filename = path.join(directory, "promotions.json");
  const original = JSON.stringify([report()]);
  await writeFile(filename, original);
  const loaded = await loadPromotionAuthority(directory, scope);
  expect(loaded.status).toBe("unverified");
  expect(loaded.evidence).toEqual([report()]);
  expect(loaded.authority).toBeUndefined();
  expect(
    canPromote(loaded.evidence[0]!, { ...scope, authority: loaded.authority }),
  ).toBe(false);
  expect(await readFile(filename, "utf8")).toBe(original);
  await writeFile(
    filename,
    JSON.stringify({ verified: true, evidence: [report()] }),
  );
  await expect(loadPromotionAuthority(directory, scope)).rejects.toThrow();
});

it("direct batch and single-decision APIs keep baseline selection despite ideal forged summaries and explicit promoted policy", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "fixture-only",
            answers: { action: { choice: "alternative", confidence: 1 } },
          }),
        ),
    ),
  );
  const options = {
    projectId: "test-project",
    state: { fixture: true },
    policy: {
      ...DEFAULT_POLICY,
      providers: ["laya"],
      decisionMode: "promoted" as const,
      promotedCategories: ["worker"],
    },
    providers: [
      {
        id: "laya" as const,
        endpoint: "http://127.0.0.1:7337/v1/decide",
        model: "fixture-only",
        maxStateChars: 1200,
      },
    ],
    evidence: [report()],
    promotionAuthority: {
      verified: true,
    } as unknown as VerifiedPromotionAuthority,
  };
  const result = await decideBatch({
    ...options,
    questions: [
      {
        id: "action",
        category: "worker",
        candidates: { safe: "Baseline", alternative: "Alternative" },
        baseline: "safe",
      },
    ],
  });
  expect(result.selections).toEqual({ action: "safe" });
  expect(result.records[0]).toMatchObject({
    mode: "shadow",
    selected: "alternative",
    baseline: "safe",
    evidence: { promotionAuthority: "unverified" },
  });
  expect(
    (
      await decide({
        ...options,
        category: "worker",
        candidates: { safe: "Baseline", alternative: "Alternative" },
        baseline: "safe",
      })
    )[0]?.mode,
  ).toBe("shadow");
});

it("CLI evaluate --promote rejects before input or project loading and never overwrites local files", async () => {
  const directory = await temporary();
  const sentinel = path.join(directory, "promotions.json");
  await writeFile(sentinel, "unchanged-private-fixture");
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const result = await execute(
    process.execPath,
    [
      "--import",
      "tsx",
      cli,
      "-C",
      directory,
      "evaluate",
      path.join(directory, "missing-input.json"),
      "--promote",
    ],
    {
      cwd,
      timeout: 30000,
      maxBuffer: 100000,
      windowsHide: true,
    },
  ).then(
    () => {
      throw new Error("Unsigned promotion unexpectedly succeeded");
    },
    (error) => error,
  );
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Unsigned evaluation is analysis-only");
  expect(result.stderr).toContain("No promotion file was written");
  expect(await readFile(sentinel, "utf8")).toBe("unchanged-private-fixture");
  expect(await readdir(directory)).toEqual(["promotions.json"]);
});

it("CLI evaluate still reports unsigned metrics successfully and explicitly denies authority", async () => {
  const directory = await temporary();
  const filename = path.join(directory, "analysis.json");
  await writeFile(
    filename,
    JSON.stringify([
      {
        split: "calibration",
        category: "worker",
        provider: "laya",
        model: "fixture-only",
        selected: "safe",
        expected: "safe",
        confidence: 1,
        caseId: "test-case",
        taskId: "test-task",
        baselineSuccess: true,
        candidateSuccess: true,
        baselineCost: 1,
        candidateCost: 0.5,
        policyViolation: false,
      },
    ]),
  );
  const result = await execute(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
      "-C",
      directory,
      "evaluate",
      filename,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      timeout: 30000,
      maxBuffer: 100000,
      windowsHide: true,
    },
  );
  const output = JSON.parse(result.stdout);
  expect(output.sampleCount).toBe(1);
  expect(output.reports).toHaveLength(1);
  expect(output.promotionEligible).toBe(false);
  expect(output.authorityStatus).toBe("unverified");
  expect(await readdir(directory)).toEqual(["analysis.json"]);
});
