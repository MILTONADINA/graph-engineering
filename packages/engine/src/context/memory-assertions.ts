import { z } from "zod";
import type {
  MemoryAssertion,
  MemoryRecord,
  ReviewedMemoryAssertions,
} from "@graph-engineering/contracts";
import { containsSecret } from "../policy.js";

const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
const label = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) => value === value.trim(),
    "Identifiers must not have surrounding whitespace",
  );
const timestamp = z.string().datetime({ offset: true });
const valueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("string"), value: z.string().max(4000) }).strict(),
  z.object({ type: z.literal("number"), value: z.number().finite() }).strict(),
  z.object({ type: z.literal("boolean"), value: z.boolean() }).strict(),
  z
    .object({
      type: z.literal("string-set"),
      value: z.array(z.string().max(1000)).max(64),
    })
    .strict(),
]);
const claimSchema = z
  .object({
    subject: label,
    predicate: label,
    // Missing scope is invalid, not silently treated as a global assertion.
    scope: z
      .record(label, label)
      .refine(
        (scope) => Object.keys(scope).length <= 16,
        "Too many scope dimensions",
      ),
    value: valueSchema,
    exclusive: z.boolean(),
    validFrom: timestamp.optional(),
    validUntil: timestamp.optional(),
  })
  .strict()
  .refine(
    (claim) =>
      !claim.validFrom ||
      !claim.validUntil ||
      Date.parse(claim.validFrom) < Date.parse(claim.validUntil),
    "Assertion validity must be a nonempty half-open interval",
  );
const reviewSchema = z
  .object({
    version: z.literal("1.0.0"),
    claims: z.array(claimSchema).min(1).max(32),
    review: z
      .object({
        reviewer: label,
        reviewedAt: timestamp,
        evidence: z.array(z.string().min(1).max(4000)).min(1).max(32),
      })
      .strict(),
  })
  .strict();

/** Reject executable/coerced shapes before Zod or JSON.stringify touches them. */
function assertPlainJson(input: unknown): void {
  let nodes = 0;
  const visited = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 6000 || depth > 12)
      throw new Error("Assertion metadata exceeds structural limits");
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "string") {
      if (value.length > 16000)
        throw new Error("Assertion metadata string is too large");
      if (containsSecret(value))
        throw new Error("Assertion metadata contains a potential secret");
      return;
    }
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (!value || typeof value !== "object")
      throw new Error(
        "Assertion metadata must contain only finite plain JSON values",
      );
    if (visited.has(value))
      throw new Error("Assertion metadata must not contain cycles");
    visited.add(value);
    const array = Array.isArray(value);
    if (
      (!array && Object.getPrototypeOf(value) !== Object.prototype) ||
      (array && Object.getPrototypeOf(value) !== Array.prototype)
    )
      throw new Error(
        "Assertion metadata must contain only plain JSON objects and arrays",
      );
    const keys = Reflect.ownKeys(value);
    if (array && (value.length > 256 || keys.length !== value.length + 1))
      throw new Error("Assertion arrays must be bounded and dense");
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || forbiddenKeys.has(key))
        throw new Error(
          "Assertion metadata contains a prohibited prototype key",
        );
      if (array && !/^(0|[1-9][0-9]*)$/.test(key))
        throw new Error("Assertion arrays cannot carry additional properties");
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
        throw new Error(
          "Assertion metadata cannot contain accessors or hidden properties",
        );
      if (
        typeof descriptor.value === "string" &&
        containsSecret(`${key}=${descriptor.value}`)
      )
        throw new Error("Assertion metadata contains a potential secret");
      visit(key, depth + 1);
      visit(descriptor.value, depth + 1);
    }
    visited.delete(value);
  };
  visit(input, 0);
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 64000)
    throw new Error("Assertion metadata exceeds 64 KB");
}

// Local stable serialization avoids importing intelligence.ts (which uses these
// helpers). Types, exact strings, explicit scope, and set semantics stay distinct.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
const ordered = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);

