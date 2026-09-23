// Deliberately known synthetic task for the opt-in local context comparison.
// Kept separate from the immutable 60-task cross-language fixture corpus.
const source = {
  "solver.mjs":
    'import { adjusted } from "./offset.mjs";\nlet text="";for await(const part of process.stdin)text+=part;const input=JSON.parse(text);process.stdout.write(JSON.stringify({answer:adjusted(input.n)})+"\\n");\n',
  "offset.mjs":
    'import { scaleValue } from "./scale.mjs";\nexport function adjusted(n) { return scaleValue(n) + 3; }\n',
  "scale.mjs": "export function scaleValue(n) { return n + 2; }\n",
};

for (let index = 0; index < 16; index++) {
  const name = `catalog${String(index).padStart(2, "0")}.mjs`;
  source[name] =
    `// Unrelated synthetic catalog entry ${index}.\n` +
    `export const catalog${index} = Object.freeze({ code: "C${index}", title: "Fixture item ${index}", count: ${index + 1}, enabled: true });\n` +
    `export function describeCatalog${index}() { return catalog${index}.title + ":" + catalog${index}.count; }\n`;
}

const oracleFiles = {
  ...source,
  "scale.mjs": "export function scaleValue(n) { return n * 2; }\n",
};
const cases = [-7, -1, 0, 1, 2, 11, 29].map((n) => ({
  n,
  answer: n * 2 + 3,
}));
const marker = "GRAPH_PAIRED_MULTIFILE_OK";

export const pairedMultiFileTask = Object.freeze({
  id: "known-synthetic-multifile-scale-v1",
  language: "javascript",
  objective:
    "Repair scaleValue in scale.mjs so solver.mjs returns answer equal to twice input.n plus three. Preserve offset.mjs and the existing API. Edit only scale.mjs.",
  acceptance: [
    "The JSON-line answer is 2*n+3 for negative, zero and positive integer n.",
    "Do not change any file other than scale.mjs.",
  ],
  files: Object.freeze(source),
  oracleFiles: Object.freeze(oracleFiles),
  allowedOutputPaths: Object.freeze(["scale.mjs"]),
  marker,
  verification: Object.freeze({
    image: "node:24-slim",
    argv: ["node", "/checks/check.mjs"],
    files: Object.freeze({
      "check.mjs":
        'import { spawnSync } from "node:child_process";\n' +
        `for (const item of ${JSON.stringify(cases)}) {\n` +
        '  const run = spawnSync(process.execPath, ["/workspace/solver.mjs"], { input: JSON.stringify({n:item.n})+"\\n", encoding:"utf8", timeout:3000 });\n' +
        '  if (run.status !== 0 || run.error || run.stderr) throw Error("solver failed");\n' +
        "  const actual = JSON.parse(run.stdout.trim());\n" +
        '  if (actual.answer !== item.answer) throw Error("answer mismatch");\n' +
        "}\n" +
        `console.log(${JSON.stringify(marker)});\n`,
    }),
  }),
  synthetic: true,
});
