# Claude Code entrypoint

Before working in this repository, read the full
[Claude Code handover](docs/claude-code-handover.md). It records the owner's
requirements, the current fork and evidence state, the safety boundaries, and
the next engineering work. Follow its linked primary documents and inspect
the current Git state, the live fork `dev` tip, open PRs and checks before
acting.

Privacy priority: do not call cloud MCP `context_get` or `run_status`, or
dispatch Graph-managed cloud worker packets, until the pre-return and
pre-dispatch guards described in the handover are implemented and tested.

Work only in this repository and the owner's fork. Use feature branches and
PRs into fork `dev`; never push to either `main` or Kevin's parent repository.
Preserve `.serena/` and private local files. Do not download another Qwen, run
metered Jev without an operator-selected numeric session cap and reviewed
price, or treat synthetic/self-signed evidence as independent promotion
authority. The handover has the detailed requirements and limits.
