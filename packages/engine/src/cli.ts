#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  assertProjectConfig,
  type ProviderConfig,
  type ProjectPolicy,
  type RunStatus,
} from "@graph-engineering/contracts";
import { GraphEngine } from "./service.js";
import { interruptedRunExitCode, runExitCode } from "./run-exit-code.js";
import { repositoryProfile } from "./scale.js";
import { summarizeOutcomes } from "./insights.js";
import {
  buildFeedbackReport,
  classifyError,
  clearDifficulties,
  feedbackIssueUrl,
  feedbackReportText,
  offerFeedback,
  readDifficulties,
  recordDifficulty,
  type ErrorKind,
  type FeedbackIo,
} from "./feedback.js";
import { checkSpecs, specTemplate, SPECS_DIR } from "./specs.js";
import {
  addKnowledgePack,
  citeKnowledge,
  reviewKnowledgePacks,
} from "./knowledge.js";
import {
  configureProvider,
  initializeProject,
  loadProject,
  loadProviders,
  PROJECT_FILE,
  projectDataDir,
} from "./project.js";
import {
  checked,
  command as runCommand,
  readJson,
  writeJson,
  errorMessage,
  localErrorMessage,
} from "./util.js";
import {
  containsSecret,
  costBudgetRefusal,
  isAllowedPath,
  redact,
} from "./policy.js";
import { parseSourceLocation } from "./context/index.js";
import { trackedFiles } from "./execution/workspace.js";
import { selectSecurityTools } from "./security/catalog.js";
import {
  baselineChanged,
  displayFinding,
  newFindings,
  readBaseline,
  runSecurityScan,
  writeBaseline,
  osvDatabase,
  OSV_DATABASE_HOST,
  updateOsvDatabase,
  writeBaselineFile,
} from "./security/scan.js";
import {
  LIVE_BASELINE_FILE,
  liveBaselineFrom,
  liveTarget,
  runLiveScan,
} from "./security/live.js";
import { createServer } from "./server.js";
import { serveMcp } from "./mcp.js";
import { listTemplates, scaffold, validateArtifacts } from "./templates.js";
import { evaluateDecisions, type EvaluationRow } from "./decisions.js";
import { PROMOTION_IMPORT_BLOCKED } from "./promotion-authority.js";
import { preparePromotionGrantRequest } from "./promotion-importer.js";
import {
  anchorFollowUpCommands,
  enrollPromotionTrustAnchor,
  OWNER_KEY_ROLES,
  preparePromotionTrustAnchor,
  verifyInstalledPromotionTrustAnchor,
} from "./promotion-anchor-enrollment.js";
import { PromotionAnchorRefusalError } from "./promotion-refusal-codes.js";
import { discoverInstalledWorkers } from "./workers/installed.js";
import { backupProject, restoreProject } from "./operations.js";
import { readRunReceipt } from "./store.js";
import {
  exportEvaluationDraft,
  importEvaluationLabels,
} from "./decision-evaluation.js";
import {
  checkDistFreshness,
  distFreshnessAction,
  distFreshnessMessage,
} from "./build-source.js";

// Program options (-C, --version, --help) are read only before the command,
// so check-add can store a check's own -C, -V, -h or -- untouched.
const cli = new Command()
  .name("graph-engine")
  .description("Local context, engineering memory, and controlled coding runs")
  .enablePositionalOptions()
  .version("0.1.0")
  .option("-C, --project <path>", "Project root", process.cwd());
// Before any command runs, compare this dist with the source beside it. A cloud
// MCP server refuses a stale build, which may lack newer export guards; other
// commands warn. Output goes to stderr: stdout carries JSON and the MCP stream.
cli.hook("preAction", (_program, action) => {
  const freshness = checkDistFreshness();
  const cloudMcp = action.name() === "mcp" && action.opts().client === "cloud";
  const decision = distFreshnessAction(freshness, cloudMcp);
  if (decision === "refuse") throw new Error(distFreshnessMessage(freshness));
  if (decision === "warn")
    process.stderr.write(`warning: ${distFreshnessMessage(freshness)}\n`);
});
const root = () => path.resolve(cli.opts().project);
const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};
async function withEngine(fn: (engine: GraphEngine) => Promise<unknown>) {
  const engine = await GraphEngine.open(root());
  try {
    print(await fn(engine));
  } finally {
    await engine.close();
  }
}
// The signals that stop a command: Ctrl-C, SIGTERM, and SIGHUP, which a
// closed terminal or a dropped SSH session sends. Without a handler, SIGHUP
// would end the process at once and skip the cleanup the others run.
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
let outputErrorsIgnored = false;
// Calls stop on each of those signals until the returned function removes
// the handlers. After a hangup the terminal is gone and writing to it fails;
// those failures are ignored, so they cannot end the process mid-cleanup.
function onStopSignal(stop: () => void): () => void {
  const handle = (signal: NodeJS.Signals) => {
    if (signal === "SIGHUP" && !outputErrorsIgnored) {
      outputErrorsIgnored = true;
      for (const stream of [process.stdout, process.stderr])
        stream.on("error", () => {});
    }
    stop();
  };
  for (const signal of STOP_SIGNALS) process.on(signal, handle);
  return () => {
    for (const signal of STOP_SIGNALS) process.off(signal, handle);
  };
}
// serve, mcp and watch run until a signal stops them. The first signal
// closes them, which for serve and mcp cancels the runs they started; later
// ones are ignored until that has finished, so a repeated Ctrl-C cannot end
// the process while those runs' checks and agents are being stopped.
function closeOnStopSignal(message: string, close: () => Promise<void>) {
  let closing = false;
  const release = onStopSignal(() => {
    if (closing) return;
    closing = true;
    process.stderr.write(message);
    // A failure to close is left unhandled, so it ends the process with the
    // error instead of leaving it up on an engine that did not close.
    void close().finally(release);
  });
}
// run, resume and review-approve wait on a run whose checks and installed
// agents run in their own process groups, so a terminal's Ctrl-C reaches only
// this process, and exiting would leave a check container or agent running
// with no time limit. Ctrl-C, SIGTERM or SIGHUP closes the engine instead,
// which cancels the run: it kills those processes, removes the check
// containers and records the run as cancelled, or as needs_reconciliation
// once its publication had started. A run still being set up is never
// launched. The handlers stay registered until the engine has closed, so a
// repeated Ctrl-C cannot end the process mid-cleanup.
async function withRunEngine(
  fn: (engine: GraphEngine) => Promise<{ status: RunStatus }>,
) {
  const engine = await GraphEngine.open(root());
  let interrupted = false;
  let run: { status: RunStatus } | undefined;
  const cancel = () => {
    if (interrupted) return;
    interrupted = true;
    process.stderr.write(
      "Cancelling the run; stopping its checks and agents...\n",
    );
    // Awaited again below, where a failure to close is reported.
    engine.close().catch(() => {});
  };
  const release = onStopSignal(cancel);
  try {
    // close() lets the run stop and closes the context before the run store,
    // so fn can still read the run's record and events once wait() returns.
    run = await fn(engine);
    print(run);
  } catch (error) {
    if (!interrupted) throw error;
    // A person's own cancel, before the run started or while it was being
    // resumed: say what stopped it, without a feedback prompt.
    process.stderr.write(`${errorMessage(error)}\n`);
  } finally {
    try {
      await engine.close();
    } finally {
      release();
    }
  }
  // A run the interrupt stopped once its publication had started needs
  // reconciliation, and keeps the exit code that says so.
  if (interrupted) process.exitCode = interruptedRunExitCode(run?.status);
}
// serve, mcp and watch keep their engine open after the action returns. An
// open engine's database worker keeps the process alive, so a step that
// fails after the open must close it, or the error is printed and the
// process never exits.
async function closeOnFailure<T>(
  engine: GraphEngine,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await engine.close();
    throw error;
  }
}

