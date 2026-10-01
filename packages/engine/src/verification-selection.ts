import {
  assertVerificationCatalogue,
  assertVerificationSelection,
  type ExecutionPlan,
  type VerificationCheck,
} from "@graph-engineering/contracts";
import { hash } from "./util.js";

type VerificationPlan = Pick<
  ExecutionPlan,
  "verification" | "verificationSelection"
>;

/** Presence is significant: explicitly optional:false is not an absent field.
 * Object key order is not significant; catalogue and argv order both are. */
export function verificationCatalogueSha256(
  catalogue: VerificationCheck[],
): string {
  assertVerificationCatalogue(catalogue);
  return hash(
    catalogue.map((check) => [
      Object.hasOwn(check, "id"),
      check.id ?? null,
      Object.hasOwn(check, "optional"),
      check.optional ?? null,
      check.image,
      check.argv,
    ]),
  );
}

export function resolveVerificationSelection(
  catalogue: VerificationCheck[],
  checkIds?: string[],
): Required<VerificationPlan> {
  assertVerificationCatalogue(catalogue);
  if (checkIds !== undefined && !Array.isArray(checkIds))
    throw new Error(
      "Verification check selection must be a nonempty list of unique check IDs",
    );
  const verificationSelection = {
    catalogueSha256: verificationCatalogueSha256(catalogue),
    checkIds: checkIds === undefined ? null : [...checkIds],
  };
  assertVerificationSelection(verificationSelection);
  if (checkIds === undefined)
    return { verification: structuredClone(catalogue), verificationSelection };
  if (catalogue.some((check) => check.id === undefined))
    throw new Error(
      "Explicit check selection requires every configured verification check to have an ID",
    );
  const selected = new Set(checkIds);
  const known = new Set(catalogue.map((check) => check.id!));
  if (checkIds.some((id) => !known.has(id)))
    throw new Error("Verification selection contains an unknown check ID");
  if (
    catalogue.some(
      (check) => check.optional !== true && !selected.has(check.id!),
    )
  )
    throw new Error("Verification selection omits a mandatory check");
  return {
    // Catalogue order, not request order, determines verifier execution.
    verification: structuredClone(
      catalogue.filter((check) => selected.has(check.id!)),
    ),
    verificationSelection,
  };
}

/** A retained plan is authoritative. Never update its selector, catalogue
 * digest or executable check descriptors to match later configuration. */
export function assertPlanVerificationSelection(
  plan: VerificationPlan,
  catalogue: VerificationCheck[],
): void {
  assertVerificationCatalogue(catalogue);
  assertVerificationCatalogue(plan.verification);
  if (plan.verificationSelection === undefined) {
    if (
      [...catalogue, ...plan.verification].some(
        (check) =>
          Object.hasOwn(check, "id") || Object.hasOwn(check, "optional"),
      )
    )
      throw new Error(
        "This legacy plan has no verification selection binding; create a fresh plan",
      );
    return;
  }
  assertVerificationSelection(plan.verificationSelection);
  if (
    plan.verificationSelection.catalogueSha256 !==
    verificationCatalogueSha256(catalogue)
  )
    throw new Error(
      "Verification catalogue changed since planning; create a fresh plan",
    );
  const resolved = resolveVerificationSelection(
    catalogue,
    plan.verificationSelection.checkIds ?? undefined,
  );
  if (
    verificationCatalogueSha256(plan.verification) !==
    verificationCatalogueSha256(resolved.verification)
  )
    throw new Error(
      "Stored verification checks do not match the plan's selection; create a fresh plan",
    );
}
