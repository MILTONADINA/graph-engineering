import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

it("runs the provisioned verifier dependency-setup regressions", async () => {
  const suite = fileURLToPath(
    new URL("../../../scripts/verification-setup.test.mjs", import.meta.url),
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--test", suite],
    { timeout: 20000 },
  );
  expect(stdout).toContain("copies nested dependencies");
  expect(stdout).toContain("classifies setup failures");
});
