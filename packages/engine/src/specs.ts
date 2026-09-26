import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { safePath, wholeRepository } from "./policy.js";
import type { ProjectPolicy } from "@graph-engineering/contracts";

/** Feature specs live here, one Markdown file per feature, grouped by area. */
export const SPECS_DIR = "specs";
export const SPEC_STATUSES = ["draft", "ready", "implemented"] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];
const REQUIRED_SECTIONS = [
  "Problem",
  "Acceptance criteria",
  "Security considerations",
  "Non-goals",
] as const;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface SpecTestLink {
  path: string;
  name: string;
}
export interface SpecCriterion {
  id: string;
  text: string;
  tests: SpecTestLink[];
}
export interface Spec {
  path: string;
  title: string;
  id: string;
  status: string;
  area: string;
  epic?: string;
  sections: Record<string, string>;
  criteria: SpecCriterion[];
}

/**
 * Reads a spec written as plain Markdown:
 *
 *     # Title
 *     - ID: slug
 *     - Status: draft | ready | implemented
 *     - Area: slug
 *     - Epic: optional text
 *     ## Problem / ## Acceptance criteria / ## Security considerations / ## Non-goals
 *     - AC1: criterion text
 *       - Test: path/to/file.test.ts :: exact test name
 */
export function parseSpec(relativePath: string, text: string): Spec {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const title =
    lines
      .find((line) => line.startsWith("# "))
      ?.slice(2)
      .trim() ?? "";
  const meta: Record<string, string> = {};
  const sections: Record<string, string[]> = {};
  let section: string | undefined;
  let fenced = false;
  for (const line of lines) {
    // Example Markdown inside a code fence is text, never structure.
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || /^\s*(```|~~~)/.test(line)) {
      if (section) sections[section]!.push(line);
      continue;
    }
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      section = heading[1]!.trim();
      sections[section] = [];
      continue;
    }
    if (section) sections[section]!.push(line);
    else {
      const field = /^- ([A-Za-z]+): (.*)$/.exec(line);
      if (field) meta[field[1]!.toLowerCase()] = field[2]!.trim();
    }
  }
  const criteria: SpecCriterion[] = [];
  let inFence = false;
  for (const line of sections["Acceptance criteria"] ?? []) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const criterion = /^- (AC\d+): (.+)$/.exec(line);
    if (criterion) {
      criteria.push({
        id: criterion[1]!,
        text: criterion[2]!.trim(),
        tests: [],
      });
      continue;
    }
    const test = /^\s+- Test: (.+?) :: (.+)$/.exec(line);
    if (test && criteria.length)
      criteria.at(-1)!.tests.push({
        path: test[1]!.trim(),
        name: test[2]!.trim(),
      });
  }
  return {
    path: relativePath,
    title,
    id: meta.id ?? "",
    status: meta.status ?? "",
    area: meta.area ?? "",
    ...(meta.epic ? { epic: meta.epic } : {}),
    sections: Object.fromEntries(
      Object.entries(sections).map(([name, body]) => [
        name,
        body.join("\n").trim(),
      ]),
    ),
    criteria,
  };
}

async function specFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (relative: string) => {
    let entries;
    try {
      entries = await readdir(path.join(root, relative), {
        withFileTypes: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(child);
      else if (
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        entry.name !== "README.md"
      )
        files.push(child);
    }
  };
  await walk(SPECS_DIR);
  return files;
}

/**
 * Whether a test file defines a runnable test with exactly this name: an
 * `it(`/`test(` call (optionally `.only`, `.concurrent`, `.each(...)`, or a
 * platform `skipIf(...)`/`runIf(...)`) whose first argument is the name.
 * Skipped or todo tests, comments and longer names do not count.
 */
export function definesTest(text: string, name: string): boolean {
  const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const modifiers =
    "(?:\\.(?:only|concurrent|sequential))?(?:\\.(?:each|skipIf|runIf)\\((?:[^()]|\\([^()]*\\))*\\))?";
  // Commented-out tests do not run: drop block comments and comment lines.
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  return new RegExp(
    `(?:^|[^.\\w])(?:it|test)${modifiers}\\(\\s*(["'\`])${quoted}\\1`,
    "m",
  ).test(code);
}

/**
 * The environment switch a linked test needs to run, when it is declared as
 * `it.runIf(process.env.NAME === "1")("name", ...)` (or `test.`/`skipIf(!...)`).
 */
export function testSwitch(text: string, name: string): string | undefined {
  const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `(?:^|[^.\\w])(?:it|test)\\.(runIf|skipIf)\\(\\s*(!?)\\(?\\s*process\\.env\\.([A-Za-z0-9_]+)\\s*===\\s*["'\`]1["'\`]\\s*\\)?\\s*\\)\\(\\s*(["'\`])${quoted}\\4`,
    "m",
  ).exec(text);
  if (!match) return undefined;
  const [, kind, negated, variable] = match;
  // runIf(X === "1") and skipIf(!(X === "1")) both need X set.
  return (kind === "runIf") !== (negated === "!") ? variable : undefined;
}

/**
 * Whether a workflow step runs a test file with an environment switch set:
 * the step's text names the file (as its package-relative tests/ path) and
 * sets the variable to "1". A light reading of the workflow text, not YAML.
 */
export function ciRunsWithSwitch(
  workflows: readonly string[],
  file: string,
  variable: string,
): boolean {
  const local = file.replace(/^.*?(?=tests\/)/, "");
  const setting = new RegExp(`\\b${variable}:\\s*["']?1["']?\\s*$`, "m");
  return workflows.some((workflow) =>
    workflow
      .split(/\n\s*- (?=name:|uses:|run:)/)
      .some((step) => step.includes(local) && setting.test(step)),
  );
}

export interface SpecReport {
  specs: {
    path: string;
    id: string;
    title: string;
    status: string;
    criteria: number;
    linked: number;
  }[];
  errors: string[];
}

/**
 * Checks every spec: required fields and sections, unique IDs, and for
 * implemented specs that each acceptance criterion links at least one test
 * whose file exists and contains the named test.
 */
export async function checkSpecs(
  root: string,
  policy: ProjectPolicy,
): Promise<SpecReport> {
  const errors: string[] = [];
  const specs: SpecReport["specs"] = [];
  const ids = new Map<string, string>();
  const fileText = new Map<string, string | null>();
  const readTestFile = async (file: string): Promise<string | null> => {
    if (!fileText.has(file)) {
      let text: string | null = null;
      try {
        // Symlinks, escapes and excluded or protected paths never count;
        // tests may sit outside a working set.
        const absolute = await safePath(root, file, wholeRepository(policy));
        if ((await stat(absolute)).isFile())
          text = await readFile(absolute, "utf8");
      } catch {
        text = null;
      }
      fileText.set(file, text);
    }
    return fileText.get(file)!;
  };
  // CI workflows, when the repository has any, decide whether a test that
  // only runs behind an environment switch counts as proof.
  const workflowDir = path.join(root, ".github", "workflows");
  const workflows = await readdir(workflowDir)
    .then((names) =>
      Promise.all(
        names
          .filter((name) => /\.ya?ml$/.test(name))
          .map((name) => readFile(path.join(workflowDir, name), "utf8")),
      ),
    )
    .catch(() => undefined);
  for (const file of await specFiles(root)) {
    const spec = parseSpec(file, await readFile(path.join(root, file), "utf8"));
    const problem = (message: string) => errors.push(`${file}: ${message}`);
    if (!spec.title) problem("missing a '# Title' line");
    if (!SLUG.test(spec.id))
      problem("ID must be lowercase letters, digits and hyphens");
    else if (ids.has(spec.id))
      problem(`ID ${spec.id} is also used by ${ids.get(spec.id)}`);
    else ids.set(spec.id, file);
    if (path.posix.basename(file, ".md") !== spec.id)
      problem(`file name must be ${spec.id}.md`);
    if (!(SPEC_STATUSES as readonly string[]).includes(spec.status))
      problem(`Status must be one of ${SPEC_STATUSES.join(", ")}`);
    if (!SLUG.test(spec.area)) problem("Area must be a lowercase slug");
    else if (path.posix.dirname(file) !== `${SPECS_DIR}/${spec.area}`)
      problem(`must live in ${SPECS_DIR}/${spec.area}/`);
    for (const section of REQUIRED_SECTIONS)
      if (!spec.sections[section]) problem(`missing '## ${section}' section`);
    const seen = new Set<string>();
    for (const criterion of spec.criteria) {
      if (seen.has(criterion.id)) problem(`${criterion.id} is listed twice`);
      seen.add(criterion.id);
    }
    if (spec.status !== "draft" && !spec.criteria.length)
      problem("a ready or implemented spec needs at least one AC line");
    let linked = 0;
    for (const criterion of spec.criteria) {
      let verified = 0;
      const unrun: string[] = [];
      for (const test of criterion.tests) {
        const text = await readTestFile(test.path);
        if (text === null)
          problem(`${criterion.id} links ${test.path}, which does not exist`);
        else if (!definesTest(text, test.name))
          problem(
            `${criterion.id} links "${test.name}", which ${test.path} does not contain`,
          );
        else {
          const variable = workflows && testSwitch(text, test.name);
          if (variable && !ciRunsWithSwitch(workflows, test.path, variable))
            unrun.push(`"${test.name}" (needs ${variable}=1)`);
          else verified++;
        }
      }
      if (verified) linked++;
      else if (spec.status === "implemented")
        problem(
          unrun.length
            ? `${criterion.id} links only tests that no CI step runs: ${unrun.join(", ")}`
            : `${criterion.id} has no verified test link`,
        );
    }
    specs.push({
      path: file,
      id: spec.id,
      title: spec.title,
      status: spec.status,
      criteria: spec.criteria.length,
      linked,
    });
  }
  return { specs, errors };
}

/** The Markdown for a new draft spec. */
export function specTemplate(options: {
  id: string;
  title: string;
  area: string;
  epic?: string;
}): string {
  if (!SLUG.test(options.id) || !SLUG.test(options.area))
    throw new Error(
      "ID and area must be lowercase letters, digits and hyphens",
    );
  const title = options.title.trim();
  if (!title || title.includes("\n")) throw new Error("Give a one-line title");
  return [
    `# ${title}`,
    "",
    `- ID: ${options.id}`,
    "- Status: draft",
    `- Area: ${options.area}`,
    ...(options.epic ? [`- Epic: ${options.epic.trim()}`] : []),
    "",
    "## Problem",
    "",
    "Who needs what, and why. Describe the behaviour, not the implementation.",
    "",
    "## Acceptance criteria",
    "",
    "- AC1: One observable, testable outcome.",
    "",
    "Under each criterion, link the tests that prove it once they exist, as",
    "an indented `- Test: <path> :: <exact test name>` line.",
    "",
    "## Security considerations",
    "",
    "Trust boundaries, inputs from outside, secrets, permissions, and abuse cases.",
    "",
    "## Non-goals",
    "",
    "What this spec deliberately does not cover.",
    "",
  ].join("\n");
}

/** The objective and acceptance criteria a plan takes from a spec. */
export function planFromSpec(spec: Spec): {
  objective: string;
  acceptance: string[];
} {
  if (!["ready", "implemented"].includes(spec.status))
    throw new Error(
      `Spec ${spec.id} is ${spec.status || "unmarked"}; mark it ready before planning`,
    );
  if (!spec.criteria.length)
    throw new Error(`Spec ${spec.id} has no acceptance criteria`);
  const security = spec.sections["Security considerations"];
  return {
    objective: [
      `${spec.title} (spec ${spec.path})`,
      "",
      spec.sections.Problem ?? "",
      ...(security ? ["", `Security considerations: ${security}`] : []),
      ...(spec.sections["Non-goals"]
        ? ["", `Non-goals: ${spec.sections["Non-goals"]}`]
        : []),
    ]
      .join("\n")
      .trim(),
    acceptance: spec.criteria.map(
      (criterion) => `${criterion.id}: ${criterion.text}`,
    ),
  };
}
