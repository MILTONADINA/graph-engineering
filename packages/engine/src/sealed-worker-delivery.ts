// Private, post-closure analysis only. A pinned signature authenticates what
// that key claimed about one call; it does not attest the worker executable,
// model loading, network peer, source origin, or independent key control.
import { createHash, createPublicKey, verify } from "node:crypto";
import { types } from "node:util";
import { z } from "zod";
import {
  validateFullCohortLedger,
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

export const SIGNED_WORKER_DELIVERY_DOMAIN =
  "graph-engineering/sealed-worker-delivery/v1\n";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const model = z.string().min(1).max(200);
const bytes = z.number().int().positive().max(2_000_000);
const timestamp = z.string().datetime();
const pinSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("sealed-worker-key-pin"),
    projectId: id,
    collectionId: id,
    workerId: id,
    keyId: id,
    publicKeyPem: z.string().min(32).max(1_000),
    publicKeySha256: digestSchema,
  })
  .strict();
const payloadSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("sealed-worker-delivery"),
    projectId: id,
    collectionId: id,
    planSha256: digestSchema,
    assignmentId: id,
    reservationId: id,
    publicDispatchSha256: digestSchema,
    callId: id,
    callReservationSha256: digestSchema,
    callReceiptSha256: digestSchema,
    providerId: id,
    providerSha256: digestSchema,
    requestedModel: model,
    reportedModel: model,
    requestSha256: digestSchema,
    requestBytes: bytes,
    responseSha256: digestSchema,
    responseBytes: bytes,
    deliveredAt: timestamp,
  })
  .strict();
const envelopeSchema = z
  .object({
    version: z.literal("1.0.0"),
    kind: z.literal("signed-sealed-worker-delivery"),
    workerId: id,
    keyId: id,
    payload: payloadSchema,
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();
const cohortEnvelopeSchema = envelopeSchema.extend({
  payload: payloadSchema.extend({
    publicDispatchSha256: digestSchema.nullable(),
  }),
});
const cohortDeliverySchema = z
  .array(
    z.object({ callId: id, pin: z.unknown(), envelope: z.unknown() }).strict(),
  )
  .max(10_000);
type SelectedCall = {
  item: CohortInspection["assignments"][number];
  call: CohortInspection["assignments"][number]["calls"][number];
};

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthOf = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;
const byteOffsetOf = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset",
)!.get!;
const bufferOf = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
)!.get!;

function copyOriginal(input: unknown, name: string): Buffer {
  if (
    types.isProxy(input) ||
    !types.isUint8Array(input) ||
    ![Uint8Array.prototype, Buffer.prototype].includes(
      Object.getPrototypeOf(input),
    )
  )
    throw new Error(`Worker delivery needs ordinary original ${name} bytes`);
  const length = byteLengthOf.call(input) as number;
  if (length < 1 || length > 2_000_000)
    throw new Error(`Worker delivery original ${name} byte limit`);
  const buffer = bufferOf.call(input) as ArrayBufferLike;
  if (types.isSharedArrayBuffer(buffer))
    throw new Error(`Worker delivery refuses shared original ${name} bytes`);
  return Buffer.from(
    new Uint8Array(buffer, byteOffsetOf.call(input) as number, length),
  );
}

function boundedJson(input: unknown, name: string): unknown {
  if (typeof input === "string" && Buffer.byteLength(input) > 16_384)
    throw new Error(`Worker delivery ${name} exceeds byte limit`);
  const value = decodeJson(input);
  if (Buffer.byteLength(canonicalJson(value)) > 16_384)
    throw new Error(`Worker delivery ${name} exceeds byte limit`);
  return value;
}

function originalFields(input: unknown): {
  requestBytes: unknown;
  responseBytes: unknown;
} {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== 2
  )
    throw new Error("Worker delivery needs exact original-byte fields");
  const fields = Object.getOwnPropertyDescriptors(input);
  for (const name of ["requestBytes", "responseBytes"] as const) {
    const descriptor = fields[name];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      throw new Error("Worker delivery refuses original-byte accessors");
  }
  return {
    requestBytes: fields.requestBytes!.value,
    responseBytes: fields.responseBytes!.value,
  };
}

