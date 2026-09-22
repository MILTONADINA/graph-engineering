// Executes only reviewed immutable historical source, never arbitrary worker patches.
// Node vm is an instrumentation boundary, NOT a hostile-code security sandbox.
import vm from "node:vm";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { z } from "zod";

export function historicalDecisionAdapter(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > 100000)
    throw new Error("Historical decision source is missing or oversized");
  const syntax = ts.createSourceFile(
    "decisions.ts",
    source,
    ts.ScriptTarget.ES2022,
    true,
  );
  if (syntax.parseDiagnostics.length)
    throw new Error("Historical decision source is invalid TypeScript");
  const requests = [];
  const exported = {};
  const context = vm.createContext({
    exports: exported,
    module: { exports: exported },
    Error,
    process: { env: {} },
    AbortController: class {
      signal = {};
    },
    AbortSignal: { any: () => ({}), timeout: () => ({}) },
    fetch: async (endpoint, request) => {
      // Deliberately a recording in-memory stub: no sockets, provider, or model.
      requests.push({ endpoint, method: request.method });
      return {
        ok: true,
        json: async () => ({
          model: "fixture-response-only",
          answers: { action: { choice: "frontier", confidence: 0.9 } },
        }),
      };
    },
    require: (name) => {
      if (name === "zod") return { z };
      if (name === "node:path") return path;
      if (name === "./policy.js")
        return {
          containsSecret: () => false, // Only fixed benign fixture states are supplied.
          assertEndpoint: (endpoint, policy, local) => {
            const host = new URL(endpoint).hostname;
            if (
              local ? host !== "127.0.0.1" : !policy.allowedHosts.includes(host)
            )
              throw new Error("Fixture endpoint is not allowed");
          },
        };
      if (name === "./util.js")
        return {
          hash: (value) =>
            createHash("sha256").update(JSON.stringify(value)).digest("hex"),
          id: () => "synthetic-observation-not-exported",
          now: () => "2026-01-01T00:00:00.000Z",
          readJson: () => {
            throw new Error("Historical fixture cannot access project files");
          },
        };
      throw new Error(`Historical fixture forbids dependency ${name}`);
    },
  });
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText;
  new vm.Script(javascript, {
    filename: "reviewed-historical-decisions.cjs",
  }).runInContext(context, { timeout: 1000 });
  if (typeof exported.decide !== "function")
    throw new Error("Historical source has no decide export");
  return async (input) => {
    const before = requests.length;
    let timer;
    try {
      const records = await Promise.race([
        exported.decide(input),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Historical decision fixture timed out")),
            1000,
          );
        }),
      ]);
      return {
        requests: requests.slice(before),
        selected: records[0]?.selected,
        failure: records[0]?.evidence?.failure ?? null,
        baseline: records[0]?.baseline,
        mode: records[0]?.mode,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
