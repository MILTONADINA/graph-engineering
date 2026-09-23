import { SealedStore } from "../store.mjs";
import { digest } from "./helpers.mjs";

const [directory, reservationId, callId] = process.argv.slice(2);
const store = new SealedStore({ directory });
try {
  store.reserveCall(reservationId, {
    callId,
    providerId: "cloud-worker",
    requestedModel: "snapshot-2026",
    requestSha256: digest(callId),
    reservedCostUsd: 0.6,
  });
} finally {
  store.close();
}