cli
  .command("init")
  .option("--name <name>")
  .action(async (options) => {
    const project = await initializeProject(root(), options.name);
    print(project);
    if (project.policy.maxCostUsd === null)
      console.error(
        "No spending cap is set (policy.maxCostUsd is null). The default policy allows only local models, so nothing is spent; set a numeric cap before permitting metered workers.",
      );
  });
cli
  .command("index")
  .option(
    "--lexical",
    "Index source, graph, and summaries without computing embeddings",
  )
  .action((options) =>
    withEngine((engine) =>
      engine.context.index({ semantic: !options.lexical }),
    ),
  );
cli
  .command("knowledge-add <url>")
  .description(
    "Fetch a documentation page (HTTPS, from a host in policy.allowedHosts) into a committed knowledge pack the graph reads offline",
  )
  .option("--name <name>", "Pack name (lowercase letters, digits, hyphens)")
  .option("--doc-version <version>", "Documented product version, if known")
  .option("--refresh", "Replace an existing pack, recording its previous hash")
  .action(async (url, options) => {
    const project = await loadProject(root());
    print(
      await addKnowledgePack({
        root: root(),
        policy: project.policy,
        url,
        name: options.name,
        version: options.docVersion,
        refresh: Boolean(options.refresh),
      }),
    );
  });
cli
  .command("knowledge-list")
  .description(
    "List knowledge packs with their source, retrieval date and hash",
  )
  .action(async () => print(await reviewKnowledgePacks(root())));
cli
  .command("knowledge-cite <pack>")
  .description(
    "Propose a research finding as an observation citing exact lines of a knowledge pack; a person accepts it with graph-engine memory-accept <id>",
  )
  .requiredOption("--lines <start-end>", "Cited line range, for example 12-18")
  .requiredOption("--claim <text>", "The finding those lines support")
  .action((pack, options) =>
    withEngine(async (engine) => {
      const match = /^(\d+)-(\d+)$/.exec(options.lines);
      if (!match)
        throw new Error("Give --lines as start-end, for example 12-18");
      return citeKnowledge({
        context: engine.context,
        root: root(),
        pack,
        startLine: Number(match[1]),
        endLine: Number(match[2]),
        claim: options.claim,
      });
    }),
  );
cli
  .command("scale")
  .description(
    "Size the repository and working set, and explain how the graph scales to it",
  )
  .action(async () =>
    print(await repositoryProfile(root(), (await loadProject(root())).policy)),
  );
cli
  .command("embeddings-provision")
  .description(
    "Explicitly download pinned local embeddings; project network policy must permit model distribution hosts",
  )
  .action(() => withEngine((engine) => engine.context.provisionEmbeddings()));
cli
  .command("context <query>")
  .option("--budget <tokens>", "Context token ceiling", (v) => Number(v))
  .action((query, options) =>
    withEngine((engine) =>
      engine.context.getContext({ query, budgetTokens: options.budget }),
    ),
  );
cli
  .command("symbols <query>")
  .action((query) =>
    withEngine((engine) => engine.context.searchSymbols(query)),
  );
cli
  .command("summaries")
  .action(() => withEngine((engine) => engine.context.listSummaries()));
cli
  .command("memory-review")
  .action(() => withEngine((engine) => engine.context.reviewMemories()));
cli
  .command("snapshots-prune")
  .option(
    "--keep <count>",
    "Newest snapshots to retain, plus protected evidence/worktree snapshots",
    Number,
    20,
  )
  .option("--apply", "Delete unreferenced snapshots (default previews only)")
  .action((options) =>
    withEngine((engine) =>
      engine.context.pruneSnapshots({
        keepLatest: options.keep,
        dryRun: !options.apply,
        protectedSnapshotIds: engine.store.planSnapshotIds(),
      }),
    ),
  );
cli
  .command("context-backup <destination>")
  .description(
    "Create an exclusive checksummed context backup; run history and model files are separate",
  )
  .action((destination) =>
    withEngine((engine) => engine.context.backup(path.resolve(destination))),
  );
cli
  .command("backup <destination>")
  .description(
    "Exclusive project context/run-history/config backup; excludes credentials, workspaces, and model weights",
  )
  .action((destination) =>
    withEngine((engine) =>
      backupProject({
        context: engine.context,
        store: engine.store,
        dataDir: engine.dataDir,
        projectId: engine.config.projectId,
        destination: path.resolve(destination),
        config: engine.config,
      }),
    ),
  );
cli
  .command("restore <backup> <destination>")
  .description(
    "Restore into a NEW private data directory only; never overwrite current data",
  )
  .action(async (backup, destination) => {
    const project = await loadProject(root());
    print(
      await restoreProject({
        backupDirectory: path.resolve(backup),
        dataDir: path.resolve(destination),
        projectId: project.projectId,
      }),
    );
  });
cli
  .command("watch")
  .option(
    "--interval <ms>",
    "Backpressured reconciliation interval",
    Number,
    2000,
  )
  .action(async (options) => {
    const interval: number = options.interval;
    if (!Number.isFinite(interval) || interval < 1000 || interval > 3_600_000)
      throw new Error("Watch interval must be between 1000 and 3600000 ms");
    const engine = await GraphEngine.open(root());
    const watcher = await closeOnFailure(engine, async () =>
      engine.context.watch({
        intervalMs: interval,
        onIndex: (snapshot) => {
          print(snapshot);
        },
        onError: (error) => {
          process.stderr.write(`${errorMessage(error)}\n`);
        },
      }),
    );
    closeOnStopSignal("Stopping the watch...\n", async () => {
      try {
        await watcher.close();
      } finally {
        await engine.close();
      }
    });
  });
cli.command("templates").action(async () => print(await listTemplates()));
cli
  .command("validate-graph <artifacts>")
  .description(
    "Validate fine-grained graph artifacts, bindings, dependency order, and manifests",
  )
  .action(async (artifacts) => {
    const result = await validateArtifacts(path.resolve(artifacts));
    print(result);
    if (!(result as { valid: boolean }).valid) process.exitCode = 1;
  });
cli
  .command("scaffold <config> <target>")
  .option("--write", "Write a new project (default previews only)")
  .action(async (config, target, options) =>
    print(
      scaffold(
        await readJson(path.resolve(config)),
        path.resolve(target),
        !options.write,
      ),
    ),
  );
