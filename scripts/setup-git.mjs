import { chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--push-remote")) {
  throw new Error("Usage: npm run setup:git -- [--push-remote REMOTE]");
}
if (args.length) {
  const remote = args[1];
  if (!/^[a-zA-Z0-9_-]+$/.test(remote)) throw new Error("Invalid remote name");
  execFileSync("git", ["remote", "get-url", "--push", remote]);
  execFileSync("git", ["config", "remote.pushDefault", remote]);
  execFileSync("git", ["config", "graph.pushRemote", remote]);
}

chmodSync(".githooks/pre-push", 0o755);
execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
  stdio: "inherit",
});
execFileSync("git", ["config", "push.default", "current"], {
  stdio: "inherit",
});
console.log(
  "Installed the main/master/dev push guard. Feature PRs target dev.",
);