export function parseReviewedAssertions(
  input: unknown,
): ReviewedMemoryAssertions {
  assertPlainJson(input);
  const parsed = reviewSchema.parse(input);
  const claims: MemoryAssertion[] = parsed.claims.map((claim) => {
    // Check assignment-like predicate/value pairs too; JSON quoting must not
    // conceal sensitive values split across the structured claim fields.
    if (
      containsSecret(
        `${claim.predicate}=${typeof claim.value.value === "string" ? claim.value.value : JSON.stringify(claim.value.value)}`,
      )
    )
      throw new Error("Assertion metadata contains a potential secret");
    return {
      ...claim,
      scope: Object.fromEntries(
        Object.entries(claim.scope).sort(([a], [b]) => ordered(a, b)),
      ),
      value:
        claim.value.type === "string-set"
          ? {
              type: "string-set",
              value: [...new Set(claim.value.value)].sort(),
            }
          : claim.value,
      ...(claim.validFrom
        ? { validFrom: new Date(claim.validFrom).toISOString() }
        : {}),
      ...(claim.validUntil
        ? { validUntil: new Date(claim.validUntil).toISOString() }
        : {}),
    };
  });
  return {
    version: "1.0.0",
    claims: [
      ...new Map(claims.map((claim) => [canonical(claim), claim])).entries(),
    ]
      .sort(([a], [b]) => ordered(a, b))
      .map(([, claim]) => claim),
    review: {
      ...parsed.review,
      reviewedAt: new Date(parsed.review.reviewedAt).toISOString(),
      evidence: [...new Set(parsed.review.evidence)].sort(),
    },
  };
}

/** A review is attributed metadata, not proof of truth or an acceptance action. */
export function attachReviewedAssertions(
  record: MemoryRecord,
  input: unknown,
): MemoryRecord {
  if (record.status !== "proposed")
    throw new Error(
      "Assertions can only be attached to a proposed memory; create a new proposal to revise accepted knowledge",
    );
  const assertions = parseReviewedAssertions(input);
  if (
    !Number.isFinite(Date.parse(record.createdAt)) ||
    Date.parse(assertions.review.reviewedAt) < Date.parse(record.createdAt)
  )
    throw new Error("Assertion review cannot predate the memory proposal");
  return { ...record, assertions };
}

export interface MemoryAssertionFinding {
  kind:
    | "exact-contradiction"
    | "assertion-semantics-conflict"
    | "invalid-assertions";
  relatedMemoryId?: string;
  claimIndex?: number;
  relatedClaimIndex?: number;
  reason: string;
}
const active = (record: MemoryRecord) =>
  record.status === "accepted" || record.status === "conflicted";
const identity = (claim: MemoryAssertion) =>
  canonical([claim.subject, claim.predicate, claim.scope]);
const overlaps = (a: MemoryAssertion, b: MemoryAssertion) =>
  Math.max(
    a.validFrom ? Date.parse(a.validFrom) : -Infinity,
    b.validFrom ? Date.parse(b.validFrom) : -Infinity,
  ) <
  Math.min(
    a.validUntil ? Date.parse(a.validUntil) : Infinity,
    b.validUntil ? Date.parse(b.validUntil) : Infinity,
  );

