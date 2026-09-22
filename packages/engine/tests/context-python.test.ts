import { afterEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_POLICY } from "@graph-engineering/contracts";
import { parseFile } from "../src/context/parser.js";
import { pythonRuntime, resolvePythonBindings } from "../src/context/python.js";
import { PYTHON_HELPER } from "../src/context/python-helper.js";
import { ContextEngine } from "../src/context/index.js";
import { checked } from "../src/util.js";
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));
const runtime = await pythonRuntime();
const roots: string[] = [],
  engines: ContextEngine[] = [];
it.runIf(!!runtime)(
  "keeps the trusted Python runtime immutable and never dispatches through caller getters",
  async () => {
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Reflect.set(runtime!, "executable", "/untrusted/python")).toBe(
      false,
    );
    let reads = 0;
    const supplied = {
      ...runtime!,
      get executable() {
        return ++reads === 1 ? runtime!.executable : "/untrusted/python";
      },
    };
    const files = await parse({
      "main.py": "def target():\n    pass\ntarget()\n",
    });
    expect(
      (await resolvePythonBindings(files, "snapshot", { runtime: supplied }))
        .resolvedCalls,
    ).toBe(1);
    expect(reads).toBe(1);
  },
);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) await engine.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const parse = (files: Record<string, string>) =>
  Promise.all(
    Object.entries(files).map(([path, text]) =>
      parseFile(path, text, "snapshot"),
    ),
  );
