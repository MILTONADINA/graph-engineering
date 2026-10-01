import { describe, expect, it } from "vitest";
import {
  assertProjectConfig,
  assertVerificationCatalogue,
  assertVerificationSelection,
  DEFAULT_POLICY,
} from "../src/index.js";

const check = { image: "toy-verify:local", argv: ["node", "--test"] };
const digest = "a".repeat(64);

describe("verification catalogue and selection contracts", () => {
  it("preserves anonymous legacy checks and accepts mandatory-default named checks", () => {
    for (const catalogue of [
      [],
      [check, check],
      [{ ...check, id: "Unit_1" }],
      [{ ...check, id: "unit", optional: false }],
      [{ ...check, id: "unit", optional: true }],
    ])
      expect(() => assertVerificationCatalogue(catalogue)).not.toThrow();
    expect(() =>
      assertProjectConfig({
        version: "1.0.0",
        projectId: "toy-verification",
        name: "Toy checks",
        policy: DEFAULT_POLICY,
        verification: [check, check],
      }),
    ).not.toThrow();
  });

  it("requires unique stable IDs and refuses unnamed optional or malformed catalogue entries", () => {
    for (const catalogue of [
      null,
      {},
      [{ ...check, optional: true }],
      [
        { ...check, id: "same" },
        { ...check, id: "same", optional: true },
      ],
      [{ ...check, id: "" }],
      [{ ...check, id: "./unit" }],
      [{ ...check, id: "unit\n" }],
      [{ ...check, id: "a".repeat(81) }],
      [{ ...check, id: "-unit" }],
      [{ ...check, optional: "true" }],
      [{ ...check, extra: true }],
      [{ ...check, argv: [] }],
    ])
      expect(() => assertVerificationCatalogue(catalogue)).toThrow(
        "Invalid verification catalogue",
      );
    expect(() =>
      assertProjectConfig({
        version: "1.0.0",
        projectId: "toy-verification",
        name: "Toy checks",
        policy: DEFAULT_POLICY,
        verification: [
          { ...check, id: "same" },
          { ...check, id: "same" },
        ],
      }),
    ).toThrow("duplicate check IDs");
  });

  it("validates complete frozen all-check and explicit-selection bindings", () => {
    expect(() =>
      assertVerificationSelection({ catalogueSha256: digest, checkIds: null }),
    ).not.toThrow();
    expect(() =>
      assertVerificationSelection({
        catalogueSha256: digest,
        checkIds: ["unit", "lint"],
      }),
    ).not.toThrow();
    for (const value of [
      null,
      {},
      [],
      { catalogueSha256: digest },
      { catalogueSha256: digest, checkIds: [] },
      { catalogueSha256: digest, checkIds: ["unit", "unit"] },
      { catalogueSha256: digest, checkIds: ["unit\n"] },
      { catalogueSha256: digest, checkIds: "unit" },
      { catalogueSha256: digest, checkIds: ["./unit"] },
      {
        catalogueSha256: digest,
        checkIds: Array.from({ length: 1001 }, (_, index) => `check${index}`),
      },
      { catalogueSha256: "A".repeat(64), checkIds: null },
      { catalogueSha256: `${digest}\n`, checkIds: null },
      { catalogueSha256: digest, checkIds: null, argv: ["unreviewed"] },
    ])
      expect(() => assertVerificationSelection(value)).toThrow(
        "Invalid verification selection",
      );
  });
});
