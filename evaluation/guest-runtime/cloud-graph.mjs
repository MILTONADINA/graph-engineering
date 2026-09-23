// Trusted cloud graph adapter. Only the QuickJS interpreter evaluates candidate
// modules. Controller-owned rows and observations never reside in guest globals.
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { z } from "zod";

const CONTEXT = "packages/engine/src/context/index.ts";
const MCP = "packages/engine/src/mcp.ts";
export const CLOUD_BYTES = 256 * 1024;
const SQL = Object.freeze({
  symbol: "SELECT payload FROM symbols WHERE snapshot_id=? AND id=?",
  edges:
    "SELECT payload FROM edges WHERE snapshot_id=? AND (source_id=? OR target_id=?) LIMIT 200",
});
const label = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => value.isWellFormed());
const sourceSchema = z
  .object({
    path: label,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    snapshotId: label,
  })
  .strict();
const symbolSchema = z
  .object({
    id: label,
    name: label,
    kind: label,
    language: z.literal("typescript"),
    source: sourceSchema,
    signature: label,
  })
  .strict();
const edgeSchema = z
  .object({
    id: label,
    from: label,
    to: label.nullable(),
    target: label,
    kind: z.enum(["calls", "imports", "references", "contains"]),
    evidence: z.enum(["syntactic", "resolved", "heuristic"]),
    resolution: z
      .object({
        kind: z.literal("static"),
        engine: z.literal("typescript"),
        version: label,
      })
      .strict()
      .optional(),
    source: sourceSchema,
  })
  .strict();
