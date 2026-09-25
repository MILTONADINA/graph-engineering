import { posix } from "node:path";
import ts from "typescript";
import type { SourceReference } from "@graph-engineering/contracts";
import type { ParsedFile } from "./parser.js";

export const SNAPSHOT_ROOT = "/snapshot/";
export const CONFIG_LIMITS = {
  files: 1024,
  bytes: 1024 * 1024,
  perFile: 65536,
  depth: 16,
  mappings: 128,
} as const;
export const isModuleConfig = (path: string) =>
  /\.jsonc?$/i.test(path) &&
  !/(?:^|\/)(?:package-lock|yarn\.lock|pnpm-lock)\.json$/i.test(path);
type Data = Record<string, unknown>;
const object = (value: unknown): value is Data =>
  !!value && typeof value === "object" && !Array.isArray(value);
const own = (value: Data, key: string) =>
  Object.hasOwn(value, key) ? value[key] : undefined;
const inside = (path: string, directory = SNAPSHOT_ROOT.slice(0, -1)) =>
  path === directory || path.startsWith(directory + "/");
const safeRelative = (value: string) =>
  value.length <= 512 &&
  !/^[/]|[\\\0?#:%]/.test(value) &&
  !value.split("/").includes("node_modules");
const joined = (directory: string, value: string): string | undefined => {
  if (!safeRelative(value)) return undefined;
  const target = posix.normalize(posix.join(directory, value));
  return inside(target) ? target : undefined;
};
const evidence = (file: ParsedFile) =>
  file.symbols.find((symbol) => symbol.kind === "file")!.source;
const mergeSources = (...sources: SourceReference[][]): SourceReference[] => [
  ...new Map(sources.flat().map((source) => [source.path, source])).values(),
];

export interface SnapshotModule {
  path: string;
  sources: SourceReference[];
}
interface Config {
  directory: string;
  baseUrl?: string;
  paths?: Record<string, string[]>;
  pathsDirectory?: string;
  sources: SourceReference[];
  blocked: boolean;
}

/** Data only. This module does not import filesystem APIs, invoke configuration,
 * or discover packages outside the immutable, policy-filtered snapshot. */
export function createSnapshotResolver(
  sourcePaths: Set<string>,
  files: ParsedFile[],
  diagnostics: Set<string>,
) {
  const records = new Map(
    files.map((file) => [SNAPSHOT_ROOT + file.path, file]),
  );
  const json = new Map<string, Data | null>();
  const configCache = new Map<string, Config>();
  const note = (message: string) => diagnostics.add(message);
  const read = (path: string): Data | null => {
    if (json.has(path)) return json.get(path)!;
    const file = records.get(path);
    if (!file || Buffer.byteLength(file.text) > CONFIG_LIMITS.perFile) {
      note(
        "missing, excluded, or oversized indexed configuration remains unresolved",
      );
      return null;
    }
    let parsed: unknown;
    try {
      const tree = ts.parseJsonText(path, file.text);
      let invalid = false,
        count = 0;
      const visit = (node: ts.Node, depth: number) => {
        if (depth > 64 || ++count > 12000) {
          invalid = true;
          return;
        }
        if (ts.isObjectLiteralExpression(node)) {
          const names = new Set<string>();
          for (const property of node.properties) {
            if (
              !ts.isPropertyAssignment(property) ||
              !ts.isStringLiteral(property.name) ||
              names.has(property.name.text)
            ) {
              invalid = true;
              break;
            }
            names.add(property.name.text);
          }
        }
        ts.forEachChild(node, (child) => visit(child, depth + 1));
      };
      visit(tree, 0);
      const decoded = ts.parseConfigFileTextToJson(path, file.text);
      if (invalid || decoded.error) throw new Error("Invalid data");
      parsed =
        posix.basename(path) === "package.json"
          ? JSON.parse(file.text)
          : decoded.config;
      if (!object(parsed)) throw new Error("Expected configuration object");
    } catch {
      note(
        "malformed, duplicate-key, or deeply nested indexed configuration remains unresolved",
      );
      json.set(path, null);
      return null;
    }
    json.set(path, parsed);
    return parsed;
  };
  const sourceAt = (path: string): string | undefined => {
    if (!inside(path)) return undefined;
    let candidates: string[];
    if (/\.[mc]?jsx?$/.test(path)) {
      const base = path.replace(/\.[mc]?jsx?$/, ""),
        suffix = posix.extname(path);
      candidates =
        suffix === ".mjs"
          ? [base + ".mts", path]
          : suffix === ".cjs"
            ? [base + ".cts", path]
            : suffix === ".jsx"
              ? [base + ".tsx", path]
              : [base + ".ts", base + ".tsx", path];
    } else if (/\.[mc]?tsx?$/.test(path)) candidates = [path];
    else if (posix.extname(path)) return undefined;
    else
      candidates = [
        ".ts",
        ".tsx",
        ".mts",
        ".cts",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".d.ts",
      ].flatMap((extension) => [path + extension, path + "/index" + extension]);
    const matches = [
      ...new Set(candidates.filter((candidate) => sourcePaths.has(candidate))),
    ];
    if (matches.length !== 1) {
      note("missing or ambiguous indexed module targets remain unresolved");
      return undefined;
    }
    return matches[0];
  };
  const config = (path: string, seen = new Set<string>()): Config => {
    if (configCache.has(path)) return configCache.get(path)!;
    const directory = posix.dirname(path),
      value = read(path);
    const result: Config = {
      directory,
      sources: records.has(path) ? [evidence(records.get(path)!)] : [],
      blocked: !value,
    };
    if (seen.has(path) || seen.size >= CONFIG_LIMITS.depth) {
      note("cyclic or over-depth configuration inheritance remains unresolved");
      return { ...result, blocked: true };
    }
    if (value) {
      const parent = own(value, "extends");
      if (parent !== undefined) {
        const target =
          typeof parent === "string" && /^\.{1,2}\//.test(parent)
            ? joined(directory, parent)
            : undefined;
        const matches = target
          ? [target, target + ".json", target + ".jsonc"].filter((candidate) =>
              records.has(candidate),
            )
          : [];
        if (matches.length !== 1) {
          result.blocked = true;
          note(
            "configuration extends must identify one indexed relative JSON/JSONC file",
          );
        } else {
          const inherited = config(matches[0]!, new Set(seen).add(path));
          Object.assign(result, inherited, {
            directory,
            sources: mergeSources(inherited.sources, result.sources),
          });
        }
      }
      const options = own(value, "compilerOptions");
      if (options !== undefined && !object(options)) result.blocked = true;
      if (object(options)) {
        // These options can change which file is selected. Never silently
        // pretend a resolver that ignores them is an exact configured binding.
        if (
          ["rootDirs", "moduleSuffixes", "customConditions"].some(
            (key) => own(options, key) !== undefined,
          )
        ) {
          result.blocked = true;
          note(
            "rootDirs, moduleSuffixes and customConditions require unsupported resolution semantics",
          );
        }
        if (own(options, "plugins") !== undefined)
          note("compiler plugins are inert indexed data and are never loaded");
        if (own(options, "baseUrl") !== undefined) {
          const base =
            typeof options.baseUrl === "string"
              ? joined(directory, options.baseUrl)
              : undefined;
          if (!base) result.blocked = true;
          else result.baseUrl = base;
        }
        if (own(options, "paths") !== undefined) {
          if (
            !object(options.paths) ||
            Object.keys(options.paths).length > CONFIG_LIMITS.mappings
          )
            result.blocked = true;
          else {
            const mappings: Record<string, string[]> = Object.create(null);
            for (const [name, targets] of Object.entries(options.paths)) {
              if (
                !safeRelative(name) ||
                name.split("*").length > 2 ||
                !Array.isArray(targets) ||
                !targets.length ||
                targets.length > 8 ||
                targets.some(
                  (target) =>
                    typeof target !== "string" ||
                    !safeRelative(target) ||
                    target.split("*").length > 2,
                )
              )
                result.blocked = true;
              else mappings[name] = targets;
            }
            result.paths = mappings;
            result.pathsDirectory = directory;
          }
        }
      }
    }
    if (result.blocked)
      note(
        "unsupported or invalid indexed project configuration blocks non-relative static binding",
      );
    configCache.set(path, result);
    return result;
  };
  const nearest = (containing: string, names: string[]): string | undefined => {
    let directory = posix.dirname(containing);
    while (inside(directory)) {
      const matches = names
        .map((name) => posix.join(directory, name))
        .filter((path) => records.has(path));
      if (matches.length) return matches[0];
      const parent = posix.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return undefined;
  };
  const matchesPattern = (
    pattern: string,
    value: string,
  ): string | undefined => {
    const parts = pattern.split("*");
    if (parts.length === 1) return value === pattern ? "" : undefined;
    return value.startsWith(parts[0]!) &&
      value.endsWith(parts[1]!) &&
      value.length >= parts[0]!.length + parts[1]!.length
      ? value.slice(parts[0]!.length, value.length - parts[1]!.length)
      : undefined;
  };
  const workspaceMatch = (pattern: unknown, relative: string): boolean => {
    if (
      typeof pattern !== "string" ||
      !safeRelative(pattern) ||
      /[!{}[\]]/.test(pattern) ||
      pattern.includes("**")
    ) {
      note(
        "workspace patterns support only exact paths and single-segment stars",
      );
      return false;
    }
    const a = pattern.replace(/^\.\//, "").replace(/\/$/, "").split("/"),
      b = relative.split("/");
    return (
      a.length === b.length &&
      a.every((part, index) => matchesPattern(part, b[index]!) !== undefined)
    );
  };
  const packages = [...records.keys()].filter(
    (path) => posix.basename(path) === "package.json",
  );
  const packageTarget = (
    name: string,
    containing: string,
  ): SnapshotModule | undefined => {
    const split = name.startsWith("@")
      ? name.split("/").slice(0, 2).join("/")
      : name.split("/")[0]!;
    if (!/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(split))
      return undefined;
    const subpath =
      name.length === split.length ? "." : "./" + name.slice(split.length + 1);
    const owner = nearest(containing, ["package.json"]);
    const matches: { path: string; value: Data; sources: SourceReference[] }[] =
      [];
    for (const packagePath of packages) {
      const value = read(packagePath);
      if (!value || own(value, "name") !== split) continue;
      if (packagePath === owner) {
        matches.push({
          path: packagePath,
          value,
          sources: [evidence(records.get(packagePath)!)],
        });
        continue;
      }
      for (const rootPath of packages) {
        const rootValue = read(rootPath),
          directory = posix.dirname(rootPath),
          packageDirectory = posix.dirname(packagePath);
        if (
          !rootValue ||
          !inside(containing, directory) ||
          packageDirectory === directory ||
          !inside(packageDirectory, directory)
        )
          continue;
        const workspaces = own(rootValue, "workspaces"),
          patterns = object(workspaces)
            ? own(workspaces, "packages")
            : workspaces;
        if (
          !Array.isArray(patterns) ||
          patterns.length > CONFIG_LIMITS.mappings
        )
          continue;
        if (
          patterns.some(
            (pattern) =>
              typeof pattern !== "string" ||
              !safeRelative(pattern) ||
              /[!{}[\]]/.test(pattern) ||
              pattern.includes("**"),
          )
        ) {
          note(
            "unsupported workspace pattern blocks package discovery for that workspace root",
          );
          continue;
        }
        if (
          patterns.some((pattern) =>
            workspaceMatch(
              pattern,
              posix.relative(directory, packageDirectory),
            ),
          )
        )
          matches.push({
            path: packagePath,
            value,
            sources: [
              evidence(records.get(packagePath)!),
              evidence(records.get(rootPath)!),
            ],
          });
      }
    }
    const unique = new Map(matches.map((match) => [match.path, match]));
    if (unique.size !== 1) {
      note(
        "missing, undeclared, or duplicate workspace package names remain unresolved",
      );
      return undefined;
    }
    const selected = [...unique.values()][0]!,
      directory = posix.dirname(selected.path),
      exports = own(selected.value, "exports");
    if (own(selected.value, "typesVersions") !== undefined) {
      note("typesVersions package mappings are unsupported");
      return undefined;
    }
    let entry: unknown,
      capture = "";
    if (exports !== undefined) {
      if (
        object(exports) &&
        Object.keys(exports).some((key) => key.startsWith("."))
      ) {
        if (Object.keys(exports).some((key) => !key.startsWith("."))) {
          note("mixed package exports conditions and subpaths are invalid");
          return undefined;
        }
        if (Object.hasOwn(exports, subpath)) entry = exports[subpath];
        else {
          const patterns = Object.keys(exports)
            .filter(
              (key) =>
                key.split("*").length === 2 &&
                matchesPattern(key, subpath) !== undefined,
            )
            .sort(
              (a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length,
            );
          if (patterns.length) {
            entry = exports[patterns[0]!];
            capture = matchesPattern(patterns[0]!, subpath)!;
          }
        }
      } else if (subpath === ".") entry = exports;
      else {
        note("package exports hides the requested subpath");
        return undefined;
      }
      let depth = 0;
      while (object(entry) && depth++ < CONFIG_LIMITS.depth) {
        // Compiler declaration evidence prefers an explicit types branch. For
        // runtime alternatives, require one identical target rather than guess
        // which host/custom condition applies to the application.
        if (Object.hasOwn(entry, "types")) {
          const keys = Object.keys(entry),
            before = keys.slice(0, keys.indexOf("types"));
          if (
            before.some((key) => ["default", "import", "node"].includes(key))
          ) {
            note(
              "package types condition is shadowed by an earlier runtime condition",
            );
            return undefined;
          }
          entry = entry.types;
          continue;
        }
        const values = Object.values(entry);
        if (
          !Object.keys(entry).some(
            (key) => key === "default" || key === "import",
          ) ||
          !values.length ||
          values.some((value) => typeof value !== "string") ||
          new Set(values).size !== 1
        ) {
          note(
            "environment-dependent package exports remain ambiguous without a unique static target",
          );
          return undefined;
        }
        entry = values[0];
      }
    } else if (subpath !== ".") entry = subpath;
    else
      entry =
        own(selected.value, "types") ??
        own(selected.value, "typings") ??
        own(selected.value, "main") ??
        "./index";
    if (
      typeof entry !== "string" ||
      entry.length > 512 ||
      (exports !== undefined && !entry.startsWith("./"))
    ) {
      note("blocked or unsupported package export target remains unresolved");
      return undefined;
    }
    const replaced = entry.replaceAll("*", capture),
      target = joined(directory, replaced);
    if (!target || !inside(target, directory)) {
      note("package export traversal outside its package is prohibited");
      return undefined;
    }
    const resolved = sourceAt(target);
    return resolved ? { path: resolved, sources: selected.sources } : undefined;
  };
  return (name: string, containing: string): SnapshotModule | undefined => {
    if (
      !safeRelative(name) ||
      (name.split("/").includes("..") && !/^\.{1,2}\//.test(name))
    ) {
      note("unsafe module specifier remains unresolved");
      return undefined;
    }
    const project = nearest(containing, [
      "tsconfig.json",
      "tsconfig.jsonc",
      "jsconfig.json",
      "jsconfig.jsonc",
    ]);
    const settings = project ? config(project) : undefined;
    if (settings?.blocked) return undefined;
    if (/^\.{1,2}\//.test(name)) {
      const path = joined(posix.dirname(containing), name);
      const resolved = path ? sourceAt(path) : undefined;
      return resolved
        ? { path: resolved, sources: settings?.sources ?? [] }
        : undefined;
    }
    if (project) {
      const mappings = settings!.paths ?? {};
      const patterns = Object.keys(mappings)
        .filter((pattern) => matchesPattern(pattern, name) !== undefined)
        .sort(
          (a, b) =>
            (a.includes("*") ? 1 : 0) - (b.includes("*") ? 1 : 0) ||
            b.indexOf("*") - a.indexOf("*"),
        );
      if (patterns.length) {
        const pattern = patterns[0]!,
          captured = matchesPattern(pattern, name)!;
        const targets = mappings[pattern]!.map((value) =>
          joined(
            settings!.baseUrl ?? settings!.pathsDirectory!,
            value.replace("*", captured),
          ),
        );
        if (targets.some((target) => !target)) {
          note("project alias escapes the indexed snapshot");
          return undefined;
        }
        const candidates = [
          ...new Set(
            targets
              .map((target) => sourceAt(target!))
              .filter((value): value is string => !!value),
          ),
        ];
        if (candidates.length !== 1) {
          note("missing or ambiguous project alias targets remain unresolved");
          return undefined;
        }
        return { path: candidates[0]!, sources: settings!.sources };
      }
      if (settings!.baseUrl) {
        const target = joined(settings!.baseUrl, name),
          resolved = target ? sourceAt(target) : undefined;
        if (resolved) return { path: resolved, sources: settings!.sources };
      }
    }
    const target = packageTarget(name, containing);
    return target
      ? {
          ...target,
          sources: mergeSources(settings?.sources ?? [], target.sources),
        }
      : undefined;
  };
}
