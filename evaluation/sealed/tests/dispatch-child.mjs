// Fixed subprocess test driver: no transport, network or arbitrary execution.
import { writeSync } from "node:fs";
import { SealedStore } from "../store.mjs";

const store = new SealedStore({ directory: process.argv[2] });
try {
  const claim = store.claimPublicDispatch(process.argv[3], {
    sha256: process.argv[4],
    bytes: Number(process.argv[5]),
  });
  writeSync(1, `${JSON.stringify(claim)}\n`);
  if (process.argv[6] === "crash") process.exit(23);
} catch (error) {
  writeSync(2, `${error.message}\n`);
  process.exitCode = 1;
} finally {
  store.close();
}
