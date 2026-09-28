# Explicit memory assertions

Structured assertions describe what a reviewer explicitly declared. They do not
prove the statement is true, verify the reviewer's identity, extract facts from
free text, or authorize acceptance/publication.

Create a private proposal that cites its evidence, then attach a reviewed JSON
file:

```sh
graph memory-add "Use PostgreSQL for production storage." --kind constraint \
  --source docs/adr/0012-database.md#L5-L18
graph memory-assertions <memory-id> reviewed-assertions.json
graph memory-accept <memory-id>
graph memory-share <memory-id>
graph memory-export-authorize <memory-id>                  # prints the exact text and its SHA-256
graph memory-export-authorize <memory-id> --sha256 <hash>  # records consent
```

Attachment is only allowed while a record is `proposed`; acceptance, sharing and
export authorization are separate, explicit operations. `--source
<path>#L<start>-L<end>` (or `#L<line>`; repeat it for more sources) cites lines
of a file in a fresh index snapshot of the working tree, which records the
file's content hash. A file that does not exist, a file the index leaves out
(excluded, ignored by Git, outside the working set, binary, over 1 MiB or
matching a credential pattern) and lines past the end of the file are refused.

Sharing does not release a memory to cloud consumers. A requirement or
constraint reaches a cloud client or worker only when it cites source evidence
inside `exportPaths`, is shared, and an operator has authorized its exact text:
`graph memory-export-authorize <memory-id>` shows the text and its SHA-256, and
re-running with `--sha256 <hash>` records that consent;
`graph memory-export-revoke <memory-id>` withdraws it. Until then cloud
`context_get` and cloud worker turns refuse the whole packet, naming each
blocked memory and the command that unblocks it. Only the operator's command
line records consent; no MCP tool or dashboard route can. `memory-add` warns
when a new requirement or constraint in a project that allows cloud inference
cites no source, or a source outside `exportPaths`, since it could not be
authorized.

To revise accepted knowledge, or to replace a requirement or constraint that
cites no exportable evidence, propose a successor with `--supersedes <old-id>`:

```sh
graph memory-add "Use PostgreSQL 16 for production storage." --kind constraint \
  --source docs/adr/0014-database.md#L3-L9 --supersedes <old-id>
graph memory-accept <new-id>   # retires <old-id>: its status becomes superseded
```

Accepting the successor retires the old memory, which keeps its history but
leaves every context packet. Only an accepted memory can be superseded, so a
`conflicted` one cannot. An assertion review's timestamp must not predate its
proposal. The authenticated local API equivalent is `POST /api/memories` with
`{ text, kind, sources?: [{ path, startLine, endLine }], supersedes? }` (the
server resolves each source's content hash and snapshot itself), then `POST /api/memories/:id/assertions` with the JSON document
as its body, followed separately by `/accept` and, if intended, `/promote`.

```json
{
  "version": "1.0.0",
  "claims": [
    {
      "subject": "application.database",
      "predicate": "engine",
      "scope": { "environment": "production" },
      "value": { "type": "string", "value": "postgresql" },
      "exclusive": true
    }
  ],
  "review": {
    "reviewer": "project-partner",
    "reviewedAt": "2026-09-22T12:00:00.000Z",
    "evidence": ["Reviewed ADR-12 and its source references"]
  }
}
```

Use the actual review time and evidence. Optional `validFrom`/`validUntil` on a
claim are ISO timestamps defining a half-open interval `[from, until)`; omitted
endpoints are unbounded. Scope is required: `{}` is explicitly global and is not
equivalent to a named environment. Subject/predicate/scope strings are exact and
case-sensitive. Equivalent aliases must be mapped to the same canonical values
by the reviewer; the engine does not guess synonyms.

Values support `string`, finite `number`, `boolean`, and `string-set`.
Strings, numbers, and booleans remain different types; set ordering and duplicate
set elements do not change meaning. Claim order, scope-key order, evidence order,
and equivalent timestamp offsets are normalized without mutating the input.

An `exact-contradiction` means two reviewed claims declare different typed values
for the same exact subject/predicate/scope, overlapping validity, and both declare
`exclusive: true`. Nonexclusive alternatives do not imply a contradiction;
inconsistent exclusivity declarations get a separate semantics flag. Free-text
`possible-contradiction` flags remain lexical heuristics. Neither flag selects a
winner or removes required constraints.

Malformed/cyclic/dangling/competing or backward-time supersession requires review.
Explicit acceptance rejects invalid links; shared import keeps required
predecessors active instead of applying invalid transitions. Valid imported
chains are processed atomically independent of filename order. Concurrent memory
changes abort compare-and-swap updates and require reloading/reviewing. Sharing
also writes a repository file, so inspect that file if a concurrent-update error
occurs during sharing.

Metadata must be plain JSON, at most 64 KB, with 1–32 claims and 1–32 evidence
entries. Identifiers and scope values are at most 240 characters; scope has at
most 16 dimensions. String values/evidence entries are at most 4,000 characters;
sets contain at most 64 strings of at most 1,000 characters. Prototype keys,
accessors, sparse arrays, non-finite values, unsupported fields, and detected
credential patterns are rejected. Credential screening is not a guarantee that
arbitrary sensitive information will be recognized. Existing memories without
assertion metadata remain supported.