cli
  .command("policy")
  .option("--file <json>", "Replace project policy from a reviewed JSON file")
  .action(async (options) => {
    const project = await loadProject(root());
    if (options.file) {
      project.policy = await readJson<ProjectPolicy>(
        path.resolve(options.file),
      );
      assertProjectConfig(project);
      await writeJson(path.join(root(), PROJECT_FILE), project);
    }
    print(project.policy);
  });
cli
  .command("check-add <image> <argv...>")
  .description(
    "Register a verification command, run with network disabled in a provisioned image",
  )
  // Everything after the image is the check's command, stored as typed.
  .passThroughOptions()
  .allowUnknownOption()
  .action(async (image, argv: string[]) => {
    const project = await loadProject(root());
    // A leading -- only separates the command from check-add's own options.
    if (argv[0] === "--") argv = argv.slice(1);
    project.verification.push({ image, argv });
    assertProjectConfig(project);
    await writeJson(path.join(root(), PROJECT_FILE), project);
    print(project.verification);
  });
// The standalone scan and --update-baseline cover committed (tracked) files,
// so a local scratch file never enters a reviewed baseline. The run gate scans
// worker-written files separately.
const securityDataDir = async () =>
  projectDataDir((await loadProject(root())).projectId);
const securityProfile = async () => ({
  files: await trackedFiles(root()),
  // Targets the owner authorized in writing. This only explains the plan:
  // security-scan never runs a live-target tool, and only security-live-scan
  // scans one.
  authorizedTargets: (
    (await loadProject(root())).security?.liveTargets ?? []
  ).map((target) => target.id),
  configuredTools: [],
  databases: (await osvDatabase(await securityDataDir()))
    ? ["osv-scanner"]
    : [],
});
cli
  .command("security-plan")
  .description(
    "Choose security tools for this repository and explain each choice, including what skipped and database or live-target tools still need",
  )
  .action(async () => {
    const plan = selectSecurityTools(await securityProfile());
    print({
      selected: plan.selected.map(({ tool, reason, runnable }) => ({
        id: tool.id,
        name: tool.name,
        category: tool.category,
        mode: tool.mode,
        license: tool.license,
        reason,
        runnable,
        ...(tool.needs ? { needs: tool.needs } : {}),
        ...(tool.runWith ? { runWith: tool.runWith } : {}),
      })),
      skipped: plan.skipped.map(({ tool, reason }) => ({
        id: tool.id,
        name: tool.name,
        reason,
      })),
    });
  });
cli
  .command("security-scan")
  .description(
    "Run the selected offline security scanners and report findings not in the reviewed baseline (.graph/security-baseline.json); exits non-zero on new findings or an incomplete scan",
  )
  .option(
    "--image <name>",
    "Scanner image built from Graph Engineering's sidecars/security/Dockerfile",
    "graph-security:local",
  )
  .option(
    "--update-baseline",
    "Accept every current finding into the baseline after review",
  )
  .action(async (options) => {
    try {
      await checked("docker", ["version", "--format", "{{.Server.Version}}"]);
    } catch {
      throw new Error("Docker is not running; start it and retry");
    }
    try {
      await checked("docker", ["image", "inspect", options.image]);
    } catch {
      throw new Error(
        `Scanner image ${options.image} is not built; build it from sidecars/security/Dockerfile in the Graph Engineering repository`,
      );
    }
    const database = await osvDatabase(await securityDataDir());
    const scan = await runSecurityScan({
      root: root(),
      image: options.image,
      profile: await securityProfile(),
      ...(database ? { osvDatabase: database.path } : {}),
    });
    if (options.updateBaseline) {
      if (scan.errors.length)
        throw new Error(
          `Scan incomplete, baseline not updated: ${redact(scan.errors.join("; "))}`,
        );
      await writeBaseline(root(), scan);
    }
    const fresh = newFindings(scan, await readBaseline(root()));
    print({
      tools: scan.tools,
      findings: scan.findings.length,
      baselined: scan.findings.length - fresh.length,
      // An uncommitted baseline change accepts risk without review.
      baselineChanged: await baselineChanged(root()),
      unscanned: scan.unscanned,
      new: fresh.slice(0, 200).map(displayFinding),
      ...(fresh.length > 200 ? { omitted: fresh.length - 200 } : {}),
      errors: scan.errors.map(redact),
      osvDatabase: database
        ? {
            updatedAt: database.updatedAt,
            // Vulnerability data ages; refresh it regularly.
            stale: Date.now() - Date.parse(database.updatedAt) > 7 * 86_400_000,
          }
        : "not downloaded; run graph-engine security-db-update to scan dependencies",
    });
    if (fresh.length || scan.errors.length) process.exitCode = 1;
  });
cli
  .command("security-live-scan <targetId>")
  .description(
    `Scan a live target authorized in security.liveTargets with the ZAP baseline scan, in containers the scan starts in a loopback-only network namespace and removes, and report findings not in the reviewed live baseline (${LIVE_BASELINE_FILE}). Advisory: managed runs never run or read it; exits non-zero on new findings`,
  )
  .option("--minutes <n>", "Minutes ZAP spiders the target (1-10)", "1")
  .option(
    "--update-baseline",
    "Accept this target's current findings into the live baseline after review",
  )
  .action(async (targetId: string, options) => {
    // Refused before Docker is touched: only an authorized target is scanned.
    const target = liveTarget(await loadProject(root()), targetId);
    const minutes = Number(options.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10)
      throw new Error("Live scan refused: --minutes must be 1 to 10");
    const controller = new AbortController();
    // Stays registered until cleanup has finished, so a repeated Ctrl-C
    // cannot end the process while containers are still being removed.
    const cancel = () => {
      if (!controller.signal.aborted) {
        process.stderr.write(
          "Cancelling the live scan; removing its containers...\n",
        );
        controller.abort();
      }
    };
    const release = onStopSignal(cancel);
    let scan: Awaited<ReturnType<typeof runLiveScan>>;
    try {
      scan = await runLiveScan({
        target,
        minutes,
        signal: controller.signal,
      });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      // A person's own cancel: cleanup has run; say so, without a report.
      process.stderr.write(`${errorMessage(error)}\n`);
      process.exitCode = 130;
      return;
    } finally {
      release();
    }
    if (options.updateBaseline)
      await writeBaselineFile(
        root(),
        liveBaselineFrom(scan, await readBaseline(root(), LIVE_BASELINE_FILE)),
        LIVE_BASELINE_FILE,
      );
    const fresh = newFindings(
      scan,
      await readBaseline(root(), LIVE_BASELINE_FILE),
    );
    const risks = ["high", "medium", "low", "informational"] as const;
    print({
      target: scan.target,
      tools: scan.tools,
      findings: scan.findings.length,
      byRisk: Object.fromEntries(
        risks.map((risk) => [
          risk,
          scan.findings.filter((finding) => finding.risk === risk).length,
        ]),
      ),
      baselined: scan.findings.length - fresh.length,
      baselineChanged: await baselineChanged(root(), LIVE_BASELINE_FILE),
      new: fresh.slice(0, 200).map(displayFinding),
      ...(fresh.length > 200 ? { omitted: fresh.length - 200 } : {}),
      ...(scan.cleanup.length ? { cleanupFailed: scan.cleanup } : {}),
    });
    if (fresh.length || scan.cleanup.length) process.exitCode = 1;
  });
