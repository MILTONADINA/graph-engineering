/** Unknown confidence is retained as null, never converted into a measured zero. */
export function normalizeDecisionConfidence(value) {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    throw new Error("Invalid observed decision confidence");
  return value;
}
