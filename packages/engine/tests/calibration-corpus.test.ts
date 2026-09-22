import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

it("validates real-task intake, split isolation, and independent signed review without inference", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      fileURLToPath(
        new URL(
          "../../../evaluation/calibration-corpus.test.mjs",
          import.meta.url,
        ),
      ),
      fileURLToPath(
        new URL(
          "../../../evaluation/validate-historical-corpus.test.mjs",
          import.meta.url,
        ),
      ),
    ],
    { timeout: 30000 },
  );
  expect(stdout).toContain("real-history intake lists nine varied candidates");
  expect(stdout).toContain("# fail 0");
});
