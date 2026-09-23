// Fixed subprocess test driver: no network or arbitrary command execution.
import { SealedStore } from "../store.mjs";
const store = new SealedStore({ directory: process.argv[2] });
try {
  const reservation = store.reserveAttempt(
    "collection-fixture",
    "baseline-assignment",
  );
  process.stdout.write(JSON.stringify(reservation) + "\n");
  if (process.argv[3] === "crash") process.exit(23);
} catch (error) {
  process.stderr.write(error.message + "\n");
  process.exitCode = 1;
} finally {
  store.close();
}