cli
  .command("security-db-update")
  .description(
    `Download the OSV vulnerability database for this repository's lockfiles (needs ${OSV_DATABASE_HOST} in policy.allowedHosts); later scans use it offline`,
  )
  .option(
    "--image <name>",
    "Scanner image built from Graph Engineering's sidecars/security/Dockerfile",
    "graph-security:local",
  )
  .action(async (options) => {
    const project = await loadProject(root());
    print(
      await updateOsvDatabase({
        root: root(),
        dataDir: projectDataDir(project.projectId),
        image: options.image,
        files: await trackedFiles(root()),
        policy: project.policy,
      }),
    );
  });
// Setting a role to a worker plans cannot use would otherwise only fail
// later, at planning time, or for a reviewer only when a run starts.
async function warnIfUnusable(
  project: Awaited<ReturnType<typeof loadProject>>,
  providerId: string,
  role?: "reviewer",
): Promise<void> {
  const provider = (
    await loadProviders(projectDataDir(project.projectId))
  ).find((configured) => configured.id === providerId);
  if (!provider)
    console.error(
      `${providerId} is not a configured worker yet; add it with graph-engine provider-add.`,
    );
  else if (
    role === "reviewer" &&
    ["codex", "claude", "cursor"].includes(provider.kind)
  )
    console.error(
      `Runs cannot use ${providerId} as their reviewer: it is an installed ${provider.kind} agent, and installed agents cannot review yet. Set an openai, anthropic or local provider with graph-engine reviewer <providerId>.`,
    );
  else if (!project.policy.providers.includes(providerId))
    console.error(
      `${providerId} is not permitted by the project policy; add it to policy.providers with graph-engine provider-enable ${providerId} before planning.`,
    );
  else warnIfUnpriced(provider, project.policy);
}
// Under a numeric cost cap, planning refuses a worker without recorded
// prices; say so when it is set up, not only when a plan fails.
function warnIfUnpriced(provider: ProviderConfig, policy: ProjectPolicy): void {
  const refusal =
    policy.maxCostUsd === null ? undefined : costBudgetRefusal(provider);
  if (refusal)
    console.error(
      `Plans cannot use ${provider.id} under the project's cost cap (policy.maxCostUsd is ${policy.maxCostUsd}). ${refusal}.`,
    );
}
cli
  .command("reviewer [providerId]")
  .description(
    "Set the API or local provider that must approve each managed run before it completes, or show the current reviewer",
  )
  .option("--clear", "Stop requiring a reviewer's approval")
  .action(async (providerId, options) => {
    const project = await loadProject(root());
    if (options.clear) delete project.review;
    else if (providerId) project.review = { providerId };
    if (options.clear || providerId) {
      assertProjectConfig(project);
      await writeJson(path.join(root(), PROJECT_FILE), project);
    }
    if (providerId) await warnIfUnusable(project, providerId, "reviewer");
    print({ review: project.review ?? null });
  });
cli
  .command("tester [providerId]")
  .description(
    "Set the worker provider that writes tests for each acceptance criterion before implementation (new test files only, which implementers may not change), or show the current tester",
  )
  .option(
    "--writes <glob...>",
    "Test-file globs the tester may write; without a provider ID, narrows the current tester's",
  )
  .option("--clear", "Stop adding a tester step to plans")
  .action(async (providerId, options) => {
    const project = await loadProject(root());
    // --writes alone narrows the current tester; it is never ignored.
    const narrow = !options.clear && !providerId && !!options.writes?.length;
    if (narrow && !project.tester)
      throw new Error(
        "No tester is set; give its provider ID: graph-engine tester <providerId> --writes <glob...>",
      );
    if (options.clear) delete project.tester;
    else if (providerId)
      project.tester = {
        providerId,
        ...(options.writes?.length ? { writes: options.writes } : {}),
      };
    else if (narrow && project.tester)
      project.tester = { ...project.tester, writes: options.writes };
    if (options.clear || providerId || narrow) {
      assertProjectConfig(project);
      await writeJson(path.join(root(), PROJECT_FILE), project);
    }
    if (providerId) await warnIfUnusable(project, providerId);
    print({ tester: project.tester ?? null });
  });
cli
  .command("provider-add <id> <kind> <model>")
  .option("--endpoint <url>")
  .option("--key-env <name>")
  .option("--efforts <list>")
  .option("--default-effort <effort>")
  .option("--input-cost <usdPerMillion>", "Reviewed input-token price", Number)
  .option(
    "--output-cost <usdPerMillion>",
    "Reviewed output-token price",
    Number,
  )
  .option("--max-context <tokens>", "Worker input ceiling", Number)
  .option("--local-thinking <mode>", "Local-server thinking: on or off")
  .option(
    "--local-thinking-budget <tokens>",
    "Local-server reasoning ceiling",
    Number,
  )
  .option(
    "--enable",
    "Allow this provider in project policy; cloud access still requires explicit policy configuration",
  )
  .action(async (id, kind, model, options) => {
    const project = await loadProject(root());
    const provider: ProviderConfig = {
      id,
      kind,
      model,
      endpoint: options.endpoint,
      apiKeyEnv: options.keyEnv,
      efforts: options.efforts?.split(","),
      defaultEffort: options.defaultEffort,
      inputCostPerMillion: options.inputCost,
      outputCostPerMillion: options.outputCost,
      maxContextTokens: options.maxContext,
      ...(options.localThinking !== undefined ||
      options.localThinkingBudget !== undefined
        ? {
            localOptions: {
              ...(options.localThinking !== undefined
                ? {
                    enableThinking:
                      z.enum(["on", "off"]).parse(options.localThinking) ===
                      "on",
                  }
                : {}),
              ...(options.localThinkingBudget !== undefined
                ? { thinkingBudget: options.localThinkingBudget }
                : {}),
            },
          }
        : {}),
    };
    await configureProvider(projectDataDir(project.projectId), provider);
    // A local worker runs on this machine at no cost, so adding one permits
    // it; a cloud or installed worker is permitted only with --enable.
    if (options.enable || kind === "local") {
      project.policy.providers = [
        ...new Set([...project.policy.providers, id]),
      ];
      assertProjectConfig(project);
      await writeJson(path.join(root(), PROJECT_FILE), project);
    }
    if (!project.policy.providers.includes(id))
      console.error(
        `${id} is configured but not permitted by the project policy; run graph-engine provider-enable ${id} to let plans use it.`,
      );
    if (kind !== "local" && project.policy.maxCostUsd === null)
      console.error(
        "This project has no spending cap (policy.maxCostUsd is null). Set a numeric cap before running metered workers.",
      );
    warnIfUnpriced(provider, project.policy);
    print(provider);
  });
