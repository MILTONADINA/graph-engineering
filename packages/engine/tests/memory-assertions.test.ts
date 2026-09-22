import { describe, expect, it } from "vitest";
import type {
  MemoryAssertion,
  MemoryRecord,
  ReviewedMemoryAssertions,
} from "@graph-engineering/contracts";
import {
  attachReviewedAssertions,
  parseReviewedAssertions,
  reviewStructuredAssertions,
  reviewSupersession,
} from "../src/context/memory-assertions.js";
import { reviewMemoryRecords } from "../src/context/intelligence.js";

const claim = (changes: Partial<MemoryAssertion> = {}): MemoryAssertion => ({
  subject: "application.database",
  predicate: "engine",
  scope: { environment: "production" },
  value: { type: "string", value: "postgresql" },
  exclusive: true,
  ...changes,
});
const reviewed = (claims = [claim()]): ReviewedMemoryAssertions => ({
  version: "1.0.0",
  claims,
  review: {
    reviewer: "partner-reviewer",
    reviewedAt: "2026-09-22T12:00:00.000Z",
    evidence: ["Reviewed project architecture decision ADR-12"],
  },
});
const memory = (
  id: string,
  assertions?: ReviewedMemoryAssertions,
  changes: Partial<MemoryRecord> = {},
): MemoryRecord => ({
  version: "1.0.0",
  id,
  projectId: "project",
  kind: "constraint",
  text: "Use PostgreSQL for production storage.",
  visibility: "private",
  status: "accepted",
  createdAt: "2026-01-01T00:00:00.000Z",
  sources: [],
  ...(assertions ? { assertions } : {}),
  ...changes,
});
const exact = (records: MemoryRecord[]) =>
  [...reviewStructuredAssertions(records).values()]
    .flat()
    .filter((flag) => flag.kind === "exact-contradiction");

describe("reviewed assertion validation", () => {
  it("canonicalizes set/claim/scope/evidence ordering without mutating the reviewed input", () => {
    const first = reviewed([
      claim({
        predicate: "roles",
        scope: { zone: "west", environment: "production" },
        value: { type: "string-set", value: ["reader", "writer", "reader"] },
      }),
      claim({ predicate: "enabled", value: { type: "boolean", value: true } }),
    ]);
    first.review.evidence = ["B", "A", "B"];
    const before = structuredClone(first);
    const second = reviewed([
      claim({ predicate: "enabled", value: { type: "boolean", value: true } }),
      claim({
        predicate: "roles",
        scope: { environment: "production", zone: "west" },
        value: { type: "string-set", value: ["writer", "reader"] },
      }),
    ]);
    second.review.evidence = ["A", "B"];
    expect(parseReviewedAssertions(first)).toEqual(
      parseReviewedAssertions(second),
    );
    expect(first).toEqual(before);
  });
  it("requires explicit scope, review attribution, evidence, exclusivity, and valid intervals", () => {
    for (const field of ["scope", "exclusive"]) {
      const value = reviewed() as any;
      delete value.claims[0][field];
      expect(() => parseReviewedAssertions(value)).toThrow();
    }
    expect(() =>
      parseReviewedAssertions({
        ...reviewed(),
        review: { reviewer: "", reviewedAt: "yesterday", evidence: [] },
      }),
    ).toThrow();
    expect(() =>
      parseReviewedAssertions(
        reviewed([
          claim({
            validFrom: "2026-02-01T00:00:00Z",
            validUntil: "2026-02-01T00:00:00Z",
          }),
        ]),
      ),
    ).toThrow("half-open");
    expect(() =>
      parseReviewedAssertions({ ...reviewed(), inferredAutomatically: true }),
    ).toThrow();
  });
  it("rejects prototype keys, nonplain objects, getters, cycles, sparse arrays, and excess size", () => {
    const prototype = JSON.parse(JSON.stringify(reviewed()));
    prototype.claims[0].scope = JSON.parse('{"__proto__":"blocked"}');
    expect(() => parseReviewedAssertions(prototype)).toThrow("prototype key");
    expect(() =>
      parseReviewedAssertions({ ...reviewed(), extra: new Date() }),
    ).toThrow("plain JSON");
    let accessed = false;
    const getter = Object.defineProperty({}, "claims", {
      enumerable: true,
      get() {
        accessed = true;
        return [];
      },
    });
    expect(() => parseReviewedAssertions(getter)).toThrow("accessors");
    expect(accessed).toBe(false);
    const cyclic: any = reviewed();
    cyclic.again = cyclic;
    expect(() => parseReviewedAssertions(cyclic)).toThrow("cycles");
    const sparse: any = reviewed();
    sparse.review.evidence = new Array(2);
    expect(() => parseReviewedAssertions(sparse)).toThrow("dense");
    expect(() =>
      parseReviewedAssertions(
        reviewed(Array.from({ length: 33 }, () => claim())),
      ),
    ).toThrow();
    expect(() =>
      parseReviewedAssertions(
        reviewed([claim({ value: { type: "number", value: Infinity } })]),
      ),
    ).toThrow("finite");
    const large = reviewed();
    large.review.evidence = Array.from({ length: 20 }, () => "x".repeat(4000));
    expect(() => parseReviewedAssertions(large)).toThrow("64 KB");
  });
  it("screens raw secret text and assignment-like predicate/value pairs", () => {
    expect(() =>
      parseReviewedAssertions(
        reviewed([claim({ scope: { password: "z".repeat(28) } })]),
      ),
    ).toThrow("secret");
    expect(() =>
      parseReviewedAssertions(
        reviewed([
          claim({ value: { type: "string", value: "sk-" + "s".repeat(28) } }),
        ]),
      ),
    ).toThrow("secret");
    expect(() =>
      parseReviewedAssertions(
        reviewed([
          claim({
            predicate: "api_key",
            value: { type: "string", value: "z".repeat(28) },
          }),
        ]),
      ),
    ).toThrow("secret");
    const evidence = reviewed();
    evidence.review.evidence = ['password="' + "z".repeat(24) + '"'];
    expect(() => parseReviewedAssertions(evidence)).toThrow("secret");
  });
  it("attaches only to proposed records and never accepts or supersedes either record", () => {
    const proposal = memory("proposal", undefined, {
      status: "proposed",
      supersedes: "previous",
    });
    const attached = attachReviewedAssertions(proposal, reviewed());
    expect(attached.status).toBe("proposed");
    expect(attached.supersedes).toBe("previous");
    expect(proposal).not.toHaveProperty("assertions");
    for (const status of ["accepted", "conflicted", "superseded"] as const)
      expect(() =>
        attachReviewedAssertions({ ...proposal, status }, reviewed()),
      ).toThrow("proposed");
    expect(() =>
      attachReviewedAssertions(
        { ...proposal, createdAt: "2027-01-01T00:00:00Z" },
        reviewed(),
      ),
    ).toThrow("predate");
  });
});

