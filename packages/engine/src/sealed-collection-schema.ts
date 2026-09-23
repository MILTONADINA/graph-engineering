// Validation only. Commitments and unsigned receipts are not sealed evidence,
// independent review, transport authorization, or promotion authority.
import { createHash } from "node:crypto";
import { types } from "node:util";
import { z } from "zod";

export const LIMITS = Object.freeze({
  bytes: 2_000_000,
  nodes: 100_000,
  depth: 24,
});
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const wellFormed = (text: string) =>
  Buffer.from(text, "utf8").toString("utf8") === text;

/** Reject ambiguous raw JSON, including duplicate decoded/escaped property names. */
export function parseBoundedJson(text: string): JsonValue {
  if (
    typeof text !== "string" ||
    !wellFormed(text) ||
    Buffer.byteLength(text) > LIMITS.bytes
  )
    throw new Error("Sealed JSON exceeds its byte/UTF-8 bounds");
  const value: unknown = JSON.parse(text);
  let position = 0,
    nodes = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(text[position] ?? "!") && position < text.length)
      position++;
  };
  const string = (): string => {
    const start = position++;
    while (position < text.length) {
      const char = text[position++];
      if (char === "\\") position++;
      else if (char === '"') return JSON.parse(text.slice(start, position));
    }
    throw new Error("Unterminated JSON string");
  };
  const visit = (depth: number): void => {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth)
      throw new Error("Sealed JSON exceeds structural bounds");
    whitespace();
    if (text[position] === '"') {
      string();
      return;
    }
    const object = text[position] === "{",
      array = text[position] === "[";
    if (object || array) {
      position++;
      whitespace();
      const closing = object ? "}" : "]",
        seen = new Set();
      if (text[position] === closing) {
        position++;
        return;
      }
      while (true) {
        if (object) {
          whitespace();
          const key = string();
          if (seen.has(key))
            throw new Error("Duplicate decoded sealed JSON key");
          seen.add(key);
          whitespace();
          position++; // colon; JSON.parse validated grammar
        }
        visit(depth + 1);
        whitespace();
        if (text[position++] === closing) return;
      }
    }
    while (position < text.length && !/[\x20\t\r\n,\]}]/.test(text[position]))
      position++;
  };
  visit(0);
  return cloneJson(value);
}

