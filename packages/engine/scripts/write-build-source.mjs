// Records the hash of src/ in dist/build-source.json after tsc, using the
// compiled engine's own hashing so the build and the startup check agree.
import { writeBuildSourceManifest } from "../dist/build-source.js";

const manifest = writeBuildSourceManifest();
process.stdout.write(
  `dist/build-source.json: sha256 ${manifest.hash} over ${manifest.files} source files\n`,
);
