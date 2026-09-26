import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ContextItem,
  ContextPacket,
  SourceReference,
} from "@graph-engineering/contracts";
import { excludedFromIndex } from "../context/index.js";
import { parseFile } from "../context/parser.js";
import {
  containsSecret,
  isAllowedPath,
  NOT_INCLUDED_WARNING,
  safePath,
} from "../policy.js";
import { hash } from "../util.js";
import {
  fitWorkerContext,
  workerRequestBytes,
  type WorkerInput,
  type WorkerProposal,
} from "../workers/api.js";

type LineRange = Pick<
  SourceReference,
  "path" | "contentHash" | "startLine" | "endLine"
>;

// Line intervals of one file's content, keyed by path and content hash.
export class SuppliedLines {
  private readonly seen = new Map<string, [number, number][]>();
  private readonly outlines = new Set<string>();
  // Paths delivered as an outline or a line range rather than whole.
  readonly partial = new Set<string>();
  private sequence = 0;
  private key(source: Pick<LineRange, "path" | "contentHash">) {
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
  covers(source: LineRange): boolean {
    return source.startLine <= source.endLine && !this.addsLines(source);
  }
  record(source: LineRange) {
    const key = this.key(source);
    this.seen.set(key, [
      ...(this.seen.get(key) ?? []),
      [source.startLine, source.endLine],
    ]);
  }
  addsOutline(source: Pick<LineRange, "path" | "contentHash">) {
    return !this.outlines.has(this.key(source));
  }
  recordOutline(source: Pick<LineRange, "path" | "contentHash">) {
    this.outlines.add(this.key(source));
  }
  // Requested evidence ranks above every retrieval score (at most about 1.1),
  // and newer requests above older ones, when fitting evicts evidence.
  nextScore() {
    return 10 + ++this.sequence / 1_000_000;
  }
}

// Records every excerpt a worker was shown, so a patch can be held to the
// lines it saw. Outlines show structure, not code, and are not recorded.
export function recordShown(shown: SuppliedLines, packet: ContextPacket) {
  for (const item of packet.items)
    if (item.source && item.kind !== "outline") shown.record(item.source);
}

const RANGE = /^(.+)#L(\d+)-L(\d+)$/;
function parseRequest(entry: string) {
  const match = RANGE.exec(entry);
  if (!match) return { path: entry };
  const start = Number(match[2]);
  const end = Number(match[3]);
  if (!Number.isSafeInteger(start) || start < 1 || end < start)
    throw new Error(`Invalid line range request: ${entry}`);
  return { path: match[1]!, start, end };
}

async function outlineEntries(
  relative: string,
  text: string,
  snapshotId: string,
): Promise<string[]> {
  const parsed = await parseFile(relative, text, snapshotId).catch(() => null);
  return (parsed?.symbols ?? [])
    .filter((symbol) => symbol.kind !== "file" && symbol.source)
    .sort((a, b) => a.source!.startLine - b.source!.startLine)
    .map(
      (symbol) =>
        `L${symbol.source!.startLine}-L${symbol.source!.endLine} ${symbol.kind} ${symbol.name}`,
    );
}

function outlineItem(
  relative: string,
  content: string,
  entries: string[],
  snapshotId: string,
  score: number,
  entryLimit: number,
): ContextItem {
  const lineCount = content.split("\n").length;
  const shown = entries.slice(0, entryLimit);
  const text = [
    `Outline of ${relative} (${lineCount} lines). It is too large to send whole; request line ranges as ${relative}#L<start>-L<end>.`,
    ...(entries.length
      ? shown
      : [
          "No symbols were parsed for this file; request line ranges directly.",
        ]),
    ...(shown.length < entries.length
      ? [`${entries.length - shown.length} more symbols omitted.`]
      : []),
  ].join("\n");
  return {
    id: hash(`outline:${relative}:${hash(content)}:${shown.length}`),
    kind: "outline",
    text,
    score,
    source: {
      path: relative,
      startLine: 1,
      endLine: lineCount,
      contentHash: hash(content),
      snapshotId,
    },
  };
}

// Reads a worker's requests into the next packet. A request is a path (the
// whole file) or path#Lstart-Lend (an inclusive range, clamped to the file).
// A range that would not fit, alone with the mandatory text, in the
// serialized request fitWorkerContext measures, or that exceeds a routed
// context budget tighter than the default, is cut to its longest prefix that
// fits; a whole file (or a range whose first line alone does not fit) returns
// an outline of the file's symbols and line ranges instead. Cloud workers get
// nothing from a file with a potential secret. Evidence from earlier turns is
// carried forward; fitting evicts retrieval excerpts first, then the oldest
// requests.
// If the mandatory text alone does not fit, fitWorkerContext reports that.
// Each turn must supply requested lines, or an outline, not yet seen.
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
  const requested: ContextPacket["items"] = [];
  const partialIds = new Set<string>();
  for (const entry of new Set(options.requests)) {
    const request = parseRequest(entry);
    const relative = request.path;
    if (provider.kind !== "local" && !isAllowedPath(relative, policy, true))
      throw new Error(`Source request is not exportable: ${relative}`);
    const absolute = await safePath(options.workspace, relative, policy);
    let content: string | undefined;
    let unreadable: string | undefined;
    try {
      content = await readFile(absolute, "utf8");
    } catch (error) {
      unreadable = (error as NodeJS.ErrnoException).code ?? "unknown";
    }
    if (content === undefined) {
      // A directory, or a path that does not exist, gets the files of the
      // nearest directory instead of ending the run, so the worker can ask
      // again for a real file. The error is not kept: its message holds the
      // private workspace path.
      const listing =
        unreadable === "EISDIR" || unreadable === "ENOENT"
          ? await directoryListing(options.workspace, relative, {
              policy,
              exportOnly: provider.kind !== "local",
              missing: unreadable === "ENOENT",
            })
          : undefined;
      if (!listing)
        throw new Error(`Requested source is unavailable: ${relative}`);
      const item: ContextItem = {
        id: hash(`${listing.path}/:${listing.text}`),
        kind: "outline",
        text: listing.text,
        score: supplied.nextScore(),
        source: {
          path: `${listing.path}/`,
          startLine: 1,
          endLine: listing.count,
          contentHash: hash(listing.text),
          snapshotId: options.snapshotId,
        },
      };
      if (!requested.some((next) => next.id === item.id)) requested.push(item);
      continue;
    }
    // A cloud worker gets nothing from a file with a potential secret, as a
    // whole-file request would: a range could cut a secret away from the
    // context the filter needs, and an outline would show where it is.
    if (provider.kind !== "local" && containsSecret(content)) continue;
    const lines = content.split("\n");
    // A trailing newline does not start another line of content.
    const lastLine = content.endsWith("\n")
      ? Math.max(1, lines.length - 1)
      : lines.length;
    if (request.start !== undefined && request.start > lastLine)
      throw new Error(
        `Line range starts after the end of ${relative} (${lastLine} lines): ${entry}`,
      );
    const startLine = request.start ?? 1;
    const contentHash = hash(content);
    const excerpt = (endLine: number): ContextItem => {
      const text =
        request.start === undefined && endLine >= lines.length
          ? content
          : lines.slice(startLine - 1, endLine).join("\n");
      return {
        id: hash(`${relative}#L${startLine}-L${endLine}:${text}`),
        kind: "code",
        text,
        score,
        source: {
          path: relative,
          startLine,
          endLine,
          contentHash,
          snapshotId: options.snapshotId,
        },
      };
    };
    const fits = (item: ContextItem) =>
      !(
        (routedLimit !== undefined &&
          Buffer.byteLength(item.text) > routedLimit) ||
        (mandatoryFits && workerRequestBytes(withItems([item])) > ceiling)
      );
    const score = supplied.nextScore();
    let item = excerpt(
      request.start === undefined
        ? lines.length
        : Math.min(request.end!, lastLine),
    );
    // Measured after the path checks so they still run first.
    mandatoryFits ??= workerRequestBytes(withItems([])) <= ceiling;
    if (!fits(item) && request.start !== undefined) {
      // Send the longest prefix of the range that fits; the worker can
      // request the rest from where it ends.
      let low = startLine;
      let high = item.source!.endLine - 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(excerpt(middle))) low = middle;
        else high = middle - 1;
      }
      if (fits(excerpt(low))) item = excerpt(low);
    }
    if (!fits(item)) {
      const entries = await outlineEntries(
        relative,
        content,
        options.snapshotId,
      );
      let limit = entries.length;
      let outline = outlineItem(
        relative,
        content,
        entries,
        options.snapshotId,
        score,
        limit,
      );
      while (limit > 0 && !fits(outline)) {
        limit = Math.floor(limit / 2);
        outline = outlineItem(
          relative,
          content,
          entries,
          options.snapshotId,
          score,
          limit,
        );
      }
      item = outline;
    }
    if (requested.some((next) => next.id === item.id)) continue;
    requested.push(item);
    if (
      item.kind === "outline" ||
      startLine > 1 ||
      item.source!.endLine < lastLine
    )
      partialIds.add(item.id);
  }
  // Rank what adds new evidence above what the worker already has, and
  // earlier requests above later ones, so a tight budget drops repeats and
  // later extras rather than the first file the worker asked for.
  const adds = (item: ContextItem) =>
    item.source &&
    (item.kind === "outline"
      ? supplied.addsOutline(item.source)
      : supplied.addsLines(item.source));
  const fresh = requested.filter(adds);
  for (const item of [...fresh].reverse())
    item.score = NEW_EVIDENCE_SCORE + supplied.nextScore();
  const carried = input.context.items.filter(
    (item) => !requested.some((next) => next.id === item.id),
  );
  const packet = fitWorkerContext(
    withItems([...carried, ...requested]),
  ).context;
  const delivered = packet.items.filter((item) =>
    requested.some((next) => next.id === item.id),
  );
  const left = fresh.filter(
    (item) => !delivered.some((next) => next.id === item.id),
  );
  packet.coverage.warnings = packet.coverage.warnings.filter(
    (warning) => !warning.startsWith(NOT_INCLUDED_WARNING),
  );
  if (left.length && delivered.some(adds))
    packet.coverage.warnings.push(
      `${NOT_INCLUDED_WARNING}${left
        .map((item) => item.source!.path)
        .join(
          ", ",
        )}. Request each one alone next, or a line range such as path#L1-L80.`,
    );
  if (!delivered.length)
    throw new RepeatedRequestError(
      "Requested sources yielded no exportable evidence within context budget; stopped to avoid no-progress model turns",
    );
  if (
    !delivered.some((item) =>
      item.kind === "outline"
        ? supplied.addsOutline(item.source!)
        : item.source && supplied.addsLines(item.source),
    )
  )
    throw new RepeatedRequestError(
      `${options.worker} repeated source requests without new evidence; stopped to avoid no-progress model turns`,
    );
  for (const item of delivered) {
    if (item.kind === "outline") supplied.recordOutline(item.source!);
    else if (item.source) supplied.record(item.source);
    if (partialIds.has(item.id)) supplied.partial.add(item.source!.path);
  }
  return packet;
}

