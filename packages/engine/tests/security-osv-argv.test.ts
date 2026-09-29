import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Every docker call is recorded instead of run, so the tests read the exact
// argv each scanner step would start.
const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../src/util.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/util.js")>()),
  command: mocks.command,
}));
import {
  OSV_DATABASE_HOST,
  runSecurityScan,
  updateOsvDatabase,
} from "../src/security/scan.js";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const directories: string[] = [];
const directory = async () => {
  const created = await mkdtemp(path.join(os.tmpdir(), "graph-osv-argv-"));
  directories.push(created);
  return created;
};
afterEach(async () => {
  mocks.command.mockReset();
  for (const created of directories.splice(0))
    await rm(created, { recursive: true, force: true });
});

function fakeDocker() {
  const runs: string[][] = [];
  mocks.command.mockImplementation(async (_executable, argv: string[]) => {
    if (argv[0] === "image")
      return { code: 0, stdout: `${IMAGE_ID}\n`, stderr: "" };
    if (argv[0] === "run") runs.push(argv);
    return { code: 0, stdout: "", stderr: "" };
  });
  // The OSV-Scanner arguments: everything after the image it runs.
  const osv = () => {
    const found = runs.filter(
      (argv) => argv[argv.indexOf(IMAGE_ID) + 1] === "osv-scanner",
    );
    expect(found).toHaveLength(1);
    return {
      docker: found[0]!.slice(0, found[0]!.indexOf(IMAGE_ID)),
      scanner: found[0]!.slice(found[0]!.indexOf(IMAGE_ID) + 1),
    };
  };
  return { osv };
}

describe("OSV-Scanner never resolves dependencies through deps.dev", () => {
  it("downloads the OSV database without resolving manifest dependencies", async () => {
    const root = await directory();
    const dataDir = await directory();
    await writeFile(
      path.join(root, "pom.xml"),
      "<project><groupId>com.example.internal</groupId></project>\n",
    );
    await writeFile(
      path.join(root, "requirements.txt"),
      "internal-private-lib==1.2.3\n",
    );
    const docker = fakeDocker();
    const result = await updateOsvDatabase({
      root,
      dataDir,
      image: "graph-security:local",
      files: ["pom.xml", "requirements.txt"],
      policy: { network: "allowlisted", allowedHosts: [OSV_DATABASE_HOST] },
    });
    expect(result.lockfiles).toEqual(["pom.xml", "requirements.txt"]);
    const { scanner } = docker.osv();
    expect(scanner).toContain("--download-offline-databases");
    // An OSV-Scanner flag, not a docker one: the networked step fetches only
    // the database, never the manifests' packages from api.deps.dev.
    expect(scanner).toContain("--no-resolve");
  });

  it("scans lockfiles offline without resolving manifest dependencies", async () => {
    const root = await directory();
    const database = await directory();
    await writeFile(path.join(root, "package-lock.json"), "{}\n");
    const docker = fakeDocker();
    await runSecurityScan({
      root,
      image: "graph-security:local",
      profile: {
        files: ["package-lock.json"],
        authorizedTargets: [],
        configuredTools: [],
      },
      osvDatabase: database,
    });
    const { docker: container, scanner } = docker.osv();
    expect(container).toContain("--network=none");
    expect(scanner).toContain("--offline-vulnerabilities");
    expect(scanner).toContain("--no-resolve");
  });
});

describe("a lockfile whose ecosystem has no downloaded OSV database", () => {
  it("says the download needs the OSV host allowed and the policy restored exactly", async () => {
    const root = await directory();
    const database = await directory();
    await writeFile(path.join(root, "package-lock.json"), "{}\n");
    mocks.command.mockImplementation(async (_executable, argv: string[]) => {
      if (argv[0] === "image")
        return { code: 0, stdout: `${IMAGE_ID}\n`, stderr: "" };
      if (
        argv[0] === "run" &&
        argv[argv.indexOf(IMAGE_ID) + 1] === "osv-scanner"
      )
        return {
          code: 127,
          stdout: "",
          stderr: "no offline version of the OSV database is available",
        };
      return { code: 0, stdout: "", stderr: "" };
    });
    const scan = await runSecurityScan({
      root,
      image: "graph-security:local",
      profile: {
        files: ["package-lock.json"],
        authorizedTargets: [],
        configuredTools: [],
      },
      osvDatabase: database,
    });
    const error = scan.errors.find((line) => line.startsWith("osv-scanner:"));
    expect(error).toContain("run graph-engine security-db-update");
    expect(error).toContain(`${OSV_DATABASE_HOST} in policy.allowedHosts`);
    // Recorded whole: a scanner's error is cut at 400 characters.
    expect(error).toContain(
      "restore .graph/project.json exactly as it was, since a plan and its runs are bound to its exact policy and a changed one voids them",
    );
  });
});

describe("security-db-update when the scanner image cannot be inspected", () => {
  // `docker image inspect` fails the same way for a stopped daemon and a
  // missing image; only `docker version` tells them apart.
  const download = async (daemonRunning: boolean) => {
    const root = await directory();
    const dataDir = await directory();
    await writeFile(path.join(root, "package-lock.json"), "{}\n");
    mocks.command.mockImplementation(async (_executable, argv: string[]) => {
      if (!daemonRunning)
        return {
          code: 1,
          stdout: "",
          stderr:
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
        };
      if (argv[0] === "image")
        return {
          code: 1,
          stdout: "",
          stderr: "Error: No such image: graph-security:local",
        };
      return { code: 0, stdout: "27.0.0\n", stderr: "" };
    });
    return updateOsvDatabase({
      root,
      dataDir,
      image: "graph-security:local",
      files: ["package-lock.json"],
      policy: { network: "allowlisted", allowedHosts: [OSV_DATABASE_HOST] },
    }).then(
      () => "",
      (error: Error) => error.message,
    );
  };

  it("says Docker is not running instead of telling the user to build the image", async () => {
    expect(await download(false)).toBe(
      "Docker is not running; start it and retry",
    );
  });

  it("says the image is not built when Docker is running", async () => {
    expect(await download(true)).toContain(
      "Security scanner image graph-security:local is not built",
    );
  });
});