/** Exact declared-claim inconsistencies only; no free-text extraction or truth inference. */
export function reviewStructuredAssertions(
  memories: MemoryRecord[],
): Map<string, MemoryAssertionFinding[]> {
  const findings = new Map<string, MemoryAssertionFinding[]>();
  const groups = new Map<
    string,
    { record: MemoryRecord; claim: MemoryAssertion; index: number }[]
  >();
  for (const record of memories.filter(active)) {
    findings.set(record.id, []);
    if (!record.assertions) continue;
    let assertions: ReviewedMemoryAssertions;
    try {
      assertions = parseReviewedAssertions(record.assertions);
      if (
        !Number.isFinite(Date.parse(record.createdAt)) ||
        Date.parse(assertions.review.reviewedAt) < Date.parse(record.createdAt)
      )
        throw new Error("Assertion review predates its proposal");
    } catch {
      findings.get(record.id)!.push({
        kind: "invalid-assertions",
        reason:
          "Structured assertion metadata is invalid; retain the original memory for explicit review.",
      });
      continue;
    }
    assertions.claims.forEach((claim, index) => {
      const key = canonical([record.projectId, identity(claim)]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ record, claim, index });
    });
  }
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!,
          b = group[j]!;
        if (!overlaps(a.claim, b.claim)) continue;
        const kind =
          a.claim.exclusive !== b.claim.exclusive
            ? "assertion-semantics-conflict"
            : a.claim.exclusive &&
                canonical(a.claim.value) !== canonical(b.claim.value)
              ? "exact-contradiction"
              : null;
        if (!kind) continue;
        const reason =
          kind === "exact-contradiction"
            ? "Reviewed exclusive claims have the same exact subject, predicate, and scope, overlapping validity, and different typed values. This does not establish which claim is true."
            : "Reviewed claims disagree on whether this exact scoped predicate is exclusive; a human must resolve the declared semantics.";
        findings.get(a.record.id)!.push({
          kind,
          relatedMemoryId: b.record.id,
          claimIndex: a.index,
          relatedClaimIndex: b.index,
          reason,
        });
        findings.get(b.record.id)!.push({
          kind,
          relatedMemoryId: a.record.id,
          claimIndex: b.index,
          relatedClaimIndex: a.index,
          reason,
        });
      }
  }
  return findings;
}

export interface MemorySupersessionFinding {
  kind: "supersession-conflict";
  relatedMemoryId?: string;
  reason: string;
}

/** Pure link/chronology review. Never changes status or chooses a winning claim. */
export function reviewSupersession(
  record: MemoryRecord,
  memories: MemoryRecord[],
): MemorySupersessionFinding[] {
  if (!record.supersedes) return [];
  const findings: MemorySupersessionFinding[] = [];
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const visited = new Set<string>();
  let cursor: MemoryRecord | undefined = record;
  while (cursor) {
    if (visited.has(cursor.id)) {
      findings.push({
        kind: "supersession-conflict",
        relatedMemoryId: cursor.id,
        reason: "Supersession cycle requires explicit review.",
      });
      break;
    }
    visited.add(cursor.id);
    if (!cursor.supersedes) break;
    const previous = byId.get(cursor.supersedes);
    if (!previous || previous.projectId !== record.projectId) {
      findings.push({
        kind: "supersession-conflict",
        relatedMemoryId: cursor.supersedes,
        reason:
          "A superseded record is missing from this project; no replacement can be established.",
      });
      break;
    }
    if (
      !Number.isFinite(Date.parse(cursor.createdAt)) ||
      !Number.isFinite(Date.parse(previous.createdAt)) ||
      Date.parse(cursor.createdAt) < Date.parse(previous.createdAt)
    ) {
      findings.push({
        kind: "supersession-conflict",
        relatedMemoryId: previous.id,
        reason:
          "Supersession chronology is invalid: a successor cannot predate its predecessor.",
      });
    }
    cursor = previous;
  }
  for (const other of memories) {
    if (
      other.id !== record.id &&
      other.projectId === record.projectId &&
      active(other) &&
      other.supersedes === record.supersedes
    )
      findings.push({
        kind: "supersession-conflict",
        relatedMemoryId: other.id,
        reason:
          "Multiple active records claim to supersede the same record; retain all required constraints for review.",
      });
  }
  const previous = byId.get(record.supersedes);
  if (
    previous &&
    previous.projectId === record.projectId &&
    record.assertions &&
    previous.assertions
  ) {
    try {
      const nextClaims = parseReviewedAssertions(record.assertions).claims;
      const previousClaims = parseReviewedAssertions(
        previous.assertions,
      ).claims;
      if (
        nextClaims.some((next) =>
          previousClaims.some(
            (old) =>
              identity(next) === identity(old) &&
              next.validUntil &&
              old.validFrom &&
              Date.parse(next.validUntil) <= Date.parse(old.validFrom),
          ),
        )
      )
        findings.push({
          kind: "supersession-conflict",
          relatedMemoryId: previous.id,
          reason:
            "A successor's asserted validity ends before its predecessor starts; the replacement timeline requires review.",
        });
    } catch {
      /* Invalid metadata is reported separately by assertion review. */
    }
  }
  return findings;
}