// Returns why a proposal may not apply, or undefined. Only files the worker
// saw in part (an outline or a line range) are checked: an edit there must
// lie inside lines it was shown. Creations, other files and edits whose
// `before` is not a unique match are left to prepareProposal.
export async function unseenPatchLocation(
  workspace: string,
  proposal: Pick<WorkerProposal, "changes">,
  shown: SuppliedLines,
  partial: ReadonlySet<string>,
  policy: WorkerInput["policy"],
): Promise<string | undefined> {
  for (const change of proposal.changes) {
    if (change.before === null || !partial.has(change.path)) continue;
    let content: string;
    try {
      content = await readFile(
        await safePath(workspace, change.path, policy),
        "utf8",
      );
    } catch {
      continue;
    }
    const at = content.indexOf(change.before);
    if (at < 0 || content.indexOf(change.before, at + 1) >= 0) continue;
    const startLine = content.slice(0, at).split("\n").length;
    const before = change.before.endsWith("\n")
      ? change.before.slice(0, -1)
      : change.before;
    const endLine = startLine + before.split("\n").length - 1;
    const location = {
      path: change.path,
      contentHash: hash(content),
      startLine,
      endLine,
    };
    if (!shown.covers(location))
      return `The change to ${change.path} edits lines ${startLine}-${endLine}, which were not shown to you; request ${change.path}#L${startLine}-L${endLine} first.`;
  }
  return undefined;
}