const requestSchema = z
  .object({
    version: z.literal("1.0.0"),
    taskId: z.literal("cloud-graph-export"),
    files: z
      .object({ [CONTEXT]: z.string().min(1), [MCP]: z.string().min(1) })
      .strict(),
    scenario: z
      .object({
        input: z
          .object({
            surface: z.enum(["context", "mcp"]),
            client: z.enum(["local", "cloud"]),
            exportOnly: z.boolean().nullable(),
            seed: label,
            depth: z.number().int().min(0).max(4),
            projectId: label,
            snapshotId: label,
            policy: z
              .object({
                inference: z.enum(["local", "allowlisted"]),
                network: z.enum(["deny", "allowlisted"]),
                exportPaths: z.array(label).max(8),
                excludedPaths: z.array(label).max(8),
              })
              .strict(),
          })
          .strict(),
        graph: z
          .object({
            symbols: z.array(symbolSchema).max(64),
            edges: z.array(edgeSchema).max(320),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export function validateCloudInput(value, CandidateError) {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new CandidateError();
  const request = parsed.data,
    { input, graph } = request.scenario;
  if (
    Object.values(request.files).some(
      (source) =>
        !source.trim() ||
        !source.isWellFormed() ||
        Buffer.byteLength(source) > 100000,
    )
  )
    throw new CandidateError();
  const symbols = new Set(graph.symbols.map((item) => item.id));
  if (
    symbols.size !== graph.symbols.length ||
    new Set(graph.edges.map((item) => item.id)).size !== graph.edges.length ||
    graph.edges.some(
      (item) =>
        !symbols.has(item.from) || (item.to !== null && !symbols.has(item.to)),
    ) ||
    [...graph.symbols, ...graph.edges].some(
      (item) => item.source.snapshotId !== input.snapshotId,
    )
  )
    throw new CandidateError();
  return request;
}

// These are the original pure policy functions from the pinned historical
// policy.ts dependency, not candidate code. Path globbing uses actual pinned
// picomatch. Filesystem and provider exports are deliberately absent.
const POLICY_MODULE = String.raw`
import picomatch from "picomatch";
const protectedPaths=[".git/**",".git","**/.git/**","**/.git",".graph/**",".graph","**/.graph/local/**","**/.graph/local","**/.graph/cache/**","**/.graph/cache","**/.graph/workspaces/**","**/.graph/workspaces","**/.graph/project.json","**/.graph/providers.json","**/.graph/decisions.json","node_modules/**","node_modules","**/node_modules/**","**/node_modules"];
export function isAllowedPath(relative,policy,forExport=false){
 const clean=relative;
 if(!clean||clean.includes("\\")||clean.includes("\0")||clean.includes(":")||clean.startsWith("/")||clean.split("/").some(s=>s==="."||s===".."||s===""||/[. ]$/.test(s)||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(s)))return false;
 const segments=clean.split("/"),prefixes=segments.map((_,index)=>segments.slice(0,index+1).join("/"));
 if(protectedPaths.some(pattern=>prefixes.some(prefix=>picomatch(pattern,{dot:true,nocase:true})(prefix)))||policy.excludedPaths.some(pattern=>prefixes.some(prefix=>picomatch(pattern,{dot:true,nocase:true,basename:!pattern.includes("/")})(prefix))))return false;
 return !forExport||(policy.exportPaths.length>0&&picomatch(policy.exportPaths,{dot:true})(clean));
}
export function containsSecret(text){return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b|(?:password|api[_-]?key|secret|access[_-]?token)\s*[:=]\s*["']?(?!\$\{|process\.env|os\.environ|<|example|placeholder|your[-_]|test[-_]|undefined|null)[A-Za-z0-9+/_=-]{16,}/i.test(text);}
`;

// Reuse only plain boolean-option matchers. This preserves the pinned library's
// match operation while avoiding repeated regexp compilation in the WASM guest.
// Other option shapes retain the original implementation without caching.
const MATCHER_MODULE = String.raw`
import actual from "graph:picomatch";
const descriptors=Object.getOwnPropertyDescriptors,ownKeys=Reflect.ownKeys,prototype=Object.getPrototypeOf,objectPrototype=Object.prototype;
const apply=Reflect.apply,get=Map.prototype.get,set=Map.prototype.set,cache=new Map();let size=0;
export default function picomatch(pattern,options={},...rest){
 if(typeof pattern!=="string"||!options||typeof options!=="object"||rest.length||![null,objectPrototype].includes(prototype(options)))return actual(pattern,options,...rest);
 const fields=descriptors(options),names=ownKeys(fields);if(names.some(name=>!["dot","nocase","basename"].includes(name)||!("value" in fields[name])||typeof fields[name].value!=="boolean"))return actual(pattern,options,...rest);
 const key=pattern+"\0"+["dot","nocase","basename"].map(name=>fields[name]?String(fields[name].value):"absent").join(":");
 let result=apply(get,cache,[key]);if(result)return result;
 result=actual(pattern,options);if(size<256){apply(set,cache,[key,result]);size++;}return result;
}
`;

const FIXTURE_MODULE = String.raw`
const raw=globalThis.__graphCloud;delete globalThis.__graphCloud;
const parse=JSON.parse,stringify=JSON.stringify,create=Object.create,define=Object.defineProperty;
const descriptors=Object.getOwnPropertyDescriptors,descriptor=Object.getOwnPropertyDescriptor,keys=Reflect.ownKeys;
const prototype=Object.getPrototypeOf,objectPrototype=Object.prototype,arrayIsArray=Array.isArray,setPrototype=Object.setPrototypeOf;
const apply=Reflect.apply,promiseResolve=Promise.resolve,PromiseClass=Promise;
define(globalThis,"Proxy",{get:()=>undefined,configurable:false});
const record=()=>create(null),list=()=>setPrototype([],null);
function bridge(operation,payload){return parse(raw(operation,stringify(payload)));}
export function refuse(){return bridge("forbidden",null);}
function text(value,max=2048){if(typeof value!=="string"||value.length>max)return refuse();return value;}
function clone(value,depth=0,budget={nodes:0}){
 if(++budget.nodes>50000||depth>24)return refuse();
 if(value===null||typeof value==="string"||typeof value==="boolean")return value;
 if(typeof value==="number"&&Number.isFinite(value))return value;
 if(!value||typeof value!=="object")return refuse();
 const array=arrayIsArray(value),parent=prototype(value);
 if(!array&&parent!==null&&parent!==objectPrototype)return refuse();
 const fields=setPrototype(descriptors(value),null),names=keys(fields),result=array?list():record();
 if(names.length>1024)return refuse();
 if(array&&names.length!==fields.length.value+1)return refuse();
 for(let index=0;index<names.length;index++){
  const key=names[index];if(array&&key==="length")continue;
  const field=fields[key];
  if(typeof key!=="string"||key==="__proto__"||key==="prototype"||key==="constructor"||!field.enumerable||!descriptor(field,"value"))return refuse();
  if(array&&(!/^(0|[1-9]\d*)$/.test(key)||Number(key)>=fields.length.value))return refuse();
  result[key]=clone(field.value,depth+1,budget);
 }
 return result;
}
function payload(operation,sql,args){const value=record();value.operation=operation;value.sql=text(sql,512);value.args=clone(args);return bridge("query",value);}
function resolved(value){return apply(promiseResolve,PromiseClass,[value]);}
const handlers=new WeakMap();let servers=0;
export class McpServer {
 constructor(){if(++servers>4)return refuse();handlers.set(this,new Map());}
 registerTool(name,_schema,callback){name=text(name);if(typeof callback!=="function"||handlers.get(this).has(name))return refuse();handlers.get(this).set(name,callback);}
}
export const sep="/";
function pathCall(operation,args){const value=record();value.operation=operation;value.args=clone(args);return bridge("path",value);}
export const isAbsolute=(...args)=>pathCall("isAbsolute",args),join=(...args)=>pathCall("join",args),relative=(...args)=>pathCall("relative",args),resolve=(...args)=>pathCall("resolve",args);
export const posix={isAbsolute,join,relative,resolve,sep};
export const promisify=()=>refuse;
let invoked=false;
export async function run(ContextEngine,createMcpServer,inputText){
 if(invoked)return refuse();invoked=true;
 const input=parse(inputText),context=create(ContextEngine.prototype),db=record();
 db.get=(sql,args)=>resolved(payload("get",sql,args));db.all=(sql,args)=>resolved(payload("all",sql,args));
 context.db=db;context.policy=input.policy;context.projectId=input.projectId;context.root="/fixture/repo";context.dataDir="/fixture/context";
 context.ready=resolved(undefined);context.index=()=>resolved({id:input.snapshotId,projectId:input.projectId});
 const actualNeighbors=context.neighbors;
 if(typeof actualNeighbors!=="function")return refuse();
 context.neighbors=function(symbolId,snapshotId,depth=1,options){
  const event=record();event.symbolId=text(symbolId);event.snapshotId=snapshotId===undefined?null:text(snapshotId);event.depth=depth;
  const opts=options===undefined?null:clone(options);event.exportOnly=opts===null||!descriptor(opts,"exportOnly")?null:opts.exportOnly;
  bridge("neighbor",event);
  return apply(actualNeighbors,context,[symbolId,snapshotId,depth,options]);
 };
 let value=null,error=null;
 try {
  if(input.surface==="context")value=await context.neighbors(input.seed,undefined,input.depth,...(input.exportOnly===null?[]:[{exportOnly:input.exportOnly}]));
  else {
   const engine=record();engine.context=context;engine.config={policy:context.policy};engine.refresh=()=>{bridge("refresh",null);return resolved(undefined);};
   const server=createMcpServer(engine,{client:input.client});
   const handler=handlers.get(server)?.get("graph_neighbors");if(typeof handler!=="function")return refuse();
   value=await handler({symbolId:input.seed,depth:input.depth});
  }
 }catch(failure){
  const field=failure&&typeof failure==="object"?descriptor(failure,"message"):null;
  if(!field||!descriptor(field,"value")||typeof field.value!=="string")return refuse();
  if(field.value!=="Graph depth must be between 1 and 3"&&field.value!=="Offline project context cannot be exported to this cloud-backed client")return refuse();
  error=field.value;value=null;
 }
 const output=record();output.value=clone(value);output.error=error;return stringify(output);
}
`;

function compile(source, filename, CandidateError) {
  const syntax = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.ES2022,
    true,
  );
  if (syntax.parseDiagnostics.length) throw new CandidateError();
  let nodes = 0;
  const visit = (node, depth = 0) => {
    if (++nodes > 40000 || depth > 128) throw new CandidateError();
    ts.forEachChild(node, (child) => visit(child, depth + 1));
  };
  visit(syntax);
  const result = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      sourceMap: false,
      inlineSourceMap: false,
      importHelpers: false,
    },
    reportDiagnostics: true,
  });
  if (
    result.outputText.length > 200000 ||
    result.diagnostics?.some(
      (item) => item.category === ts.DiagnosticCategory.Error,
    )
  )
    throw new CandidateError();
  return result.outputText;
}

export async function executeCloudGraph(request, CandidateError) {
  const deadline = performance.now() + 3000;
  const [
    { newQuickJSWASMModuleFromVariant, newVariant },
    { default: release },
  ] = await Promise.all([
    import("quickjs-emscripten-core"),
    import("@jitl/quickjs-wasmfile-release-sync"),
  ]);
  const compiledContext = compile(
      request.files[CONTEXT],
      "context.ts",
      CandidateError,
    ),
    compiledMcp = compile(request.files[MCP], "mcp.ts", CandidateError);
  const [zod, picomatch] = await Promise.all([
    readFile("/opt/graph-guest/zod-guest.mjs", "utf8"),
    readFile("/opt/graph-guest/picomatch-guest.mjs", "utf8"),
  ]);
  const { input, graph } = request.scenario;
  const queries = [],
    neighborCalls = [];
  let refreshCalls = 0,
    boundaryViolation = false,
    diagnostic = false,
    interrupted = false,
    checks = 0,
    capabilities = 0,
    traceBytes = 0,
    jobs = 0;
  const variant = newVariant(release, {
    emscriptenModule: {
      print: () => {
        diagnostic = true;
      },
      printErr: () => {
        diagnostic = true;
      },
    },
    log: () => {},
  });
  const QuickJS = await newQuickJSWASMModuleFromVariant(variant),
    runtime = QuickJS.newRuntime();
  let context, output, failure;
  const handles = [];
  const guard = () => {
    if (performance.now() >= deadline) interrupted = true;
    if (boundaryViolation || interrupted) throw new CandidateError();
    if (diagnostic) throw new Error("Cloud interpreter diagnostic");
  };
  try {
    runtime.setMemoryLimit(64 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    runtime.setInterruptHandler(() => {
      if (++checks > 20000 || performance.now() >= deadline) interrupted = true;
      return interrupted || boundaryViolation;
    });
    context = runtime.newContext();
    const own = (handle) => {
      handles.push(handle);
      return handle;
    };
    const unwrap = (result) => {
      if (result.error) {
        result.error.dispose();
        throw new CandidateError();
      }
      return own(result.value);
    };
    const text = (handle, maximum = CLOUD_BYTES) => {
      if (context.typeof(handle) !== "string") throw new CandidateError();
      const count = context.getProp(handle, "length");
      let length;
      try {
        length = context.getNumber(count);
      } finally {
        count.dispose();
      }
      if (!Number.isInteger(length) || length < 0 || length > maximum)
        throw new CandidateError();
      const value = context.getString(handle);
      if (
        value.length !== length ||
        !value.isWellFormed() ||
        Buffer.byteLength(value) > maximum
      )
        throw new CandidateError();
      return value;
    };
    const refuse = () => {
      boundaryViolation = true;
      return { error: context.newError("Cloud capability refused") };
    };
    const exact = (value, names) =>
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === [...names].sort().join(",");
    const strings = (value, min, max) =>
      Array.isArray(value) &&
      value.length >= min &&
      value.length <= max &&
      value.every(
        (item) =>
          typeof item === "string" &&
          item.isWellFormed() &&
          item.length <= 2048,
      );
    const record = (list, value) => {
      traceBytes += Buffer.byteLength(JSON.stringify(value));
      if (traceBytes > CLOUD_BYTES) throw new CandidateError();
      list.push(value);
    };
    const capability = own(
      context.newFunction("cloudCapability", (...args) => {
        try {
          guard();
          if (++capabilities > 8192 || args.length !== 2) return refuse();
          const operation = text(args[0], 32),
            payload = JSON.parse(text(args[1]));
          let result;
          if (operation === "query") {
            if (
              !exact(payload, ["operation", "sql", "args"]) ||
              typeof payload.sql !== "string" ||
              payload.sql.length > 512 ||
              queries.length >= 640 ||
              !strings(payload.args, 2, 3) ||
              payload.args[0] !== input.snapshotId
            )
              return refuse();
            const sql = payload.sql.replace(/\s+/g, " ").trim();
            if (
              payload.operation === "get" &&
              sql === SQL.symbol &&
              payload.args.length === 2
            ) {
              const node = graph.symbols.find(
                (item) => item.id === payload.args[1],
              );
              result = node ? { payload: JSON.stringify(node) } : null;
            } else if (
              payload.operation === "all" &&
              sql === SQL.edges &&
              payload.args.length === 3 &&
              payload.args[1] === payload.args[2]
            ) {
              result = graph.edges
                .filter(
                  (item) =>
                    item.from === payload.args[1] ||
                    item.to === payload.args[1],
                )
                .slice(0, 200)
                .map((item) => ({ payload: JSON.stringify(item) }));
            } else return refuse();
            record(queries, {
              operation: payload.operation,
              sql: payload.sql,
              args: [...payload.args],
            });
          } else if (operation === "neighbor") {
            if (
              !exact(payload, [
                "symbolId",
                "snapshotId",
                "depth",
                "exportOnly",
              ]) ||
              typeof payload.symbolId !== "string" ||
              payload.symbolId.length > 2048 ||
              !(
                payload.snapshotId === null ||
                typeof payload.snapshotId === "string"
              ) ||
              !Number.isInteger(payload.depth) ||
              !(
                payload.exportOnly === null ||
                typeof payload.exportOnly === "boolean"
              ) ||
              neighborCalls.length >= 16
            )
              return refuse();
            record(neighborCalls, payload);
            result = null;
          } else if (operation === "refresh") {
            if (payload !== null || ++refreshCalls > 32) return refuse();
            result = null;
          } else if (operation === "path") {
            if (
              !exact(payload, ["operation", "args"]) ||
              !["isAbsolute", "join", "relative", "resolve"].includes(
                payload.operation,
              ) ||
              !strings(payload.args, 1, 16) ||
              (payload.operation === "isAbsolute" &&
                payload.args.length !== 1) ||
              (payload.operation === "relative" && payload.args.length !== 2)
            )
              return refuse();
            // Pure POSIX operations only. resolve's base is fixed, never the host cwd.
            result =
              payload.operation === "resolve"
                ? path.posix.resolve("/fixture", ...payload.args)
                : path.posix[payload.operation](...payload.args);
          } else return refuse();
          const encoded = JSON.stringify(result);
          if (Buffer.byteLength(encoded) > CLOUD_BYTES) return refuse();
          return context.newString(encoded);
        } catch {
          return refuse();
        }
      }),
    );
    context.setProp(context.global, "__graphCloud", capability);
    const reexports = (names) =>
      `export {${names.map((name) => `refuse as ${name}`).join(",")}} from "graph:cloud";`;
    const modules = new Map([
      ["graph:cloud", FIXTURE_MODULE],
      ["zod", zod],
      ["picomatch", MATCHER_MODULE],
      ["graph:picomatch", picomatch],
      ["candidate:context", compiledContext],
      ["candidate:mcp", compiledMcp],
      ["graph:policy", POLICY_MODULE],
      [
        "@modelcontextprotocol/sdk/server/mcp.js",
        'export {McpServer} from "graph:cloud";',
      ],
      [
        "@modelcontextprotocol/sdk/server/stdio.js",
        reexports(["StdioServerTransport"]),
      ],
      [
        "node:path",
        'export {isAbsolute,join,posix,relative,resolve,sep} from "graph:cloud";',
      ],
      ["node:util", 'export {promisify} from "graph:cloud";'],
      ["node:child_process", reexports(["execFile"])],
      ["node:crypto", reexports(["randomUUID"])],
      [
        "node:fs/promises",
        reexports([
          "chmod",
          "lstat",
          "mkdir",
          "readFile",
          "readdir",
          "realpath",
          "writeFile",
        ]),
      ],
      ["ignore", 'export {refuse as default} from "graph:cloud";'],
      ["@graph-engineering/contracts", 'export const SCHEMA_VERSION="1.0.0";'],
      ["graph:database", reexports(["ContextDatabase"])],
      [
        "graph:intelligence",
        reexports(["canonicalJson", "summarizeFiles", "reviewMemoryRecords"]) +
          'export const SUMMARY_VERSION="fixture-only";',
      ],
      [
        "graph:maintenance",
        reexports(["backupDatabase", "restoreContextBackup"]),
      ],
      [
        "graph:embeddings",
        reexports(["LocalEmbeddings"]) +
          'export const EMBEDDING_DIMENSIONS=1,EMBEDDING_KEY="fixture-only";',
      ],
      [
        "graph:parser",
        reexports(["chunkFile", "hash", "parseFile"]) +
          'export const PARSER_VERSION="fixture-only";',
      ],
      [
        "graph:semantic",
        reexports(["resolveSnapshotBindings"]) +
          'export const SEMANTIC_VERSION="fixture-only";',
      ],
      [
        "graph:memory-assertions",
        reexports([
          "attachReviewedAssertions",
          "parseReviewedAssertions",
          "reviewSupersession",
        ]),
      ],
      ["graph:templates", reexports(["listTemplates"])],
    ]);
    const virtualFiles = new Map([
      ["/engine/context/index.js", "candidate:context"],
      ["/engine/mcp.js", "candidate:mcp"],
      ["/engine/policy.js", "graph:policy"],
      ["/engine/templates.js", "graph:templates"],
      ...[
        "database",
        "intelligence",
        "maintenance",
        "embeddings",
        "parser",
        "semantic",
        "memory-assertions",
      ].map((name) => [`/engine/context/${name}.js`, `graph:${name}`]),
    ]);
    runtime.setModuleLoader(
      (name) => {
        if (!modules.has(name)) {
          boundaryViolation = true;
          throw new Error("Cloud module refused");
        }
        return modules.get(name);
      },
      (base, requested) => {
        let name = requested;
        if (requested.startsWith(".")) {
          const directory =
            base === "candidate:context"
              ? "/engine/context"
              : base === "candidate:mcp"
                ? "/engine"
                : null;
          name = directory
            ? virtualFiles.get(path.posix.resolve(directory, requested))
            : undefined;
        } else if (
          base.startsWith("candidate:") &&
          /^(?:graph|candidate):/.test(requested)
        ) {
          name = undefined;
        }
        if (!modules.has(name)) {
          boundaryViolation = true;
          throw new Error("Cloud import refused");
        }
        return name;
      },
    );
    const drain = () => {
      while (runtime.hasPendingJob()) {
        guard();
        if (++jobs > 8000) {
          interrupted = true;
          throw new CandidateError();
        }
        const result = runtime.executePendingJobs(1);
        if (result.error) {
          result.error.dispose();
          throw new CandidateError();
        }
      }
      guard();
    };
    const settle = (handle) => {
      drain();
      const state = context.getPromiseState(handle);
      if (state.type === "pending") throw new CandidateError();
      if (state.type === "rejected") {
        state.error.dispose();
        throw new CandidateError();
      }
      return own(state.value);
    };
    const fixture = unwrap(
      context.evalCode(FIXTURE_MODULE, "graph:cloud", { type: "module" }),
    );
    const run = own(context.getProp(fixture, "run"));
    const contextModule = settle(
      unwrap(
        context.evalCode(compiledContext, "candidate:context", {
          type: "module",
        }),
      ),
    );
    const mcpModule = settle(
      unwrap(
        context.evalCode(compiledMcp, "candidate:mcp", { type: "module" }),
      ),
    );
    const engine = own(context.getProp(contextModule, "ContextEngine")),
      createServer = own(context.getProp(mcpModule, "createMcpServer"));
    if (
      context.typeof(engine) !== "function" ||
      context.typeof(createServer) !== "function"
    )
      throw new CandidateError();
    const inputText = own(context.newString(JSON.stringify(input)));
    const observedText = settle(
      unwrap(
        context.callFunction(
          run,
          context.undefined,
          engine,
          createServer,
          inputText,
        ),
      ),
    );
    const value = JSON.parse(text(observedText));
    if (!exact(value, ["value", "error"])) throw new CandidateError();
    output = {
      version: "1.0.0",
      status: "completed",
      observations: { ...value, refreshCalls, neighborCalls, queries },
    };
    if (Buffer.byteLength(JSON.stringify(output)) > CLOUD_BYTES)
      throw new CandidateError();
    guard();
  } catch (error) {
    failure = error;
  } finally {
    for (const handle of handles.reverse()) if (handle.alive) handle.dispose();
    if (context?.alive) context.dispose();
    if (runtime.alive) runtime.dispose();
  }
  if (failure) throw failure;
  guard();
  return output;
}