function verificationTime(options: Readonly<{ nowMs?: number }>): number {
  const parsedOptions = z
    .object({ nowMs: z.number().optional() })
    .strict()
    .parse(decodeJson(options));
  const nowMs = parsedOptions.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > 8_640_000_000_000_000)
    throw new Error("Worker delivery verification time is invalid");
  return nowMs;
}

function inspectValidatedSignedWorkerDelivery(
  inspection: CohortInspection,
  pinInput: unknown,
  envelopeInput: unknown,
  originals: Readonly<{ requestBytes: Uint8Array; responseBytes: Uint8Array }>,
  nowMs: number,
  selected?: SelectedCall,
  permitUndispatchedCall = false,
) {
  const pin = pinSchema.parse(boundedJson(pinInput, "key pin"));
  const signed = (
    permitUndispatchedCall ? cohortEnvelopeSchema : envelopeSchema
  ).parse(boundedJson(envelopeInput, "envelope"));
  const claim = signed.payload;
  const item = selected
    ? selected.item.assignment.assignmentId === claim.assignmentId
      ? selected.item
      : undefined
    : inspection.assignments.find(
        (entry) => entry.assignment.assignmentId === claim.assignmentId,
      );
  const call = selected
    ? selected.call.reservation.callId === claim.callId
      ? selected.call
      : undefined
    : item?.calls.find((entry) => entry.reservation.callId === claim.callId);
  const provider = item
    ? inspection.plan.configurations[item.assignment.arm].providers.find(
        (entry) => entry.providerId === call?.reservation.providerId,
      )
    : undefined;
  if (
    pin.projectId !== inspection.plan.projectId ||
    pin.collectionId !== inspection.plan.collectionId ||
    pin.workerId !== signed.workerId ||
    pin.keyId !== signed.keyId ||
    claim.projectId !== pin.projectId ||
    claim.collectionId !== pin.collectionId
  )
    throw new Error("Worker delivery key or collection identity differs");
  if (
    !item?.reservation ||
    (!permitUndispatchedCall && !item.publicDispatch) ||
    !item.receipt ||
    !call?.receipt ||
    call.receipt.status !== "completed" ||
    !provider ||
    claim.planSha256 !== inspection.planSha256 ||
    claim.reservationId !== item.reservation.reservationId ||
    claim.publicDispatchSha256 !==
      (item.publicDispatch ? hashJson(item.publicDispatch) : null) ||
    claim.callReservationSha256 !== hashJson(call.reservation) ||
    claim.callReceiptSha256 !== hashJson(call.receipt) ||
    claim.providerId !== provider.providerId ||
    claim.providerSha256 !== hashJson(provider) ||
    claim.requestedModel !== call.reservation.requestedModel ||
    claim.reportedModel !== call.receipt.reportedModel ||
    claim.requestSha256 !== call.reservation.requestSha256 ||
    claim.responseSha256 !== call.receipt.responseSha256 ||
    Date.parse(claim.deliveredAt) < Date.parse(call.reservation.reservedAt) ||
    Date.parse(claim.deliveredAt) > Date.parse(call.receipt.finishedAt) ||
    Date.parse(claim.deliveredAt) > nowMs + 60_000
  )
    throw new Error("Worker delivery differs from the frozen call");
  if (!pin.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----"))
    throw new Error("Worker delivery requires a public key pin");
  const key = createPublicKey(pin.publicKeyPem);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    key.export({ type: "spki", format: "pem" }).toString() !== pin.publicKeyPem
  )
    throw new Error("Worker delivery requires canonical Ed25519 PEM");
  const fingerprint = createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
  if (fingerprint !== pin.publicKeySha256)
    throw new Error("Worker delivery key fingerprint differs from pin");
  const { signature, ...unsigned } = signed;
  const signatureBytes = Buffer.from(signature, "base64");
  if (
    signatureBytes.toString("base64") !== signature ||
    !verify(
      null,
      Buffer.from(SIGNED_WORKER_DELIVERY_DOMAIN + canonicalJson(unsigned)),
      key,
      signatureBytes,
    )
  )
    throw new Error("Worker delivery signature differs");
  const original = originalFields(originals);
  let request: Buffer | undefined;
  let response: Buffer | undefined;
  try {
    request = copyOriginal(original.requestBytes, "request");
    response = copyOriginal(original.responseBytes, "response");
    if (
      request.length !== claim.requestBytes ||
      createHash("sha256").update(request).digest("hex") !== claim.requestSha256
    )
      throw new Error("Worker delivery original request bytes differ");
    if (
      response.length !== claim.responseBytes ||
      createHash("sha256").update(response).digest("hex") !==
        claim.responseSha256
    )
      throw new Error("Worker delivery original response bytes differ");
  } finally {
    request?.fill(0);
    response?.fill(0);
  }
  return freezeJson({
    kind: "sealed-worker-delivery-signature-only" as const,
    projectId: claim.projectId,
    collectionId: claim.collectionId,
    assignmentId: claim.assignmentId,
    callId: claim.callId,
    workerId: pin.workerId,
    keyPinSha256: hashJson(pin),
    workerClaimSha256: hashJson(claim),
    requestSha256: claim.requestSha256,
    responseSha256: claim.responseSha256,
    signatureVerifiedAgainstPin: true as const,
    originalBytesChecked: true as const,
    independentKeyControlVerified: false as const,
    modelExecutionAuthenticated: false as const,
    workerRuntimeAttested: false as const,
    artifactSourceAuthenticated: false as const,
    promotionEligible: false as const,
  });
}