describe("isolated CPython snapshot bindings", () => {
  it.runIf(!!runtime && process.platform === "linux")(
    "measures the interpreter image rather than inherited Linux pre-exec parent RSS",
    async () => {
      const files = await parse({
        "main.py": "def target():\n    pass\ntarget()\n",
      });
      // A separate fixed Node parent owns the allocation, so this test does not
      // inflate the long-lived Vitest worker or retain hundreds of MiB afterward.
      const parent = String.raw`
const {spawnSync}=require('node:child_process');
const request=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
const retained=Buffer.alloc(384*1024*1024,65);
const execute=(program,input)=>{
 const child=spawnSync(request.executable,['-I','-S','-B','-c',program],{cwd:'/',env:{},encoding:'utf8',input,maxBuffer:65536,timeout:5000});
 if(child.error||child.status!==0)throw new Error('Isolated Python probe failed');
 return JSON.parse(child.stdout);
};
const measured=execute('import json,resource\nwith open("/proc/self/status") as f: lines=f.read().splitlines()\nprint(json.dumps({"inheritedPeakKiB":resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,"imagePeakKiB":int(next(line for line in lines if line.startswith("VmHWM:")).split()[1])}))');
const regular=execute(request.helper,JSON.stringify({...request.input,maxRssKiB:262144}));
const tiny=execute(request.helper,JSON.stringify({...request.input,maxRssKiB:1}));
process.stdout.write(JSON.stringify({parentRss:process.memoryUsage().rss,measured,regular,tiny,retained:retained[0]}));
`;
      const result = JSON.parse(
        await checked(process.execPath, ["-e", parent], {
          cwd: "/",
          env: {},
          timeoutMs: 10000,
          maxBytes: 65536,
          input: JSON.stringify({
            executable: runtime!.executable,
            helper: PYTHON_HELPER,
            input: { files, maxNodes: 100000 },
          }),
        }),
      );
      expect(result.parentRss).toBeGreaterThan(256 * 1024 * 1024);
      expect(result.measured.inheritedPeakKiB).toBeGreaterThan(256 * 1024);
      expect(result.measured.imagePeakKiB).toBeLessThan(256 * 1024);
      expect(result.regular.diagnostics).toEqual([]);
      expect(result.regular.analyzedFiles).toBe(1);
      expect(result.regular.updates).toHaveLength(1);
      expect(result.tiny.updates).toEqual([]);
      expect(result.tiny.diagnostics.join(" ")).toContain("resource limit");
    },
  );
  it.runIf(!!runtime && process.platform === "linux")(
    "retains Linux interpreter high-water enforcement after an allocation is freed",
    async () => {
      const definitions = PYTHON_HELPER.split(
        "\ntry:\n    output = json.dumps(main()",
        1,
      )[0]!;
      const probe =
        definitions +
        String.raw`
max_rss_kib = 32 * 1024
allocated = bytearray(64 * 1024 * 1024)
for index in range(0, len(allocated), 4096): allocated[index] = 1
del allocated
try:
    check_peak_rss()
    print('MISSED_PEAK')
except MemoryError:
    print('REJECTED_PEAK')
`;
      expect(
        await checked(runtime!.executable, ["-I", "-S", "-B", "-c", probe], {
          cwd: "/",
          env: {},
          timeoutMs: 5000,
          maxBytes: 1000,
        }),
      ).toBe("REJECTED_PEAK");
    },
  );
  it.runIf(!!runtime && process.platform === "linux")(
    "fails closed on unavailable, malformed or oversized Linux peak accounting",
    async () => {
      const definitions = PYTHON_HELPER.split(
        "\ntry:\n    output = json.dumps(main()",
        1,
      )[0]!;
      const probe =
        definitions +
        String.raw`
import builtins, io
cases = ['Name: python\n', 'VmHWM: bad kB\n', 'VmHWM: 0 kB\n', 'VmHWM: 1 MB\n', 'VmHWM: 1 kB\nVmHWM: 2 kB\n', 'x'*65537]
rejected = 0
for text in cases:
    builtins.open = lambda *args, **kwargs: io.StringIO(text)
    try: check_peak_rss()
    except MemoryError: rejected += 1
print(rejected)
`;
      expect(
        await checked(runtime!.executable, ["-I", "-S", "-B", "-c", probe], {
          cwd: "/",
          env: {},
          timeoutMs: 5000,
          maxBytes: 1000,
        }),
      ).toBe("6");
    },
  );
  it.runIf(!!runtime)(
    "does not infer unimported package attributes or bypass dynamic package initializers",
    async () => {
      const files = await parse({
        "pkg/__init__.py": "",
        "pkg/hidden.py": "def target():\n    pass\n",
        "pkg/loaded.py": "def target():\n    pass\n",
        "dynamic/__init__.py": "def __getattr__(name):\n    return object()\n",
        "dynamic/child.py": "def target():\n    pass\n",
        "main.py":
          "import pkg\nimport pkg.loaded\nfrom pkg import hidden as explicit\nimport dynamic.child\npkg.hidden.target()\npkg.loaded.target()\nexplicit.target()\ndynamic.child.target()\n",
      });
      const result = await resolvePythonBindings(files, "snapshot");
      expect(
        result.updates
          .filter((edge) => edge.kind === "calls")
          .map((edge) => edge.target)
          .sort(),
      ).toEqual(["explicit.target", "pkg.loaded.target"]);
    },
  );
  it("reports absent and untrusted runtime identities without executing them", async () => {
    const files = await parse({
      "main.py": "def target():\n    pass\ntarget()\n",
    });
    expect(
      (
        await resolvePythonBindings(files, "snapshot", { runtime: null })
      ).diagnostics.join(" "),
    ).toContain("unavailable");
    expect(
      (
        await resolvePythonBindings(files, "snapshot", {
          runtime: {
            executable: "/tmp/project-code",
            version: "3.14.0",
            identity: "untrusted",
          },
        })
      ).resolvedCalls,
    ).toBe(0);
  });
  it.runIf(!!runtime)(
    "resolves direct, aliased, namespace, relative, re-export, nested lexical calls and constructors",
    async () => {
      const files = await parse({
        "pkg/__init__.py": "from .lib import target as exported\n",
        "pkg/lib.py": "def target():\n    return 1\nclass Builder:\n    pass\n",
        "main.py":
          "from pkg.lib import target as alias, Builder\nimport pkg.lib as module\nimport pkg.lib\nfrom pkg import exported\nalias()\nmodule.target()\npkg.lib.target()\nexported()\nBuilder()\ndef outer():\n    def inner():\n        pass\n    inner()\nouter()\n",
      });
      const result = await resolvePythonBindings(files, "snapshot");
      expect(result.diagnostics).toEqual([]);
      expect(result.resolvedCalls).toBe(7);
      expect(
        result.updates
          .filter((edge) => edge.kind === "calls")
          .every(
            (edge) =>
              edge.resolution?.engine === "cpython" &&
              edge.resolution.version === runtime!.version,
          ),
      ).toBe(true);
    },
  );
  it.runIf(!!runtime)(
    "abstains on shadowing, rebinding, decorators, star imports, conditional definitions and dynamic dispatch",
    async () => {
      const files = await parse({
        "lib.py": "def target():\n    pass\n",
        "main.py":
          "from lib import target\ndef shadow(target):\n    target()\ndef changed():\n    target()\n    target = None\n@decorator\ndef decorated():\n    pass\nif condition:\n    def conditional():\n        pass\ndecorated()\nconditional()\nobj.target()\ngetattr(obj, 'target')()\ntarget()\n",
        "star.py": "from lib import *\ntarget()\n",
        "dynamic.py":
          "from lib import target\nexec('target = None')\ntarget()\n",
      });
      const result = await resolvePythonBindings(files, "snapshot");
      expect(
        result.updates
          .filter((edge) => edge.kind === "calls")
          .map((edge) => [edge.source.path, edge.target]),
      ).toEqual([["main.py", "target"]]);
    },
  );
  it.runIf(!!runtime)(
    "rejects module reassignment, ambiguous package names, nonlocal writes, missing and namespace-package targets",
    async () => {
      const files = await parse({
        "lib.py": "def target():\n    pass\n",
        "patch.py": "import lib\nlib.target = replacement\nlib.target()\n",
        "other.py":
          "from lib import target\ntarget()\ndef outer():\n    def local():\n        pass\n    def change():\n        nonlocal local\n        local = None\n    local()\n",
        "ambiguous.py": "def target():\n    pass\n",
        "ambiguous/__init__.py": "def target():\n    pass\n",
        "namespace/lib.py": "def target():\n    pass\n",
        "main.py":
          "from ambiguous import target as a\nfrom missing import target as b\nfrom namespace.lib import target as c\na()\nb()\nc()\n",
      });
      expect(
        (await resolvePythonBindings(files, "snapshot")).resolvedCalls,
      ).toBe(0);
    },
  );
  it.runIf(!!runtime)(
    "handles UTF-8 byte columns, stale hashes and snapshot source limits",
    async () => {
      const files = await parse({
        "main.py": "def target():\n    pass\ntext = '🔒'; target()\n",
      });
      expect(
        (await resolvePythonBindings(files, "snapshot")).resolvedCalls,
      ).toBe(1);
      files[0]!.text += "\n# stale";
      expect(
        (await resolvePythonBindings(files, "snapshot")).resolvedCalls,
      ).toBe(0);
      const large = await parse({
        "main.py": "#" + "a".repeat(4 * 1024 * 1024),
      });
      expect(
        (await resolvePythonBindings(large, "snapshot")).diagnostics.join(" "),
      ).toContain("limits");
    },
  );
  it
    .runIf(!!runtime)
    .each([{ maxNodes: 1 }, { maxOutputBytes: 1 }, { maxRssKiB: 1 }])(
    "enforces each configured resource limit independently: %j",
    async (options) => {
      const files = await parse({
        "main.py": "def target():\n    pass\ntarget()\n",
      });
      const result = await resolvePythonBindings(files, "snapshot", options);
      expect(result.resolvedCalls).toBe(0);
      expect(result.updates).toEqual([]);
      expect(result.diagnostics.join(" ")).toMatch(/limit|timed out/i);
    },
  );
  it.runIf(!!runtime).each(["spawn", "completion"] as const)(
    "rejects elapsed deadlines when synchronous %s work prevents the timer callback from running",
    async (blockedPhase) => {
      const files = await parse({
        "main.py": "def target():\n    pass\ntarget()\n",
      });
      const baseline = await resolvePythonBindings(files, "snapshot");
      expect(baseline.resolvedCalls).toBe(1);
      const output = JSON.stringify({
        version: runtime!.version,
        updates: baseline.updates.map((edge) => ({
          edgeId: edge.id,
          to: edge.to,
          sources: edge.resolution!.sources,
        })),
        diagnostics: [],
        analyzedFiles: 1,
      });
      const delay = () =>
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: undefined,
        exitCode: null,
        signalCode: null,
        kill: vi.fn(() => true),
        stdin: Object.assign(new EventEmitter(), {
          end: () => {
            if (blockedPhase === "completion") delay();
            child.stdout.emit("data", Buffer.from(output));
            child.emit("close", 0);
          },
        }),
      });
      vi.spyOn(childProcess, "spawn").mockImplementation((() => {
        if (blockedPhase === "spawn") delay();
        return child;
      }) as unknown as typeof childProcess.spawn);
      const result = await resolvePythonBindings(files, "snapshot", {
        timeoutMs: 5,
      });
      expect(result.resolvedCalls).toBe(0);
      expect(result.updates).toEqual([]);
      expect(result.diagnostics.join(" ")).toContain("timed out");
    },
  );
  it.runIf(!!runtime)(
    "enforces RSS inside even a short-lived isolated helper without relying on a ps sample",
    async () => {
      const files = await parse({
        "main.py": "def target():\n    pass\ntarget()\n",
      });
      const output = await new Promise<{ code: number | null; stdout: string }>(
        (resolve, reject) => {
          const child = childProcess.spawn(
            runtime!.executable,
            ["-I", "-S", "-B", "-c", PYTHON_HELPER],
            { cwd: "/", env: {}, stdio: ["pipe", "pipe", "ignore"] },
          );
          let stdout = "";
          child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
          });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout }));
          child.stdin.end(
            JSON.stringify({ files, maxNodes: 100000, maxRssKiB: 1 }),
          );
        },
      );
      expect(output.code).toBe(0);
      const result = JSON.parse(output.stdout);
      expect(result.updates).toEqual([]);
      expect(result.analyzedFiles).toBe(0);
      expect(result.diagnostics.join(" ")).toContain("resource limit");
    },
  );
  it.runIf(!!runtime).each([
    { sample: "zombie", code: null, output: "0\n", expected: 1 },
    { sample: "just exited", code: 1, output: "", expected: 1 },
    { sample: "missing sampler", code: "ENOENT", output: "", expected: 0 },
    { sample: "excess memory", code: null, output: "999999\n", expected: 0 },
  ])(
    "handles a $sample RSS sample without hiding enforcement errors",
    async ({ code, output, expected }) => {
      const files = await parse({
        "main.py": "def target():\n    pass\ntarget()\n",
      });
      // The interpreter is real. Only the first parent memory sample is injected;
      // subsequent samples use real ps, independent of interpreter startup speed.
      vi.spyOn(childProcess, "execFile").mockImplementationOnce(((
        ...args: unknown[]
      ) => {
        const callback = args.at(-1) as (
          error: unknown,
          stdout: string,
          stderr: string,
        ) => void;
        queueMicrotask(() =>
          callback(
            code === null ? null : Object.assign(new Error("sample"), { code }),
            output,
            "",
          ),
        );
        return new EventEmitter();
      }) as unknown as typeof childProcess.execFile);
      const result = await resolvePythonBindings(files, "snapshot", {
        maxRssKiB: 255 * 1024,
      });
      expect(result.resolvedCalls).toBe(expected);
      if (!expected) expect(result.diagnostics.join(" ")).toContain("limit");
    },
  );
  it.runIf(!!runtime)(
    "never imports or executes source or startup hooks and filters private re-export evidence",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "graph-python-"));
      roots.push(root);
      const repo = join(root, "repo");
      await mkdir(repo);
      const sentinel = join(root, "EXECUTED");
      const write = async (path: string, text: string) => {
        await mkdir(join(repo, path, ".."), { recursive: true });
        await writeFile(join(repo, path), text);
      };
      await write(
        "sitecustomize.py",
        `open(${JSON.stringify(sentinel)}, 'w').write('bad')\n`,
      );
      await write(
        "lib.py",
        `open(${JSON.stringify(sentinel)}, 'w').write('bad')\ndef target():\n    pass\n`,
      );
      await write("private.py", "from lib import target\n");
      await write(
        "main.py",
        "from private import target\ndef main():\n    target()\n",
      );
      const engine = new ContextEngine({
        projectId: "python-project",
        root: repo,
        dataDir: join(root, "data"),
        policy: {
          ...structuredClone(DEFAULT_POLICY),
          exportPaths: ["main.py", "lib.py"],
        },
      });
      engines.push(engine);
      const first = await engine.index({ semantic: false }),
        main = (await engine.searchSymbols("main", first.id)).find(
          (symbol) => symbol.kind !== "file",
        )!;
      const call = (await engine.neighbors(main.id, first.id)).find(
        (edge) => edge.kind === "calls",
      )!;
      expect(call.resolution?.engine).toBe("cpython");
      expect(
        call.resolution?.sources?.some(
          (source) => source.path === "private.py",
        ),
      ).toBe(true);
      expect(
        (
          await engine.neighbors(main.id, first.id, 3, { exportOnly: true })
        ).some((edge) => edge.kind === "calls"),
      ).toBe(false);
      await expect(access(sentinel)).rejects.toThrow();
      await write("lib.py", "def different():\n    pass\n");
      const second = await engine.index({ semantic: false });
      expect(
        (await engine.neighbors(main.id, second.id)).find(
          (edge) => edge.kind === "calls",
        )?.resolution,
      ).toBeUndefined();
      engine.updatePolicy({
        ...engine.policy,
        excludedPaths: [...engine.policy.excludedPaths, "private.py"],
      });
      expect(
        (await engine.neighbors(main.id, first.id)).find(
          (edge) => edge.kind === "calls",
        )?.resolution,
      ).toBeUndefined();
    },
  );
});
