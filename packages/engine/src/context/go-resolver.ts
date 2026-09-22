import { posix } from "node:path";
import type { ParsedFile } from "./parser.js";

export interface GoPackageGroup {
  id: string;
  goVersion: string;
  minimumVersion: string;
  files: string[];
  sources: string[];
  imports: Record<string, string>;
}
export const isGoConfig = (name: string) =>
  ["go.mod", "go.work"].includes(posix.basename(name));
const parent = (name: string) =>
  posix.dirname(name) === "." ? "" : posix.dirname(name);
const within = (name: string, root: string) =>
  root === "" || name === root || name.startsWith(root + "/");
const moduleName = /^[A-Za-z0-9][A-Za-z0-9._~/-]{0,249}$/;
const validModule = (value: string) =>
  moduleName.test(value) &&
  !value.split("/").some((part) => !part || part === "." || part === "..");
const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s*\/\/.*$/, "").trim())
    .filter(Boolean);
interface Module {
  root: string;
  name: string;
  version: string;
  source: string;
  valid: boolean;
}
interface Workspace {
  root: string;
  modules: string[];
  source: string;
  valid: boolean;
  version: string;
}
const compareVersions = (left: string, right: string) => {
  const a = left.replace(/^go/, "").split(".").map(Number);
  const b = right.replace(/^go/, "").split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta) return delta;
  }
  return 0;
};
function parseModule(file: ParsedFile): Module {
  const result: Module = {
    root: parent(file.path),
    name: "",
    version: "",
    source: file.path,
    valid: true,
  };
  let block = false;
  for (const line of lines(file.text)) {
    if (block) {
      if (line === ")") {
        block = false;
        continue;
      }
      if (!/^[^\s]+\s+v[0-9][^\s]*$/.test(line)) result.valid = false;
      continue;
    }
    const words = line.split(/\s+/);
    if (
      words[0] === "module" &&
      words.length === 2 &&
      validModule(words[1]!) &&
      !result.name
    )
      result.name = words[1]!;
    else if (
      words[0] === "go" &&
      words.length === 2 &&
      /^1\.[0-9]+(?:\.[0-9]+)?$/.test(words[1]!) &&
      !result.version
    )
      result.version = "go" + words[1]!;
    else if (line === "require (") block = true;
    else if (
      words[0] === "require" &&
      words.length === 3 &&
      validModule(words[1]!) &&
      /^v[0-9]/.test(words[2]!)
    ) {
    } else result.valid = false;
  }
  if (block || !result.name) result.valid = false;
  if (!result.version) result.version = "go1.16";
  return result;
}
function parseWorkspace(file: ParsedFile): Workspace {
  const result: Workspace = {
    root: parent(file.path),
    modules: [],
    source: file.path,
    valid: true,
    version: "",
  };
  let block = false,
    version = false;
  const add = (value: string) => {
    if (
      !/^(?:\.|\.\/[A-Za-z0-9_./-]+)$/.test(value) ||
      value.split("/").some((part) => part === ".." || part === "")
    ) {
      result.valid = false;
      return;
    }
    const root = posix.normalize(posix.join(result.root, value));
    result.modules.push(root === "." ? "" : root);
  };
  for (const line of lines(file.text)) {
    if (block) {
      if (line === ")") {
        block = false;
        continue;
      }
      add(line);
      continue;
    }
    if (/^go 1\.[0-9]+(?:\.[0-9]+)?$/.test(line) && !version) {
      version = true;
      result.version = "go" + line.slice(3);
    } else if (line === "use (") block = true;
    else if (line.startsWith("use ")) add(line.slice(4));
    else result.valid = false;
  }
  if (
    block ||
    !version ||
    !result.modules.length ||
    new Set(result.modules).size !== result.modules.length
  )
    result.valid = false;
  return result;
}

