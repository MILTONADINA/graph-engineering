// Private, post-closure analysis only. A caller-pinned signature binds a claim
// to frozen ledger records and original verdict bytes; it does not attest the
// oracle runtime, image, host, signer governance, or independent key control.
import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import {
  validateFullCohortLedger,
  type CohortAssignment,
  type CohortInspection,
} from "./full-cohort-ledger.js";
import {
  originalByteManifestSchema,
  originalReferences,
  readAndCheckOriginal,
} from "./sealed-aggregate-provenance.js";
import {
  canonicalJson,
  decodeJson,
  digestSchema,
  freezeJson,
  hashJson,
} from "./sealed-collection-schema.js";

export const SIGNED_ORACLE_EXECUTION_DOMAIN =
  "graph-engineering/sealed-oracle-execution/v1\n";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const timestamp = z.string().datetime();
const pinSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("sealed-oracle-executor-key-pin"),
    projectId: id,
    collectionId: id,
    oracleExecutorId: id,
    keyId: id,
    publicKeyPem: z.string().min(32).max(1_000),
    publicKeySha256: digestSchema,
  })
  .strict();
const payloadSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("sealed-oracle-execution"),
    projectId: id,
    collectionId: id,
    planSha256: digestSchema,
    assignmentId: id,
    reservationId: id,
    taskSha256: digestSchema,
    publicDispatchSha256: digestSchema,
    oracleInvocationSha256: digestSchema,
    oracleVerdictSha256: digestSchema,
    oracleSha256: digestSchema,
    proposalSha256: digestSchema,
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    verificationSha256: digestSchema,
    verificationBytes: z.number().int().min(1).max(8192),
    executedAt: timestamp,
  })
  .strict();
const envelopeSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("signed-sealed-oracle-execution"),
    oracleExecutorId: id,
    keyId: id,
    payload: payloadSchema,
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();
const executionsSchema = z
  .array(
    z
      .object({ assignmentId: id, pin: z.unknown(), envelope: z.unknown() })
      .strict(),
  )
  .max(2_000);

function boundedJson(input: unknown, name: string): unknown {
  if (typeof input === "string" && Buffer.byteLength(input) > 16_384)
    throw new Error(`Oracle execution ${name} exceeds byte limit`);
  const value = decodeJson(input);
  if (Buffer.byteLength(canonicalJson(value)) > 16_384)
    throw new Error(`Oracle execution ${name} exceeds byte limit`);
  return value;
}

function verificationTime(options: Readonly<{ nowMs?: number }>): number {
  const parsed = z
    .object({ nowMs: z.number().optional() })
    .strict()
    .parse(decodeJson(options));
  const nowMs = parsed.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > 8_640_000_000_000_000)
    throw new Error("Oracle execution verification time is invalid");
  return nowMs;
}

