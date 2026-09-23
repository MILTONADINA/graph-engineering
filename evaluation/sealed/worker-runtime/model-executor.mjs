// Offline one-shot guest: packet in, exact public-only model request out.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildLocalModelRequest } from "./model-request.mjs";

async function main() {
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 65534 ||
    fileURLToPath(import.meta.url) !==
      "/opt/sealed-public-intake/model-executor.mjs"
  )
    throw new Error("Fixed model worker container required");
  await readFile("/.dockerenv");
  const [, , model, tokenLimit] = process.argv;
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("Model packet input limit");
    chunks.push(chunk);
  }
  const request = buildLocalModelRequest(
    Buffer.concat(chunks),
    model,
    Number(tokenLimit),
  );
  process.stdout.write(request);
}

main().catch(() => {
  // Never print packet bytes, source, model output or an exception to logs.
  process.exitCode = 1;
});
