// Narrow private digest oracle. This is not a general engineering test runner.
import { createHash, timingSafeEqual } from "node:crypto";

export const MAX_ORACLE_BYTES = 2_000_000;
export const MAX_PROPOSAL_BYTES = 2_000_000;
export const FRAME_HEADER_BYTES = 24;
export const MAX_FRAME_BYTES =
  FRAME_HEADER_BYTES + MAX_ORACLE_BYTES + MAX_PROPOSAL_BYTES;
const SHA = /^[a-f0-9]{64}$/;

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export function oracleBytes(expectedSha256) {
  if (typeof expectedSha256 !== "string" || !SHA.test(expectedSha256))
    throw new Error("Digest oracle needs one exact proposal SHA-256");
  return Buffer.from(
    JSON.stringify({
      expectedSha256,
      kind: "sealed-digest-oracle",
      version: "1.0.0",
    }),
  );
}

export function frameOracleRequest(oracle, proposal, nonce) {
  if (
    !Buffer.isBuffer(oracle) ||
    !Buffer.isBuffer(proposal) ||
    !Buffer.isBuffer(nonce) ||
    oracle.length < 1 ||
    oracle.length > MAX_ORACLE_BYTES ||
    proposal.length < 1 ||
    proposal.length > MAX_PROPOSAL_BYTES ||
    nonce.length !== 16
  )
    throw new Error("Oracle frame has invalid bounded bytes");
  const frame = Buffer.allocUnsafe(
    FRAME_HEADER_BYTES + oracle.length + proposal.length,
  );
  frame.writeUInt32BE(oracle.length, 0);
  frame.writeUInt32BE(proposal.length, 4);
  nonce.copy(frame, 8);
  oracle.copy(frame, FRAME_HEADER_BYTES);
  proposal.copy(frame, FRAME_HEADER_BYTES + oracle.length);
  return frame;
}

export function verifyOracleFrame(input) {
  if (!Buffer.isBuffer(input) || input.length < FRAME_HEADER_BYTES)
    throw new Error("Invalid oracle frame");
  const oracleLength = input.readUInt32BE(0);
  const proposalLength = input.readUInt32BE(4);
  if (
    oracleLength < 1 ||
    oracleLength > MAX_ORACLE_BYTES ||
    proposalLength < 1 ||
    proposalLength > MAX_PROPOSAL_BYTES ||
    input.length !== FRAME_HEADER_BYTES + oracleLength + proposalLength
  )
    throw new Error("Oracle frame length mismatch");
  const oracle = input.subarray(
    FRAME_HEADER_BYTES,
    FRAME_HEADER_BYTES + oracleLength,
  );
  const proposal = input.subarray(FRAME_HEADER_BYTES + oracleLength);
  let parsed;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(oracle);
    parsed = JSON.parse(text);
    if (
      !parsed ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !== "expectedSha256,kind,version" ||
      parsed.kind !== "sealed-digest-oracle" ||
      parsed.version !== "1.0.0" ||
      typeof parsed.expectedSha256 !== "string" ||
      !SHA.test(parsed.expectedSha256) ||
      !oracle.equals(oracleBytes(parsed.expectedSha256))
    )
      throw new Error("Invalid oracle commitment");
  } catch {
    throw new Error("Invalid private digest oracle");
  }
  const proposalSha256 = sha256(proposal);
  const accepted = timingSafeEqual(
    Buffer.from(proposalSha256, "hex"),
    Buffer.from(parsed.expectedSha256, "hex"),
  );
  return Object.freeze({
    version: "1.0.0",
    kind: "sealed-digest-verification",
    oracleSha256: sha256(oracle),
    nonce: input.subarray(8, FRAME_HEADER_BYTES).toString("hex"),
    status: accepted ? "pass" : "fail",
  });
}
