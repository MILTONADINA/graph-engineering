import { describe, expect, it } from "vitest";
import type { VerificationCheck } from "@graph-engineering/contracts";
import { hash } from "../src/util.js";
import {
  assertPlanVerificationSelection,
  resolveVerificationSelection,
  verificationCatalogueSha256,
} from "../src/verification-selection.js";

const catalogue = (): VerificationCheck[] => [
  { id: "base", image: "toy:local", argv: ["check", "--all"] },
  { id: "area", optional: true, image: "toy:local", argv: ["check", "--area"] },
  { id: "slow", optional: true, image: "toy:local", argv: ["check", "--slow"] },
];
describe("verification selection resolution", () => {
  it("validates catalogue inputs before producing a public digest", () => {
    expect(() =>
      verificationCatalogueSha256([
        { id: "bad", image: "toy:local", argv: [] },
      ]),
    ).toThrow("Invalid verification catalogue");
    expect(() =>
      verificationCatalogueSha256([
        { id: "same", image: "toy:local", argv: ["one"] },
        { id: "same", image: "toy:local", argv: ["two"] },
      ]),
    ).toThrow("duplicate check IDs");
    expect(() =>
      verificationCatalogueSha256([
        { optional: true, image: "toy:local", argv: ["one"] },
      ]),
    ).toThrow("Invalid verification catalogue");
  });
  it("omitted selection freezes every configured check and its full ordered catalogue identity", () => {
    const checks = catalogue();
    const plan = resolveVerificationSelection(checks);
    expect(plan.verification).toEqual(checks);
    expect(plan.verification).not.toBe(checks);
    expect(plan.verificationSelection).toEqual({
      checkIds: null,
      catalogueSha256: hash(
        checks.map((check) => [
          Object.hasOwn(check, "id"),
          check.id ?? null,
          Object.hasOwn(check, "optional"),
          check.optional ?? null,
          check.image,
          check.argv,
        ]),
      ),
    });
    checks[0]!.argv.push("--changed");
    expect(plan.verification[0]!.argv).toEqual(["check", "--all"]);
  });
  it("requires mandatory entries and resolves explicit selections in catalogue order", () => {
    const checks = catalogue();
    const plan = resolveVerificationSelection(checks, ["area", "base"]);
    expect(plan.verification).toEqual(checks.slice(0, 2));
    expect(plan.verificationSelection.checkIds).toEqual(["area", "base"]);
    expect(() => assertPlanVerificationSelection(plan, checks)).not.toThrow();
  });
  it.each([
    { ids: ["area"], reason: "mandatory" },
    { ids: ["base", "unknown"], reason: "unknown" },
    { ids: ["base", "base"], reason: "verification" },
    { ids: [], reason: "verification" },
  ])("refuses invalid selection $ids", ({ ids, reason }) => {
    expect(() => resolveVerificationSelection(catalogue(), ids)).toThrow(
      new RegExp(reason, "i"),
    );
  });
  it("refuses explicit selection while even one legacy entry is unnamed", () => {
    expect(() =>
      resolveVerificationSelection(
        [{ image: "toy:local", argv: ["legacy"] }, ...catalogue()],
        ["base"],
      ),
    ).toThrow("every configured verification check to have an ID");
  });
  it("keeps anonymous duplicate checks and absent/false optional flags mandatory by default", () => {
    const legacy = { image: "toy:local", argv: ["legacy"] };
    expect(resolveVerificationSelection([legacy, legacy]).verification).toEqual(
      [legacy, legacy],
    );
    const checks = catalogue();
    checks[1]!.optional = false;
    expect(() => resolveVerificationSelection(checks, ["base"])).toThrow(
      "mandatory",
    );
  });
  it("ignores object key order but binds catalogue order, argv order and explicit field presence", () => {
    const checks = catalogue();
    const reorderedKeys = checks.map(({ id, optional, image, argv }) => ({
      argv,
      image,
      ...(optional === undefined ? {} : { optional }),
      id,
    }));
    expect(verificationCatalogueSha256(reorderedKeys)).toBe(
      verificationCatalogueSha256(checks),
    );
    const changes = [
      [...checks].reverse(),
      checks.map((check) => ({ ...check, argv: [...check.argv].reverse() })),
      checks.map((check, index) =>
        index ? check : { ...check, optional: false },
      ),
    ];
    for (const changed of changes)
      expect(verificationCatalogueSha256(changed)).not.toBe(
        verificationCatalogueSha256(checks),
      );
  });
  it.each(["added", "removed", "command", "optional"] as const)(
    "refuses %s catalogue drift including unselected checks",
    (change) => {
      const checks = catalogue();
      const plan = resolveVerificationSelection(checks, ["base"]);
      if (change === "added")
        checks.push({ id: "new", image: "toy:local", argv: ["new"] });
      if (change === "removed") checks.pop();
      if (change === "command") checks[2]!.argv = ["different"];
      if (change === "optional") checks[2]!.optional = false;
      expect(() => assertPlanVerificationSelection(plan, checks)).toThrow(
        "catalogue changed",
      );
    },
  );
  it("refuses altered resolved commands or a selector inconsistent with its retained descriptors", () => {
    const checks = catalogue();
    const plan = resolveVerificationSelection(checks, ["base", "area"]);
    plan.verification[0]!.argv = ["skip"];
    expect(() => assertPlanVerificationSelection(plan, checks)).toThrow(
      "do not match",
    );
    const other = resolveVerificationSelection(checks, ["base", "area"]);
    other.verificationSelection.checkIds = ["base"];
    expect(() => assertPlanVerificationSelection(other, checks)).toThrow(
      "do not match",
    );
  });
  it("allows old all-anonymous plans only while both retained and current checks lack selection metadata", () => {
    const legacy = [{ image: "toy:local", argv: ["legacy"] }];
    expect(() =>
      assertPlanVerificationSelection({ verification: legacy }, legacy),
    ).not.toThrow();
    for (const check of [
      { ...legacy[0]!, id: "named" },
      { ...legacy[0]!, optional: false },
    ]) {
      expect(() =>
        assertPlanVerificationSelection({ verification: legacy }, [check]),
      ).toThrow("fresh plan");
      expect(() =>
        assertPlanVerificationSelection({ verification: [check] }, legacy),
      ).toThrow("fresh plan");
    }
  });
});
