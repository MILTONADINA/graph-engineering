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
  usageSchema,
  observationSchema,
  reservationSchema,
  callReservationSchema,
  callReceiptSchema,
  attemptReceiptSchema,
  eventSchema,
  closureSchema,
} = schema;
