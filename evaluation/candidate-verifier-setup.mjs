import { SETUP_MARKER } from "./candidate-verifier-infrastructure.mjs";

const dir = (path, mode = 0o755) => ({ path, type: "directory", mode });
const file = (path, content, mode = 0o644) => ({
  path,
  type: "file",
  content,
  mode,
});
const child = (status = 0, stderr = "", error = null) => ({
  status,
  stderr,
  stdout: "",
  error,
});
function fixture() {
  return {
    tree: [
      dir("/opt/graph-deps"),
      dir("/workspace", 0o700),
      dir("/outside", 0o700),
      file("/outside/canary", "keep unchanged"),
      file("/opt/graph-deps/package.json", '{"name":"fixture"}'),
      file("/workspace/package.json", '{"name":"fixture"}'),
      dir("/opt/graph-deps/node_modules", 0o555),
      dir("/opt/graph-deps/node_modules/pkg", 0o555),
      file(
        "/opt/graph-deps/node_modules/pkg/run.js",
        "fixture executable\n",
        0o755,
      ),
      dir("/opt/graph-deps/node_modules/.bin"),
      {
        path: "/opt/graph-deps/node_modules/.bin/pkg",
        type: "symlink",
        mode: 0o777,
        target: "../pkg/run.js",
      },
    ],
    cpFault: false,
    copyFault: false,
    children: [child(), child()],
  };
}
const copied = [
  { path: "node_modules", type: "directory", mode: 0o555 },
  { path: "node_modules/.bin", type: "directory", mode: 0o755 },
  {
    path: "node_modules/.bin/pkg",
    type: "symlink",
    mode: 0o777,
    target: "../pkg/run.js",
  },
  { path: "node_modules/pkg", type: "directory", mode: 0o555 },
  {
    path: "node_modules/pkg/run.js",
    type: "file",
    mode: 0o755,
    content: "fixture executable\n",
  },
];
const cases = [];
function add(id, change, expected) {
  const input = fixture();
  change(input);
  cases.push({
    id,
    input,
    expected: { ...expected, outside: "keep unchanged" },
  });
}
add("setup-copies-executable-and-relative-symlink", () => {}, {
  exitCode: 0,
  wrapperMarker: false,
  commands: 2,
  destination: copied,
});
add(
  "setup-native-cp-eacces-workaround",
  (input) => {
    input.cpFault = true;
  },
  { exitCode: 0, wrapperMarker: false, commands: 2, destination: copied },
);
add(
  "setup-root-metadata-mismatch",
  (input) => {
    input.tree.find((item) => item.path === "/workspace/package.json").content =
      '{"name":"changed"}';
  },
  { exitCode: 78, wrapperMarker: true, commands: 0, destination: [] },
);
add(
  "setup-late-metadata-before-any-copy",
  (input) => {
    input.tree.push(
      file(
        "/opt/graph-deps/graph-templates/tools/validate-graph/package-lock.json",
        "locked",
      ),
      file(
        "/workspace/graph-templates/tools/validate-graph/package-lock.json",
        "changed",
      ),
    );
  },
  { exitCode: 78, wrapperMarker: true, commands: 0, destination: [] },
);
add(
  "setup-copy-file-denied",
  (input) => {
    input.copyFault = true;
  },
  { exitCode: 78, wrapperMarker: true, commands: 0 },
);
add(
  "setup-destination-symlink-refused",
  (input) => {
    input.tree.push({
      path: "/workspace/node_modules",
      type: "symlink",
      mode: 0o777,
      target: "/outside",
    });
  },
  {
    exitCode: 78,
    wrapperMarker: true,
    commands: 0,
    destination: [
      {
        path: "node_modules",
        type: "symlink",
        mode: 0o777,
        target: "/outside",
      },
    ],
  },
);
add(
  "setup-npm-launch-enoent",
  (input) => {
    input.children[0] = child(null, "", {
      code: "ENOENT",
      message: "npm executable unavailable",
    });
  },
  { exitCode: 78, wrapperMarker: true, commands: 1, destination: copied },
);
add(
  "setup-ordinary-eacces-test-failure",
  (input) => {
    input.children[0] = child(
      1,
      "EACCES in the authorization test assertion\n",
    );
  },
  { exitCode: 1, wrapperMarker: false, commands: 1, destination: copied },
);
add(
  "setup-second-command-test-failure",
  (input) => {
    input.children[1] = child(1, "Assertion mismatch\n");
  },
  { exitCode: 1, wrapperMarker: false, commands: 2, destination: copied },
);
add(
  "setup-child-78-is-not-wrapper-marker",
  (input) => {
    input.children[0] = child(78, "Ordinary test exited 78\n");
  },
  { exitCode: 78, wrapperMarker: false, commands: 1, destination: copied },
);
add(
  "setup-child-null-status",
  (input) => {
    input.children[0] = child(null, "Child interrupted\n");
  },
  { exitCode: 1, wrapperMarker: false, commands: 1, destination: copied },
);
// Explicit characterization: the historical protocol is not authenticated.
// Child stderr/status can reproduce the marker pair even though the wrapper
// did not emit the marker. This observation must not be called trusted origin.
add(
  "setup-child-marker-spoof-characterization",
  (input) => {
    input.children[0] = child(78, SETUP_MARKER + "\nchild-controlled text\n");
  },
  {
    exitCode: 78,
    wrapperMarker: false,
    commands: 1,
    destination: copied,
    childSpoofedPair: true,
  },
);

function freeze(value) {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
freeze(cases);
export function infrastructureSetupCases() {
  return cases;
}
export function checkInfrastructureSetupObservation(observed, expected) {
  if (
    !observed ||
    Object.keys(observed).sort().join(",") !==
      "commands,destination,exitCode,outside,stderr,stdout,uncaught,wrapperErrors" ||
    observed.exitCode !== expected.exitCode ||
    typeof observed.stderr !== "string" ||
    typeof observed.stdout !== "string" ||
    !Array.isArray(observed.wrapperErrors) ||
    !Array.isArray(observed.commands) ||
    !Array.isArray(observed.destination) ||
    observed.commands.length !== expected.commands ||
    observed.outside !== expected.outside
  )
    return false;
  if (
    observed.wrapperErrors.some((line) => typeof line !== "string") ||
    observed.wrapperErrors.includes(SETUP_MARKER) !== expected.wrapperMarker
  )
    return false;
  const argv = [
    ["run", "check"],
    ["test", "--prefix", "graph-templates/tools/validate-graph"],
  ];
  if (
    observed.commands.some(
      (command, index) =>
        command.executable !== "npm" ||
        JSON.stringify(command.args) !== JSON.stringify(argv[index]) ||
        command.cwd !== "/workspace" ||
        command.stdio !== "inherit" ||
        command.shell !== false,
    )
  )
    return false;
  if (
    expected.destination &&
    JSON.stringify(observed.destination) !==
      JSON.stringify(expected.destination)
  )
    return false;
  if (
    expected.wrapperMarker &&
    !observed.stderr.startsWith(SETUP_MARKER + "\n")
  )
    return false;
  if (
    expected.childSpoofedPair &&
    (!observed.stderr.startsWith(SETUP_MARKER + "\n") ||
      observed.wrapperErrors.length !== 0)
  )
    return false;
  return observed.uncaught === null;
}
