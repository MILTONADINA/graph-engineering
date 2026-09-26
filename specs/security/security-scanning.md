# Security scanning and the run security gate

- ID: security-scanning
- Status: implemented
- Area: security

## Problem

Teams need security tools chosen for what their repository actually contains, with each choice explained, and a scan that fails only on findings nobody has reviewed. Once a team commits a reviewed baseline, every managed run should be gated on it, so a worker cannot introduce a new finding, hide one with a suppression, or slip in a file the scanners cannot read.

## Acceptance criteria

- AC1: `security-plan` lists every catalog tool as selected or skipped with a reason, chooses offline scanners by what the repository contains, and never selects dynamic testing without an authorized target.
  - Test: packages/engine/tests/security-catalog.test.ts :: explains every tool as selected or skipped
  - Test: packages/engine/tests/security-catalog.test.ts :: chooses offline scanners by what the repository contains
  - Test: packages/engine/tests/security-catalog.test.ts :: never selects dynamic testing without an authorized target
- AC2: Scanner reports are read into findings, and a report showing an incomplete scan makes the scan incomplete, never clean.
  - Test: packages/engine/tests/security-catalog.test.ts :: reads each scanner's JSON report into findings
  - Test: packages/engine/tests/security-catalog.test.ts :: refuses scanner reports that show the scan was incomplete
- AC3: Inline scanner suppressions are themselves reported as findings, so adding one needs review.
  - Test: packages/engine/tests/security-catalog.test.ts :: reports inline scanner suppressions so adding one needs review
- AC4: The scan gates only on findings missing from the reviewed baseline, and findings on repeated lines stay distinct.
  - Test: packages/engine/tests/security-catalog.test.ts :: gates only on findings missing from the reviewed baseline
  - Test: packages/engine/tests/security-catalog.test.ts :: keeps findings distinct when a file repeats the flagged line
- AC5: A managed run fails when its verified result adds a finding missing from the baseline or the scan is incomplete, and passes when all findings are in the baseline.
  - Test: packages/engine/tests/execution.test.ts :: fails a run whose verified result adds a finding missing from the reviewed baseline
  - Test: packages/engine/tests/execution.test.ts :: accepts a result whose findings are all in the baseline, and refuses an incomplete scan
- AC6: The run gate uses the baseline committed at the run's base commit, and fails on changed files no scanner could read or a malformed baseline.
  - Test: packages/engine/tests/execution.test.ts :: keeps the gate of the run's own base commit when the checkout changes
  - Test: packages/engine/tests/execution.test.ts :: refuses changed files the scanner could not read and malformed baselines
- AC7: A project with no committed baseline is not scanned during runs.
  - Test: packages/engine/tests/execution.test.ts :: does not scan a project that keeps no reviewed baseline
- AC8: The standalone scan and baseline update cover committed files only, so an untracked scratch file never enters a reviewed baseline.
  - Test: packages/engine/tests/hygiene.test.ts :: lists committed files only for the standalone scan

## Security considerations

Repository files, including scanner configuration files, are hostile input: scans run in a container with no network and all capabilities dropped, against a private copy, and scanner configuration in the repository is scanned under a neutral name so it cannot reconfigure the tools. The baseline is an acceptance of risk, so it is written only when a person asks and the run gate reads it from the base commit, not the working tree, so an uncommitted edit or later checkout cannot switch the gate off. Dynamic tools (ZAP, Nuclei, Burp Suite) are never run against live systems without an authorized target, and no command records such authorization yet. The planted-findings end-to-end test runs only when the scanner image has been built locally.

## Non-goals

The graph does not download vulnerability databases for dependency scanners, does not scan or attack running systems, does not render Helm charts, and does not create a baseline automatically.
