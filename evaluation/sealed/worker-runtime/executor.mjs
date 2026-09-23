// One-shot, public-only intake. No model, oracle, proposal or filesystem output.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inspectPublicPacket } from "./packet.mjs";

async function main() {
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 65534 ||
    fileURLToPath(import.meta.url) !== "/opt/sealed-public-intake/executor.mjs"
  )
    throw new Error("Fixed container required");
  await readFile("/.dockerenv");
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("Public packet input limit");
    chunks.push(chunk);
  }
  const ack = inspectPublicPacket(Buffer.concat(chunks));
  process.stdout.write(`${JSON.stringify(ack)}\n`);
}

main().catch(() => {
  // Do not echo input, exceptions or source into Docker/host logs.
  process.exitCode = 1;
});