// Permitting a configured worker must not touch its stored configuration:
// running provider-add again would replace every option not repeated.
cli
  .command("provider-enable <id>")
  .description(
    "Permit a configured worker in the project policy, leaving its configuration unchanged",
  )
  .action(async (id) => {
    const project = await loadProject(root());
    const provider = (
      await loadProviders(projectDataDir(project.projectId))
    ).find((configured) => configured.id === id);
    if (!provider)
      throw new Error(
        `${id} is not a configured provider; add it with graph-engine provider-add`,
      );
    project.policy.providers = [...new Set([...project.policy.providers, id])];
    assertProjectConfig(project);
    await writeJson(path.join(root(), PROJECT_FILE), project);
    if (provider.kind !== "local" && project.policy.maxCostUsd === null)
      console.error(
        "This project has no spending cap (policy.maxCostUsd is null). Set a numeric cap before running metered workers.",
      );
    warnIfUnpriced(provider, project.policy);
    print(project.policy.providers);
  });
cli.command("providers").action(async () => {
  const project = await loadProject(root());
  print(await loadProviders(projectDataDir(project.projectId)));
});
cli
  .command("capabilities")
  .description("Probe installed coding clients without starting paid inference")
  .action(async () => print(await discoverInstalledWorkers()));
cli
  .command("plan [objective]")
  .description(
    "Plan a change from an objective and acceptance criteria, or from a feature spec with --spec",
  )
  .option("--accept <criterion...>", "Acceptance criteria")
  .option(
    "--spec <path>",
    "Plan from a ready or implemented spec under specs/ (objective and criteria come from it)",
  )
  .option("--provider <id>")
  .option("--effort <effort>")
  .option(
    "--steps <json>",
    "Reviewed dependency DAG steps with per-step providers/templates",
  )
  .action(async (objective, options) =>
    withEngine(async (engine) => {
      const steps = options.steps
        ? ((await readJson(
            path.resolve(options.steps),
          )) as import("@graph-engineering/contracts").ExecutionStep[])
        : undefined;
      const common = {
        providerId: options.provider,
        effort: options.effort,
        ...(steps ? { steps } : {}),
      };
      if (options.spec) {
        if (objective || options.accept)
          throw new Error(
            "With --spec, the objective and acceptance criteria come from the spec",
          );
        return warnAboutPlan(
          engine,
          await engine.createPlanFromSpec(
            path.relative(root(), path.resolve(root(), options.spec)),
            common,
          ),
        );
      }
      if (!objective || !options.accept?.length)
        throw new Error(
          "Give an objective and --accept criteria, or plan from a spec with --spec",
        );
      return warnAboutPlan(
        engine,
        await engine.createPlan({
          ...common,
          objective,
          acceptance: options.accept,
        }),
      );
    }),
  );
// Say before the run, not when it refuses or stops half way, that a plan
// has no verification commands or needs more model calls than its roles'
// shared run-wide budget allows.
function warnAboutPlan(
  engine: GraphEngine,
  plan: import("@graph-engineering/contracts").ExecutionPlan,
) {
  for (const warning of engine.planWarnings(plan)) console.error(warning);
  return plan;
}
cli
  .command("plan-approve <planId>")
  .description(
    "Show a plan in full; with --yes, approve it as it stands (bound to its content) so a connected AI client or the dashboard may start it even when it publishes",
  )
  .option("--yes", "Approve the plan shown")
  .action((planId, options) =>
    withEngine(async (engine) => {
      const plan = engine.store.plan(planId);
      // The approval binds the whole stored plan, so everything that shapes
      // what a run does is shown: a template step's inputs set what it
      // generates and where, as an objective does for a worker step.
      const shown = {
        planId,
        objective: plan.objective,
        acceptance: plan.acceptance,
        steps: plan.steps.map((step) => ({
          id: step.id,
          kind: step.kind,
          objective: step.objective,
          dependsOn: step.dependsOn,
          providerId: step.providerId ?? null,
          effort: step.effort ?? null,
          templateId: step.templateId ?? null,
          inputs: step.inputs ?? null,
          writes: step.writes ?? null,
        })),
        verification: plan.verification,
        publication: plan.publication,
        routing: plan.routing ?? null,
        ...(plan.exportSide ? { exportSide: plan.exportSide } : {}),
        spec: plan.spec ?? null,
      };
      if (!options.yes)
        return {
          ...shown,
          approved: false,
          next: `Review the plan above, then run graph-engine plan-approve ${planId} --yes`,
        };
      return { ...shown, approved: true, ...engine.store.approvePlan(planId) };
    }),
  );
cli
  .command("spec-new <area> <id>")
  .description(
    "Write a draft feature spec at specs/<area>/<id>.md to fill in: problem, acceptance criteria, security considerations, non-goals",
  )
  .requiredOption("--title <title>", "One-line feature title")
  .option("--epic <name>", "Epic this feature belongs to")
  .action(async (area, id, options) => {
    const file = path.join(root(), SPECS_DIR, area, `${id}.md`);
    const text = specTemplate({
      id,
      area,
      title: options.title,
      epic: options.epic,
    });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, { flag: "wx" });
    print({ path: path.relative(root(), file), status: "draft" });
  });
cli
  .command("spec-check")
  .description(
    "Check every spec under specs/: required sections, unique IDs, and that each criterion of an implemented spec links an existing test",
  )
  .action(async () => {
    const report = await checkSpecs(root(), (await loadProject(root())).policy);
    print(report);
    if (report.errors.length) process.exitCode = 1;
  });
// A steps file left in the project is untracked source: a plan made while
// it is there binds it in its snapshot, so moving it changes the source
// before the run, and a run that publishes refuses the unclean checkout.
// Warn before the planner call so a person can stop without spending it,
// and say whether it warned, so the next step does not name the file as is.
// Never throws, so the claimed file is still removed if the call fails.
async function warnIfBoundAsSource(
  out: string,
  shown: string,
): Promise<boolean> {
  try {
    // Both sides through symlinks: a project reached through a link, or an
    // --out through one, is still the same checkout (so is macOS /var and
    // /private/var). The file exists: decompose has just created it.
    const [base, target] = await Promise.all([realpath(root()), realpath(out)]);
    const relative = path.relative(base, target);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      return false;
    const ignored = await runCommand(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-C",
        base,
        "check-ignore",
        "-q",
        "--",
        relative,
      ],
      { timeoutMs: 10_000 },
    );
    // 0 is ignored, 1 is not; anything else (not a Git checkout) says nothing.
    if (ignored.code !== 1) return false;
    process.stderr.write(
      `warning: ${shown} is inside the project and not ignored by Git. A plan made while it is there binds it as source, so it must stay unchanged until the run starts, and a run that publishes refuses the unclean checkout. Before plan --steps, move it outside the project or to a Git-ignored path.\n`,
    );
    return true;
  } catch {
    // The warning is advice; failing to check changes nothing.
    return false;
  }
}
cli
  .command("decompose <objective>")
  .description(
    "Ask a planner to propose dependency-ordered steps; review or edit the steps file, then create the plan with plan --steps",
  )
  .requiredOption("--accept <criterion...>", "Acceptance criteria")
  .requiredOption("--planner <id>", "API or local provider that proposes steps")
  .requiredOption("--out <file>", "New file to write the proposed steps to")
  .option("--provider <id>", "Worker provider for every step")
  .option("--effort <effort>")
  .action(async (objective, options) =>
    withEngine(async (engine) => {
      // Never overwrite: the file is what a person reviews and approves.
      // Claim it before the planner call, so a path that exists or cannot
      // be created costs no call, and remove it if no proposal reaches it.
      const out = path.resolve(options.out);
      const file = await open(out, "wx", 0o600);
      // Ctrl-C, SIGTERM or SIGHUP during the call (a local planner can take
      // minutes) aborts it, so the claimed file is removed below instead of
      // being left empty to refuse the next attempt.
      const controller = new AbortController();
      const cancel = () => {
        if (controller.signal.aborted) return;
        process.stderr.write(
          `Cancelling the decomposition; removing ${options.out}...\n`,
        );
        controller.abort();
      };
      const release = onStopSignal(cancel);
      let proposal: Awaited<ReturnType<GraphEngine["proposeSteps"]>>;
      let bound: boolean;
      try {
        // Inside the cancellable span, so Ctrl-C here still removes the file.
        bound = await warnIfBoundAsSource(out, options.out);
        proposal = await engine.proposeSteps({
          objective,
          acceptance: options.accept,
          plannerId: options.planner,
          providerId: options.provider,
          effort: options.effort,
          signal: controller.signal,
        });
        await file.writeFile(`${JSON.stringify(proposal.steps, null, 2)}\n`);
      } catch (error) {
        await file.close();
        await rm(out, { force: true });
        if (!controller.signal.aborted) throw error;
        // A person's own cancel: nothing was proposed and nothing is left.
        process.exitCode = 130;
        return { cancelled: true };
      } finally {
        release();
      }
      await file.close();
      const plan = `graph-engine plan ${JSON.stringify(objective)} --accept ...`;
      return {
        ...proposal,
        // A file bound as source is moved before planning, so the next
        // step cannot name where it is now.
        next: bound
          ? `Review ${options.out}, move it outside the project or to a Git-ignored path, then: ${plan} --steps <its new path>`
          : `Review ${options.out}, then: ${plan} --steps ${options.out}`,
      };
    }),
  );
