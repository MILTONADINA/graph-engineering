// A deliberately narrow, in-process bridge from a frozen public task to its
// original artifact bytes. It does not issue grants, run workers, or settle the
// ledger. Only a trusted caller may supply the source export policy and send.
// Handles are deliberately not durable: restart requires re-retention from
// currently exportable source. An interrupted artifact publication may leave
// unreferenced bytes, never a usable handle. A durable claim prevents a second
// callback attempt; it cannot prove delivery or make delivery atomic with
// settlement. No sandbox or promotion authority is supplied here.
import { types } from "node:util";
import { tsImport } from "tsx/esm/api";
import { ArtifactStore } from "./artifacts.mjs";
import { cloneJson, hashJson } from "./schema.mjs";
import { SealedStore } from "./store.mjs";

const { buildSealedPublicPacket, assertPublicPacketCommitment } =
  await tsImport(
    "../../packages/engine/src/sealed-public-packet.ts",
    import.meta.url,
  );
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA = /^[a-f0-9]{64}$/;

function fields(input, expected, label) {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error(`${label} must be a plain data object`);
  const names = Reflect.ownKeys(input);
  if (
    names.length !== expected.length ||
    names.some((name) => !expected.includes(name))
  )
    throw new Error(`${label} has unexpected fields`);
  const result = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
      throw new Error(`${label} refuses accessors and hidden fields`);
    result[name] = descriptor.value;
  }
  return result;
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value))
    throw new Error(`Invalid ${label}`);
  return value;
}

function rejectKnownOracleLeak(packet, privateBytes, oracleSha256) {
  const exposed = [];
  const collect = (value) => {
    if (typeof value === "string") exposed.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object")
      Object.values(value).forEach(collect);
  };
  collect(packet);
  const markers = new Set([oracleSha256]);
  if (privateBytes.length >= 16 && privateBytes.length <= 100_000) {
    markers.add(privateBytes.toString("hex"));
    markers.add(privateBytes.toString("base64"));
    markers.add(privateBytes.toString("base64url"));
  }
  let oracleText;
  try {
    oracleText = new TextDecoder("utf-8", { fatal: true }).decode(privateBytes);
  } catch {
    // A binary oracle still has its digest and common encodings screened.
  }
  if (oracleText !== undefined) {
    const text = oracleText;
    if (text) markers.add(text);
    for (const match of text.matchAll(/\b[a-f0-9]{64}\b/gi)) {
      if (markers.size > 128)
        throw new Error("Private oracle has too many digest markers to screen");
      const digest = match[0];
      markers.add(digest);
      markers.add(digest.toUpperCase());
      markers.add(Buffer.from(digest).toString("base64"));
      markers.add(Buffer.from(digest).toString("base64url"));
      markers.add(Buffer.from(digest).toString("hex"));
    }
  }
  for (const value of exposed)
    for (const marker of markers)
      if (marker && value.includes(marker))
        throw new Error("Public packet contains private oracle material");
}

export class SealedPublicPacketBridge {
  #store;
  #artifacts;
  #handles = new WeakMap();

  constructor(options) {
    const { store, artifacts } = fields(
      options,
      ["store", "artifacts"],
      "Public packet bridge options",
    );
    if (
      !(store instanceof SealedStore) ||
      !(artifacts instanceof ArtifactStore)
    )
      throw new Error("Public packet bridge needs trusted sealed stores");
    this.#store = store;
    this.#artifacts = artifacts;
  }

