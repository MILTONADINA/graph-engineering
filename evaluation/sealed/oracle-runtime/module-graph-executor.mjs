// Fixed offline QuickJS module-graph guest. The Node supervisor owns framing
// and observations; candidate modules receive no Node objects or private data.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SHA = /^[a-f0-9]{64}$/;
const CHALLENGE = /^[a-f0-9]{32}$/;
const PRIVATE_NAME =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx))$/i;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exact = (value, names) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...names].sort().join(",");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function safePath(value) {
  return (
    typeof value === "string" &&
    value.length >= 4 &&
    value.length <= 400 &&
    value.isWellFormed() &&
    value.endsWith(".js") &&
    !/[\\:\x00-\x1f\x7f?#%]/.test(value) &&
    value
      .split("/")
      .every(
        (part) =>
          part &&
          part !== "." &&
          part !== ".." &&
          part.toLowerCase() !== "node_modules" &&
          !/[. ]$/.test(part) &&
          !PRIVATE_NAME.test(part) &&
          ![".ssh", ".aws", ".gnupg", "private-memory"].includes(
            part.toLowerCase(),
          ) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}

// Captures trusted QuickJS built-ins before candidate module evaluation.
// QuickJS's pinned freeze has a documented weakness for replacement of some
// frozen data properties, so later calls use only lexical captures.
const OBSERVER = `
const O=Object,A=Array,N=Number,J=JSON,R=Reflect;
const own=O.getOwnPropertyDescriptors,proto=O.getPrototypeOf,keys=R.ownKeys;
const isArray=A.isArray,isFinite=N.isFinite,stringify=J.stringify,parse=J.parse;
const create=O.create,setPrototypeOf=O.setPrototypeOf,hasOwn=O.hasOwn;
const objectPrototype=O.prototype,arrayPrototype=A.prototype;
const apply=R.apply,regexpTest=RegExp.prototype.test,indexPattern=/^(0|[1-9]\\d*)$/;
O.freeze(O.prototype);O.freeze(A.prototype);O.freeze(J);
O.freeze(O);O.freeze(A);O.freeze(N);O.freeze(R);
export function parseInput(text){return parse(text)}
export function observe(value){
 let nodes=0;
 function copy(item,depth){
  if(++nodes>1000||depth>12)throw Error('bound');
  if(item===null||typeof item==='boolean')return item;
  if(typeof item==='number'&&isFinite(item))return item;
  if(typeof item==='string')return item;
  if(!item||typeof item!=='object'||'then' in item)throw Error('type');
  const array=isArray(item),p=proto(item);
  if(array?p!==arrayPrototype:p!==null&&p!==objectPrototype)throw Error('prototype');
  const descriptors=own(item),names=keys(descriptors);
  if(names.length>1001||(array&&(item.length>1000||names.length!==item.length+1)))throw Error('size');
  const result=array?[]:create(null);
  if(array)setPrototypeOf(result,null);
  for(const key of names){
   if(array&&key==='length')continue;
   const d=descriptors[key];
   if(typeof key!=='string'||key==='__proto__'||key==='prototype'||key==='constructor'||
      !d.enumerable||!hasOwn(d,'value')||
      (array&&(!apply(regexpTest,indexPattern,[key])||N(key)>=item.length)))throw Error('field');
   result[key]=copy(d.value,depth+1);
  }
  return result;
 }
 return stringify(copy(value,0));
}`;

function resolveImport(base, requested, modules) {
  if (
    typeof requested !== "string" ||
    !/^\.\.?\//.test(requested) ||
    !requested.endsWith(".js") ||
    /[\\:\x00-\x1f\x7f?#%]/.test(requested)
  )
    throw new Error("Only listed relative JS imports are allowed");
  const parts = base.split("/");
  parts.pop();
  for (const part of requested.split("/")) {
    if (part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error("Import traverses graph root");
      parts.pop();
    } else if (part) parts.push(part);
    else throw new Error("Empty import segment");
  }
  const target = parts.join("/");
  if (!safePath(target) || !modules.has(target))
    throw new Error("Import is not in the frozen public manifest");
  return target;
}

async function execute(request) {
  const [
    { newQuickJSWASMModuleFromVariant, newVariant },
    { default: release },
  ] = await Promise.all([
    import("quickjs-emscripten-core"),
    import("@jitl/quickjs-wasmfile-release-sync"),
  ]);
  let diagnostic = false,
    interrupted = false,
    interrupts = 0,
    boundaryViolation = false;
  const deadline = performance.now() + 2500;
  const QuickJS = await newQuickJSWASMModuleFromVariant(
    newVariant(release, {
      emscriptenModule: {
        print: () => {
          diagnostic = true;
        },
        printErr: () => {
          diagnostic = true;
        },
      },
      log: () => {},
    }),
  );
  const runtime = QuickJS.newRuntime();
  let context;
  const handles = [];
  const own = (handle) => {
    handles.push(handle);
    return handle;
  };
  const unwrap = (result) => {
    if (result.error) {
      result.error.dispose();
      throw new Error("Candidate module failed");
    }
    return own(result.value);
  };
  try {
    runtime.setMemoryLimit(64 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    runtime.setInterruptHandler(() => {
      interrupted ||= performance.now() >= deadline || ++interrupts > 15000;
      return interrupted;
    });
    const modules = new Map(
      request.files.map((file) => [file.path, file.source]),
    );
    runtime.setModuleLoader(
      (name) => {
        if (!modules.has(name)) {
          boundaryViolation = true;
          throw new Error("Unlisted module refused");
        }
        return modules.get(name);
      },
      (base, requested) => {
        try {
          return resolveImport(base, requested, modules);
        } catch {
          boundaryViolation = true;
          throw new Error("Import refused");
        }
      },
    );
    context = runtime.newContext();
    const observer = unwrap(
      context.evalCode(OBSERVER, "graph:private-observer", { type: "module" }),
    );
    const observe = own(context.getProp(observer, "observe"));
    const parseInput = own(context.getProp(observer, "parseInput"));
    const input = unwrap(
      context.callFunction(
        parseInput,
        context.undefined,
        own(context.newString(canonical(request.input))),
      ),
    );
    const candidate = unwrap(
      context.evalCode(modules.get(request.entry), request.entry, {
        type: "module",
      }),
    );
    if (boundaryViolation || runtime.hasPendingJob())
      throw new Error("Module graph boundary failed");
    const solve = own(context.getProp(candidate, "solve"));
    if (context.typeof(solve) !== "function")
      throw new Error("Entry module must export solve");
    const result = unwrap(
      context.callFunction(solve, context.undefined, input),
    );
    if (runtime.hasPendingJob()) throw new Error("Async candidate refused");
    const json = unwrap(
      context.callFunction(observe, context.undefined, result),
    );
    if (context.typeof(json) !== "string")
      throw new Error("Invalid JSON result");
    const length = own(context.getProp(json, "length"));
    if (context.getNumber(length) > 4096) throw new Error("Result byte limit");
    const text = context.getString(json);
    if (
      Buffer.byteLength(text) > 4096 ||
      diagnostic ||
      interrupted ||
      boundaryViolation ||
      performance.now() >= deadline ||
      runtime.hasPendingJob()
    )
      throw new Error("Interpreter did not complete cleanly");
    const value = JSON.parse(text);
    if (Buffer.byteLength(canonical(value)) > 4096)
      throw new Error("Result exceeded JSON limit");
    return value;
  } finally {
    for (const handle of handles.reverse()) if (handle.alive) handle.dispose();
    if (context?.alive) context.dispose();
    if (runtime.alive) runtime.dispose();
  }
}

async function main() {
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 65534 ||
    fileURLToPath(import.meta.url) !==
      "/opt/sealed-oracle/module-graph-executor.mjs"
  )
    throw new Error("Fixed offline module graph guest required");
  await readFile("/.dockerenv");
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 850_000) throw new Error("Module graph guest input limit");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const request = JSON.parse(raw);
    if (
      !exact(request, [
        "kind",
        "version",
        "entry",
        "files",
        "input",
        "caseIndex",
        "arm",
        "challenge",
        "sourceSha256",
        "inputSha256",
      ]) ||
      request.kind !== "sealed-js-module-graph-request" ||
      request.version !== "1.0.0" ||
      !Array.isArray(request.files) ||
      request.files.length < 2 ||
      request.files.length > 7 ||
      !request.files.some((file) => file.path === request.entry) ||
      !Number.isSafeInteger(request.caseIndex) ||
      request.caseIndex < 0 ||
      request.caseIndex > 11 ||
      !["baseline", "candidate"].includes(request.arm) ||
      typeof request.challenge !== "string" ||
      !CHALLENGE.test(request.challenge) ||
      typeof request.sourceSha256 !== "string" ||
      !SHA.test(request.sourceSha256) ||
      typeof request.inputSha256 !== "string" ||
      !SHA.test(request.inputSha256) ||
      Buffer.byteLength(canonical(request.input)) > 4096 ||
      sha(Buffer.from(canonical(request.input))) !== request.inputSha256 ||
      canonical(request) !== raw
    )
      throw new Error("Invalid module graph guest request");
    let previous = "";
    const folded = new Set();
    for (const file of request.files) {
      if (
        !exact(file, ["path", "source"]) ||
        !safePath(file.path) ||
        file.path <= previous ||
        folded.has(file.path.toLowerCase()) ||
        typeof file.source !== "string" ||
        !file.source.isWellFormed() ||
        !file.source.trim() ||
        file.source.includes("\0") ||
        Buffer.byteLength(file.source) > 100_000
      )
        throw new Error("Invalid module graph source file");
      previous = file.path;
      folded.add(file.path.toLowerCase());
    }
    const baseline = {
      kind: "sealed-js-module-graph-baseline",
      version: "1.0.0",
      entry: request.entry,
      files: request.files,
    };
    if (sha(Buffer.from(canonical(baseline))) !== request.sourceSha256)
      throw new Error("Module graph source identity differs");
    let status = "completed",
      value = null;
    try {
      value = await execute(request);
    } catch {
      status = "candidate-error";
    }
    const observation = {
      kind: "sealed-js-module-graph-observation",
      version: "1.0.0",
      challenge: request.challenge,
      caseIndex: request.caseIndex,
      arm: request.arm,
      sourceSha256: request.sourceSha256,
      inputSha256: request.inputSha256,
      status,
      value,
    };
    process.stdout.write(`${canonical(observation)}\n`);
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

main().catch(() => {
  process.exitCode = 1;
});
