import { posix } from "node:path";
import type { ParsedFile } from "./parser.js";

export interface CSharpGroup {
  id: string;
  files: string[];
  sources: string[];
  nullable: boolean;
}
const directory = (name: string) =>
  posix.dirname(name) === "." ? "" : posix.dirname(name);
const within = (name: string, root: string) =>
  !root || name === root || name.startsWith(root + "/");
export const isCSharpConfig = (name: string) =>
  /\.(?:csproj|props|targets)$/i.test(name) ||
  posix.basename(name).toLowerCase() === "global.json";

/** A deliberately tiny inert project format, not an MSBuild evaluator. */
function project(text: string): { nullable: boolean } | null {
  const xml = text.replace(/^\uFEFF/, "").trim();
  const root =
    /^<Project\s+Sdk="Microsoft\.NET\.Sdk"\s*>\s*<PropertyGroup>\s*([^]*?)\s*<\/PropertyGroup>\s*<\/Project>$/.exec(
      xml,
    );
  if (!root || /[&]|<!|<\?/.test(xml)) return null;
  const properties = new Map<string, string>();
  let remaining = root[1]!;
  while (remaining.trim()) {
    const match =
      /^\s*<(TargetFramework|Nullable|ImplicitUsings|LangVersion|OutputType)>\s*([^<>]*)\s*<\/\1>/.exec(
        remaining,
      );
    if (!match || properties.has(match[1]!)) return null;
    properties.set(match[1]!, match[2]!.trim());
    remaining = remaining.slice(match[0].length);
  }
  if (
    properties.get("TargetFramework") !== "net8.0" ||
    ![undefined, "disable"].includes(properties.get("ImplicitUsings")) ||
    ![undefined, "disable", "enable"].includes(properties.get("Nullable")) ||
    ![undefined, "12", "12.0"].includes(properties.get("LangVersion")) ||
    ![undefined, "Library"].includes(properties.get("OutputType"))
  )
    return null;
  return { nullable: properties.get("Nullable") === "enable" };
}
export function csharpGroups(files: ParsedFile[]): {
  groups: CSharpGroup[];
  diagnostics: string[];
} {
  const configs = files.filter((file) => isCSharpConfig(file.path));
  const projects = configs.filter((file) => /\.csproj$/i.test(file.path));
  const groups = new Map<string, CSharpGroup>();
  const notes = new Set<string>();
  for (const file of files.filter((file) => file.language === "csharp")) {
    const candidates = projects
      .filter((item) => within(file.path, directory(item.path)))
      .sort((a, b) => directory(b.path).length - directory(a.path).length);
    const selected = candidates[0];
    const projectRoot = selected
      ? directory(selected.path)
      : directory(file.path);
    const relative = posix.relative(projectRoot || ".", file.path).split("/");
    if (
      (selected && ["bin", "obj"].includes(relative[0]!.toLowerCase())) ||
      relative.slice(0, -1).some((part) => part.startsWith("."))
    ) {
      notes.add(
        "default-excluded build/hidden-folder sources retain syntax-only evidence",
      );
      continue;
    }
    // SDK default globs can include a nested project's sources. Do not silently
    // remove those files and then claim this is the parent compilation.
    if (
      selected &&
      projects.some(
        (other) =>
          other !== selected &&
          directory(other.path) !== projectRoot &&
          within(other.path, projectRoot),
      )
    ) {
      notes.add(
        "nested project layouts require explicit compile-set support; parent projects remain syntax-only",
      );
      continue;
    }
    if (
      configs.some(
        (item) =>
          !/\.csproj$/i.test(item.path) &&
          (within(file.path, directory(item.path)) ||
            (selected && within(item.path, projectRoot))),
      )
    ) {
      notes.add(
        "ambient project/global SDK configuration is not evaluated; affected sources remain syntax-only",
      );
      continue;
    }
    let settings: { nullable: boolean } | null = { nullable: false };
    if (selected) {
      settings = project(selected.text);
      if (
        !settings ||
        candidates.filter(
          (item) => directory(item.path) === directory(selected.path),
        ).length !== 1
      ) {
        notes.add(
          "unsupported or ambiguous project metadata retains syntax-only evidence",
        );
        continue;
      }
    }
    const id = selected ? "project:" + selected.path : "isolated:" + file.path;
    const group = groups.get(id) ?? {
      id,
      files: [],
      sources: selected ? [selected.path] : [],
      nullable: settings.nullable,
    };
    group.files.push(file.path);
    groups.set(id, group);
    if (!selected)
      notes.add(
        "sources without a represented supported project are analyzed in isolation, not merged across files",
      );
  }
  return {
    groups: [...groups.values()]
      .map((group) => ({ ...group, files: group.files.sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics: [...notes]
      .sort()
      .map((note) => "C# static binding limitation: " + note + "."),
  };
}