describe("exact declared assertion consistency, not semantic truth", () => {
  it("uses human-supplied canonical identifiers for aliases and does not infer from free text", () => {
    const a = memory("a", reviewed(), { text: "Use Postgres." });
    const b = memory("b", reviewed(), { text: "Use PostgreSQL." });
    expect(exact([a, b])).toEqual([]);
    expect(
      exact([a, memory("c", undefined, { text: "Never use Postgres." })]),
    ).toEqual([]);
    const renamed = memory(
      "d",
      reviewed([claim({ value: { type: "string", value: "Postgres" } })]),
    );
    expect(exact([a, renamed])).toHaveLength(2); // No hidden synonym mapping.
  });
  it("flags opposite exclusive values symmetrically, preserving both required constraints", () => {
    const records = [
      memory("a", reviewed()),
      memory(
        "b",
        reviewed([claim({ value: { type: "string", value: "sqlite" } })]),
        { status: "conflicted", kind: "requirement" },
      ),
    ];
    const before = structuredClone(records);
    const reviews = reviewMemoryRecords(
      records,
      new Map(),
      "snapshot",
      () => false,
    );
    expect(
      reviews.every((review) =>
        review.flags.some(
          (flag) =>
            flag.kind === "exact-contradiction" && flag.method === "structured",
        ),
      ),
    ).toBe(true);
    expect(records).toEqual(before);
    expect(records.map((record) => record.status)).toEqual([
      "accepted",
      "conflicted",
    ]);
  });
  it("keeps strings, numbers, booleans and string sets distinct", () => {
    for (const [left, right] of [
      [
        { type: "string", value: "1" },
        { type: "number", value: 1 },
      ],
      [
        { type: "string", value: "false" },
        { type: "boolean", value: false },
      ],
      [
        { type: "string", value: "a" },
        { type: "string-set", value: ["a"] },
      ],
    ] as const)
      expect(
        exact([
          memory(
            "a",
            reviewed([claim({ value: left as MemoryAssertion["value"] })]),
          ),
          memory(
            "b",
            reviewed([claim({ value: right as MemoryAssertion["value"] })]),
          ),
        ]),
      ).toHaveLength(2);
    expect(
      exact([
        memory(
          "a",
          reviewed([
            claim({ value: { type: "string-set", value: ["a", "b"] } }),
          ]),
        ),
        memory(
          "b",
          reviewed([
            claim({ value: { type: "string-set", value: ["b", "a", "a"] } }),
          ]),
        ),
      ]),
    ).toEqual([]);
  });
  it("does not collapse scope, project, subject, predicate, or nonexclusive alternatives", () => {
    const base = memory("a", reviewed());
    for (const change of [
      { scope: {} },
      { scope: { environment: "staging" } },
      { subject: "other.database" },
      { predicate: "engine.backup" },
    ])
      expect(
        exact([
          base,
          memory(
            "b",
            reviewed([
              claim({ ...change, value: { type: "string", value: "sqlite" } }),
            ]),
          ),
        ]),
      ).toEqual([]);
    expect(
      exact([
        base,
        memory(
          "b",
          reviewed([claim({ value: { type: "string", value: "sqlite" } })]),
          { projectId: "other-project" },
        ),
      ]),
    ).toEqual([]);
    expect(
      exact([
        memory("a", reviewed([claim({ exclusive: false })])),
        memory(
          "b",
          reviewed([
            claim({
              exclusive: false,
              value: { type: "string", value: "sqlite" },
            }),
          ]),
        ),
      ]),
    ).toEqual([]);
    const semantics = reviewStructuredAssertions([
      base,
      memory("b", reviewed([claim({ exclusive: false })])),
    ]);
    expect(semantics.get("a")?.[0]?.kind).toBe("assertion-semantics-conflict");
  });
  it("compares overlapping half-open intervals, normalizes timezone aliases, and ignores inactive proposals", () => {
    const earlier = memory(
      "a",
      reviewed([claim({ validUntil: "2026-06-01T00:00:00Z" })]),
    );
    const later = memory(
      "b",
      reviewed([
        claim({
          validFrom: "2026-06-01T00:00:00Z",
          value: { type: "string", value: "sqlite" },
        }),
      ]),
    );
    expect(exact([earlier, later])).toEqual([]);
    const overlap = memory(
      "c",
      reviewed([
        claim({
          validFrom: "2026-05-01T00:00:00Z",
          value: { type: "string", value: "sqlite" },
        }),
      ]),
    );
    expect(exact([earlier, overlap])).toHaveLength(2);
    expect(exact([earlier, { ...overlap, status: "proposed" }])).toEqual([]);
    expect(exact([{ ...earlier, status: "superseded" }, overlap])).toEqual([]);
    expect(
      parseReviewedAssertions(
        reviewed([claim({ validFrom: "2026-06-01T01:00:00+01:00" })]),
      ).claims[0]?.validFrom,
    ).toBe("2026-06-01T00:00:00.000Z");
  });
  it("keeps lexical flags separate and marks invalid reviewed metadata without dropping the memory", () => {
    const records = [
      memory("a", undefined, { text: "Use atomic refresh token rotation." }),
      memory("b", undefined, {
        text: "Never use atomic refresh token rotation.",
      }),
    ];
    const reviews = reviewMemoryRecords(
      records,
      new Map(),
      "snapshot",
      () => false,
    );
    expect(
      reviews[0]?.flags.some(
        (flag) =>
          flag.kind === "possible-contradiction" && flag.method === "lexical",
      ),
    ).toBe(true);
    expect(
      reviews[0]?.flags.some((flag) => flag.kind === "exact-contradiction"),
    ).toBe(false);
    const invalid = memory("invalid", { ...reviewed(), claims: [] });
    expect(
      reviewStructuredAssertions([invalid]).get("invalid")?.[0]?.kind,
    ).toBe("invalid-assertions");
    expect(invalid.status).toBe("accepted");
  });
});

