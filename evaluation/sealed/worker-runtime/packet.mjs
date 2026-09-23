// The fixed intake guest consumes one canonical, builder-shaped public packet.
// Shape validation is not proof that a particular builder produced the bytes.
import { createHash } from "node:crypto";

const MAX_PACKET_BYTES = 2_000_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA = /^[a-f0-9]{64}$/;
const PRIVATE_NAME =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx))$/i;
// Mirrors the exporter's conservative screen; it is not a complete DLP policy.
const SECRET =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b|(?:password|api[_-]?key|secret|access[_-]?token)\s*[:=]\s*["']?(?!\$\{|process\.env|os\.environ|<|example|placeholder|your[-_]|test[-_]|undefined|null)[A-Za-z0-9+/_=-]{16,}/i;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exact = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const wellFormed = (value, min, max) =>
  typeof value === "string" &&
  value.length >= min &&
  value.length <= max &&
  value.isWellFormed();

function publicPath(value) {
  if (!wellFormed(value, 1, 400) || /[\\:\x00-\x1f]/.test(value)) return false;
  return value
    .split("/")
    .every(
      (part) =>
        part &&
        part !== "." &&
        part !== ".." &&
        !/[. ]$/.test(part) &&
        !PRIVATE_NAME.test(part) &&
        ![".ssh", ".aws", ".gnupg", "private-memory"].includes(
          part.toLowerCase(),
        ) &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    );
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Rejects changed/noncanonical bytes and returns a content-only acknowledgment. */
export function inspectPublicPacket(input) {
  if (
    !Buffer.isBuffer(input) ||
    input.length < 1 ||
    input.length > MAX_PACKET_BYTES ||
    (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf)
  )
    throw new Error("Invalid bounded public packet bytes");
  let packet;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    packet = JSON.parse(text);
  } catch {
    throw new Error("Public packet must be UTF-8 JSON");
  }
  if (
    !exact(packet, [
      "version",
      "kind",
      "taskId",
      "repositoryId",
      "baselineSha256",
      "objective",
      "acceptance",
      "files",
    ]) ||
    packet.version !== "1.0.0" ||
    packet.kind !== "sealed-public-task-packet" ||
    typeof packet.taskId !== "string" ||
    !ID.test(packet.taskId) ||
    typeof packet.repositoryId !== "string" ||
    !ID.test(packet.repositoryId) ||
    typeof packet.baselineSha256 !== "string" ||
    !SHA.test(packet.baselineSha256) ||
    !wellFormed(packet.objective, 1, 4000) ||
    SECRET.test(packet.objective) ||
    !Array.isArray(packet.acceptance) ||
    packet.acceptance.length < 1 ||
    packet.acceptance.length > 30 ||
    packet.acceptance.some(
      (item) => !wellFormed(item, 1, 2000) || SECRET.test(item),
    ) ||
    !Array.isArray(packet.files) ||
    packet.files.length < 1 ||
    packet.files.length > 64
  )
    throw new Error("Invalid public packet shape");
  const paths = new Set();
  for (const file of packet.files) {
    if (
      !exact(file, ["path", "kind", "sha256", "content"]) ||
      !publicPath(file.path) ||
      !["source", "documentation"].includes(file.kind) ||
      typeof file.sha256 !== "string" ||
      !SHA.test(file.sha256) ||
      !wellFormed(file.content, 0, 100_000) ||
      Buffer.byteLength(file.content) > 100_000 ||
      file.content.includes("\0") ||
      SECRET.test(file.content) ||
      hash(Buffer.from(file.content)) !== file.sha256 ||
      paths.has(file.path.toLowerCase())
    )
      throw new Error("Invalid public source entry");
    paths.add(file.path.toLowerCase());
  }
  if (canonical(packet) !== text)
    throw new Error("Public packet must use exact canonical bytes");
  return Object.freeze({
    version: "1.0.0",
    kind: "sealed-public-intake-ack",
    status: "accepted",
    publicPacketSha256: hash(input),
    bytes: input.length,
    taskId: packet.taskId,
    repositoryId: packet.repositoryId,
  });
}
