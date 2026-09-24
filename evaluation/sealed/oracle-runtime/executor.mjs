// Container-only verifier entrypoint. Invalid input is deliberately silent.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MAX_FRAME_BYTES, verifyOracleFrame } from "./verifier.mjs";

async function main() {
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 65534 ||
    fileURLToPath(import.meta.url) !== "/opt/sealed-oracle/executor.mjs"
  )
    throw new Error("Fixed offline verifier container required");
  await readFile("/.dockerenv");
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_FRAME_BYTES) throw new Error("Oracle input limit");
    chunks.push(chunk);
  }
  const frame = Buffer.concat(chunks);
  try {
    process.stdout.write(`${JSON.stringify(verifyOracleFrame(frame))}\n`);
  } finally {
    frame.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

main().catch(() => {
  // Never echo the oracle, candidate, exception or stack to stdout/stderr.
  process.exitCode = 1;
});
