// Evaluated only in QuickJS. The filesystem, subprocess results and CLI streams
// belong to the trusted controller outside this candidate realm.
const parse = JSON.parse,
  stringify = JSON.stringify,
  NativeError = Error;
const create = Object.create,
  define = Object.defineProperty;
const capability = globalThis.__graphSetupCapability;
delete globalThis.__graphSetupCapability;
function call(operation, args = []) {
  const request = create(null);
  define(request, "operation", { value: operation, enumerable: true });
  define(request, "args", { value: args, enumerable: true });
  const result = parse(capability(stringify(request)));
  if (!result.ok) {
    const error = new NativeError(result.error.message);
    if (result.error.code) error.code = result.error.code;
    throw error;
  }
  return result.value;
}
export const existsSync = (path) => call("existsSync", [path]);
export const readFileSync = (path) => {
  const text = call("readFileSync", [path]);
  return Object.freeze({
    value: text,
    equals: (other) => other?.value === text,
  });
};
export const lstatSync = (path) => {
  const value = call("lstatSync", [path]);
  return Object.freeze({
    mode: value.mode,
    isSymbolicLink: () => value.type === "symlink",
    isDirectory: () => value.type === "directory",
    isFile: () => value.type === "file",
  });
};
export const readdirSync = (path) => call("readdirSync", [path]);
export const readlinkSync = (path) => call("readlinkSync", [path]);
export const mkdirSync = (path, options) => call("mkdirSync", [path, options]);
export const chmodSync = (path, mode) => call("chmodSync", [path, mode]);
export const copyFileSync = (source, target) =>
  call("copyFileSync", [source, target]);
export const cpSync = (source, target, options) =>
  call("cpSync", [source, target, options]);
export const symlinkSync = (source, target) =>
  call("symlinkSync", [source, target]);
export const spawnSync = (executable, args, options) => {
  const result = call("spawnSync", [executable, args, options]);
  if (result.error) {
    const error = new NativeError(result.error.message);
    error.code = result.error.code;
    result.error = error;
  }
  return result;
};
function normalize(name) {
  const parts = [];
  for (const part of name.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return "/" + parts.join("/");
}
export const path = Object.freeze({
  join: (...parts) => normalize(parts.join("/")),
  resolve: (...parts) => normalize(parts.join("/")),
});
export const fileURLToPath = (value) => {
  if (value !== "file:///fixture/verify-project.mjs")
    throw new NativeError("Unsupported fixture URL");
  return "/fixture/verify-project.mjs";
};
const process = {
  cwd: () => call("cwd"),
  argv: Object.freeze(["node", "/fixture/verify-project.mjs"]),
  env: Object.freeze({}),
  exit: (code) => {
    call("exit", [code]);
    throw new NativeError("Fixture process exit");
  },
};
define(process, "exitCode", { set: (code) => call("exitCode", [code]) });
define(globalThis, "process", { value: Object.freeze(process) });
define(globalThis, "console", {
  value: Object.freeze({
    log: (...args) => call("stdout", [args.join(" ")]),
    error: (...args) => call("stderr", [args.join(" ")]),
  }),
});