/** Objects are also accepted, but accessors/proxies/coercion never run during validation. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export function cloneJson(input: unknown): JsonValue {
  let nodes = 0,
    bytes = 0;
  const charge = (amount: number) => {
    bytes += amount;
    if (bytes > LIMITS.bytes)
      throw new Error("Sealed data exceeds byte bounds");
  };
  const stringBytes = (value: string) => {
    if (Buffer.byteLength(value) > LIMITS.bytes)
      throw new Error("Sealed data exceeds byte bounds");
    return Buffer.byteLength(JSON.stringify(value));
  };
  const copy = (value: unknown, depth: number): JsonValue => {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth)
      throw new Error("Sealed data exceeds structural bounds");
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      charge(JSON.stringify(value).length);
      return value;
    }
    if (typeof value === "string") {
      charge(stringBytes(value));
      if (!wellFormed(value))
        throw new Error("Sealed data must be plain finite JSON");
      return value;
    }
    if (!value || typeof value !== "object" || types.isProxy(value))
      throw new Error("Sealed data must be plain finite JSON");
    const array = Array.isArray(value),
      prototype = Object.getPrototypeOf(value);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      throw new Error("Sealed data must have plain JSON prototypes");
    if (Reflect.ownKeys(value).length > LIMITS.nodes)
      throw new Error("Sealed data exceeds structural bounds");
    const fields = Object.getOwnPropertyDescriptors(value);
    const result: { [key: string]: JsonValue } = Object.create(null);
    charge(2); // enclosing object/array punctuation
    let first = true;
    for (const key of Reflect.ownKeys(fields)) {
      if (array && key === "length") continue;
      const field = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key === "string" && !array) charge(stringBytes(key) + 1);
      if (
        typeof key !== "string" ||
        !wellFormed(key) ||
        forbidden.has(key) ||
        !field.enumerable ||
        !Object.hasOwn(field, "value")
      )
        throw new Error(
          "Sealed JSON refuses forbidden keys, accessors and hidden fields",
        );
      if (
        array &&
        (!/^(0|[1-9]\d*)$/.test(key) ||
          Number(key) >= (value as unknown[]).length)
      )
        throw new Error("Sealed arrays must be dense JSON");
      if (!first) charge(1);
      first = false;
      result[key] = copy(field.value, depth + 1);
    }
    if (array && Object.keys(fields).length !== (value as unknown[]).length + 1)
      throw new Error("Sealed arrays must be dense JSON");
    return array
      ? Array.from(
          { length: (value as unknown[]).length },
          (_, index) => result[String(index)],
        )
      : result;
  };
  const result = copy(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.bytes)
    throw new Error("Sealed data exceeds byte bounds");
  return result;
}
export const decodeJson = (input: unknown): JsonValue =>
  typeof input === "string" ? parseBoundedJson(input) : cloneJson(input);
export function canonicalJson(input: unknown): string {
  const value = cloneJson(input);
  const serialize = (item: JsonValue): string =>
    Array.isArray(item)
      ? `[${item.map(serialize).join(",")}]`
      : item && typeof item === "object"
        ? `{${Object.keys(item)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${serialize(item[key])}`)
            .join(",")}}`
        : JSON.stringify(item);
  return serialize(value);
}
export const hashJson = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeJson(item);
    Object.freeze(value);
  }
  return value;
}

const version = z.literal("1.0.0");
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const label = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const timestamp = z.string().datetime();
const amount = z.number().finite().nonnegative().max(1e12);
const count = z.number().int().nonnegative().max(1e12);
const arm = z.enum(["baseline", "candidate"]);
const relative = z
  .string()
  .min(1)
  .max(400)
  .refine(
    (value) =>
      !/[\\:\x00-\x1f]/.test(value) &&
      value
        .split("/")
        .every(
          (part) =>
            part &&
            ![".", ".."].includes(part) &&
            !/[. ]$/.test(part) &&
            !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ),
    "Expected a portable relative path",
  );
const unique = (values: unknown[], message: string): void => {
  if (new Set(values).size !== values.length) throw new Error(message);
};

export const frozenConfigurationSchema = z
  .object({
    version,
    kind: z.literal("sealed-frozen-configuration"),
    configurationId: id,
    implementationSha256: digestSchema,
    policySha256: digestSchema,
    promptSha256: digestSchema,
    contextImplementationSha256: digestSchema,
    categoryStateVersions: z
      .array(z.object({ category: id, stateFormatVersion: id }).strict())
      .min(1)
      .max(100),
    providers: z
      .array(
        z
          .object({
            providerId: id,
            kind: z.enum(["local", "openai", "anthropic", "laya", "jev"]),
            endpointOrigin: z.string().url().max(2048),
            requestedModel: label,
            modelIdentity: z.discriminatedUnion("kind", [
              z
                .object({
                  kind: z.literal("local-weights"),
                  weightsSha256: digestSchema,
                  tokenizerSha256: digestSchema,
                  runtimeSha256: digestSchema,
                })
                .strict(),
              z
                .object({
                  kind: z.literal("provider-snapshot"),
                  snapshotId: label,
                })
                .strict(),
              z
                .object({
                  kind: z.literal("unversioned-alias"),
                  limitation: label,
                })
                .strict(),
            ]),
            effort: label.nullable(),
            maxOutputTokens: count.positive(),
            samplingSha256: digestSchema,
            pricingSha256: digestSchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    maxCallsPerAttempt: z.number().int().min(1).max(100),
    maxCostUsdPerAttempt: amount.nullable(),
    maxDurationMs: z.number().int().min(1).max(3_600_000),
  })
  .strict();

export const taskCommitmentSchema = z
  .object({
    version,
    kind: z.literal("sealed-task-commitment"),
    taskId: id,
    stableTaskId: id,
    stableFamilyId: id,
    exposureDomain: id,
    repositoryId: id,
    exposure: z.literal("sealed-unseen"),
    baselineSha256: digestSchema,
    publicPacketSha256: digestSchema,
    oracleSha256: digestSchema,
    referenceRepairSha256: digestSchema.nullable(),
    category: id,
    stateFormatVersion: id,
    risk: z.enum(["low", "moderate", "high", "critical"]),
    allowedOutputPaths: z.array(relative).min(1).max(100),
    curatorId: id,
  })
  .strict();

export const exposureRegistrySchema = z
  .object({
    version,
    kind: z.literal("sealed-exposure-registry"),
    registryId: id,
    createdAt: timestamp,
    entries: z
      .array(
        z
          .object({
            stableTaskId: id,
            stableFamilyId: id,
            exposureDomain: id,
            exposure: z.enum([
              "known-history",
              "calibration",
              "previously-replayed",
              "previously-disclosed",
            ]),
            evidenceSha256: digestSchema,
            artifactSha256s: z.array(digestSchema).max(100),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export const assignmentSchema = z
  .object({
    assignmentId: id,
    taskId: id,
    arm,
    ordinal: z.number().int().min(0).max(2000),
  })
  .strict();
export const collectionPlanSchema = z
  .object({
    version,
    kind: z.literal("sealed-collection-plan"),
    collectionId: id,
    projectId: id,
    createdAt: timestamp,
    notBefore: timestamp,
    expiresAt: timestamp,
    population: z.string().min(20).max(4000),
    samplingRule: z.string().min(20).max(4000),
    exposureRegistrySha256: digestSchema,
    trustPolicySha256: digestSchema,
    calibrationDatasetSha256: digestSchema,
    thresholdsSha256: digestSchema,
    configurations: z
      .object({
        baseline: frozenConfigurationSchema,
        candidate: frozenConfigurationSchema,
      })
      .strict(),
    tasks: z.array(taskCommitmentSchema).min(1).max(1000),
    assignments: z.array(assignmentSchema).min(2).max(2000),
    producerIds: z.array(id).min(1).max(20),
    limitations: z.array(label).min(1).max(20),
  })
  .strict();

export function validateCollectionPlan(
  input: unknown,
  registryInput: unknown,
  { expectedRegistrySha256 }: { expectedRegistrySha256?: string } = {},
) {
  const plan = collectionPlanSchema.parse(decodeJson(input)),
    registry = exposureRegistrySchema.parse(decodeJson(registryInput));
  const registrySha256 = hashJson(registry);
  if (
    !digestSchema.safeParse(expectedRegistrySha256).success ||
    expectedRegistrySha256 !== registrySha256 ||
    plan.exposureRegistrySha256 !== registrySha256
  )
    throw new Error(
      "Exposure registry must match the separately pinned digest",
    );
  if (!(
    Date.parse(plan.createdAt) <= Date.parse(plan.notBefore) &&
    Date.parse(plan.notBefore) < Date.parse(plan.expiresAt)
  ))
    throw new Error("Invalid collection time window");
  unique(
    plan.tasks.map((task) => task.taskId),
    "Duplicate task ID",
  );
  unique(
    plan.tasks.map((task) => task.stableTaskId),
    "Duplicate stable task identity",
  );
  unique(
    plan.tasks.map((task) =>
      hashJson({
        repositoryId: task.repositoryId,
        baselineSha256: task.baselineSha256,
        publicPacketSha256: task.publicPacketSha256,
        oracleSha256: task.oracleSha256,
        referenceRepairSha256: task.referenceRepairSha256,
      }),
    ),
    "Duplicate exact task content cannot inflate the population",
  );
  unique(
    plan.assignments.map((item) => item.assignmentId),
    "Duplicate assignment ID",
  );
  unique(
    plan.assignments.map((item) => item.ordinal),
    "Duplicate assignment ordinal",
  );
  unique(
    plan.assignments.map((item) => `${item.taskId}\0${item.arm}`),
    "Duplicate task/arm assignment",
  );
  unique(plan.producerIds, "Duplicate producer identity");
  if (
    plan.assignments.length !== plan.tasks.length * 2 ||
    plan.assignments.some(
      (item) => !plan.tasks.some((task) => task.taskId === item.taskId),
    ) ||
    [...plan.assignments]
      .sort((a, b) => a.ordinal - b.ordinal)
      .some((item, index) => item.ordinal !== index)
  )
    throw new Error("Every task needs exactly two ordered arm assignments");
  for (const task of plan.tasks) {
    if (
      task.oracleSha256 === task.publicPacketSha256 ||
      task.referenceRepairSha256 === task.publicPacketSha256
    )
      throw new Error(
        "Private oracle or reference repair cannot equal the public worker packet",
      );
    unique(
      task.allowedOutputPaths.map((name) => name.toLowerCase()),
      "Conflicting task output paths",
    );
    if (
      registry.entries.some(
        (item) =>
          item.stableTaskId === task.stableTaskId ||
          item.stableFamilyId === task.stableFamilyId ||
          item.artifactSha256s.some((digest) =>
            [
              task.baselineSha256,
              task.publicPacketSha256,
              task.oracleSha256,
              task.referenceRepairSha256,
            ].includes(digest),
          ),
      )
    )
      throw new Error("Known task or family exposure cannot become held-out");
  }
  for (const config of Object.values(plan.configurations)) {
    unique(
      config.providers.map((item) => item.providerId),
      "Duplicate provider identity",
    );
    unique(
      config.categoryStateVersions.map((item) => item.category),
      "Duplicate category state identity",
    );
    for (const provider of config.providers) {
      const endpoint = new URL(provider.endpointOrigin);
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        endpoint.pathname !== "/" ||
        endpoint.origin !== provider.endpointOrigin
      )
        throw new Error(
          "Provider origin must be canonical and credential-free",
        );
    }
    if (
      plan.tasks.some(
        (task) =>
          !config.categoryStateVersions.some(
            (item) =>
              item.category === task.category &&
              item.stateFormatVersion === task.stateFormatVersion,
          ),
      )
    )
      throw new Error(
        "Frozen configuration lacks a task category/state version",
      );
  }
  return freezeJson({
    plan,
    registry,
    planSha256: hashJson(plan),
    registrySha256,
  });
}

// A spending authorization is an unsigned local commitment. The separately
// selected digest is checked by the ledger at registration; the schema alone
// does not establish that a human approved the spend.
export const spendingAuthorizationSchema = z
  .object({
    version,
    kind: z.literal("sealed-spending-authorization"),
    authorizationId: id,
    sessionId: id,
    projectId: id,
    createdAt: timestamp,
    notBefore: timestamp,
    expiresAt: timestamp,
    approvalEvidenceSha256: digestSchema,
    totalCapUsd: amount.positive().max(1_000_000_000),
    collections: z
      .array(z.object({ collectionId: id, planSha256: digestSchema }).strict())
      .min(1)
      .max(1000),
    providers: z
      .array(
        z
          .object({
            providerId: id,
            kind: z.enum(["openai", "anthropic", "jev"]),
            endpointOrigin: z.string().url().max(2048),
            requestedModel: label,
            modelIdentitySha256: digestSchema,
            pricingSha256: digestSchema,
            providerSha256: digestSchema,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      Date.parse(value.createdAt) > Date.parse(value.notBefore) ||
      Date.parse(value.notBefore) >= Date.parse(value.expiresAt)
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid authorization time window",
      });
    if (
      new Set(value.collections.map((item) => item.collectionId)).size !==
      value.collections.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Duplicate authorized collection",
      });
    if (
      new Set(value.providers.map((item) => item.providerSha256)).size !==
      value.providers.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Duplicate authorized provider",
      });
  });

export const usageSchema = z
  .object({
    inputTokens: count.nullable(),
    outputTokens: count.nullable(),
    costUsd: amount.nullable(),
    reportedCostUsd: amount.nullable(),
    chargedCostUsd: amount.nullable(),
    basis: z.enum([
      "provider-reported",
      "reviewed-rate-card",
      "local-no-api-charge",
      "aggregate",
      "unknown",
    ]),
    pricingSha256: digestSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.basis === "unknown" && value.costUsd !== null)
      ctx.addIssue({
        code: "custom",
        message: "Unknown cost cannot become measured savings",
      });
    if (
      value.basis === "provider-reported" &&
      (value.costUsd === null || value.reportedCostUsd !== value.costUsd)
    )
      ctx.addIssue({
        code: "custom",
        message: "Provider-reported cost must retain the original amount",
      });
    if (
      value.basis === "reviewed-rate-card" &&
      (value.costUsd === null || value.pricingSha256 === null)
    )
      ctx.addIssue({
        code: "custom",
        message: "Rate-card derivation requires its price identity",
      });
    if (value.basis === "local-no-api-charge" && value.costUsd !== 0)
      ctx.addIssue({
        code: "custom",
        message: "Local no-API-charge usage must report zero API cost",
      });
  });
export const observationSchema = z
  .object({
    recordId: id,
    caseId: id,
    category: id,
    providerId: id,
    model: label,
    stateFormatVersion: id,
    stateHash: digestSchema,
    candidates: z.array(label).min(1).max(1000),
    selected: label.nullable(),
    confidence: z.number().finite().min(0).max(1).nullable(),
    observedAt: timestamp,
    callId: id,
  })
  .strict();
export const reservationSchema = z
  .object({
    version,
    kind: z.literal("sealed-attempt-reservation"),
    reservationId: id,
    collectionId: id,
    assignmentId: id,
    taskId: id,
    stableTaskId: id,
    stableFamilyId: id,
    exposureDomain: id,
    arm,
    ordinal: count,
    attemptOrdinal: z.literal(1),
    planSha256: digestSchema,
    configurationSha256: digestSchema,
    taskSha256: digestSchema,
    reservedAt: timestamp,
  })
  .strict();
export const publicDispatchClaimSchema = z
  .object({
    version,
    kind: z.literal("sealed-public-dispatch-claim"),
    reservationId: id,
    reservationSha256: digestSchema,
    collectionId: id,
    assignmentId: id,
    taskId: id,
    taskSha256: digestSchema,
    planSha256: digestSchema,
    publicPacketSha256: digestSchema,
    publicPacketBytes: z.number().int().min(1).max(LIMITS.bytes),
    claimedAt: timestamp,
  })
  .strict();
export const legacyOracleInvocationClaimSchema = z
  .object({
    version,
    kind: z.literal("sealed-oracle-invocation-claim"),
    reservationId: id,
    reservationSha256: digestSchema,
    collectionId: id,
    assignmentId: id,
    taskId: id,
    taskSha256: digestSchema,
    planSha256: digestSchema,
    publicDispatchSha256: digestSchema,
    oracleSha256: digestSchema,
    proposalSha256: digestSchema,
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    claimedAt: timestamp,
  })
  .strict();
export const callBoundOracleInvocationClaimSchema = z
  .object({
    version,
    kind: z.literal("sealed-call-bound-oracle-invocation-claim"),
    reservationId: id,
    reservationSha256: digestSchema,
    collectionId: id,
    assignmentId: id,
    taskId: id,
    taskSha256: digestSchema,
    planSha256: digestSchema,
    publicDispatchSha256: digestSchema,
    oracleSha256: digestSchema,
    callId: id,
    callReservationSha256: digestSchema,
    callReceiptSha256: digestSchema,
    responseSha256: digestSchema,
    proposalDerivation: z.literal("openai-chat-content-utf8-v1"),
    proposalSha256: digestSchema,
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    claimedAt: timestamp,
  })
  .strict();
export const callBoundEngineeringInvocationClaimSchema = z
  .object({
    version,
    kind: z.literal("sealed-call-bound-engineering-invocation-claim"),
    reservationId: id,
    reservationSha256: digestSchema,
    collectionId: id,
    assignmentId: id,
    taskId: id,
    taskSha256: digestSchema,
    planSha256: digestSchema,
    publicDispatchSha256: digestSchema,
    baselineSha256: digestSchema,
    oracleSha256: digestSchema,
    callId: id,
    callReservationSha256: digestSchema,
    callReceiptSha256: digestSchema,
    responseSha256: digestSchema,
    proposalDerivation: z.literal("openai-chat-content-utf8-v1"),
    proposalSha256: digestSchema,
    resultSourceSha256: digestSchema,
    verifierKind: z.literal("sealed-json-function-v1"),
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    claimedAt: timestamp,
  })
  .strict();
export const oracleInvocationClaimSchema = z.discriminatedUnion("kind", [
  legacyOracleInvocationClaimSchema,
  callBoundOracleInvocationClaimSchema,
  callBoundEngineeringInvocationClaimSchema,
]);
export const oracleVerdictRecordSchema = z
  .object({
    version,
    kind: z.literal("sealed-private-oracle-verdict-reference"),
    reservationId: id,
    claimSha256: digestSchema,
    verificationSha256: digestSchema,
    verificationBytes: z.number().int().min(1).max(4096),
    recordedAt: timestamp,
  })
  .strict();
export const callReservationSchema = z
  .object({
    version,
    kind: z.literal("sealed-call-reservation"),
    callId: id,
    reservationId: id,
    ordinal: count,
    providerId: id,
    requestedModel: label,
    requestSha256: digestSchema,
    reservedCostUsd: amount.nullable(),
    reservedAt: timestamp,
    authorizationId: id.optional(),
    authorizationSha256: digestSchema.optional(),
    sessionId: id.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const references = [
      value.authorizationId,
      value.authorizationSha256,
      value.sessionId,
    ];
    if (
      references.some((item) => item !== undefined) &&
      references.some((item) => item === undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "Incomplete spending authorization binding",
      });
  });
export const callReceiptSchema = z
  .object({
    version,
    kind: z.literal("sealed-call-receipt"),
    callId: id,
    reservationSha256: digestSchema,
    status: z.enum(["completed", "provider-error", "timeout", "ambiguous"]),
    responseSha256: digestSchema.nullable(),
    reportedModel: label.nullable(),
    usage: usageSchema,
    finishedAt: timestamp,
  })
  .strict();
export const attemptReceiptSchema = z
  .object({
    version,
    kind: z.literal("sealed-attempt-receipt"),
    reservationId: id,
    reservationSha256: digestSchema,
    status: z.enum([
      "completed",
      "candidate-rejected",
      "provider-error",
      "policy-blocked",
      "timeout",
      "collector-crashed",
      "infrastructure-error",
    ]),
    finishedAt: timestamp,
    publicRequestSha256: digestSchema.nullable(),
    proposalSha256: digestSchema.nullable(),
    resultSourceSha256: digestSchema.nullable(),
    observations: z.array(observationSchema).max(1000),
    callReceiptSha256s: z.array(digestSchema).max(100),
    outcome: z
      .object({
        success: z.boolean().nullable(),
        policyViolation: z.boolean(),
        verificationSha256: digestSchema.nullable(),
        runtimeSha256: digestSchema.nullable(),
      })
      .strict(),
    usage: usageSchema,
    limitations: z.array(label).min(1).max(20),
  })
  .strict();
export const eventSchema = z
  .object({
    version,
    kind: z.literal("sealed-ledger-event"),
    collectionId: id,
    sequence: count.positive(),
    type: z.enum([
      "registered",
      "attempt-reserved",
      "public-dispatch-claimed",
      "oracle-invocation-claimed",
      "call-bound-oracle-invocation-claimed",
      "call-bound-engineering-invocation-claimed",
      "oracle-verdict-retained",
      "call-reserved",
      "call-settled",
      "attempt-settled",
      "closed",
    ]),
    createdAt: timestamp,
    previousSha256: digestSchema.nullable(),
    payloadSha256: digestSchema,
  })
  .strict();
export const closureSchema = z
  .object({
    version,
    kind: z.literal("sealed-collection-closure"),
    collectionId: id,
    planSha256: digestSchema,
    closedAt: timestamp,
    complete: z.boolean(),
    promotionEligible: z.literal(false),
    inventory: z
      .array(
        z
          .object({
            assignmentId: id,
            taskId: id,
            arm,
            ordinal: count,
            status: z.enum(["not-attempted", "terminal"]),
            reservationSha256: digestSchema.nullable(),
            receiptSha256: digestSchema.nullable(),
            callReservationSha256s: z.array(digestSchema).max(100),
            callReceiptSha256s: z.array(digestSchema).max(100),
          })
          .strict(),
      )
      .min(2)
      .max(2000),
    eventHeadSha256: digestSchema,
    limitations: z.array(label).min(1).max(20),
  })
  .strict();
