# Knowledge packs and cited research

- ID: knowledge-packs
- Status: implemented
- Area: context

## Problem

Models and tools change faster than any model's training data, so workers need current documentation that the team can review. An operator needs to store a documentation page as a reviewed, versioned file in the repository, read it offline, and turn a finding from it into a cited observation that a person accepts, without the fetch step becoming a way to pull in secrets or hostile content.

## Acceptance criteria

- AC1: `knowledge-add` fetches nothing unless the project's network policy allowlists the source's host over HTTPS, and refuses a URL that carries credentials or a potential secret.
  - Test: packages/engine/tests/knowledge.test.ts :: refuses unsafe or unapproved sources without fetching
  - Test: packages/engine/tests/knowledge.test.ts :: refuses a secret-bearing URL without fetching, and never writes through a symlinked pack
- AC2: Redirects, unsupported content types, oversized pages and pages containing a potential secret are refused and nothing is written.
  - Test: packages/engine/tests/knowledge.test.ts :: refuses redirects, other content types, oversized pages and secrets, writing nothing
- AC3: A stored pack records its source, retrieval time and hash; adding it again is refused, and `--refresh` records the previous hash.
  - Test: packages/engine/tests/knowledge.test.ts :: stores a sourced pack, refuses to overwrite it, and records the previous hash on refresh
- AC4: HTML pages are reduced to readable text without scripts, in time linear in the page size even for hostile markup.
  - Test: packages/engine/tests/knowledge.test.ts :: turns HTML into readable text without scripts
  - Test: packages/engine/tests/knowledge.test.ts :: converts hostile HTML in linear time
- AC5: Packs are indexed for local workers (including under a working set), are never exported to cloud clients, cannot be written or range-requested by workers, and can only be cited as a proposed observation memory.
  - Test: packages/engine/tests/knowledge.test.ts :: is indexed for local workers, never exported, and cited only as a proposed observation
  - Test: packages/engine/tests/knowledge.test.ts :: stays indexed under a working set, and out of reach of worker writes and range requests
- AC6: `knowledge-list` reports each pack's age and flags packs over 180 days old, and a context packet that includes a stale pack warns about it.
  - Test: packages/engine/tests/hygiene.test.ts :: reports stale packs and warns when retrieval includes one

## Security considerations

Fetched pages are untrusted third-party content. Network access is deny-by-default and host-allowlisted, redirects are refused so the reviewed URL is the one fetched, size limits bound parsing, and HTML conversion is linear-time to resist crafted markup. Packs live under `.graph/`, which is never sent to cloud workers and which workers cannot write, so a worker cannot plant "documentation" that later work trusts. A symlinked pack is refused so a refresh cannot write outside the pack directory. Citing a pack creates only a proposed, private observation, never a requirement or constraint, so fetched text cannot become mandatory context without a person.

## Non-goals

Knowledge packs do not crawl sites, follow links, or refresh themselves on a schedule. They are evidence, not instructions, and they are not exported to cloud models whatever the export policy says.
