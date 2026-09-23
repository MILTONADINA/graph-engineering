// Fixed native probe and command construction. No historical/candidate command
// string or source is ever executed by this module.
import path from "node:path";

export const PRIVATE_PROBE_CONTENT = "graph-private-bind-mount-witness\n";
export const NATIVE_MOUNT_PROBE = String.raw`
const fs = require("node:fs");
const status = fs.readFileSync("/proc/self/status", "utf8");
const field = (name) => {
  const line = status.split("\n").find((item) => item.startsWith(name + ":"));
  if (!line) throw new Error("Missing Linux process status field");
  return line.slice(line.indexOf(":") + 1).trim();
};
const metadata = (name) => {
  try {
    const value = fs.lstatSync(name);
    return { uid: value.uid, gid: value.gid, mode: value.mode & 4095, symbolicLink: value.isSymbolicLink() };
  } catch (error) { return { error: error.code }; }
};
let content = null, error = null;
try { content = fs.readFileSync("/fixture/probe.txt", "utf8"); }
catch (failure) { error = failure.code; }
process.stdout.write(JSON.stringify({
  uid: process.getuid(), gid: process.getgid(),
  uids: field("Uid").split(/\s+/).map(Number),
  gids: field("Gid").split(/\s+/).map(Number),
  capEff: field("CapEff"), capPrm: field("CapPrm"), capBnd: field("CapBnd"),
  noNewPrivs: field("NoNewPrivs"),
  uidMap: fs.readFileSync("/proc/self/uid_map", "utf8").trim(),
  gidMap: fs.readFileSync("/proc/self/gid_map", "utf8").trim(),
  directory: metadata("/fixture"), file: metadata("/fixture/probe.txt"), content, error
}));
`;

export function nativeMountCommand({
  imageId,
  name,
  endpoint,
  directory,
  uid,
  gid,
}) {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(imageId) ||
    !/^graph-native-mount-[a-f0-9-]{36}$/.test(name)
  )
    throw new Error(
      "Native mount probe requires an exact image and owned container name",
    );
  if (
    typeof endpoint !== "string" ||
    endpoint.length > 4096 ||
    !/^unix:\/\/\/[^\x00-\x20?#]+$/.test(endpoint)
  )
    throw new Error(
      "Native Linux mount proof requires a local Unix Docker socket",
    );
  if (
    typeof directory !== "string" ||
    !path.posix.isAbsolute(directory) ||
    path.posix.normalize(directory) !== directory ||
    /[,\x00-\x1f]/.test(directory) ||
    !/^graph-native-mount-[A-Za-z0-9]+$/.test(path.posix.basename(directory))
  )
    throw new Error(
      "Native mount source must be an owned temporary fixture directory",
    );
  if (
    ![uid, gid].every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 2147483647,
    )
  )
    throw new Error("Native mount identity must be bounded numeric uid/gid");
  return [
    "docker",
    "--host",
    endpoint,
    "run",
    "--rm",
    "--pull=never",
    "--name",
    name,
    "--network=none",
    "--read-only",
    "--user",
    `${uid}:${gid}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=64",
    "--memory=256m",
    "--memory-swap=256m",
    "--cpus=1",
    "--mount",
    `type=bind,source=${directory},target=/fixture,readonly`,
    "--workdir",
    "/",
    "--env",
    "NODE_OPTIONS=",
    "--entrypoint",
    "/usr/local/bin/node",
    imageId,
    "-e",
    NATIVE_MOUNT_PROBE,
  ];
}

/** Probe denial is accepted only with the exact expected process and mount state. */
export function validateNativeMountProbe(
  observed,
  { uid, gid, ownerUid, ownerGid, readable },
) {
  const fields = [
    "uid",
    "gid",
    "uids",
    "gids",
    "capEff",
    "capPrm",
    "capBnd",
    "noNewPrivs",
    "uidMap",
    "gidMap",
    "directory",
    "file",
    "content",
    "error",
  ].sort();
  if (
    !observed ||
    Object.keys(observed).sort().join(",") !== fields.join(",") ||
    observed.uid !== uid ||
    observed.gid !== gid ||
    JSON.stringify(observed.uids) !== JSON.stringify([uid, uid, uid, uid]) ||
    JSON.stringify(observed.gids) !== JSON.stringify([gid, gid, gid, gid]) ||
    ["capEff", "capPrm", "capBnd"].some(
      (key) => !/^0{16}$/.test(observed[key]),
    ) ||
    observed.noNewPrivs !== "1"
  )
    throw new Error(
      "Native probe process identity/capabilities differ from the required semantics",
    );
  // Refuse a remapped/rootless environment, rather than relabeling a namespace
  // ownership mismatch as the historical DAC failure.
  for (const key of ["uidMap", "gidMap"])
    if (
      typeof observed[key] !== "string" ||
      !/^0\s+0\s+4294967295$/.test(observed[key].trim())
    )
      throw new Error(
        "Native mount fixture requires an unremapped Linux Docker daemon",
      );
  const expectedDirectory = {
    uid: ownerUid,
    gid: ownerGid,
    mode: 0o700,
    symbolicLink: false,
  };
  if (JSON.stringify(observed.directory) !== JSON.stringify(expectedDirectory))
    throw new Error(
      "Native bind mount ownership/mode mismatch (possible daemon namespace mapping)",
    );
  if (readable) {
    const expectedFile = {
      uid: ownerUid,
      gid: ownerGid,
      mode: 0o600,
      symbolicLink: false,
    };
    if (
      observed.content !== PRIVATE_PROBE_CONTENT ||
      observed.error !== null ||
      JSON.stringify(observed.file) !== JSON.stringify(expectedFile)
    )
      throw new Error(
        "Owner identity did not preserve private-file read access",
      );
  } else if (
    observed.content !== null ||
    observed.error !== "EACCES" ||
    JSON.stringify(observed.file) !== '{"error":"EACCES"}'
  )
    throw new Error(
      "Capability-free non-owner must reproduce actual EACCES, not an unrelated failure",
    );
  return observed;
}
