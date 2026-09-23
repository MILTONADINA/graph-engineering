// This entire module runs inside QuickJS, never in host Node. It has no bridge
// to host functions, filesystem, subprocesses, networking, or environment.
const NativeFunction = Function;
const jsonParse = JSON.parse;
const jsonStringify = JSON.stringify;
const own = Object.hasOwn;
const define = Object.defineProperty;
const create = Object.create;
const freeze = Object.freeze;
const arrayPush = Function.prototype.call.bind(Array.prototype.push);
const keys = Object.keys;
const entries = Object.entries;
const ErrorClass = Error;
const MapClass = Map;

export function run(text, ajvText, fixtureText) {
  const input = jsonParse(text);
  const baseline = jsonParse(fixtureText);
  let violation = false;
  const refuse = () => {
    violation = true;
    throw new ErrorClass("Fixture capability refused");
  };
  const filesystem = new MapClass();
  for (const [name, value] of entries(baseline.schemas))
    filesystem.set("/templates/artifacts/" + name, value);
  for (const [name, value] of entries(input.input)) {
    filesystem.set(
      name === "template-registry.json"
        ? "/templates/" + name
        : "/project/" + name,
      typeof value === "string" ? value : jsonStringify(value),
    );
  }
  const sources = new MapClass();
  for (const [name, value] of entries(input.files)) {
    if (name.startsWith("graph-templates/artifacts/"))
      filesystem.set("/templates/artifacts/" + name.split("/").at(-1), value);
    else
      sources.set(
        "/templates/tools/validate-graph/" + name.split("/").at(-1),
        value,
      );
  }
  const normalize = (name) => {
    if (typeof name !== "string" || name.length > 2048 || name.includes("\0"))
      return refuse();
    const absolute = name.startsWith("/");
    const parts = [];
    for (const part of name.split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") arrayPush(parts, part);
    }
    return (absolute ? "/" : "") + parts.join("/");
  };
  const join = (...parts) => normalize(parts.join("/"));
  const resolve = (...parts) => {
    let result = "/project";
    for (const part of parts)
      result = part.startsWith("/") ? part : result + "/" + part;
    return normalize(result);
  };
  const dirname = (name) =>
    normalize(name).split("/").slice(0, -1).join("/") || "/";
  const fs = freeze({
    existsSync: (name) => filesystem.has(normalize(name)),
    readFileSync: (name, encoding) => {
      name = normalize(name);
      if (encoding !== "utf8") return refuse();
      if (!filesystem.has(name)) {
        // Missing approved fixture files are ordinary ENOENT, not a capability
        // violation: the historical baseline intentionally catches this case.
        if (
          /^\/project\/(?:architecture(?:\.schema)?\.json|test(?:\.schema)?\.json|requirements(?:\.schema)?\.json|database(?:\.schema){0,2}\.json|api(?:\.schema)?\.json|auth(?:\.schema)?\.json|storage(?:\.schema)?\.json|frontend(?:\.schema)?\.json|integration(?:\.schema)?\.json|deployment(?:\.schema)?\.json|\.env\.example|\.graph\/manifest\.json)$/.test(
            name,
          )
        )
          throw new ErrorClass("ENOENT: missing fixture file");
        return refuse();
      }
      return filesystem.get(name);
    },
  });
  const path = freeze({ join, resolve, dirname });
  let logged = null;
  let exitCode = 0;
  const exitSentinel = freeze({});
  const console = freeze({
    log: (...args) => {
      if (
        logged !== null ||
        args.length !== 1 ||
        typeof args[0] !== "string" ||
        args[0].length > 60000
      )
        return refuse();
      logged = args[0];
    },
    warn: refuse,
    error: refuse,
  });
  const process = {
    argv: freeze([
      "node",
      "/templates/tools/validate-graph/index.js",
      "/project",
      "/templates",
    ]),
    env: freeze({}),
  };
  define(process, "exitCode", {
    get: () => exitCode,
    set: (value) => {
      if (value !== 0 && value !== 1) return refuse();
      exitCode = value;
    },
  });
  define(process, "exit", {
    value: (value) => {
      if (value !== 0 && value !== 1) return refuse();
      exitCode = value;
      throw exitSentinel;
    },
  });
  freeze(process);
  // Compile trusted Ajv in the same isolated realm. No Node imports/functions
  // cross this boundary, including when schemas use regex or recursive refs.
  const ajv = NativeFunction(ajvText + "\nreturn GraphTrustedAjv;")();
  const clone = (value) => jsonParse(jsonStringify(value));
  define(globalThis, "structuredClone", { value: clone, configurable: false });
  define(globalThis, "console", { value: console, configurable: false });
  define(globalThis, "process", { value: process, configurable: false });
  const modules = new MapClass();
  const entryPath = "/templates/tools/validate-graph/index.js";
  const entry = { exports: {} };
  function load(name, existing) {
    if (modules.has(name)) return modules.get(name).exports;
    if (!sources.has(name)) return refuse();
    const module = existing || { exports: {} };
    modules.set(name, module);
    function require(specifier) {
      if (specifier === "fs" || specifier === "node:fs") return fs;
      if (specifier === "path" || specifier === "node:path") return path;
      if (specifier === "ajv/dist/2020" || specifier === "ajv/dist/2020.js")
        return ajv.Ajv;
      if (specifier === "ajv-formats") return ajv.addFormats;
      if (
        typeof specifier === "string" &&
        /^\.\/(?:contracts|validate)(?:\.js)?$/.test(specifier)
      )
        return load(
          join(
            dirname(name),
            specifier.endsWith(".js") ? specifier : specifier + ".js",
          ),
        );
      return refuse();
    }
    require.main = entry;
    const source = sources.get(name).replace(/^#![^\n]*(?:\n|$)/, "");
    NativeFunction(
      "require",
      "module",
      "exports",
      "__filename",
      "__dirname",
      source,
    )(require, module, module.exports, name, dirname(name));
    return module.exports;
  }
  try {
    load(entryPath, entry);
  } catch (error) {
    if (error !== exitSentinel) throw error;
  }
  if (violation || logged === null || logged.length > 60000)
    throw new ErrorClass("Candidate did not produce a bounded CLI result");
  // The result text, not a candidate-authored pass assertion, is the observed
  // program behavior. The host owns all expected values and acceptance checks.
  // Candidate Object.prototype.toJSON must not rewrite the fixture's captured
  // exit status or console bytes. Only primitive own properties are serialized.
  const observation = create(null);
  define(observation, "exitCode", { value: exitCode, enumerable: true });
  define(observation, "resultText", { value: logged, enumerable: true });
  return jsonStringify(observation);
}