  #openTask(collectionId, taskId) {
    const inspection = this.#store.inspectCollection(collectionId);
    if (inspection.closure)
      throw new Error("Cannot use a closed collection for public dispatch");
    if (Date.now() >= Date.parse(inspection.plan.expiresAt))
      throw new Error("Public task collection has expired");
    const task = inspection.plan.tasks.find((item) => item.taskId === taskId);
    if (!task) throw new Error("Unknown frozen public task");
    return { inspection, task };
  }

  /** Retain only fresh, explicitly exported source/docs matching the plan. */
  async retain(input) {
    const { collectionId, taskId, packetInput, oracleReference } = fields(
      input,
      ["collectionId", "taskId", "packetInput", "oracleReference"],
      "Public packet retention",
    );
    identifier(collectionId, "collection ID");
    identifier(taskId, "task ID");
    const request = cloneJson(
      fields(
        packetInput,
        [
          "root",
          "policy",
          "taskId",
          "repositoryId",
          "baselineSha256",
          "objective",
          "acceptance",
          "selected",
        ],
        "Public packet input",
      ),
    );
    // The builder validates its complete request and reads every selected file
    // through the project export policy. No artifact is written on a mismatch.
    const before = this.#openTask(collectionId, taskId);
    const prepared = await buildSealedPublicPacket(request);
    // Reject all uncommitted candidate packets before reading private bytes:
    // otherwise the error becomes a chosen-string oracle for their contents.
    assertPublicPacketCommitment(prepared, before.task);
    const oracle = fields(
      oracleReference,
      ["sha256", "bytes"],
      "Private oracle reference",
    );
    if (
      typeof oracle.sha256 !== "string" ||
      !SHA.test(oracle.sha256) ||
      oracle.sha256 !== before.task.oracleSha256 ||
      !Number.isSafeInteger(oracle.bytes) ||
      oracle.bytes < 1 ||
      oracle.bytes > 2_000_000
    )
      throw new Error("Private oracle reference differs from frozen task");
    const returnedBytes = await this.#artifacts.get(oracle);
    const oracleBytes = Buffer.from(returnedBytes);
    try {
      rejectKnownOracleLeak(
        prepared.packet,
        oracleBytes,
        before.task.oracleSha256,
      );
    } finally {
      oracleBytes.fill(0);
      returnedBytes.fill(0);
    }
    const artifact = await this.#artifacts.put(prepared.bytes);
    if (artifact.sha256 !== before.task.publicPacketSha256)
      throw new Error("Retained public bytes differ from frozen commitment");
    const after = this.#openTask(collectionId, taskId);
    if (
      after.inspection.planSha256 !== before.inspection.planSha256 ||
      after.task.publicPacketSha256 !== artifact.sha256
    )
      throw new Error("Frozen public task changed during retention");
    const handle = Object.freeze({
      collectionId,
      taskId,
      planSha256: after.inspection.planSha256,
      artifact,
    });
    this.#handles.set(handle, handle);
    return handle;
  }

  #activeAttempt(handle, reservationId) {
    const { inspection, task } = this.#openTask(
      handle.collectionId,
      handle.taskId,
    );
    if (
      inspection.planSha256 !== handle.planSha256 ||
      task.publicPacketSha256 !== handle.artifact.sha256
    )
      throw new Error("Public packet handle differs from frozen task");
    const assignment = inspection.assignments.find(
      (item) => item.reservation?.reservationId === reservationId,
    );
    if (
      !assignment ||
      assignment.receipt ||
      assignment.assignment.taskId !== handle.taskId
    )
      throw new Error("Public dispatch requires an active task reservation");
    const reservation = assignment.reservation;
    if (
      reservation.collectionId !== handle.collectionId ||
      reservation.taskSha256 !== hashJson(task) ||
      reservation.planSha256 !== inspection.planSha256
    )
      throw new Error("Public dispatch reservation identity mismatch");
    const now = Date.now();
    const reservedAt = Date.parse(reservation.reservedAt);
    const maxDurationMs =
      inspection.plan.configurations[reservation.arm].maxDurationMs;
    if (
      now < reservedAt ||
      now >= Date.parse(inspection.plan.expiresAt) ||
      now - reservedAt >= maxDurationMs
    )
      throw new Error("Public dispatch attempt deadline has expired");
    return reservation;
  }

  /** Attempt a trusted callback at most once after a durable claim; delivery is not proven. */
  async dispatch(input) {
    const { handle, reservationId, send } = fields(
      input,
      ["handle", "reservationId", "send"],
      "Public packet dispatch",
    );
    identifier(reservationId, "reservation ID");
    if (
      !handle ||
      typeof handle !== "object" ||
      this.#handles.get(handle) !== handle
    )
      throw new Error("Public packet handle was not retained by this bridge");
    if (typeof send !== "function")
      throw new Error("Public packet dispatch needs a trusted callback");
    this.#activeAttempt(handle, reservationId);
    const bytes = await this.#artifacts.get(handle.artifact);
    // Re-read after the awaited artifact read, then commit an irreversible
    // claim before invoking any callback. A crash can leave zero delivery.
    this.#activeAttempt(handle, reservationId);
    const claim = this.#store.claimPublicDispatch(
      reservationId,
      handle.artifact,
    );
    // Recovery can race after the claim. This check catches recovery that has
    // already finished; a trusted supervisor must stop/isolate the transport
    // before abandoning an in-flight attempt.
    this.#activeAttempt(handle, reservationId);
    const metadata = Object.freeze({
      collectionId: handle.collectionId,
      taskId: handle.taskId,
      reservationId,
      claimSha256: hashJson(claim),
      publicPacketSha256: handle.artifact.sha256,
      bytes: handle.artifact.bytes,
    });
    await send(new Uint8Array(bytes), metadata);
    return metadata;
  }
}
