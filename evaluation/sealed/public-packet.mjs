// A deliberately narrow, in-process bridge from a frozen public task to its
// original artifact bytes. It does not issue grants, run workers, or settle the
// ledger. Only a trusted caller may supply the source export policy and send.
// Handles are deliberately not durable: restart requires re-retention from
// currently exportable source. An interrupted artifact publication may leave
// unreferenced bytes, never a usable handle. Dispatch is not one-time or atomic
// with settlement, and no sandbox or promotion authority is supplied here.
import { types } from "node:util";
import { tsImport } from "tsx/esm/api";
import { ArtifactStore } from "./artifacts.mjs";
import { hashJson } from "./schema.mjs";
import { SealedStore } from "./store.mjs";

const { buildSealedPublicPacket, assertPublicPacketCommitment } =
  await tsImport(
    "../../packages/engine/src/sealed-public-packet.ts",
    import.meta.url,
  );
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

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
    const { collectionId, taskId, packetInput } = fields(
      input,
      ["collectionId", "taskId", "packetInput"],
      "Public packet retention",
    );
    identifier(collectionId, "collection ID");
    identifier(taskId, "task ID");
    // The builder validates its complete request and reads every selected file
    // through the project export policy. No artifact is written on a mismatch.
    const before = this.#openTask(collectionId, taskId);
    const prepared = await buildSealedPublicPacket(packetInput);
    assertPublicPacketCommitment(prepared, before.task);
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

  /** Expose only detached committed bytes to a trusted callback, never a private artifact. */
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
    // Re-read ledger state after the awaited artifact read, immediately before
    // invoking the callback. There is no atomic lease or one-time grant here.
    this.#activeAttempt(handle, reservationId);
    const metadata = Object.freeze({
      collectionId: handle.collectionId,
      taskId: handle.taskId,
      reservationId,
      publicPacketSha256: handle.artifact.sha256,
      bytes: handle.artifact.bytes,
    });
    await send(new Uint8Array(bytes), metadata);
    return metadata;
  }
}