cli
  .command("accept <runId>")
  .description(
    "Record that you accept a succeeded run's verified result (a person's decision; never offered over MCP)",
  )
  .option("--note <text>", "Why, for the record")
  .action((runId, options) =>
    withEngine((engine) =>
      engine.recordAcceptance(runId, { accepted: true, note: options.note }),
    ),
  );
cli
  .command("reject <runId>")
  .description(
    "Record that you reject a succeeded run's verified result; the note becomes a proposed project memory",
  )
  .requiredOption("--note <text>", "What is wrong with the result")
  .action((runId, options) =>
    withEngine((engine) =>
      engine.recordAcceptance(runId, { accepted: false, note: options.note }),
    ),
  );
cli
  .command("outcomes [runId]")
  .description(
    "Recorded run outcomes, oldest first, linked to the decisions and memories that shaped them (local analysis only; never promotion evidence)",
  )
  .option("--decision <id>", "Only outcomes of runs that used this decision")
  .option(
    "--memory <id>",
    "Only outcomes of runs whose context held this memory",
  )
  .option(
    "--summary",
    "Count how runs ended: statuses, gates, acceptance, cost, and per decision option and memory",
  )
  .action((runId, options) =>
    withEngine(async (engine) => {
      const outcomes = engine.store
        .outcomes(runId)
        .filter(
          (outcome) =>
            (!options.decision ||
              outcome.decisionIds.includes(options.decision)) &&
            (!options.memory || outcome.memoryIds.includes(options.memory)),
        );
      return options.summary
        ? summarizeOutcomes(outcomes, engine.store.decisions())
        : outcomes;
    }),
  );
cli.command("run <planId>").action((planId) =>
  withRunEngine(async (engine) => {
    // Starting a run from the command line is the person's own approval.
    const run = await engine.start(planId, { approvedByPerson: true });
    process.stderr.write(`Run ${run.id}\n`);
    for (const event of engine.store.events(run.id))
      if (event.type === "security.database_missing")
        process.stderr.write(`warning: ${String(event.data.message)}\n`);
    return noteFailedRun(await engine.wait(run.id));
  }),
);
cli
  .command("runs")
  .action(() => withEngine(async (engine) => engine.store.runs()));
cli.command("inspect <runId>").action((runId) =>
  withEngine(async (engine) => ({
    run: engine.store.run(runId),
    events: engine.store.events(runId),
  })),
);
cli
  .command("run-receipt <runId>")
  .description("Read a retained run and its events without triggering recovery")
  .action(async (runId) => {
    const project = await loadProject(root());
    print(
      readRunReceipt(
        projectDataDir(project.projectId),
        project.projectId,
        runId,
      ),
    );
  });
cli
  .command("cancel <runId>")
  .action((runId) => withEngine(async (engine) => engine.cancel(runId)));
cli
  .command("review-approve <runId>")
  .description(
    "Approve a run's change yourself, in place of the AI reviewer, when it stopped at code review after its checks passed; the run resumes and its review is recorded as approved by a person",
  )
  .requiredOption("--note <text>", "What you reviewed, for the record")
  .action((runId, options) =>
    withRunEngine(async (engine) => {
      await engine.approveReview(runId, options.note);
      await engine.resume(runId, true);
      const run = noteFailedRun(await engine.wait(runId));
      const events = engine.store.events(runId);
      const approved = events.findLastIndex(
        (event) => event.type === "review.person_approved",
      );
      if (
        !events
          .slice(approved + 1)
          .some(
            (event) =>
              event.type === "review.completed" && event.data.by === "person",
          )
      )
        console.error(
          "Your approval was not used: the resumed run did not reach the approved snapshot's review. Inspect the run's events.",
        );
      return run;
    }),
  );
cli
  .command("resume <runId>")
  .option(
    "--reconciled",
    "Acknowledge review of the retained workspace and external effects",
  )
  .action((runId, options) =>
    withRunEngine(async (engine) => {
      await engine.resume(runId, Boolean(options.reconciled));
      return noteFailedRun(await engine.wait(runId));
    }),
  );