function inspectSignedClaim(
  inspection: CohortInspection,
  item: CohortAssignment,
  pinInput: unknown,
  envelopeInput: unknown,
  nowMs: number,
) {
  const pin = pinSchema.parse(boundedJson(pinInput, "key pin"));
  const envelope = envelopeSchema.parse(boundedJson(envelopeInput, "envelope"));
  const claim = envelope.payload;
  const invocation = item.oracleInvocation;
  const verdict = item.oracleVerdict;
  const reservation = item.reservation;
  const dispatch = item.publicDispatch;
  const task = inspection.plan.tasks.find(
    (entry) => entry.taskId === item.assignment.taskId,
  );
  if (
    pin.projectId !== inspection.plan.projectId ||
    pin.collectionId !== inspection.plan.collectionId ||
    pin.oracleExecutorId !== envelope.oracleExecutorId ||
    pin.keyId !== envelope.keyId ||
    claim.projectId !== pin.projectId ||
    claim.collectionId !== pin.collectionId
  )
    throw new Error("Oracle execution key or collection identity differs");
  if (
    !invocation ||
    !verdict ||
    !reservation ||
    !dispatch ||
    !task ||
    claim.planSha256 !== inspection.planSha256 ||
    claim.assignmentId !== item.assignment.assignmentId ||
    claim.reservationId !== reservation.reservationId ||
    claim.taskSha256 !== hashJson(task) ||
    claim.publicDispatchSha256 !== hashJson(dispatch) ||
    claim.oracleInvocationSha256 !== hashJson(invocation) ||
    claim.oracleVerdictSha256 !== hashJson(verdict) ||
    claim.oracleSha256 !== invocation.oracleSha256 ||
    claim.proposalSha256 !== invocation.proposalSha256 ||
    claim.imageId !== invocation.imageId ||
    claim.verificationSha256 !== verdict.verificationSha256 ||
    claim.verificationBytes !== verdict.verificationBytes ||
    Date.parse(claim.executedAt) < Date.parse(invocation.claimedAt) ||
    Date.parse(claim.executedAt) > Date.parse(verdict.recordedAt) ||
    Date.parse(claim.executedAt) > nowMs + 60_000
  )
    throw new Error("Oracle execution differs from frozen invocation/verdict");
  if (!pin.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----"))
    throw new Error("Oracle execution requires a public key pin");
  const key = createPublicKey(pin.publicKeyPem);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    key.export({ type: "spki", format: "pem" }).toString() !== pin.publicKeyPem
  )
    throw new Error("Oracle execution requires canonical Ed25519 PEM");
  const fingerprint = createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
  if (fingerprint !== pin.publicKeySha256)
    throw new Error("Oracle execution key fingerprint differs from pin");
  const { signature, ...unsigned } = envelope;
  const signatureBytes = Buffer.from(signature, "base64");
  if (
    signatureBytes.toString("base64") !== signature ||
    !verify(
      null,
      Buffer.from(SIGNED_ORACLE_EXECUTION_DOMAIN + canonicalJson(unsigned)),
      key,
      signatureBytes,
    )
  )
    throw new Error("Oracle execution signature differs");
  return {
    assignmentId: claim.assignmentId,
    keyPinSha256: hashJson(pin),
    oracleClaimSha256: hashJson(claim),
    oracleInvocationSha256: claim.oracleInvocationSha256,
    oracleVerdictSha256: claim.oracleVerdictSha256,
    verificationSha256: claim.verificationSha256,
    verificationBytes: claim.verificationBytes,
  };
}

/**
 * Verify exactly one caller-pinned signature and original verdict for every
 * private oracle verdict in a complete closed collection. The result remains
 * private analysis metadata, never a source of promotion authority.
 */
