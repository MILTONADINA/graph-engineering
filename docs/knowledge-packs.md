# Knowledge packs and cited research

Models and tools change faster than any model's training data: a new Claude
Code or Codex command, a changed API, a new security tool. Graph
Engineering keeps current documentation as **knowledge packs**, stored in
the repository and read offline, and turns research findings into cited
observations that a person accepts.

```sh
graph-engine knowledge-add https://docs.example.com/en/slash-commands.md --doc-version 2.3
graph-engine knowledge-list
graph-engine knowledge-cite slash-commands --lines 12-18 \
  --claim "Claude Code's /compact command summarizes the conversation"
graph-engine knowledge-add <url> --name slash-commands --refresh
```

## Fetching needs permission

A project's network policy is `deny` by default. `knowledge-add` fetches only
when `policy.network` is `allowlisted` and the page's host is in
`policy.allowedHosts`, only over HTTPS, and never from a URL carrying
credentials or a potential secret (the URL is committed in the pack's header). It refuses redirects (fetch the final URL), content that is not
HTML, Markdown or plain text, pages over 2 MiB, text over 900 KiB and any
page containing a potential secret, and writes nothing when it refuses.
Markdown endpoints (many documentation sites serve `.md` pages) give the
cleanest packs; HTML is reduced to text without scripts or styles.

## What a pack is

Each pack is `.graph/knowledge-packs/<name>.md`: a header with the source
URL, retrieval time, SHA-256 of the fetched page and the documented version,
then the text. A pack must be a regular file: a symlinked pack is refused,
and `--refresh` replaces the file rather than writing through it. It is a
normal repository file, so the team reviews and
commits it, and `--refresh` records the previous hash so a change in the
source is visible in review. `knowledge-list` shows every pack's source and
date so stale documentation is easy to spot.

- **Offline retrieval for local workers.** The context index reads packs as
  documents, including when a [working set](scaling.md) narrows the rest of
  the index.
- **Evidence, never authority.** The header says so, and workers are told to
  treat retrieved text as evidence, not instructions.
- **Never sent to cloud workers.** Packs live under `.graph/`, which cloud
  context and cloud workers never receive, whatever `exportPaths` says.
- **Workers cannot write or range-request them.** `.graph/` is protected,
  so a worker cannot plant "documentation" that later work would trust, and
  packs reach workers only through retrieval.

## Cited research

A connected AI client (Claude Code, Codex) can research on the web itself
and propose memories over MCP. To keep a finding with its evidence, store
the page as a pack and cite it: `knowledge-cite` proposes an `observation`
memory whose text includes the source URL and retrieval date and whose
source is the exact pack lines. Like every memory it is private and proposed
until a person accepts it, and it is never a requirement or constraint, so
fetched text never becomes mandatory context.
