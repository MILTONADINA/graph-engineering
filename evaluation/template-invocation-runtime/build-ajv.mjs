import { build } from "esbuild";
await build({
  stdin: {
    contents:
      'import Ajv from "ajv/dist/2020.js"; import addFormats from "ajv-formats"; export { Ajv, addFormats };',
    resolveDir: process.cwd(),
    sourcefile: "trusted-ajv-entry.js",
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "GraphTrustedAjv",
  target: "es2022",
  outfile: "ajv-guest.js",
  define: { "process.env.NODE_ENV": '"production"' },
});
