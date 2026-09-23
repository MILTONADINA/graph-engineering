// A sealed worker receives an explicitly selected public source packet. Memory,
// private oracle bytes and prior arm outcomes have no representation here.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ProjectPolicy } from "@graph-engineering/contracts";
import { containsSecret, isAllowedPath, safePath } from "./policy.js";
import { canonicalJson, freezeJson } from "./sealed-collection-schema.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const requestSchema = z
  .object({
    taskId: identity,
    repositoryId: identity,
    baselineSha256: digest,
    objective: z.string().min(1).max(4000),
    acceptance: z.array(z.string().min(1).max(2000)).min(1).max(30),
    selected: z
      .array(
        z
          .object({
            path: z.string().min(1).max(400),
            kind: z.enum(["source", "documentation"]),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict();
const MAX_FILE_BYTES = 100_000;
const MAX_PACKET_BYTES = 2_000_000;
const privateNames =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx))$/i;
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

function assertPublicPath(relative: string, policy: ProjectPolicy): void {
  const segments = relative.split("/");
  if (
    !isAllowedPath(relative, policy, true) ||
    segments.some(
      (segment) =>
        privateNames.test(segment) ||
        [".ssh", ".aws", ".gnupg", "private-memory"].includes(
          segment.toLowerCase(),
        ),
    )
  )
    throw new Error("Selected file is outside public source/document scope");
}

async function readSelectedFile(
  root: string,
  relative: string,
  policy: ProjectPolicy,
): Promise<string> {
  assertPublicPath(relative, policy);
  const filename = await safePath(root, relative, policy);
  const before = await lstat(filename);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > MAX_FILE_BYTES
  )
    throw new Error("Selected file must be a bounded regular source file");
  const handle = await open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > MAX_FILE_BYTES
    )
      throw new Error("Selected file changed before reading");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > MAX_FILE_BYTES)
        throw new Error("Selected file exceeds its byte limit");
      chunks.push(chunk);
    }
    const after = await handle.stat();
    if (
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      size !== after.size ||
      (await realpath(filename)) !== filename
    )
      throw new Error("Selected file changed while reading");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    if (content.includes("\0") || containsSecret(content))
      throw new Error(
        "Selected file contains binary data or a potential secret",
      );
    return content;
  } finally {
    await handle.close();
  }
}

export interface SealedPublicPacketInput {
  root: string;
  policy: ProjectPolicy;
  taskId: string;
  repositoryId: string;
  baselineSha256: string;
  objective: string;
  acceptance: string[];
  selected: { path: string; kind: "source" | "documentation" }[];
}

/** Reads fresh files and returns the exact bytes to retain before dispatch. */
export async function buildSealedPublicPacket(input: SealedPublicPacketInput) {
  const { root, policy, ...data } = input;
  const request = requestSchema.parse(data);
  if (
    !path.isAbsolute(root) ||
    !request.objective.isWellFormed() ||
    request.acceptance.some((item) => !item.isWellFormed()) ||
    request.selected.some(
      (item) => !item.path.isWellFormed() || /[\x00-\x1f]/.test(item.path),
    ) ||
    containsSecret(request.objective) ||
    request.acceptance.some(containsSecret)
  )
    throw new Error(
      "Public packet needs an absolute root and well-formed, secret-free task",
    );
  const canonicalRoot = await realpath(root);
  const names = request.selected.map((item) => item.path.toLowerCase());
  if (new Set(names).size !== names.length)
    throw new Error("Duplicate public source path");
  const files = [];
  for (const item of request.selected) {
    const content = await readSelectedFile(canonicalRoot, item.path, policy);
    files.push({
      path: item.path,
      kind: item.kind,
      sha256: hash(Buffer.from(content)),
      content,
    });
  }
  const packet = freezeJson({
    version: "1.0.0" as const,
    kind: "sealed-public-task-packet" as const,
    taskId: request.taskId,
    repositoryId: request.repositoryId,
    baselineSha256: request.baselineSha256,
    objective: request.objective,
    acceptance: request.acceptance,
    files,
  });
  const bytes = Buffer.from(canonicalJson(packet));
  if (bytes.length > MAX_PACKET_BYTES)
    throw new Error("Public source packet exceeds its byte limit");
  return {
    packet,
    bytes,
    sha256: hash(bytes),
  };
}

/** Bind the exact prepared worker packet to the frozen task commitment. */
export function assertPublicPacketCommitment(
  prepared: Awaited<ReturnType<typeof buildSealedPublicPacket>>,
  task: {
    taskId: string;
    repositoryId: string;
    baselineSha256: string;
    publicPacketSha256: string;
  },
): void {
  if (
    prepared.packet.taskId !== task.taskId ||
    prepared.packet.repositoryId !== task.repositoryId ||
    prepared.packet.baselineSha256 !== task.baselineSha256 ||
    prepared.sha256 !== task.publicPacketSha256 ||
    hash(prepared.bytes) !== task.publicPacketSha256
  )
    throw new Error("Public worker packet differs from its frozen task");
}
