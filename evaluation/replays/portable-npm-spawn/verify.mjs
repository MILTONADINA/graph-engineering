import { historicalNpmInvocation } from "./adapter.mjs";

export function verifyHistoricalNpm(files) {
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const lifecycleCli =
    "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  const pathCli =
    "C:\\Users\\Example User\\npm\\node_modules\\npm\\bin\\npm-cli.js";
  const temporary = "C:\\Users\\Example User\\Temp\\pack fixture";
  const scenarios = [
    {
      id: "windows-lifecycle-spaces",
      platform: "win32",
      execPath: node,
      env: { npm_execpath: lifecycleCli },
      existing: [lifecycleCli],
      tmpDir: temporary,
      expectedExecutable: node,
      expectedCli: lifecycleCli,
    },
    {
      id: "windows-node-relative",
      platform: "win32",
      execPath: node,
      env: {},
      existing: [lifecycleCli],
      tmpDir: temporary,
      expectedExecutable: node,
      expectedCli: lifecycleCli,
    },
    {
      id: "windows-case-insensitive-path",
      platform: "win32",
      execPath: "C:\\Other\\node.exe",
      env: { Path: "C:\\Users\\Example User\\npm" },
      existing: [pathCli],
      tmpDir: temporary,
      expectedExecutable: "C:\\Other\\node.exe",
      expectedCli: pathCli,
    },
    {
      id: "windows-no-unsafe-fallback",
      platform: "win32",
      execPath: node,
      env: {},
      existing: [],
      tmpDir: temporary,
      expectedExecutable: null,
    },
    {
      id: "posix-direct-npm",
      platform: "linux",
      execPath: "/usr/bin/node",
      env: {},
      existing: [],
      tmpDir: "/tmp/pack fixture",
      expectedExecutable: "npm",
    },
  ];
  const checks = scenarios.map((scenario) => {
    const observed = historicalNpmInvocation(files, scenario);
    const expectedArgs = [
      ...(scenario.expectedCli ? [scenario.expectedCli] : []),
      "pack",
      "--pack-destination",
      scenario.tmpDir,
      "--json",
    ];
    const invocation = observed.calls[0];
    const passed =
      scenario.expectedExecutable === null
        ? observed.calls.length === 0 &&
          observed.error?.includes("Cannot locate npm-cli.js")
        : observed.calls.length === 1 &&
          invocation.executable === scenario.expectedExecutable &&
          JSON.stringify(invocation.args) === JSON.stringify(expectedArgs) &&
          invocation.shell === false &&
          observed.error === "GRAPH_HISTORICAL_INVOCATION_CAPTURED";
    return {
      id: scenario.id,
      passed: !!passed,
      observed: {
        dispatches: observed.calls.length,
        executable: invocation?.executable ?? null,
        argvBoundariesPreserved:
          JSON.stringify(invocation?.args) === JSON.stringify(expectedArgs),
        shell: invocation?.shell ?? false,
        error: observed.error,
      },
    };
  });
  return {
    success: checks.every((check) => check.passed),
    checks,
    actualChildProcesses: 0,
    modelCalls: 0,
    limitations: [
      "Windows and Linux process/filesystem surfaces are instrumented on this host, not native operating-system validation.",
      "Only recorded trusted code is executed; this harness does not safely verify arbitrary worker-generated scripts.",
      "npm pack, tar extraction, and generated application builds are not executed by this fixture.",
    ],
  };
}
