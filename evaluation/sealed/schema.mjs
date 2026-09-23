// One authoritative pure schema; this adapter never imports candidate engine execution.
import { tsImport } from "tsx/esm/api";
const schema = await tsImport(
  "../../packages/engine/src/sealed-collection-schema.ts",
  import.meta.url,
);
export const {
  LIMITS,
  parseBoundedJson,
  cloneJson,
  decodeJson,
  canonicalJson,
  hashJson,
  freezeJson,
  digestSchema,
  frozenConfigurationSchema,
  taskCommitmentSchema,
  exposureRegistrySchema,
  assignmentSchema,
  collectionPlanSchema,
  validateCollectionPlan,
  spendingAuthorizationSchema,
  usageSchema,
  observationSchema,
  reservationSchema,
  publicDispatchClaimSchema,
  oracleInvocationClaimSchema,
  callReservationSchema,
  callReceiptSchema,
  attemptReceiptSchema,
  eventSchema,
  closureSchema,
} = schema;