/** Inert allowlisted metadata only. Never asks cmd/go to load modules or config. */
export function goPackageGroups(files: ParsedFile[]): {
  groups: GoPackageGroup[];
  diagnostics: string[];
} {
  const notes = new Set<string>(),
    modules = files
      .filter((file) => posix.basename(file.path) === "go.mod")
      .map(parseModule),
    workspaces = files
      .filter((file) => posix.basename(file.path) === "go.work")
      .map(parseWorkspace);
  if (
    modules.some((item) => !item.valid) ||
    workspaces.some((item) => !item.valid)
  )
    notes.add(
      "unsupported go.mod/go.work directives or malformed metadata; affected packages remain syntax-only",
    );
  const grouped = new Map<string, ParsedFile[]>();
  for (const file of files.filter((file) => file.language === "go")) {
    const base = posix.basename(file.path);
    if (
      base.startsWith(".") ||
      base.startsWith("_") ||
      base.endsWith("_test.go") ||
      file.path.split("/").includes("vendor")
    ) {
      notes.add(
        "test, ignored and vendored Go files retain syntax-only coverage",
      );
      continue;
    }
    const directory = parent(file.path);
    const list = grouped.get(directory) ?? [];
    list.push(file);
    grouped.set(directory, list);
  }
  type Item = {
    group: GoPackageGroup;
    module?: Module;
    workspace?: Workspace;
    importPath?: string;
  };
  const items: Item[] = [];
  for (const [directory, source] of grouped) {
    const module = modules
      .filter((item) => within(directory, item.root))
      .sort((a, b) => b.root.length - a.root.length)[0];
    const workspace = workspaces
      .filter((item) => within(directory, item.root))
      .sort((a, b) => b.root.length - a.root.length)[0];
    if (
      (module && !module.valid) ||
      (workspace &&
        (!workspace.valid ||
          !module ||
          !workspace.modules.includes(module.root) ||
          compareVersions(workspace.version, module.version) < 0))
    ) {
      notes.add(
        "missing, unsupported or inactive workspace/module metadata; affected packages remain syntax-only",
      );
      continue;
    }
    if (
      source.some(
        (file) =>
          !file.parsed ||
          /^[\t ]*\/\/(?:go:build|\s*\+build)\b/m.test(
            file.text.replace(/^\uFEFF/, ""),
          ) ||
          /_(?:aix|android|darwin|dragonfly|freebsd|illumos|ios|js|linux|netbsd|openbsd|plan9|solaris|wasip1|windows|386|amd64|arm|arm64|loong64|mips|mips64|mips64le|mipsle|ppc64|ppc64le|riscv64|s390x|wasm)(?:_[A-Za-z0-9]+)?\.go$/.test(
            file.path,
          ),
      )
    ) {
      notes.add(
        "build-constrained or unavailable package sources are not assigned an implicit build target",
      );
      continue;
    }
    const importPath = module
      ? module.name +
        (directory === module.root
          ? ""
          : "/" + posix.relative(module.root, directory))
      : undefined;
    items.push({
      group: {
        id: "snapshot/" + (directory ? "dir/" + directory : "root"),
        goVersion: module?.version ?? "",
        minimumVersion: workspace?.version ?? module?.version ?? "",
        files: source.map((file) => file.path).sort(),
        sources: [
          ...(module ? [module.source] : []),
          ...(workspace ? [workspace.source] : []),
        ],
        imports: {},
      },
      module,
      workspace,
      importPath,
    });
  }
  for (const item of items) {
    for (const target of items) {
      if (!target.importPath || !item.module || !target.module) continue;
      if (
        item.module !== target.module &&
        (!item.workspace ||
          item.workspace !== target.workspace ||
          !item.workspace.modules.includes(target.module.root))
      )
        continue;
      const segments = target.importPath.split("/"),
        internal = segments.lastIndexOf("internal");
      if (
        internal >= 0 &&
        (!item.importPath ||
          !within(item.importPath, segments.slice(0, internal).join("/")))
      )
        continue;
      const duplicates = items.filter(
        (other) => other.importPath === target.importPath,
      );
      if (duplicates.length !== 1) {
        notes.add("ambiguous snapshot package import paths remain unresolved");
        continue;
      }
      item.group.imports[target.importPath] = target.group.id;
    }
  }
  return {
    groups: items
      .map((item) => item.group)
      .sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics: [...notes]
      .sort()
      .map((note) => "Go static binding limitation: " + note + "."),
  };
}