/**
 * Check one signed claim against a complete frozen ledger and the exact
 * original request/response bytes. The pin must come from a separately
 * approved source; this function cannot establish that source or mint routing
 * authority. The signed claim is not proof that the named model actually ran.
 */
export function inspectSignedSealedWorkerDelivery(
  inspectionInput: unknown,
  pinsInput: unknown,
  pinInput: unknown,
  envelopeInput: unknown,
  originals: Readonly<{ requestBytes: Uint8Array; responseBytes: Uint8Array }>,
  options: Readonly<{ nowMs?: number }> = {},
) {
  const nowMs = verificationTime(options);
  const inspection = validateFullCohortLedger(inspectionInput, pinsInput);
  if (!inspection.closure?.complete)
    throw new Error("Worker delivery needs a complete closed collection");
  return inspectValidatedSignedWorkerDelivery(
    inspection,
    pinInput,
    envelopeInput,
    originals,
    nowMs,
  );
}

/**
 * Require one signed, original-byte-checked claim for every completed call in a
 * closed collection. This covers caller-pinned signatures, not the worker,
 * loaded model, signer governance, source, oracle, or anti-rollback chronology.
 */
export async function inspectSignedSealedWorkerDeliveryCohort(
  inspectionInput: unknown,
  pinsInput: unknown,
  manifestInput: unknown,
  expectedManifestSha256: unknown,
  reader: (reference: {
    role: string;
    sha256: string;
    bytes: number;
  }) => Promise<Uint8Array>,
  deliveriesInput: unknown,
  options: Readonly<{ nowMs?: number }> = {},
) {
  const nowMs = verificationTime(options);
  const inspection = validateFullCohortLedger(inspectionInput, pinsInput);
  if (!inspection.closure?.complete)
    throw new Error(
      "Worker delivery cohort needs a complete closed collection",
    );
  const manifest = originalByteManifestSchema.parse(decodeJson(manifestInput));
  const manifestSha256 = digestSchema.parse(expectedManifestSha256);
  if (
    typeof reader !== "function" ||
    hashJson(manifest) !== manifestSha256 ||
    manifest.collectionId !== inspection.plan.collectionId ||
    manifest.planSha256 !== inspection.planSha256
  )
    throw new Error(
      "Worker delivery cohort needs its pinned original manifest",
    );
  const expectedRoles = [...originalReferences(inspection)].sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  );
  if (manifest.entries.length !== expectedRoles.length)
    throw new Error(
      "Worker delivery cohort original role inventory is incomplete",
    );
  for (let index = 0; index < expectedRoles.length; index++) {
    const [role, sha256] = expectedRoles[index]!;
    const entry = manifest.entries[index]!;
    if (entry.role !== role || entry.sha256 !== sha256)
      throw new Error("Worker delivery cohort original role or digest differs");
  }
  const deliveries = cohortDeliverySchema.parse(decodeJson(deliveriesInput));
  const expected = new Map<string, SelectedCall>();
  for (const item of inspection.assignments)
    for (const call of item.calls)
      if (call.receipt?.status === "completed") {
        if (expected.size >= 10_000)
          throw new Error("Worker delivery cohort exceeds its call bound");
        if (expected.has(call.reservation.callId))
          throw new Error("Worker delivery cohort repeats a frozen call ID");
        expected.set(call.reservation.callId, { item, call });
      }
  if (!expected.size || deliveries.length !== expected.size)
    throw new Error("Worker delivery cohort coverage is incomplete");
  const references = new Map(
    manifest.entries.map((entry) => [entry.role, entry] as const),
  );
  if (references.size !== manifest.entries.length)
    throw new Error("Worker delivery cohort repeats an original artifact role");
  const seen = new Set<string>();
  const inventory: {
    callId: string;
    keyPinSha256: string;
    workerClaimSha256: string;
    requestSha256: string;
    responseSha256: string;
  }[] = [];
  for (const delivery of deliveries) {
    const selected = expected.get(delivery.callId);
    if (!selected || seen.has(delivery.callId))
      throw new Error(
        "Worker delivery cohort contains an unknown or repeated call",
      );
    seen.add(delivery.callId);
    const requestRef = references.get(`call/${delivery.callId}/request`);
    const responseRef = references.get(`call/${delivery.callId}/response`);
    if (
      !requestRef ||
      !responseRef ||
      requestRef.sha256 !== selected.call.reservation.requestSha256 ||
      responseRef.sha256 !== selected.call.receipt?.responseSha256
    )
      throw new Error("Worker delivery cohort original references differ");
    let request: Buffer | undefined;
    let response: Buffer | undefined;
    try {
      request = await readAndCheckOriginal(requestRef, reader);
      response = await readAndCheckOriginal(responseRef, reader);
      const checked = inspectValidatedSignedWorkerDelivery(
        inspection,
        delivery.pin,
        delivery.envelope,
        { requestBytes: request, responseBytes: response },
        nowMs,
        selected,
        true,
      );
      inventory.push({
        callId: checked.callId,
        keyPinSha256: checked.keyPinSha256,
        workerClaimSha256: checked.workerClaimSha256,
        requestSha256: checked.requestSha256,
        responseSha256: checked.responseSha256,
      });
    } finally {
      request?.fill(0);
      response?.fill(0);
    }
  }
  inventory.sort((left, right) =>
    left.callId < right.callId ? -1 : left.callId > right.callId ? 1 : 0,
  );
  return freezeJson({
    kind: "sealed-worker-delivery-cohort-signatures-only" as const,
    projectId: inspection.plan.projectId,
    collectionId: inspection.plan.collectionId,
    planSha256: inspection.planSha256,
    originalByteManifestSha256: manifestSha256,
    verifiedWorkerDeliveryCount: inventory.length,
    completedCallsWithoutPublicDispatch: [...expected.values()].filter(
      ({ item }) => !item.publicDispatch,
    ).length,
    workerDeliveryInventorySha256: hashJson(inventory),
    allCompletedCallsCovered: true as const,
    signaturesVerifiedAgainstCallerPins: true as const,
    originalRequestResponseBytesChecked: true as const,
    publicDispatchProvenForEveryCall: false as const,
    publicPacketDeliveryAuthenticated: false as const,
    independentKeyControlVerified: false as const,
    modelExecutionAuthenticated: false as const,
    workerRuntimeAttested: false as const,
    artifactSourceAuthenticated: false as const,
    oracleExecutionAuthenticated: false as const,
    promotionEligible: false as const,
  });
}