// Feedback for a proposal that did not apply. Cloud workers get the details
// only when every path in the proposal is exportable.
export function patchFeedbackFor(
  message: string,
  proposal: Pick<WorkerProposal, "changes">,
  provider: WorkerInput["provider"],
  policy: WorkerInput["policy"],
): string {
  if (
    provider.kind === "local" ||
    proposal.changes.every((change) => isAllowedPath(change.path, policy, true))
  )
    return message;
  return "A proposed change did not apply to lines you were shown. Request the exact exportable lines you intend to edit, then propose again.";
}

const LISTING_LIMIT = 200;
// Above any retrieved or carried evidence score.
const NEW_EVIDENCE_SCORE = 1_000;

/**
 * The files under the requested directory, or under the nearest existing
 * parent of a path that does not exist, as the worker may see them: never
 * ignored, build or policy-excluded paths, and only exportable ones for a
 * cloud worker. Bounded to 200 entries.
 */
async function directoryListing(
  workspace: string,
  requested: string,
  options: {
    policy: WorkerInput["policy"];
    exportOnly: boolean;
    missing: boolean;
  },
): Promise<{ path: string; text: string; count: number } | undefined> {
  let directory = requested.replace(/\/+$/, "");
  for (;;) {
    const info = await stat(path.join(workspace, directory)).catch(() => null);
    if (info?.isDirectory()) break;
    if (!directory || directory === ".") return undefined;
    const parent = path.posix.dirname(directory);
    directory = parent === "." ? "" : parent;
  }
  const files: string[] = [];
  let truncated = false;
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(workspace, relative), {
      withFileTypes: true,
    });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === ".git" || entry.isSymbolicLink()) continue;
      if (
        excludedFromIndex(child, options.policy, {
          directory: entry.isDirectory(),
        })
      )
        continue;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) {
        if (options.exportOnly && !isAllowedPath(child, options.policy, true))
          continue;
        if (files.length >= LISTING_LIMIT) {
          truncated = true;
          return;
        }
        files.push(child);
      }
    }
  };
  await walk(directory);
  const shown = directory || ".";
  const text = [
    options.missing
      ? `${requested} does not exist. Files under ${shown}:`
      : `${shown} is a directory. Its files:`,
    ...files.map((file) => `- ${file}`),
    ...(truncated
      ? [`(first ${LISTING_LIMIT} files; request a subdirectory to see more)`]
      : []),
    "Request one of these files, or a line range of one, to read it.",
  ].join("\n");
  return { path: shown, text, count: Math.max(1, files.length) };
}

/**
 * A request added no new evidence: the worker already has every source it
 * asked for, or none of them fits the context budget.
 */
export class RepeatedRequestError extends Error {}

/** What a worker is told the first time it repeats a request. */
export const REPEATED_REQUEST_FEEDBACK =
  "Your last request added nothing new: you already have those sources, or they do not fit the context budget. Propose your change now from the context you have, or request a different file or a smaller line range such as path#L1-L80. Another request that adds nothing stops the run.";
