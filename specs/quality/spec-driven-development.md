# Spec-driven development

- ID: spec-driven-development
- Status: implemented
- Area: quality
- Epic: AI agile team

## Problem

A team builds what was agreed and can show that it works. Every feature of
Graph Engineering, and of a project that uses it, is written as a spec
before it is built: the problem, acceptance criteria, and a link from each
criterion to the test that proves it. A checker keeps the links honest, CI
runs it, and plans can be created straight from a ready spec.

## Acceptance criteria

- AC1: A spec is read into its title, ID, status, area, epic, sections, criteria and test links, ignoring anything inside code fences.
  - Test: packages/engine/tests/specs.test.ts :: reads fields, sections, criteria and test links
  - Test: packages/engine/tests/specs.test.ts :: ignores headings and criteria inside code fences
- AC2: `spec-new` scaffolds a valid draft, and a draft cannot be planned.
  - Test: packages/engine/tests/specs.test.ts :: scaffolds a valid draft
  - Test: packages/engine/tests/specs.test.ts :: refuses to plan a draft
- AC3: `spec-check` passes an implemented spec whose criteria all link existing tests, and reports missing tests, missing sections, wrong placement and duplicate IDs.
  - Test: packages/engine/tests/specs.test.ts :: passes an implemented spec whose criteria link existing tests
  - Test: packages/engine/tests/specs.test.ts :: reports missing tests, missing sections, bad placement and duplicate IDs
- AC4: A ready spec may have criteria without tests yet, but not zero criteria.
  - Test: packages/engine/tests/specs.test.ts :: lets a ready spec have untested criteria but not an empty one
- AC5: A link counts only when the named file defines a runnable test with exactly that name; commented-out tests and symlinked files do not count.
  - Test: packages/engine/tests/specs.test.ts :: counts only a runnable test with exactly the linked name
  - Test: packages/engine/tests/specs.test.ts :: does not follow a symlinked test file
- AC6: In a repository with CI workflows, a criterion proven only by tests that need an environment switch no CI step sets for that file fails the check.
  - Test: packages/engine/tests/specs.test.ts :: reads the switch a linked test needs
  - Test: packages/engine/tests/specs.test.ts :: fails a criterion proven only by a switched-off test that no CI step runs
- AC7: `plan --spec` takes the objective and criteria from a ready spec and records the spec's path and hash on the plan.
  - Test: packages/engine/tests/outcomes.test.ts :: takes the objective and criteria from a ready spec and records it on the plan

## Security considerations

Test files are read through the same path checks as any source read:
symlinks, escapes and excluded paths never count as proof. Specs and tests
are plain repository files and are reviewed like code. A test link proves a
named test exists and, where CI workflows exist, that CI runs it; it does
not prove the test is thorough.

## Non-goals

Judging test quality, updating links automatically, or reading CI
configuration as full YAML; the workflow check is a textual reading of each
step.
