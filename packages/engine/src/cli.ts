#!/usr/bin/env node
import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  assertProjectConfig,
  type ProviderConfig,
  type ProjectPolicy,
} from "@graph-engineering/contracts";
import { GraphEngine } from "./service.js";
import { repositoryProfile } from "./scale.js";
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
import { checked, readJson, writeJson, errorMessage } from "./util.js";
import { trackedFiles } from "./execution/workspace.js";
import { selectSecurityTools } from "./security/catalog.js";
import {
  baselineChanged,
  newFindings,
  readBaseline,
  runSecurityScan,
  writeBaseline,
} from "./security/scan.js";
import { createServer } from "./server.js";
import { serveMcp } from "./mcp.js";
import { listTemplates, scaffold, validateArtifacts } from "./templates.js";
import { evaluateDecisions, type EvaluationRow } from "./decisions.js";
import { PROMOTION_IMPORT_BLOCKED } from "./promotion-authority.js";
import { discoverInstalledWorkers } from "./workers/installed.js";
import { backupProject, restoreProject } from "./operations.js";
import { readRunReceipt } from "./store.js";
import {
  exportEvaluationDraft,
  importEvaluationLabels,
} from "./decision-evaluation.js";

const cli = new Command()
  .name("graph-engine")
  .description("Local context, engineering memory, and controlled coding runs")
  .version("0.1.0")
  .option("-C, --project <path>", "Project root", process.cwd());
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

cli
  .command("init")
  .option("--name <name>")
  .action(async (options) =>
    print(await initializeProject(root(), options.name)),
  );
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
    "Propose a research finding as an observation citing exact lines of a knowledge pack; a person accepts it with memory review",
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
    const engine = await GraphEngine.open(root());
    const watcher = engine.context.watch({
      intervalMs: options.interval,
      onIndex: (snapshot) => {
        print(snapshot);
      },
      onError: (error) => {
        process.stderr.write(`${errorMessage(error)}\n`);
      },
    });
    const stop = async () => {
      await watcher.close();
      await engine.close();
    };
    process.once("SIGINT", () => {
      void stop();
    });
    process.once("SIGTERM", () => {
      void stop();
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
  .allowUnknownOption()
  .action(async (image, argv) => {
    const project = await loadProject(root());
    project.verification.push({ image, argv });
    assertProjectConfig(project);
    await writeJson(path.join(root(), PROJECT_FILE), project);
    print(project.verification);
  });
// The standalone scan and --update-baseline cover committed (tracked) files,
// so a local scratch file never enters a reviewed baseline. The run gate scans
// worker-written files separately.
const securityProfile = async () => ({
  files: await trackedFiles(root()),
  // Dynamic testing needs a target the owner authorizes; none is recorded yet.
  authorizedTargets: [],
  configuredTools: [],
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
    const scan = await runSecurityScan({
      root: root(),
      image: options.image,
      profile: await securityProfile(),
    });
    if (options.updateBaseline) {
      if (scan.errors.length)
        throw new Error(
          `Scan incomplete, baseline not updated: ${scan.errors.join("; ")}`,
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
      new: fresh.slice(0, 200),
      ...(fresh.length > 200 ? { omitted: fresh.length - 200 } : {}),
      errors: scan.errors,
    });
    if (fresh.length || scan.errors.length) process.exitCode = 1;
  });
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
    print({ review: project.review ?? null });
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
    if (options.enable) {
      project.policy.providers = [
        ...new Set([...project.policy.providers, id]),
      ];
      assertProjectConfig(project);
      await writeJson(path.join(root(), PROJECT_FILE), project);
    }
    print(provider);
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
        return engine.createPlanFromSpec(
          path.relative(root(), path.resolve(root(), options.spec)),
          common,
        );
      }
      if (!objective || !options.accept?.length)
        throw new Error(
          "Give an objective and --accept criteria, or plan from a spec with --spec",
        );
      return engine.createPlan({
        ...common,
        objective,
        acceptance: options.accept,
      });
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
      const proposal = await engine.proposeSteps({
        objective,
        acceptance: options.accept,
        plannerId: options.planner,
        providerId: options.provider,
        effort: options.effort,
      });
      // Never overwrite: the file is what a person reviews and approves.
      await writeFile(
        path.resolve(options.out),
        `${JSON.stringify(proposal.steps, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      return {
        ...proposal,
        next: `Review ${options.out}, then: graph-engine plan ${JSON.stringify(objective)} --accept ... --steps ${options.out}`,
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
  .action((runId, options) =>
    withEngine(async (engine) =>
      engine.store
        .outcomes(runId)
        .filter(
          (outcome) =>
            (!options.decision ||
              outcome.decisionIds.includes(options.decision)) &&
            (!options.memory || outcome.memoryIds.includes(options.memory)),
        ),
    ),
  );
cli.command("run <planId>").action((planId) =>
  withEngine(async (engine) => {
    const run = await engine.start(planId);
    process.stderr.write(`Run ${run.id}\n`);
    return engine.wait(run.id);
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
  .command("resume <runId>")
  .option(
    "--reconciled",
    "Acknowledge review of the retained workspace and external effects",
  )
  .action((runId, options) =>
    withEngine(async (engine) => {
      await engine.resume(runId, Boolean(options.reconciled));
      return engine.wait(runId);
    }),
  );
cli
  .command("memory-add <text>")
  .option("--kind <kind>", "Memory category", "observation")
  .action((text, options) =>
    withEngine((engine) =>
      engine.context.createMemory({
        text,
        kind: z
          .enum([
            "observation",
            "decision",
            "requirement",
            "constraint",
            "solution",
          ])
          .parse(options.kind),
      }),
    ),
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
  .action((id) => withEngine((engine) => engine.context.promoteMemory(id)));
cli
  .command("memory-export-authorize <id>")
  .description(
    "Authorize cloud export of one accepted, shared memory's exact text; without --sha256, print the text and its SHA-256 for review",
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
cli
  .command("serve")
  .option("--port <number>", "Loopback port", "4317")
  .action(async (options) => {
    const engine = await GraphEngine.open(root());
    const { app, token } = createServer(engine);
    const address = await app.listen({
      host: "127.0.0.1",
      port: z.coerce.number().int().min(0).max(65535).parse(options.port),
    });
    process.stdout.write(`${address}/#token=${token}\n`);
    const close = async () => {
      await app.close();
      await engine.close();
    };
    process.once("SIGINT", () => void close());
    process.once("SIGTERM", () => void close());
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
    const engine = await GraphEngine.open(root());
    const server = await serveMcp(engine, {
      client: z.enum(["local", "cloud"]).parse(options.client),
      allowRun: options.allowRun,
      allowRunStatus: options.allowRunStatus,
    });
    process.once(
      "SIGINT",
      () => void server.close().then(() => engine.close()),
    );
    process.once(
      "SIGTERM",
      () => void server.close().then(() => engine.close()),
    );
  });
cli.parseAsync().catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
});
