# ai.testing-agent

**What.** For every node `architecture.json` actually executed, confirms (or invokes) matching test coverage — unit for repository/service, api for controller/route, integration for the database connection node — and records real (executed, not assumed) pass/fail state in `test.schema.json`.

**Requires.** `architecture.schema`.

**Produces.** `test.schema` including `coverageGaps` for anything missing.

**Hands off to.** `ai.validation-agent`, which checks `coverageGaps` as part of its "missing tests" category.

**Rule.** Never mark a suite `passing` without having run it — `run_tests` output is the only source of truth for `status`.
