import { SealedStore } from "../store.mjs";

const [
  directory,
  reservationId,
  expectedPlanSha256,
  oracleSha256,
  proposalSha256,
  callId,
  expectedCallReceiptSha256,
  expectedResponseSha256,
  imageId,
] = process.argv.slice(2);
const store = new SealedStore({ directory });
try {
  store.claimOracleInvocation(reservationId, {
    expectedPlanSha256,
    oracleSha256,
    proposalSha256,
    callId,
    expectedCallReceiptSha256,
    expectedResponseSha256,
    imageId,
  });
} finally {
  store.close();
}
process.exit(23);
