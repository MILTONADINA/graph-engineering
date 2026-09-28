// The per-user data directory that holds the owner's promotion files outside
// every project: the owner's public keys (`promotion-keys/`), the prepared
// trust anchor, the local enrollment record (`promotion-enrollment/`) and the
// Rekor high-water state (`rekor-witness/`, see promotion-rekor-witness.ts).
// Project data dirs are `<this>/projects/<id>`, and backups copy only named
// files from a project data dir, so nothing here is ever backed up, restored
// or indexed for an MCP client.
import os from "node:os";
import path from "node:path";

/** `~/Library/Application Support/graph-engineering` on macOS, XDG elsewhere. */
export function promotionUserDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  if (platform === "darwin")
    return path.join(
      home,
      "Library",
      "Application Support",
      "graph-engineering",
    );
  const data =
    env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME
      : path.join(home, ".local", "share");
  return path.join(data, "graph-engineering");
}

/** Where the owner's key tool keeps `<role>.pub.pem` unless told otherwise. */
export const OWNER_KEY_DIR_NAME = "promotion-keys";
/** The local enrollment record's directory (0700) and file (0600). */
export const ENROLLMENT_DIR_NAME = "promotion-enrollment";
export const ENROLLMENT_FILE_NAME = "enrollment.json";
/** Where `anchor-prepare` writes unless given `--out`. */
export const PREPARED_ANCHOR_FILE_NAME = "promotion-trust-anchor.prepared.json";
