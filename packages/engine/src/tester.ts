import type {
  ExecutionPlan,
  ExecutionStep,
} from "@graph-engineering/contracts";

/** The step ID a configured tester's step always uses. */
export const TESTER_STEP_ID = "tester";

/** Files a tester may write unless the project narrows them. */
export const DEFAULT_TEST_FILES = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.*",
  "**/*Test.*",
  "**/*Tests.*",
  "**/test_*.py",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
];

/**
 * The tester's step, first in the plan: before any implementation, write new
 * tests that prove each acceptance criterion, creating test files only.
 * They are expected to fail until the implementing steps finish.
 */
export function testerStep(options: {
  providerId: string;
  acceptance: string[];
  writes?: string[];
  spec?: ExecutionPlan["spec"];
}): ExecutionStep {
  const writes = options.writes?.length ? options.writes : DEFAULT_TEST_FILES;
  return {
    id: TESTER_STEP_ID,
    kind: "worker",
    providerId: options.providerId,
    dependsOn: [],
    writes,
    objective: [
      "Act as the team's tester, before anyone implements the change.",
      "Write new automated tests, in this repository's existing test framework and layout, that prove each acceptance criterion below. They should fail now and pass once the change is implemented; read the code they exercise so they compile against the intended interface.",
      `Create new test files only (matching ${writes.join(", ")}): do not edit existing tests or production code. Check any test data you use (for example check digits or expected totals) by working it out, and keep the tests independent of the implementation's internals.`,
      "",
      "Acceptance criteria:",
      ...options.acceptance.map((criterion) => `- ${criterion}`),
      ...(options.spec
        ? [
            "",
            `Spec: ${options.spec.path}. Name tests so each criterion's test can be linked from the spec.`,
          ]
        : []),
    ].join("\n"),
  };
}
