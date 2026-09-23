// Copied over the guest's historical dist/store.js. The unmodified historical
// service.ts runs in Node; every durable store operation runs in the separate
// controller, using the actual historical RunStore implementation.
import { execFileSync } from "node:child_process";

const node = process.execPath;
const helper = "/opt/retry/runtime/candidate-rpc-helper.mjs";
const environment = Object.freeze({
  GRAPH_RETRY_CONTROL_SOCKET: process.env.GRAPH_RETRY_CONTROL_SOCKET,
});
const methods = Object.freeze([
  "recoverInterrupted",
  "savePlan",
  "plan",
  "saveRun",
  "reserve",
  "reserveResume",
  "claim",
  "run",
  "runs",
  "events",
  "event",
  "decision",
  "decisions",
  "assertResumeAccounting",
  "usage",
  "reserveCall",
  "settleCall",
  "tryAcquireWorker",
  "releaseWorker",
  "accountingSummary",
  "close",
]);

export function retryControllerCall(operation, args = []) {
  if (
    typeof operation !== "string" ||
    operation.length > 80 ||
    !Array.isArray(args)
  )
    throw new Error("Invalid retry controller request");
  const input = JSON.stringify({ operation, args });
  if (Buffer.byteLength(input) > 65_000)
    throw new Error("Retry controller request limit");
  const output = execFileSync(node, [helper], {
    input,
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 65_536,
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (Buffer.byteLength(output) > 65_000)
    throw new Error("Retry controller response limit");
  const result = JSON.parse(output);
  if (
    !result ||
    Object.keys(result).sort().join(",") !== "ok,value" ||
    typeof result.ok !== "boolean"
  )
    throw new Error("Invalid retry controller response");
  if (!result.ok) throw new Error(String(result.value).slice(0, 300));
  return result.value;
}

export class RunStore {
  schemaVersion = 3;
  constructor(directory, projectId) {
    retryControllerCall("store.open", [directory, projectId]);
  }
}
for (const method of methods)
  Object.defineProperty(RunStore.prototype, method, {
    value: function (...args) {
      return retryControllerCall(`store.${method}`, args);
    },
  });
