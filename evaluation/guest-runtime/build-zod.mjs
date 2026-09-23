// Trusted, fixed dependency bundling during explicit Docker provisioning only.
// No candidate input, repository config, plugin or module-resolution override.
import { build } from "esbuild";
import { writeFile } from "node:fs/promises";

const result = await build({
  stdin: {
    contents: 'export { z } from "zod";',
    sourcefile: "trusted-zod-entry.mjs",
    resolveDir: "/opt/graph-guest",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  write: false,
  metafile: true,
  logLevel: "silent",
});
if (
  result.outputFiles.length !== 1 ||
  result.outputFiles[0].contents.length > 500_000 ||
  Object.values(result.metafile.outputs).some((output) => output.imports.length)
)
  throw new Error("Guest Zod dependency must be one bounded standalone module");
await writeFile(
  "/opt/graph-guest/zod-guest.mjs",
  result.outputFiles[0].contents,
  {
    flag: "wx",
    mode: 0o444,
  },
);

const matcher = await build({
  stdin: {
    contents: 'export { default } from "picomatch";',
    sourcefile: "trusted-picomatch-entry.mjs",
    resolveDir: "/opt/graph-guest",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  write: false,
  metafile: true,
  logLevel: "silent",
});
if (
  matcher.outputFiles.length !== 1 ||
  matcher.outputFiles[0].contents.length > 150000 ||
  Object.values(matcher.metafile.outputs).some(
    (output) => output.imports.length,
  )
)
  throw new Error(
    "Guest picomatch dependency must be one bounded standalone module",
  );
await writeFile(
  "/opt/graph-guest/picomatch-guest.mjs",
  matcher.outputFiles[0].contents,
  { flag: "wx", mode: 0o444 },
);
