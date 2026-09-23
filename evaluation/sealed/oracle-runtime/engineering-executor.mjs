// Fixed offline QuickJS guest. Candidate code stays in WASM and receives one
// input. The supervisor receives no private expected values or oracle bytes.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

// Loaded as a separate QuickJS module before candidate source. Its lexical
// handles are held by the supervisor, not exported to candidate code.
const OBSERVER = `
const O=Object,A=Array,N=Number,J=JSON,R=Reflect;
const own=O.getOwnPropertyDescriptors,proto=O.getPrototypeOf,keys=R.ownKeys;
const isArray=A.isArray,isFinite=N.isFinite,stringify=J.stringify;
const create=O.create,setPrototypeOf=O.setPrototypeOf,hasOwn=O.hasOwn;
const objectPrototype=O.prototype,arrayPrototype=A.prototype;
const apply=R.apply,regexpTest=RegExp.prototype.test,indexPattern=/^(0|[1-9]\\d*)$/;
O.freeze(O.prototype);O.freeze(A.prototype);O.freeze(J);
O.freeze(O);O.freeze(A);O.freeze(N);O.freeze(R);
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

async function execute(request) {
  const [
    { newQuickJSWASMModuleFromVariant, newVariant },
    { default: release },
  ] = await Promise.all([
    import("quickjs-emscripten-core"),
    import("@jitl/quickjs-wasmfile-release-sync"),
  ]);
  let diagnostic = false;
  let interrupted = false;
  let interrupts = 0;
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
      throw new Error("Candidate execution failed");
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
    runtime.setModuleLoader(() => {
      throw new Error("Imports refused");
    });
    context = runtime.newContext();
    const observerModule = unwrap(
      context.evalCode(OBSERVER, "graph:private-observer", { type: "module" }),
    );
    const observe = own(context.getProp(observerModule, "observe"));
    // Parse JSON as data, never as an object-literal expression. The host
    // currently rejects prototype keys too, but this preserves the exact
    // input semantics if that validation contract changes later.
    const input = unwrap(
      context.evalCode(
        `JSON.parse(${JSON.stringify(canonical(request.input))})`,
        "case:input",
      ),
    );
    const candidate = unwrap(
      context.evalCode(
        `const module={exports:{}};const exports=module.exports;\n${request.source}\n;module.exports.solve`,
        "candidate:solution.js",
      ),
    );
    if (context.typeof(candidate) !== "function")
      throw new Error("Candidate has no solve function");
    const result = unwrap(
      context.callFunction(candidate, context.undefined, input),
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
      "/opt/sealed-oracle/engineering-executor.mjs"
  )
    throw new Error("Fixed offline engineering guest required");
  await readFile("/.dockerenv");
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 120_000) throw new Error("Engineering guest input limit");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const request = JSON.parse(raw);
    if (
      !request ||
      Array.isArray(request) ||
      Object.keys(request).sort().join(",") !== "input,nonce,source,version" ||
      request.version !== "1.0.0" ||
      typeof request.nonce !== "string" ||
      !/^[a-f0-9]{32}$/.test(request.nonce) ||
      typeof request.source !== "string" ||
      !request.source.isWellFormed() ||
      !request.source.trim() ||
      Buffer.byteLength(request.source) > 100_000 ||
      Buffer.byteLength(canonical(request.input)) > 4096 ||
      canonical(request) !== raw
    )
      throw new Error("Invalid engineering guest request");
    let status = "completed";
    let value = null;
    try {
      value = await execute(request);
    } catch {
      status = "candidate-error";
    }
    const observation = {
      kind: "sealed-json-function-observation",
      nonce: request.nonce,
      status,
      value,
      version: "1.0.0",
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
