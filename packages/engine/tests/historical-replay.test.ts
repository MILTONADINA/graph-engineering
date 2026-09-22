import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

it("checks historical replay isolation, bounds and independent acceptance harness", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      fileURLToPath(
        new URL(
          "../../../evaluation/historical-replay.test.mjs",
          import.meta.url,
        ),
      ),
    ],
    { timeout: 20000 },
  );
  expect(stdout).toContain("independent harness detects the regression");
  expect(stdout).toContain("# fail 0");
});