describe("explicit supersession link and temporal review", () => {
  it("allows an explicit later successor without silently changing either record", () => {
    const previous = memory("previous", reviewed(), { status: "superseded" });
    const next = memory(
      "next",
      reviewed([claim({ value: { type: "string", value: "sqlite" } })]),
      { supersedes: previous.id, createdAt: "2026-02-01T00:00:00Z" },
    );
    expect(reviewSupersession(next, [previous, next])).toEqual([]);
    expect(exact([previous, next])).toEqual([]);
    expect(previous.status).toBe("superseded");
    expect(next.status).toBe("accepted");
  });
  it("flags competing successors, dangling ancestors, cross-project targets, cycles, and backward chronology", () => {
    const previous = memory("previous");
    const next = memory("next", undefined, { supersedes: previous.id });
    const rival = memory("rival", undefined, { supersedes: previous.id });
    expect(
      reviewSupersession(next, [previous, next, rival])[0]?.reason,
    ).toContain("Multiple active");
    expect(reviewSupersession(next, [next])[0]?.reason).toContain("missing");
    expect(
      reviewSupersession(next, [
        { ...previous, supersedes: "missing-ancestor" },
        next,
      ])[0]?.reason,
    ).toContain("missing");
    expect(
      reviewSupersession(next, [{ ...previous, projectId: "other" }, next])[0]
        ?.reason,
    ).toContain("missing");
    expect(
      reviewSupersession(next, [
        { ...previous, supersedes: next.id },
        next,
      ]).some((flag) => flag.reason.includes("cycle")),
    ).toBe(true);
    expect(
      reviewSupersession({ ...next, createdAt: "2025-12-01T00:00:00Z" }, [
        previous,
        next,
      ]).some((flag) => flag.reason.includes("chronology")),
    ).toBe(true);
  });
  it("flags a replacement whose asserted validity ends before its predecessor starts", () => {
    const previous = memory(
      "previous",
      reviewed([claim({ validFrom: "2026-07-01T00:00:00Z" })]),
    );
    const next = memory(
      "next",
      reviewed([claim({ validUntil: "2026-06-01T00:00:00Z" })]),
      { supersedes: previous.id, createdAt: "2026-02-01T00:00:00Z" },
    );
    expect(
      reviewSupersession(next, [previous, next]).some((flag) =>
        flag.reason.includes("validity ends"),
      ),
    ).toBe(true);
    expect(previous.status).toBe("accepted");
  });
});
