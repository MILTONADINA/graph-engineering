import { readFile } from "node:fs/promises";
import type {
  ContextPacket,
  SourceReference,
} from "@graph-engineering/contracts";
import { isAllowedPath, safePath } from "../policy.js";
import { hash } from "../util.js";
import {
  fitWorkerContext,
  workerRequestBytes,
  type WorkerInput,
} from "../workers/api.js";

type LineRange = Pick<
  SourceReference,
  "path" | "contentHash" | "startLine" | "endLine"
>;

// Line intervals supplied to a worker in one attempt, per file path and
// content hash. Only requested items count, so a worker may still request a
// file that retrieval already showed.
export class SuppliedLines {
  private readonly seen = new Map<string, [number, number][]>();
  private key(source: LineRange) {
    return `${source.path}\0${source.contentHash}`;
  }
  addsLines(source: LineRange): boolean {
    if (source.startLine > source.endLine) return false;
    const ranges = [...(this.seen.get(this.key(source)) ?? [])].sort(
      (a, b) => a[0] - b[0],
    );
    let next = source.startLine;
    for (const [start, end] of ranges) {
      if (end < next) continue;
      if (start > next) return true;
      next = end + 1;
      if (next > source.endLine) return false;
    }
    return next <= source.endLine;
  }
  record(source: LineRange) {
    const key = this.key(source);
    this.seen.set(key, [
      ...(this.seen.get(key) ?? []),
      [source.startLine, source.endLine],
    ]);
  }
}

// Reads a worker's requested files into the next packet. A file is refused
// when it alone, with the mandatory text, would not fit the serialized request
// that fitWorkerContext measures; files that each fit alone can still be
// dropped together by fitting. A routed context budget tighter than the
// default also bounds each file's raw size, so that decision keeps applying to
// requests. If the mandatory text alone does not fit, fitWorkerContext reports
// that instead. Each turn must supply lines the worker has not yet seen.
export async function requestedSourcePacket(options: {
  workspace: string;
  input: WorkerInput;
  requests: readonly string[];
  snapshotId: string;
  supplied: SuppliedLines;
  worker: "Worker" | "DAG worker";
  routedBudget?: number;
}): Promise<ContextPacket> {
  const { input, supplied } = options;
  const { provider, policy } = input;
  const ceiling = Math.min(
    policy.maxContextTokens,
    provider.maxContextTokens ?? policy.maxContextTokens,
  );
  const withItems = (items: ContextPacket["items"]): WorkerInput => ({
    ...input,
    context: {
      ...input.context,
      items,
      estimatedTokens:
        Buffer.byteLength(JSON.stringify(items)) +
        Buffer.byteLength(JSON.stringify(input.context.mandatory)),
    },
  });
  const routedLimit =
    options.routedBudget !== undefined &&
    options.routedBudget < Math.floor(ceiling * 0.7)
      ? options.routedBudget
      : undefined;
  let mandatoryFits: boolean | undefined;
  const items: ContextPacket["items"] = [];
  for (const relative of new Set(options.requests)) {
    if (provider.kind !== "local" && !isAllowedPath(relative, policy, true))
      throw new Error(`Source request is not exportable: ${relative}`);
    const absolute = await safePath(options.workspace, relative, policy);
    let text: string;
    try {
      text = await readFile(absolute, "utf8");
    } catch {
      throw new Error(`Requested source is unavailable: ${relative}`);
    }
    const item = {
      id: hash(relative + text),
      kind: "code" as const,
      text,
      score: 1,
      source: {
        path: relative,
        startLine: 1,
        endLine: text.split("\n").length,
        contentHash: hash(text),
        snapshotId: options.snapshotId,
      },
    };
    // Measured after the path checks so they still run first.
    mandatoryFits ??= workerRequestBytes(withItems([])) <= ceiling;
    if (
      (routedLimit !== undefined && Buffer.byteLength(text) > routedLimit) ||
      (mandatoryFits && workerRequestBytes(withItems([item])) > ceiling)
    )
      throw new Error(
        `Requested file is too large for the context budget: ${relative}`,
      );
    items.push(item);
  }
  const packet = fitWorkerContext(withItems(items)).context;
  if (!packet.items.length)
    throw new Error(
      "Requested sources yielded no exportable evidence within context budget; stopped to avoid no-progress model turns",
    );
  if (
    !packet.items.some((item) => item.source && supplied.addsLines(item.source))
  )
    throw new Error(
      `${options.worker} repeated source requests without new evidence; stopped to avoid no-progress model turns`,
    );
  for (const item of packet.items)
    if (item.source) supplied.record(item.source);
  return packet;
}
