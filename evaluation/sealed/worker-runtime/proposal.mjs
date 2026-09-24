// Public-only, strict parser shared by the local relay and private collector.
// The collector derives exact proposal bytes from the retained model response;
// neither caller-supplied proposal text nor a second permissive parser is used.
import { decodeJson } from "../schema.mjs";

function finiteTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseRetainedLocalProposal(raw, task, packet, requestedModel) {
  const body = decodeJson(
    new TextDecoder("utf-8", { fatal: true }).decode(raw),
  );
  const text = body?.choices?.[0]?.message?.content;
  const model = body?.model;
  if (
    typeof model !== "string" ||
    model !== requestedModel ||
    model.length < 1 ||
    model.length > 256 ||
    /[\x00-\x1f\x7f]/.test(model) ||
    typeof text !== "string" ||
    text.length > 500_000
  )
    throw new Error("Local model returned no bounded structured proposal");
  const proposalBytes = Buffer.from(text, "utf8");
  if (proposalBytes.length > 500_000)
    throw new Error("Local model proposal byte limit");
  const proposal = decodeJson(text);
  if (
    !proposal ||
    Array.isArray(proposal) ||
    Object.keys(proposal).sort().join(",") !== "changes,requests,summary" ||
    typeof proposal.summary !== "string" ||
    proposal.summary.length > 4000 ||
    !Array.isArray(proposal.changes) ||
    proposal.changes.length > 50 ||
    !Array.isArray(proposal.requests) ||
    proposal.requests.length > 12 ||
    proposal.requests.some(
      (value) =>
        typeof value !== "string" || value.length < 1 || value.length > 400,
    )
  )
    throw new Error("Local model proposal shape rejected");
  const selected = new Map(
    packet.files.map((file) => [file.path, file.content]),
  );
  const seen = new Set();
  for (const change of proposal.changes) {
    if (
      !change ||
      Array.isArray(change) ||
      Object.keys(change).sort().join(",") !== "after,before,path" ||
      typeof change.path !== "string" ||
      !task.allowedOutputPaths.includes(change.path) ||
      seen.has(change.path) ||
      typeof change.after !== "string" ||
      Buffer.byteLength(change.after) > 100_000 ||
      (change.before !== null &&
        (typeof change.before !== "string" ||
          !change.before ||
          !selected.get(change.path)?.includes(change.before))) ||
      (change.before === null && selected.has(change.path))
    )
      throw new Error("Local model proposal exceeds frozen output scope");
    seen.add(change.path);
  }
  return {
    model,
    proposalBytes,
    inputTokens: finiteTokenCount(
      body.usage?.prompt_tokens ?? body.usage?.input_tokens,
    ),
    outputTokens: finiteTokenCount(
      body.usage?.completion_tokens ?? body.usage?.output_tokens,
    ),
  };
}
