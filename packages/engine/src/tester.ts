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
  "**/test_*.py",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
];

/**
 * The tester's step: after every implementing step, write or extend tests
 * that prove each acceptance criterion, changing only test files.
 */
export function testerStep(options: {
  providerId: string;
  acceptance: string[];
  dependsOn: string[];
  writes?: string[];
  spec?: ExecutionPlan["spec"];
}): ExecutionStep {
  const writes = options.writes?.length ? options.writes : DEFAULT_TEST_FILES;
  return {
    id: TESTER_STEP_ID,
    kind: "worker",
    providerId: options.providerId,
    dependsOn: options.dependsOn,
    writes,
    objective: [
      "Act as the team's tester for the change the earlier steps made.",
      "Write or extend automated tests, in this repository's existing test framework and layout, that prove each acceptance criterion below. Every required check must still pass.",
      `Change only test files (matching ${writes.join(", ")}). Do not change production code; if a criterion cannot be tested without one, add a test that documents the gap and say so in your summary.`,
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