cli
  .command("memory-add <text>")
  .description(
    "Propose a private project memory; a person accepts it with memory-accept. An accepted requirement or constraint reaches a cloud client or worker only when it cites source evidence inside exportPaths (--source) and is shared and authorized for export (memory-share, memory-export-authorize)",
  )
  .option(
    "--kind <kind>",
    "Memory category: observation, decision, requirement, constraint or solution",
    "observation",
  )
  .option(
    "--source <path#Lstart-Lend>",
    "Cite lines of a repository file as evidence, for example src/api.ts#L10-L24; resolved against the current index snapshot. Repeat for more sources",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .option(
    "--supersedes <id>",
    "The accepted memory this proposal replaces; accepting the proposal retires it",
  )
  .action((text, options) =>
    withEngine(async (engine) => {
      const kind = z
        .enum([
          "observation",
          "decision",
          "requirement",
          "constraint",
          "solution",
        ])
        .parse(options.kind);
      const sources = (options.source as string[]).map(parseSourceLocation);
      const memory = await engine.context.proposeMemory({
        text,
        kind,
        sources,
        ...(options.supersedes !== undefined
          ? { supersedes: options.supersedes as string }
          : {}),
      });
      // Mandatory memory blocks cloud consumers until it can be exported.
      const policy = engine.config.policy;
      if (
        (kind === "constraint" || kind === "requirement") &&
        policy.inference !== "local" &&
        policy.network !== "deny"
      ) {
        const outside = memory.sources
          .map((source) => source.path)
          .filter(
            (file) =>
              !isAllowedPath(file, policy, true) || containsSecret(file),
          );
        if (!memory.sources.length)
          console.error(
            `warning: this ${kind} cites no --source, so once accepted it cannot be authorized for cloud export, and cloud clients and workers are refused until it is superseded by a sourced memory`,
          );
        else if (outside.length)
          console.error(
            `warning: ${outside.filter((file) => !containsSecret(file)).join(", ") || "a source"} is outside exportPaths, so once accepted this ${kind} cannot be authorized for cloud export, and cloud clients and workers are refused; local workers still receive it`,
          );
      }
      return memory;
    }),
  );
cli
  .command("memories")
  .action(() => withEngine((engine) => engine.context.listMemories()));
cli
  .command("memory-accept <id>")
  .action((id) => withEngine((engine) => engine.context.acceptMemory(id)));
cli
  .command("memory-reject <id>")
  .description(
    "Decline a proposed memory with a reason; it stays on record but is never accepted or retrieved",
  )
  .requiredOption("--reason <text>", "Why the proposal is rejected")
  .action((id, options) =>
    withEngine((engine) => engine.context.rejectMemory(id, options.reason)),
  );
cli
  .command("memory-assertions <id> <json>")
  .description(
    "Attach explicitly reviewed structured assertions to a proposed memory; does not accept it",
  )
  .action((id, file) =>
    withEngine(async (engine) =>
      engine.context.setMemoryAssertions(
        id,
        await readJson(path.resolve(file)),
      ),
    ),
  );
cli
  .command("memory-share <id>")
  .description(
    "Write an accepted memory to .graph/knowledge/<id>.json for review and commit; sharing does not authorize cloud export",
  )
  .action((id) => withEngine((engine) => engine.context.promoteMemory(id)));
cli
  .command("memory-export-authorize <id>")
  .description(
    "Authorize cloud export of one accepted, shared memory's exact text; without --sha256, print the text and its SHA-256 for review. The memory must cite source evidence inside exportPaths; replace one that does not with memory-add --source <path#Lstart-Lend> --supersedes <id>",
  )
  .option(
    "--sha256 <hex>",
    "SHA-256 of the exact memory text, echoed back after review",
  )
  .action((id, options) =>
    withEngine((engine) =>
      options.sha256
        ? engine.context.authorizeMemoryExport(id, options.sha256)
        : engine.context.memoryExportReview(id),
    ),
  );
cli
  .command("memory-export-revoke <id>")
  .description(
    "Withdraw every recorded cloud-export authorization for one memory",
  )
  .action((id) =>
    withEngine((engine) => engine.context.revokeMemoryExport(id)),
  );
cli
  .command("memory-import")
  .action(() => withEngine((engine) => engine.context.importSharedMemories()));
cli
  .command("decisions")
  .action(() => withEngine(async (engine) => engine.store.decisions()));
cli
  .command("evaluation-export <mapping> <output>")
  .requiredOption("--dataset <id>")
  .description(
    "Export observed decisions with explicit decision-ID/task-ID mappings; does not invent expected labels",
  )
  .action((mapping, output, options) =>
    withEngine(async (engine) => {
      const taskIds = await readJson<Record<string, string>>(
        path.resolve(mapping),
      );
      const records = engine.store
        .decisions()
        .filter((record) => Object.hasOwn(taskIds, record.id));
      const draft = exportEvaluationDraft(records, {
        datasetId: options.dataset,
        taskIds,
      });
      const { open } = await import("node:fs/promises");
      const file = await open(path.resolve(output), "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(draft, null, 2));
      } finally {
        await file.close();
      }
      return {
        output: path.resolve(output),
        observations: draft.observations.length,
      };
    }),
  );
cli
  .command("evaluation-labels <input> <output>")
  .description(
    "Join {draft,provenance,labels} for analysis only; unsigned labels confer no promotion authority",
  )
  .action(async (input, output) => {
    const dataset = importEvaluationLabels(await readJson(path.resolve(input)));
    const { open } = await import("node:fs/promises");
    const file = await open(path.resolve(output), "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(dataset, null, 2));
    } finally {
      await file.close();
    }
    print({
      output: path.resolve(output),
      rows: dataset.rows.length,
      promotionEligible: false,
    });
  });
cli
  .command("evaluate <json>")
  .description(
    "Evaluate labeled calibration/held-out outcomes; does not fabricate benchmark results",
  )
  .option(
    "--promote",
    "Rejected until a signed promotion-bound importer and sealed held-out workflow exist",
  )
  .action(async (file, options) => {
    if (options.promote) throw new Error(PROMOTION_IMPORT_BLOCKED);
    const rows = await readJson<EvaluationRow[]>(path.resolve(file));
    const report = evaluateDecisions(rows);
    print({
      ...report,
      promotionEligible: false,
      authorityStatus: "unverified",
    });
  });
const promotion = cli
  .command("promotion")
  .description(
    "Verify-only promotion tooling; never signs, writes grants or confers authority",
  );
promotion
  .command("prepare-grant <bundle>")
  .description(
    "Verify a promotion bundle in order and emit unsigned grant requests; stops at the first refusal",
  )
  .action(async (bundle) => {
    const result = await preparePromotionGrantRequest(root(), bundle);
    if (result.outcome === "refused") {
      // A refusal is an outcome, not a failure to report as a difficulty.
      process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }
    print(result);
  });
const anchorRefused = (refusal: string, detail: string) => {
  // A refusal is an outcome, not a failure to report as a difficulty.
  process.stderr.write(`${refusal}\n${detail}\n`);
  process.exitCode = 1;
};
promotion
  .command("anchor-prepare")
  .description(
    "Write a trust anchor from the owner's public keys to a new file and print the sudo commands that install it; never runs them",
  )
  .option("--key-dir <dir>", "Directory holding <role>.pub.pem")
  .option("--out <file>", "New file to write (default: the user data dir)")
  .action(async (options) => {
    const keyDir = options.keyDir ? path.resolve(options.keyDir) : undefined;
    let prepared;
    try {
      prepared = await preparePromotionTrustAnchor({
        projectRoot: root(),
        keyDir,
        out: options.out ? path.resolve(options.out) : undefined,
      });
    } catch (error) {
      if (error instanceof PromotionAnchorRefusalError)
        return anchorRefused(error.code, error.message);
      throw error;
    }
    const followUp = anchorFollowUpCommands(keyDir);
    const lines = [
      `Wrote ${prepared.file}`,
      `Anchor SHA-256: ${prepared.anchorSha256}`,
      ...OWNER_KEY_ROLES.map(
        (role) =>
          `${role} key SHA-256: ${prepared.anchor[`${role}Keys`][0]!.publicKeySha256}`,
      ),
      `Rekor log ID: ${prepared.anchor.rekor.logId}`,
      "",
      "Check the fingerprints above against your keys, then install it yourself:",
      "",
      ...prepared.installCommands.map((command) => `  ${command}`),
      "",
      `The last command must print ${prepared.anchorSha256}.`,
      `Then check it: ${followUp.verify}`,
      `and enroll it: ${followUp.enroll}`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  });
promotion
  .command("anchor-verify")
  .description(
    "Check the installed trust anchor read-only: owner, mode, canonical form and key fingerprints",
  )
  .option("--key-dir <dir>", "Directory holding <role>.pub.pem")
  .action(async (options) => {
    const result = await verifyInstalledPromotionTrustAnchor({
      keyDir: options.keyDir ? path.resolve(options.keyDir) : undefined,
    });
    if (result.outcome === "refused")
      return anchorRefused(result.refusal, result.detail);
    process.stdout.write(`OK ${result.path} ${result.anchorSha256}\n`);
  });
promotion
  .command("enroll")
  .description(
    "Record the verified anchor's witness and signer fingerprints locally and initialise the Rekor high-water mark (one read-only request to the anchor's Rekor host)",
  )
  .option("--key-dir <dir>", "Directory holding <role>.pub.pem")
  .action(async (options) => {
    const result = await enrollPromotionTrustAnchor({
      keyDir: options.keyDir ? path.resolve(options.keyDir) : undefined,
    });
    if (result.outcome === "refused")
      return anchorRefused(result.refusal, result.detail);
    print(result);
  });
cli
  .command("serve")
  .option("--port <number>", "Loopback port", "4317")
  .action(async (options) => {
    const port = z.coerce
      .number()
      .int()
      .min(0)
      .max(65535)
      .safeParse(options.port);
    if (!port.success)
      throw new Error(
        `--port must be a whole number from 0 to 65535, not ${options.port}`,
      );
    const engine = await GraphEngine.open(root());
    const { app, token, address } = await closeOnFailure(engine, async () => {
      const server = createServer(engine);
      try {
        return {
          ...server,
          address: await server.app.listen({
            host: "127.0.0.1",
            port: port.data,
          }),
        };
      } catch (error) {
        await server.app.close();
        throw error;
      }
    });
    process.stdout.write(`${address}/#token=${token}\n`);
    closeOnStopSignal(
      "Stopping the dashboard; cancelling the runs it started...\n",
      async () => {
        try {
          await app.close();
        } finally {
          await engine.close();
        }
      },
    );
  });
cli
  .command("mcp")
  .option(
    "--client <kind>",
    "Declare whether the consuming model is local or cloud-backed",
    "cloud",
  )
  .option("--allow-run", "Expose managed run start capability")
  .option(
    "--allow-run-status",
    "Expose run status, usage, commit and PR metadata to a cloud client",
  )
  .action(async (options) => {
    const client = z.enum(["local", "cloud"]).safeParse(options.client);
    if (!client.success)
      throw new Error(`--client must be local or cloud, not ${options.client}`);
    const engine = await GraphEngine.open(root());
    const server = await closeOnFailure(engine, () =>
      serveMcp(engine, {
        client: client.data,
        allowRun: options.allowRun,
        allowRunStatus: options.allowRunStatus,
      }),
    );
    // Output goes to stderr: stdout carries the MCP stream.
    closeOnStopSignal(
      "Stopping the MCP server; cancelling the runs it started...\n",
      async () => {
        try {
          await server.close();
        } finally {
          await engine.close();
        }
      },
    );
  });
cli
  .command("feedback [note...]")
  .description(
    "Show an anonymous report for the maintainers (version, command, difficulty kinds, platform, your note) and, if you agree, open it as a GitHub issue",
  )
  .option("--log", "Include the difficulty kinds recorded on this machine")
  .action(async (note: string[], options) => {
    const log = options.log ? await readDifficulties() : undefined;
    const report = buildFeedbackReport({
      engineVersion: ENGINE_VERSION,
      command: "feedback",
      commands: commandNames(),
      kinds: log
        ? Object.entries(log.kinds).map(([kind, entry]) => ({
            kind: kind as ErrorKind,
            count: entry.count,
          }))
        : [],
      note: note.join(" "),
    });
    const io = terminalIo();
    if (!io.interactive) {
      print({
        report: feedbackReportText(report),
        issue: feedbackIssueUrl(report),
      });
      return;
    }
    await offerFeedback(report, io);
  });
cli
  .command("feedback-log")
  .description(
    "Show the difficulty kinds recorded on this machine (kinds, counts and times only)",
  )
  .option("--clear", "Delete the local log")
  .action(async (options) => {
    if (options.clear) await clearDifficulties();
    print(await readDifficulties());
  });

// Feedback: a run that failed, or a command that errored, is recorded as a
// difficulty kind locally, and a person at a terminal is offered a report.
// A command that waited for a run also exits with that run's code
// (runExitCode): 0 only when it succeeded.
let failedRunError: string | undefined;
function noteFailedRun<T extends { status: RunStatus; error?: string | null }>(
  run: T,
): T {
  if (run.status === "failed" && run.error) failedRunError = run.error;
  process.exitCode = runExitCode(run.status);
  return run;
}
const ENGINE_VERSION = (() => {
  try {
    return (
      JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ) as { version: string }
    ).version;
  } catch {
    return "unknown";
  }
})();
function commandNames(): string[] {
  return cli.commands.map((command) => command.name());
}
function currentCommand(): string | undefined {
  const names = new Set(commandNames());
  return process.argv.slice(2).find((arg) => names.has(arg));
}
function terminalIo(): FeedbackIo {
  return {
    // A person at a terminal, not a CI job or an agent's pseudo-terminal.
    interactive: Boolean(
      process.stdin.isTTY && process.stderr.isTTY && !process.env.CI,
    ),
    ask: async (question) => {
      const prompt = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        // No answer within two minutes is a no.
        return await prompt.question(question, {
          signal: AbortSignal.timeout(120_000),
        });
      } catch {
        return "";
      } finally {
        prompt.close();
      }
    },
    write: (text) => process.stderr.write(text),
    open: async (url) => {
      const [command, args] =
        process.platform === "darwin"
          ? ["open", [url]]
          : process.platform === "win32"
            ? // Not through cmd, which would split the URL at each "&".
              ["rundll32", ["url.dll,FileProtocolHandler", url]]
            : ["xdg-open", [url]];
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.on("error", () => undefined);
      child.unref();
    },
  };
}
async function handleDifficulty(message: string): Promise<void> {
  const kind = classifyError(message);
  const command = currentCommand();
  if (
    command === "feedback" ||
    command === "feedback-log" ||
    process.env.GRAPH_ENGINE_NO_FEEDBACK === "1"
  )
    return;
  try {
    await recordDifficulty(kind);
    await offerFeedback(
      buildFeedbackReport({
        engineVersion: ENGINE_VERSION,
        command,
        commands: commandNames(),
        kinds: [{ kind, count: 1 }],
      }),
      terminalIo(),
    );
  } catch {
    // Feedback never changes a command's outcome.
  }
}

cli
  .parseAsync()
  .then(async () => {
    if (failedRunError) await handleDifficulty(failedRunError);
  })
  .catch(async (error) => {
    // A person at this machine also sees detail kept from cloud clients,
    // such as the names of files Git skips checking.
    process.stderr.write(`${localErrorMessage(error)}\n`);
    process.exitCode = 1;
    await handleDifficulty(errorMessage(error));
  });