export async function inspectSignedSealedOracleExecutionCohort(
  inspectionInput: unknown,
  pinsInput: unknown,
  manifestInput: unknown,
  expectedManifestSha256: unknown,
  reader: (reference: {
    role: string;
    sha256: string;
    bytes: number;
  }) => Promise<Uint8Array>,
  executionsInput: unknown,
  options: Readonly<{ nowMs?: number }> = {},
) {
  const nowMs = verificationTime(options);
  const inspection = validateFullCohortLedger(inspectionInput, pinsInput);
  if (!inspection.closure?.complete)
    throw new Error("Oracle execution needs a complete closed collection");
  const manifest = originalByteManifestSchema.parse(decodeJson(manifestInput));
  const manifestSha256 = digestSchema.parse(expectedManifestSha256);
  if (
    typeof reader !== "function" ||
    hashJson(manifest) !== manifestSha256 ||
    manifest.collectionId !== inspection.plan.collectionId ||
    manifest.planSha256 !== inspection.planSha256
  )
    throw new Error("Oracle execution needs its pinned original manifest");
  const expectedRoles = [...originalReferences(inspection)].sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  );
  if (manifest.entries.length !== expectedRoles.length)
    throw new Error("Oracle execution original role inventory is incomplete");
  for (let index = 0; index < expectedRoles.length; index++) {
    const [role, sha256] = expectedRoles[index]!;
    const entry = manifest.entries[index]!;
    if (entry.role !== role || entry.sha256 !== sha256)
      throw new Error("Oracle execution original role or digest differs");
  }
  const expected = new Map<string, CohortAssignment>();
  for (const item of inspection.assignments)
    if (item.oracleVerdict) {
      const assignmentId = item.assignment.assignmentId;
      if (expected.has(assignmentId))
        throw new Error("Oracle execution repeats a frozen assignment ID");
      expected.set(assignmentId, item);
    }
  if (!expected.size)
    throw new Error("Oracle execution has no private verdicts to inspect");
  const executions = executionsSchema.parse(decodeJson(executionsInput));
  const seen = new Set<string>();
  for (const execution of executions) {
    if (!expected.has(execution.assignmentId))
      throw new Error("Oracle execution contains an unknown assignment");
    if (seen.has(execution.assignmentId))
      throw new Error("Oracle execution contains a repeated assignment");
    seen.add(execution.assignmentId);
  }
  if (seen.size !== expected.size)
    throw new Error("Oracle execution cohort coverage is incomplete");
  const references = new Map(
    manifest.entries.map((entry) => [entry.role, entry] as const),
  );
  if (references.size !== manifest.entries.length)
    throw new Error("Oracle execution repeats an original artifact role");
  const checkedClaims = executions.map((execution) => {
    const item = expected.get(execution.assignmentId)!;
    const verdict = item.oracleVerdict!;
    const checked = inspectSignedClaim(
      inspection,
      item,
      execution.pin,
      execution.envelope,
      nowMs,
    );
    const roles = expectedRoles.filter(
      ([role, digest]) =>
        role.startsWith("oracle/") &&
        role.endsWith(`/${execution.assignmentId}/private-verdict`) &&
        digest === verdict.verificationSha256,
    );
    if (roles.length !== 1)
      throw new Error("Oracle execution private verdict role is ambiguous");
    const reference = references.get(roles[0]![0]);
    if (
      !reference ||
      reference.sha256 !== checked.verificationSha256 ||
      reference.bytes !== checked.verificationBytes
    )
      throw new Error("Oracle execution private verdict reference differs");
    return { checked, reference };
  });
  const inventory: ReturnType<typeof inspectSignedClaim>[] = [];
  for (const { checked, reference } of checkedClaims) {
    let bytes: Buffer | undefined;
    try {
      bytes = await readAndCheckOriginal(reference, reader);
      if (
        bytes.length !== checked.verificationBytes ||
        createHash("sha256").update(bytes).digest("hex") !==
          checked.verificationSha256
      )
        throw new Error("Oracle execution original verdict bytes differ");
      inventory.push(checked);
    } finally {
      bytes?.fill(0);
    }
  }
  inventory.sort((left, right) =>
    left.assignmentId < right.assignmentId
      ? -1
      : left.assignmentId > right.assignmentId
        ? 1
        : 0,
  );
  return freezeJson({
    kind: "sealed-oracle-execution-cohort-signatures-only" as const,
    projectId: inspection.plan.projectId,
    collectionId: inspection.plan.collectionId,
    planSha256: inspection.planSha256,
    originalByteManifestSha256: manifestSha256,
    verifiedOracleVerdictCount: inventory.length,
    oracleExecutionInventorySha256: hashJson(inventory),
    allPrivateOracleVerdictsCovered: true as const,
    signaturesVerifiedAgainstCallerPins: true as const,
    originalVerdictBytesChecked: true as const,
    independentKeyControlVerified: false as const,
    oracleExecutionAuthenticated: false as const,
    oracleRuntimeAttested: false as const,
    imageProvenanceAuthenticated: false as const,
    artifactSourceAuthenticated: false as const,
    promotionEligible: false as const,
  });
}
