// Durable collection bookkeeping only: no worker, signatures, oracle, or delivery proof.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import {
  decodeJson,
  canonicalJson,
  hashJson,
  freezeJson,
  validateCollectionPlan,
  spendingAuthorizationSchema,
  reservationSchema,
  publicDispatchClaimSchema,
  oracleInvocationClaimSchema,
  oracleVerdictRecordSchema,
  callReservationSchema,
  callReceiptSchema,
  attemptReceiptSchema,
  eventSchema,
  closureSchema,
} from "./schema.mjs";

const now = () => new Date().toISOString();
const unknownUsage = () => ({
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  reportedCostUsd: null,
  chargedCostUsd: null,
  basis: "unknown",
  pricingSha256: null,
});
const snapshot = (value) => freezeJson(decodeJson(canonicalJson(value)));
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const LIMITATIONS = [
  "Unsigned local bookkeeping; no protected collection, independent review or promotion authority.",
  "Spending approval evidence is an externally selected digest, not a verified human signature; provider bills can exceed reserved estimates.",
  "A malicious storage operator can roll back this database; a separately governed anti-rollback witness is not implemented.",
];
const paidKinds = new Set(["openai", "anthropic", "jev"]);
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const sha256 = /^[a-f0-9]{64}$/;
const MAX_PUBLIC_PACKET_BYTES = 2_000_000;
function providerSpendClass(provider) {
  const endpoint = new URL(provider.endpointOrigin);
  if (paidKinds.has(provider.kind)) return "paid";
  if (
    ["local", "laya"].includes(provider.kind) &&
    ["http:", "https:"].includes(endpoint.protocol) &&
    loopbackHosts.has(endpoint.hostname)
  )
    return "local";
  throw new Error(
    "A local/Laya provider outside loopback cannot reserve a sealed call",
  );
}
function microUsd(value) {
  const scaled = Math.round(value * 1_000_000);
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isSafeInteger(scaled) ||
    value !== scaled / 1_000_000
  )
    throw new Error(
      "Spending amounts require at most six decimal places and safe bounds",
    );
  return BigInt(scaled);
}
function paidScope(provider) {
  return {
    providerId: provider.providerId,
    kind: provider.kind,
    endpointOrigin: provider.endpointOrigin,
    requestedModel: provider.requestedModel,
    modelIdentitySha256: hashJson(provider.modelIdentity),
    pricingSha256: provider.pricingSha256,
    providerSha256: hashJson(provider),
  };
}
function privateFile(filename, { optional = false } = {}) {
  let info;
  try {
    info = lstatSync(filename);
  } catch (error) {
    if (optional && error.code === "ENOENT") return false;
    throw error;
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 64 * 1024 * 1024 ||
    (process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()))
  )
    throw new Error(
      "Ledger files must be bounded private regular files owned by this user",
    );
  return true;
}
function publicDispatchClaim(input) {
  try {
    return publicDispatchClaimSchema.parse(decodeJson(input));
  } catch {
    throw new Error("Invalid public dispatch claim");
  }
}

export class SealedStore {
  #db;
  #directory;
  #closed = false;
  constructor({ directory }) {
    if (
      typeof directory !== "string" ||
      !path.isAbsolute(directory) ||
      directory.length > 4096
    )
      throw new Error("Provide an absolute existing private ledger directory");
    const info = lstatSync(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()))
    )
      throw new Error(
        "Ledger directory must be private, owned, and not a symlink",
      );
    this.#directory = realpathSync(directory);
    const filename = path.join(this.#directory, "sealed.sqlite");
    for (const suffix of ["-wal", "-shm", "-journal"])
      privateFile(filename + suffix, { optional: true });
    if (!privateFile(filename, { optional: true })) {
      let fd;
      try {
        fd = openSync(
          filename,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        fchmodSync(fd, 0o600);
        fsyncSync(fd);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      privateFile(filename);
    }
    this.#db = new Database(filename);
    try {
      this.#db.pragma("busy_timeout = 5000");
      this.#db.pragma("foreign_keys = ON");
      this.#db.pragma("recursive_triggers = ON");
      this.#db.pragma("journal_mode = WAL");
      this.#db.pragma("synchronous = FULL");
      this.#db.pragma("max_page_count = 16384");
      const version = this.#db.pragma("user_version", { simple: true });
      if (![0, 1, 2, 3, 4, 5].includes(version))
        throw new Error("Unsupported sealed ledger version");
      this.#db
        .transaction(() => {
          this.#db.exec(`
          CREATE TABLE IF NOT EXISTS collections(id TEXT PRIMARY KEY,plan_json TEXT NOT NULL,registry_json TEXT NOT NULL,plan_hash TEXT NOT NULL,registry_hash TEXT NOT NULL,closure_json TEXT);
          CREATE TABLE IF NOT EXISTS assignments(collection_id TEXT NOT NULL REFERENCES collections(id),id TEXT NOT NULL,task_id TEXT NOT NULL,arm TEXT NOT NULL,ordinal INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(collection_id,id),UNIQUE(collection_id,task_id,arm),UNIQUE(collection_id,ordinal));
          CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,collection_id TEXT NOT NULL,assignment_id TEXT NOT NULL,reservation_json TEXT NOT NULL,receipt_json TEXT,UNIQUE(collection_id,assignment_id),FOREIGN KEY(collection_id,assignment_id) REFERENCES assignments(collection_id,id));
          CREATE TABLE IF NOT EXISTS public_dispatches(reservation_id TEXT PRIMARY KEY REFERENCES attempts(id),claim_json TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS oracle_invocations(reservation_id TEXT PRIMARY KEY REFERENCES attempts(id),claim_json TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS oracle_verdicts(reservation_id TEXT PRIMARY KEY REFERENCES oracle_invocations(reservation_id),record_json TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS exposures(domain TEXT NOT NULL,task_id TEXT NOT NULL,arm TEXT NOT NULL,reservation_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),PRIMARY KEY(domain,task_id,arm));
          CREATE TABLE IF NOT EXISTS family_exposures(domain TEXT NOT NULL,family_id TEXT NOT NULL,collection_id TEXT NOT NULL REFERENCES collections(id),PRIMARY KEY(domain,family_id));
          CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,reservation_id TEXT NOT NULL REFERENCES attempts(id),ordinal INTEGER NOT NULL,reservation_json TEXT NOT NULL,receipt_json TEXT,UNIQUE(reservation_id,ordinal));
          CREATE TABLE IF NOT EXISTS spending_authorizations(id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,authorization_json TEXT NOT NULL,authorization_hash TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS authorization_collections(collection_id TEXT PRIMARY KEY REFERENCES collections(id),authorization_id TEXT NOT NULL REFERENCES spending_authorizations(id));
          CREATE TABLE IF NOT EXISTS events(collection_id TEXT NOT NULL REFERENCES collections(id),sequence INTEGER NOT NULL,json TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(collection_id,sequence));
          CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'Immutable ledger event');END;
          CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'Immutable ledger event');END;
          CREATE TRIGGER IF NOT EXISTS collections_no_change BEFORE UPDATE OF plan_json,registry_json,plan_hash,registry_hash ON collections BEGIN SELECT RAISE(ABORT,'Immutable collection plan');END;
          CREATE TRIGGER IF NOT EXISTS attempts_no_change BEFORE UPDATE OF reservation_json ON attempts BEGIN SELECT RAISE(ABORT,'Immutable attempt reservation');END;
          CREATE TRIGGER IF NOT EXISTS public_dispatches_no_update BEFORE UPDATE ON public_dispatches BEGIN SELECT RAISE(ABORT,'Immutable public dispatch claim');END;
          CREATE TRIGGER IF NOT EXISTS public_dispatches_no_delete BEFORE DELETE ON public_dispatches BEGIN SELECT RAISE(ABORT,'Immutable public dispatch claim');END;
          CREATE TRIGGER IF NOT EXISTS oracle_invocations_no_update BEFORE UPDATE ON oracle_invocations BEGIN SELECT RAISE(ABORT,'Immutable oracle invocation claim');END;
          CREATE TRIGGER IF NOT EXISTS oracle_invocations_no_delete BEFORE DELETE ON oracle_invocations BEGIN SELECT RAISE(ABORT,'Immutable oracle invocation claim');END;
          CREATE TRIGGER IF NOT EXISTS oracle_verdicts_no_update BEFORE UPDATE ON oracle_verdicts BEGIN SELECT RAISE(ABORT,'Immutable oracle verdict reference');END;
          CREATE TRIGGER IF NOT EXISTS oracle_verdicts_no_delete BEFORE DELETE ON oracle_verdicts BEGIN SELECT RAISE(ABORT,'Immutable oracle verdict reference');END;
          CREATE TRIGGER IF NOT EXISTS calls_no_change BEFORE UPDATE OF reservation_json ON calls BEGIN SELECT RAISE(ABORT,'Immutable call reservation');END;
          CREATE TRIGGER IF NOT EXISTS spending_authorizations_no_update BEFORE UPDATE ON spending_authorizations BEGIN SELECT RAISE(ABORT,'Immutable spending authorization');END;
          CREATE TRIGGER IF NOT EXISTS spending_authorizations_no_delete BEFORE DELETE ON spending_authorizations BEGIN SELECT RAISE(ABORT,'Immutable spending authorization');END;
          CREATE TRIGGER IF NOT EXISTS authorization_collections_no_update BEFORE UPDATE ON authorization_collections BEGIN SELECT RAISE(ABORT,'Immutable authorization binding');END;
          CREATE TRIGGER IF NOT EXISTS authorization_collections_no_delete BEFORE DELETE ON authorization_collections BEGIN SELECT RAISE(ABORT,'Immutable authorization binding');END;
          CREATE TRIGGER IF NOT EXISTS attempts_one_settlement BEFORE UPDATE OF receipt_json ON attempts WHEN OLD.receipt_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'Attempt already terminal');END;
          CREATE TRIGGER IF NOT EXISTS calls_one_settlement BEFORE UPDATE OF receipt_json ON calls WHEN OLD.receipt_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'Call already terminal');END;
          CREATE TRIGGER IF NOT EXISTS collections_one_closure BEFORE UPDATE OF closure_json ON collections WHEN OLD.closure_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'Collection already closed');END;
          PRAGMA user_version=5;
        `);
        })
        .immediate();
      if (process.platform !== "win32") {
        const fd = openSync(this.#directory, constants.O_RDONLY);
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
    } catch (error) {
      this.#db.close();
      this.#closed = true;
      throw error;
    }
  }
  close() {
    if (!this.#closed) {
      this.#db.close();
      this.#closed = true;
    }
  }
  get storageSettings() {
    return snapshot({
      journalMode: this.#db.pragma("journal_mode", { simple: true }),
      synchronous: this.#db.pragma("synchronous", { simple: true }),
      recursiveTriggers: this.#db.pragma("recursive_triggers", {
        simple: true,
      }),
      maxPageCount: this.#db.pragma("max_page_count", { simple: true }),
    });
  }
  #collection(id, { open = false } = {}) {
    const row = this.#db
      .prepare("SELECT * FROM collections WHERE id=?")
      .get(id);
    if (!row) throw new Error("Unknown collection");
    if (open && row.closure_json) throw new Error("Collection is closed");
    const validated = validateCollectionPlan(row.plan_json, row.registry_json, {
      expectedRegistrySha256: row.registry_hash,
    });
    if (validated.planSha256 !== row.plan_hash)
      throw new Error("Collection identity mismatch");
    return { ...row, ...validated };
  }
  #event(collectionId, type, payload) {
    const head = this.#db
      .prepare(
        "SELECT sequence,hash FROM events WHERE collection_id=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(collectionId);
    const event = eventSchema.parse({
      version: "1.0.0",
      kind: "sealed-ledger-event",
      collectionId,
      sequence: (head?.sequence ?? 0) + 1,
      type,
      createdAt: now(),
      previousSha256: head?.hash ?? null,
      payloadSha256: hashJson(payload),
    });
    const digest = hashJson(event);
    this.#db
      .prepare("INSERT INTO events VALUES(?,?,?,?)")
      .run(collectionId, event.sequence, canonicalJson(event), digest);
    return digest;
  }
  registerPlan(input, registry, { expectedRegistrySha256 } = {}) {
    const validated = validateCollectionPlan(input, registry, {
      expectedRegistrySha256,
    });
    return this.#db
      .transaction(() => {
        if (
          this.#db
            .prepare("SELECT 1 FROM collections WHERE id=?")
            .get(validated.plan.collectionId)
        )
          throw new Error("Collection already registered; plans are immutable");
        this.#db
          .prepare("INSERT INTO collections VALUES(?,?,?,?,?,NULL)")
          .run(
            validated.plan.collectionId,
            canonicalJson(validated.plan),
            canonicalJson(validated.registry),
            validated.planSha256,
            validated.registrySha256,
          );
        const insert = this.#db.prepare(
          "INSERT INTO assignments VALUES(?,?,?,?,?,?)",
        );
        for (const assignment of validated.plan.assignments)
          insert.run(
            validated.plan.collectionId,
            assignment.assignmentId,
            assignment.taskId,
            assignment.arm,
            assignment.ordinal,
            canonicalJson(assignment),
          );
        this.#event(validated.plan.collectionId, "registered", validated.plan);
        return snapshot({
          collectionId: validated.plan.collectionId,
          planSha256: validated.planSha256,
          promotionEligible: false,
        });
      })
      .immediate();
  }
  #authorizationForCollection(collectionId) {
    const row = this.#db
      .prepare(
        "SELECT s.* FROM spending_authorizations s JOIN authorization_collections ac ON ac.authorization_id=s.id WHERE ac.collection_id=?",
      )
      .get(collectionId);
    if (!row) return null;
    const authorization = spendingAuthorizationSchema.parse(
      decodeJson(row.authorization_json),
    );
    if (
      authorization.authorizationId !== row.id ||
      authorization.sessionId !== row.session_id ||
      authorization.projectId !== row.project_id ||
      hashJson(authorization) !== row.authorization_hash
    )
      throw new Error("Spending authorization identity mismatch");
    const collection = this.#collection(collectionId);
    if (
      collection.plan.projectId !== authorization.projectId ||
      !authorization.collections.some(
        (item) =>
          item.collectionId === collectionId &&
          item.planSha256 === collection.planSha256,
      )
    )
      throw new Error("Spending authorization plan binding mismatch");
    return { authorization, sha256: row.authorization_hash };
  }
  #sessionState(authorization) {
    const rows = this.#db
      .prepare(
        "SELECT c.reservation_json,c.receipt_json FROM calls c JOIN attempts a ON a.id=c.reservation_id JOIN authorization_collections ac ON ac.collection_id=a.collection_id WHERE ac.authorization_id=?",
      )
      .all(authorization.authorizationId);
    let reservedMicros = 0n,
      knownCostUsd = 0,
      ambiguousCalls = 0,
      unsettledCalls = 0,
      knownOverrun = false;
    for (const row of rows) {
      const reservation = callReservationSchema.parse(
        decodeJson(row.reservation_json),
      );
      if (!reservation.authorizationId) continue;
      if (
        reservation.authorizationId !== authorization.authorizationId ||
        reservation.authorizationSha256 !== hashJson(authorization) ||
        reservation.sessionId !== authorization.sessionId ||
        reservation.reservedCostUsd === null
      )
        throw new Error("Paid call authorization binding mismatch");
      reservedMicros += microUsd(reservation.reservedCostUsd);
      if (!row.receipt_json) {
        unsettledCalls++;
        continue;
      }
      const receipt = callReceiptSchema.parse(decodeJson(row.receipt_json));
      if (
        receipt.reservationSha256 !== hashJson(reservation) ||
        receipt.callId !== reservation.callId
      )
        throw new Error("Paid call receipt identity mismatch");
      if (receipt.usage.costUsd !== null) knownCostUsd += receipt.usage.costUsd;
      if (receipt.status === "ambiguous" || receipt.usage.costUsd === null)
        ambiguousCalls++;
      if (
        [
          receipt.usage.costUsd,
          receipt.usage.reportedCostUsd,
          receipt.usage.chargedCostUsd,
        ].some(
          (amount) => amount !== null && amount > reservation.reservedCostUsd,
        )
      )
        knownOverrun = true;
    }
    return {
      reservedMicros,
      knownCostUsd,
      ambiguousCalls,
      unsettledCalls,
      knownOverrun,
    };
  }
  registerSpendingAuthorization(
    input,
    { expectedAuthorizationSha256, expectedApprovalEvidenceSha256 } = {},
  ) {
    const authorization = spendingAuthorizationSchema.parse(decodeJson(input));
    const authorizationSha256 = hashJson(authorization);
    if (
      authorizationSha256 !== expectedAuthorizationSha256 ||
      authorization.approvalEvidenceSha256 !== expectedApprovalEvidenceSha256
    )
      throw new Error(
        "Spending authorization and external approval digests must be separately selected",
      );
    if (Date.now() >= Date.parse(authorization.expiresAt))
      throw new Error("Spending authorization has expired");
    microUsd(authorization.totalCapUsd);
    return this.#db
      .transaction(() => {
        const required = new Map();
        for (const binding of authorization.collections) {
          const collection = this.#collection(binding.collectionId, {
            open: true,
          });
          if (
            collection.plan.projectId !== authorization.projectId ||
            collection.planSha256 !== binding.planSha256
          )
            throw new Error(
              "Authorization project or plan differs from collection",
            );
          if (
            this.#db
              .prepare("SELECT 1 FROM attempts WHERE collection_id=? LIMIT 1")
              .get(binding.collectionId)
          )
            throw new Error(
              "Spending must be authorized before collection attempts",
            );
          if (
            this.#db
              .prepare(
                "SELECT 1 FROM authorization_collections WHERE collection_id=?",
              )
              .get(binding.collectionId)
          )
            throw new Error("Collection already has a spending authorization");
          for (const config of Object.values(collection.plan.configurations)) {
            const paidProviders = config.providers.filter(
              (provider) => providerSpendClass(provider) === "paid",
            );
            if (paidProviders.length && config.maxCostUsdPerAttempt === null)
              throw new Error(
                "Paid collection requires a frozen per-attempt cost cap",
              );
            for (const provider of paidProviders) {
              if (
                provider.pricingSha256 === null ||
                provider.modelIdentity.kind !== "provider-snapshot"
              )
                throw new Error(
                  "Paid provider requires frozen pricing and a versioned model identity",
                );
              required.set(hashJson(provider), paidScope(provider));
            }
          }
        }
        if (
          !required.size ||
          !same(
            [...required.values()].sort((a, b) =>
              a.providerSha256.localeCompare(b.providerSha256),
            ),
            [...authorization.providers].sort((a, b) =>
              a.providerSha256.localeCompare(b.providerSha256),
            ),
          )
        )
          throw new Error(
            "Authorization provider, model, origin or pricing scope differs from frozen plans",
          );
        this.#db
          .prepare("INSERT INTO spending_authorizations VALUES(?,?,?,?,?)")
          .run(
            authorization.authorizationId,
            authorization.sessionId,
            authorization.projectId,
            canonicalJson(authorization),
            authorizationSha256,
          );
        const insert = this.#db.prepare(
          "INSERT INTO authorization_collections VALUES(?,?)",
        );
        for (const binding of authorization.collections) {
          insert.run(binding.collectionId, authorization.authorizationId);
        }
        return snapshot({
          authorization,
          sha256: authorizationSha256,
          reservedCostUsd: 0,
          remainingCapUsd: authorization.totalCapUsd,
          promotionEligible: false,
        });
      })
      .immediate();
  }
  inspectSpendingAuthorization(authorizationId) {
    return this.#db
      .transaction(() => {
        const row = this.#db
          .prepare("SELECT * FROM spending_authorizations WHERE id=?")
          .get(authorizationId);
        if (!row) throw new Error("Unknown spending authorization");
        const authorization = spendingAuthorizationSchema.parse(
          decodeJson(row.authorization_json),
        );
        if (
          row.authorization_hash !== hashJson(authorization) ||
          row.session_id !== authorization.sessionId ||
          row.project_id !== authorization.projectId
        )
          throw new Error("Spending authorization identity mismatch");
        for (const binding of authorization.collections)
          if (
            this.#authorizationForCollection(binding.collectionId)?.sha256 !==
            row.authorization_hash
          )
            throw new Error(
              "Spending authorization collection inventory mismatch",
            );
        const state = this.#sessionState(authorization);
        return snapshot({
          authorization,
          sha256: row.authorization_hash,
          reservedCostUsd: Number(state.reservedMicros) / 1_000_000,
          remainingCapUsd:
            Number(microUsd(authorization.totalCapUsd) - state.reservedMicros) /
            1_000_000,
          knownCostUsd: state.knownCostUsd,
          ambiguousCalls: state.ambiguousCalls,
          unsettledCalls: state.unsettledCalls,
          knownOverrun: state.knownOverrun,
          promotionEligible: false,
        });
      })
      .deferred();
  }
  reserveAttempt(collectionId, assignmentId) {
    return this.#db
      .transaction(() => {
        const { plan, planSha256 } = this.#collection(collectionId, {
          open: true,
        });
        const timestamp = now();
        if (
          Date.parse(timestamp) < Date.parse(plan.notBefore) ||
          Date.parse(timestamp) >= Date.parse(plan.expiresAt)
        )
          throw new Error("Collection is outside its frozen time window");
        const assignment = plan.assignments.find(
          (item) => item.assignmentId === assignmentId,
        );
        if (!assignment) throw new Error("Unknown assignment");
        if (
          this.#db
            .prepare(
              "SELECT 1 FROM attempts WHERE collection_id=? AND assignment_id=?",
            )
            .get(collectionId, assignmentId)
        )
          throw new Error("Assignment already consumed; no retry or reset");
        // There is no parallel scheduling policy in this frozen plan. Earlier
        // assignments must be terminal before the next one can consume a turn.
        for (const earlier of plan.assignments.filter(
          (item) => item.ordinal < assignment.ordinal,
        )) {
          const prior = this.#db
            .prepare(
              "SELECT receipt_json FROM attempts WHERE collection_id=? AND assignment_id=?",
            )
            .get(collectionId, earlier.assignmentId);
          if (!prior?.receipt_json)
            throw new Error(
              "Cannot skip or overlap the frozen assignment order",
            );
        }
        const task = plan.tasks.find(
          (item) => item.taskId === assignment.taskId,
        );
        const exposed = this.#db
          .prepare(
            "SELECT collection_id FROM family_exposures WHERE family_id=? AND collection_id<>?",
          )
          .get(task.stableFamilyId, collectionId);
        if (exposed && exposed.collection_id !== collectionId)
          throw new Error("Family was already exposed by another collection");
        if (
          this.#db
            .prepare(
              "SELECT 1 FROM exposures e JOIN attempts a ON a.id=e.reservation_id WHERE e.task_id=? AND a.collection_id<>?",
            )
            .get(task.stableTaskId, collectionId)
        )
          throw new Error(
            "Stable task was already exposed by another collection",
          );
        const reservation = reservationSchema.parse({
          version: "1.0.0",
          kind: "sealed-attempt-reservation",
          reservationId: randomUUID(),
          collectionId,
          assignmentId,
          taskId: task.taskId,
          stableTaskId: task.stableTaskId,
          stableFamilyId: task.stableFamilyId,
          exposureDomain: task.exposureDomain,
          arm: assignment.arm,
          ordinal: assignment.ordinal,
          attemptOrdinal: 1,
          planSha256,
          configurationSha256: hashJson(plan.configurations[assignment.arm]),
          taskSha256: hashJson(task),
          reservedAt: timestamp,
        });
        this.#db
          .prepare("INSERT INTO attempts VALUES(?,?,?,?,NULL)")
          .run(
            reservation.reservationId,
            collectionId,
            assignmentId,
            canonicalJson(reservation),
          );
        this.#db
          .prepare("INSERT INTO exposures VALUES(?,?,?,?)")
          .run(
            task.exposureDomain,
            task.stableTaskId,
            assignment.arm,
            reservation.reservationId,
          );
        this.#db
          .prepare("INSERT OR IGNORE INTO family_exposures VALUES(?,?,?)")
          .run(task.exposureDomain, task.stableFamilyId, collectionId);
        this.#event(collectionId, "attempt-reserved", reservation);
        return snapshot(reservation);
      })
      .immediate();
  }
  #attempt(reservationId, { open = false } = {}) {
    const row = this.#db
      .prepare("SELECT * FROM attempts WHERE id=?")
      .get(reservationId);
    if (!row) throw new Error("Unknown attempt reservation");
    if (open && row.receipt_json)
      throw new Error("Attempt is already terminal");
    const collection = this.#collection(row.collection_id, { open }),
      reservation = reservationSchema.parse(decodeJson(row.reservation_json));
    return { ...row, ...collection, reservation };
  }
  #assertPublicDispatch(claim, reservation, plan) {
    const task = plan.tasks.find((item) => item.taskId === reservation.taskId);
    const claimedAt = Date.parse(claim.claimedAt);
    const reservedAt = Date.parse(reservation.reservedAt);
    const maxDurationMs = plan.configurations[reservation.arm].maxDurationMs;
    if (
      !task ||
      claim.reservationId !== reservation.reservationId ||
      claim.reservationSha256 !== hashJson(reservation) ||
      claim.collectionId !== reservation.collectionId ||
      claim.assignmentId !== reservation.assignmentId ||
      claim.taskId !== task.taskId ||
      claim.taskSha256 !== hashJson(task) ||
      claim.planSha256 !== reservation.planSha256 ||
      claim.publicPacketSha256 !== task.publicPacketSha256 ||
      claimedAt < reservedAt ||
      claimedAt >= Date.parse(plan.expiresAt) ||
      claimedAt - reservedAt >= maxDurationMs
    )
      throw new Error("Public dispatch claim differs from its frozen attempt");
  }
  /** A durable, at-most-once permission claim, not evidence of delivery. */
  claimPublicDispatch(reservationId, packetReference) {
    const reference = decodeJson(packetReference);
    if (
      !reference ||
      Array.isArray(reference) ||
      Object.keys(reference).sort().join(",") !== "bytes,sha256" ||
      typeof reference.sha256 !== "string" ||
      !sha256.test(reference.sha256) ||
      !Number.isSafeInteger(reference.bytes) ||
      reference.bytes < 1 ||
      reference.bytes > MAX_PUBLIC_PACKET_BYTES
    )
      throw new Error("Public dispatch needs a bounded artifact reference");
    return this.#db
      .transaction(() => {
        const attempt = this.#attempt(reservationId, { open: true });
        const timestamp = now();
        if (
          Date.parse(timestamp) < Date.parse(attempt.reservation.reservedAt) ||
          Date.parse(timestamp) >= Date.parse(attempt.plan.expiresAt) ||
          Date.parse(timestamp) - Date.parse(attempt.reservation.reservedAt) >=
            attempt.plan.configurations[attempt.reservation.arm].maxDurationMs
        )
          throw new Error("Public dispatch attempt deadline has expired");
        if (
          this.#db
            .prepare("SELECT 1 FROM public_dispatches WHERE reservation_id=?")
            .get(reservationId)
        )
          throw new Error("Public dispatch already claimed; never retry");
        if (
          this.#db
            .prepare("SELECT 1 FROM calls WHERE reservation_id=? LIMIT 1")
            .get(reservationId)
        )
          throw new Error("Public dispatch must precede every model call");
        const task = attempt.plan.tasks.find(
          (item) => item.taskId === attempt.reservation.taskId,
        );
        if (!task || task.publicPacketSha256 !== reference.sha256)
          throw new Error("Public packet differs from frozen task");
        const claim = publicDispatchClaim({
          version: "1.0.0",
          kind: "sealed-public-dispatch-claim",
          reservationId,
          reservationSha256: hashJson(attempt.reservation),
          collectionId: attempt.reservation.collectionId,
          assignmentId: attempt.reservation.assignmentId,
          taskId: task.taskId,
          taskSha256: hashJson(task),
          planSha256: attempt.reservation.planSha256,
          publicPacketSha256: reference.sha256,
          publicPacketBytes: reference.bytes,
          claimedAt: timestamp,
        });
        this.#assertPublicDispatch(claim, attempt.reservation, attempt.plan);
        this.#db
          .prepare("INSERT INTO public_dispatches VALUES(?,?)")
          .run(reservationId, canonicalJson(claim));
        this.#event(
          attempt.reservation.collectionId,
          "public-dispatch-claimed",
          claim,
        );
        return snapshot(claim);
      })
      .immediate();
  }
  #assertOracleInvocation(claim, reservation, plan, publicDispatch) {
    const task = plan.tasks.find((item) => item.taskId === reservation.taskId);
    const claimedAt = Date.parse(claim.claimedAt);
    const reservedAt = Date.parse(reservation.reservedAt);
    if (
      !task ||
      !publicDispatch ||
      claim.reservationId !== reservation.reservationId ||
      claim.reservationSha256 !== hashJson(reservation) ||
      claim.collectionId !== reservation.collectionId ||
      claim.assignmentId !== reservation.assignmentId ||
      claim.taskId !== task.taskId ||
      claim.taskSha256 !== hashJson(task) ||
      claim.planSha256 !== reservation.planSha256 ||
      claim.publicDispatchSha256 !== hashJson(publicDispatch) ||
      claim.oracleSha256 !== task.oracleSha256 ||
      [
        task.oracleSha256,
        task.publicPacketSha256,
        task.referenceRepairSha256,
      ].includes(claim.proposalSha256) ||
      claimedAt < Date.parse(publicDispatch.claimedAt) ||
      claimedAt < reservedAt ||
      claimedAt >= Date.parse(plan.expiresAt) ||
      claimedAt - reservedAt >=
        plan.configurations[reservation.arm].maxDurationMs
    )
      throw new Error("Oracle invocation differs from the frozen attempt");
    if (
      [
        "sealed-call-bound-engineering-invocation-claim",
        "sealed-call-bound-module-graph-invocation-claim",
        "sealed-call-bound-repository-invocation-claim",
        "sealed-call-bound-repository-v2-invocation-claim",
      ].includes(claim.kind) &&
      (claim.baselineSha256 !== task.baselineSha256 ||
        claim.resultSourceSha256 === task.baselineSha256 ||
        [task.oracleSha256, task.publicPacketSha256].includes(
          claim.resultSourceSha256,
        ))
    )
      throw new Error("Engineering result differs from frozen baseline scope");
    if (
      claim.kind === "sealed-call-bound-repository-invocation-claim" &&
      (task.stateFormatVersion !== "repo-snapshot-v1" ||
        claim.resultSourceSha256 === claim.proposalSha256 ||
        [
          task.baselineSha256,
          task.publicPacketSha256,
          claim.resultSourceSha256,
        ].includes(claim.recipeSha256))
    )
      throw new Error(
        "Repository claim differs from frozen snapshot or recipe roles",
      );
    if (
      claim.kind === "sealed-call-bound-repository-v2-invocation-claim" &&
      (task.stateFormatVersion !== "repo-snapshot-v1" ||
        task.executionScopeSha256 !== claim.scopeSha256 ||
        claim.resultSourceSha256 === claim.proposalSha256 ||
        [
          task.baselineSha256,
          task.publicPacketSha256,
          task.oracleSha256,
          claim.scopeSha256,
          claim.resultSourceSha256,
        ].includes(claim.recipeSha256) ||
        [
          task.baselineSha256,
          task.publicPacketSha256,
          task.oracleSha256,
          claim.scopeSha256,
          claim.recipeSha256,
          claim.resultSourceSha256,
        ].includes(claim.baselineTreeSha256))
    )
      throw new Error(
        "Repository v2 claim differs from frozen snapshot, scope or recipe roles",
      );
    if (
      claim.kind === "sealed-call-bound-oracle-invocation-claim" ||
      claim.kind === "sealed-call-bound-engineering-invocation-claim" ||
      claim.kind === "sealed-call-bound-module-graph-invocation-claim" ||
      claim.kind === "sealed-call-bound-repository-invocation-claim" ||
      claim.kind === "sealed-call-bound-repository-v2-invocation-claim"
    ) {
      const row = this.#db
        .prepare(
          "SELECT reservation_json,receipt_json FROM calls WHERE id=? AND reservation_id=?",
        )
        .get(claim.callId, reservation.reservationId);
      if (!row?.receipt_json)
        throw new Error(
          "Call-bound oracle needs a settled call in this attempt",
        );
      const call = callReservationSchema.parse(
        decodeJson(row.reservation_json),
      );
      const receipt = callReceiptSchema.parse(decodeJson(row.receipt_json));
      const provider = plan.configurations[reservation.arm].providers.find(
        (item) => item.providerId === call.providerId,
      );
      if (
        !provider ||
        provider.kind !== "local" ||
        provider.modelIdentity.kind !== "local-weights" ||
        call.requestedModel !== provider.requestedModel ||
        receipt.status !== "completed" ||
        receipt.reportedModel !== call.requestedModel ||
        receipt.usage.basis !== "local-no-api-charge" ||
        !receipt.responseSha256 ||
        claim.callReservationSha256 !== hashJson(call) ||
        claim.callReceiptSha256 !== hashJson(receipt) ||
        claim.responseSha256 !== receipt.responseSha256 ||
        Date.parse(call.reservedAt) < Date.parse(publicDispatch.claimedAt) ||
        Date.parse(receipt.finishedAt) < Date.parse(call.reservedAt) ||
        claimedAt < Date.parse(receipt.finishedAt)
      )
        throw new Error(
          "Oracle claim differs from a completed local model call",
        );
    }
  }
  /** Durable one-shot call-bound claim; not proof of guest execution or proposal correctness. */
  claimOracleInvocation(reservationId, input) {
    const data = decodeJson(input);
    if (
      !data ||
      Array.isArray(data) ||
      Object.keys(data).sort().join(",") !==
        "callId,expectedCallReceiptSha256,expectedPlanSha256,expectedResponseSha256,imageId,oracleSha256,proposalSha256" ||
      ![
        data.expectedCallReceiptSha256,
        data.expectedPlanSha256,
        data.expectedResponseSha256,
        data.oracleSha256,
        data.proposalSha256,
      ].every((value) => typeof value === "string" && sha256.test(value)) ||
      typeof data.callId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(data.callId) ||
      typeof data.imageId !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(data.imageId)
    )
      throw new Error(
        "Oracle claim needs exact pinned plan, image and artifact hashes",
      );
    return this.#db
      .transaction(() => {
        const attempt = this.#attempt(reservationId, { open: true });
        if (attempt.planSha256 !== data.expectedPlanSha256)
          throw new Error("Oracle claim plan differs from frozen collection");
        const dispatchRow = this.#db
          .prepare(
            "SELECT claim_json FROM public_dispatches WHERE reservation_id=?",
          )
          .get(reservationId);
        if (!dispatchRow)
          throw new Error("Oracle invocation requires prior public dispatch");
        if (
          this.#db
            .prepare("SELECT 1 FROM oracle_invocations WHERE reservation_id=?")
            .get(reservationId)
        )
          throw new Error("Oracle invocation already claimed; never retry");
        const publicDispatch = publicDispatchClaim(dispatchRow.claim_json);
        this.#assertPublicDispatch(
          publicDispatch,
          attempt.reservation,
          attempt.plan,
        );
        const callRow = this.#db
          .prepare(
            "SELECT reservation_json,receipt_json FROM calls WHERE id=? AND reservation_id=?",
          )
          .get(data.callId, reservationId);
        if (!callRow?.receipt_json)
          throw new Error("Oracle claim requires a completed local model call");
        if (
          this.#db
            .prepare(
              "SELECT COUNT(*) AS count FROM calls WHERE reservation_id=?",
            )
            .get(reservationId).count !== 1
        )
          throw new Error("Oracle claim requires exactly one model call");
        const call = callReservationSchema.parse(
          decodeJson(callRow.reservation_json),
        );
        const receipt = callReceiptSchema.parse(
          decodeJson(callRow.receipt_json),
        );
        if (
          hashJson(receipt) !== data.expectedCallReceiptSha256 ||
          receipt.responseSha256 !== data.expectedResponseSha256
        )
          throw new Error(
            "Oracle claim response/call receipt differs from frozen call",
          );
        const task = attempt.plan.tasks.find(
          (item) => item.taskId === attempt.reservation.taskId,
        );
        const claim = oracleInvocationClaimSchema.parse({
          version: "1.0.0",
          kind: "sealed-call-bound-oracle-invocation-claim",
          reservationId,
          reservationSha256: hashJson(attempt.reservation),
          collectionId: attempt.reservation.collectionId,
          assignmentId: attempt.reservation.assignmentId,
          taskId: task.taskId,
          taskSha256: hashJson(task),
          planSha256: attempt.planSha256,
          publicDispatchSha256: hashJson(publicDispatch),
          oracleSha256: data.oracleSha256,
          callId: call.callId,
          callReservationSha256: hashJson(call),
          callReceiptSha256: hashJson(receipt),
          responseSha256: receipt.responseSha256,
          proposalDerivation: "openai-chat-content-utf8-v1",
          proposalSha256: data.proposalSha256,
          imageId: data.imageId,
          claimedAt: now(),
        });
        this.#assertOracleInvocation(
          claim,
          attempt.reservation,
          attempt.plan,
          publicDispatch,
        );
        this.#db
          .prepare("INSERT INTO oracle_invocations VALUES(?,?)")
          .run(reservationId, canonicalJson(claim));
        this.#event(
          attempt.reservation.collectionId,
          "call-bound-oracle-invocation-claimed",
          claim,
        );
        return snapshot(claim);
      })
      .immediate();
  }
  /** One-shot engineering verification claim; no guest execution or success is implied. */
  claimEngineeringInvocation(reservationId, input) {
    const data = decodeJson(input);
    if (
      !data ||
      Array.isArray(data) ||
      Object.keys(data).sort().join(",") !==
        "baselineSha256,callId,expectedCallReceiptSha256,expectedPlanSha256,expectedResponseSha256,imageId,oracleSha256,proposalSha256,resultSourceSha256" ||
      ![
        data.baselineSha256,
        data.expectedCallReceiptSha256,
        data.expectedPlanSha256,
        data.expectedResponseSha256,
        data.oracleSha256,
        data.proposalSha256,
        data.resultSourceSha256,
      ].every((value) => typeof value === "string" && sha256.test(value)) ||
      typeof data.callId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(data.callId) ||
      typeof data.imageId !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(data.imageId)
    )
      throw new Error(
        "Engineering claim needs frozen call and result identities",
      );
    return this.#db
      .transaction(() => {
        const attempt = this.#attempt(reservationId, { open: true });
        if (attempt.planSha256 !== data.expectedPlanSha256)
          throw new Error(
            "Engineering claim plan differs from frozen collection",
          );
        const dispatchRow = this.#db
          .prepare(
            "SELECT claim_json FROM public_dispatches WHERE reservation_id=?",
          )
          .get(reservationId);
        if (!dispatchRow)
          throw new Error("Engineering claim requires prior public dispatch");
        if (
          this.#db
            .prepare("SELECT 1 FROM oracle_invocations WHERE reservation_id=?")
            .get(reservationId)
        )
          throw new Error("Oracle invocation already claimed; never retry");
        const publicDispatch = publicDispatchClaim(dispatchRow.claim_json);
        this.#assertPublicDispatch(
          publicDispatch,
          attempt.reservation,
          attempt.plan,
        );
        const callRows = this.#db
          .prepare(
            "SELECT reservation_json,receipt_json FROM calls WHERE reservation_id=? ORDER BY ordinal",
          )
          .all(reservationId);
        if (callRows.length !== 1 || !callRows[0].receipt_json)
          throw new Error(
            "Engineering claim requires exactly one settled model call",
          );
        const call = callReservationSchema.parse(
          decodeJson(callRows[0].reservation_json),
        );
        const receipt = callReceiptSchema.parse(
          decodeJson(callRows[0].receipt_json),
        );
        if (
          call.callId !== data.callId ||
          hashJson(receipt) !== data.expectedCallReceiptSha256 ||
          receipt.responseSha256 !== data.expectedResponseSha256
        )
          throw new Error(
            "Engineering claim differs from retained model response",
          );
        const task = attempt.plan.tasks.find(
          (item) => item.taskId === attempt.reservation.taskId,
        );
        const claim = oracleInvocationClaimSchema.parse({
          version: "1.0.0",
          kind: "sealed-call-bound-engineering-invocation-claim",
          reservationId,
          reservationSha256: hashJson(attempt.reservation),
          collectionId: attempt.reservation.collectionId,
          assignmentId: attempt.reservation.assignmentId,
          taskId: task.taskId,
          taskSha256: hashJson(task),
          planSha256: attempt.planSha256,
          publicDispatchSha256: hashJson(publicDispatch),
          baselineSha256: data.baselineSha256,
          oracleSha256: data.oracleSha256,
          callId: call.callId,
          callReservationSha256: hashJson(call),
          callReceiptSha256: hashJson(receipt),
          responseSha256: receipt.responseSha256,
          proposalDerivation: "openai-chat-content-utf8-v1",
          proposalSha256: data.proposalSha256,
          resultSourceSha256: data.resultSourceSha256,
          verifierKind: "sealed-json-function-v1",
          imageId: data.imageId,
          claimedAt: now(),
        });
        this.#assertOracleInvocation(
          claim,
          attempt.reservation,
          attempt.plan,
          publicDispatch,
        );
        this.#db
          .prepare("INSERT INTO oracle_invocations VALUES(?,?)")
          .run(reservationId, canonicalJson(claim));
        this.#event(
          attempt.reservation.collectionId,
          "call-bound-engineering-invocation-claimed",
          claim,
        );
        return snapshot(claim);
      })
      .immediate();
  }
  /** Separate v2 graph claim, sharing the same durable one-shot oracle slot. */
  claimModuleGraphInvocation(reservationId, input) {
    const data = decodeJson(input);
    if (
      !data ||
      Array.isArray(data) ||
      Object.keys(data).sort().join(",") !==
        "baselineSha256,callId,expectedCallReceiptSha256,expectedPlanSha256,expectedResponseSha256,imageId,oracleSha256,proposalSha256,resultSourceSha256" ||
      ![
        data.baselineSha256,
        data.expectedCallReceiptSha256,
        data.expectedPlanSha256,
        data.expectedResponseSha256,
        data.oracleSha256,
        data.proposalSha256,
        data.resultSourceSha256,
      ].every((value) => typeof value === "string" && sha256.test(value)) ||
      typeof data.callId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(data.callId) ||
      typeof data.imageId !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(data.imageId)
    )
      throw new Error(
        "Module graph claim needs frozen call and result identities",
      );
    return this.#db
      .transaction(() => {
        const attempt = this.#attempt(reservationId, { open: true });
        if (attempt.planSha256 !== data.expectedPlanSha256)
          throw new Error(
            "Module graph claim plan differs from frozen collection",
          );
        const dispatchRow = this.#db
          .prepare(
            "SELECT claim_json FROM public_dispatches WHERE reservation_id=?",
          )
          .get(reservationId);
        if (!dispatchRow)
          throw new Error("Module graph claim requires prior public dispatch");
        if (
          this.#db
            .prepare("SELECT 1 FROM oracle_invocations WHERE reservation_id=?")
            .get(reservationId)
        )
          throw new Error("Oracle invocation already claimed; never retry");
        const publicDispatch = publicDispatchClaim(dispatchRow.claim_json);
        this.#assertPublicDispatch(
          publicDispatch,
          attempt.reservation,
          attempt.plan,
        );
        const callRows = this.#db
          .prepare(
            "SELECT reservation_json,receipt_json FROM calls WHERE reservation_id=? ORDER BY ordinal",
          )
          .all(reservationId);
        if (callRows.length !== 1 || !callRows[0].receipt_json)
          throw new Error(
            "Module graph claim requires exactly one settled model call",
          );
        const call = callReservationSchema.parse(
          decodeJson(callRows[0].reservation_json),
        );
        const receipt = callReceiptSchema.parse(
          decodeJson(callRows[0].receipt_json),
        );
        if (
          call.callId !== data.callId ||
          hashJson(receipt) !== data.expectedCallReceiptSha256 ||
          receipt.responseSha256 !== data.expectedResponseSha256
        )
          throw new Error(
            "Module graph claim differs from retained model response",
          );
        const task = attempt.plan.tasks.find(
          (item) => item.taskId === attempt.reservation.taskId,
        );
        const claim = oracleInvocationClaimSchema.parse({
          version: "1.0.0",
          kind: "sealed-call-bound-module-graph-invocation-claim",
          reservationId,
          reservationSha256: hashJson(attempt.reservation),
          collectionId: attempt.reservation.collectionId,
          assignmentId: attempt.reservation.assignmentId,
          taskId: task.taskId,
          taskSha256: hashJson(task),
          planSha256: attempt.planSha256,
          publicDispatchSha256: hashJson(publicDispatch),
          baselineSha256: data.baselineSha256,
          oracleSha256: data.oracleSha256,
          callId: call.callId,
          callReservationSha256: hashJson(call),
          callReceiptSha256: hashJson(receipt),
          responseSha256: receipt.responseSha256,
          proposalDerivation: "openai-chat-content-utf8-v1",
          proposalSha256: data.proposalSha256,
          resultSourceSha256: data.resultSourceSha256,
          verifierKind: "sealed-js-module-graph-v1",
          imageId: data.imageId,
          claimedAt: now(),
        });
        this.#assertOracleInvocation(
          claim,
          attempt.reservation,
          attempt.plan,
          publicDispatch,
        );
        this.#db
          .prepare("INSERT INTO oracle_invocations VALUES(?,?)")
          .run(reservationId, canonicalJson(claim));
        this.#event(
          attempt.reservation.collectionId,
          "call-bound-module-graph-invocation-claimed",
          claim,
        );
        return snapshot(claim);
      })
      .immediate();
  }
  /** One-shot bounded repository claim; a tree digest is not proof of correct derivation or guest execution. */
  claimRepositoryInvocation(reservationId, input) {
    return this.#claimRepositoryInvocation(reservationId, input, false);
  }
  /** One-shot v2 whole-execution-tree claim; still no authenticated execution authority. */
  claimRepositoryV2Invocation(reservationId, input) {
    return this.#claimRepositoryInvocation(reservationId, input, true);
  }
  #claimRepositoryInvocation(reservationId, input, v2) {
    const data = decodeJson(input);
    const expectedFields = v2
      ? "baselineSha256,baselineTreeSha256,callId,expectedCallReceiptSha256,expectedPlanSha256,expectedResponseSha256,imageId,oracleSha256,proposalSha256,recipeSha256,resultSourceSha256,scopeSha256"
      : "baselineSha256,callId,expectedCallReceiptSha256,expectedPlanSha256,expectedResponseSha256,imageId,oracleSha256,proposalSha256,recipeSha256,resultSourceSha256";
    if (
      !data ||
      Array.isArray(data) ||
      Object.keys(data).sort().join(",") !== expectedFields ||
      ![
        data.baselineSha256,
        ...(v2 ? [data.baselineTreeSha256, data.scopeSha256] : []),
        data.expectedCallReceiptSha256,
        data.expectedPlanSha256,
        data.expectedResponseSha256,
        data.oracleSha256,
        data.proposalSha256,
        data.recipeSha256,
        data.resultSourceSha256,
      ].every((value) => typeof value === "string" && sha256.test(value)) ||
      typeof data.callId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(data.callId) ||
      typeof data.imageId !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(data.imageId)
    )
      throw new Error(
        "Repository claim needs frozen call, recipe and result identities",
      );
    return this.#db
      .transaction(() => {
        const attempt = this.#attempt(reservationId, { open: true });
        if (attempt.planSha256 !== data.expectedPlanSha256)
          throw new Error(
            "Repository claim plan differs from frozen collection",
          );
        const dispatchRow = this.#db
          .prepare(
            "SELECT claim_json FROM public_dispatches WHERE reservation_id=?",
          )
          .get(reservationId);
        if (!dispatchRow)
          throw new Error("Repository claim requires prior public dispatch");
        if (
          this.#db
            .prepare("SELECT 1 FROM oracle_invocations WHERE reservation_id=?")
            .get(reservationId)
        )
          throw new Error("Oracle invocation already claimed; never retry");
        const publicDispatch = publicDispatchClaim(dispatchRow.claim_json);
        this.#assertPublicDispatch(
          publicDispatch,
          attempt.reservation,
          attempt.plan,
        );
        const callRows = this.#db
          .prepare(
            "SELECT reservation_json,receipt_json FROM calls WHERE reservation_id=? ORDER BY ordinal",
          )
          .all(reservationId);
        if (callRows.length !== 1 || !callRows[0].receipt_json)
          throw new Error(
            "Repository claim requires exactly one settled model call",
          );
        const call = callReservationSchema.parse(
          decodeJson(callRows[0].reservation_json),
        );
        const receipt = callReceiptSchema.parse(
          decodeJson(callRows[0].receipt_json),
        );
        if (
          call.callId !== data.callId ||
          hashJson(receipt) !== data.expectedCallReceiptSha256 ||
          receipt.responseSha256 !== data.expectedResponseSha256
        )
          throw new Error(
            "Repository claim differs from retained model response",
          );
        const task = attempt.plan.tasks.find(
          (item) => item.taskId === attempt.reservation.taskId,
        );
        const claim = oracleInvocationClaimSchema.parse({
          version: "1.0.0",
          kind: v2
            ? "sealed-call-bound-repository-v2-invocation-claim"
            : "sealed-call-bound-repository-invocation-claim",
          reservationId,
          reservationSha256: hashJson(attempt.reservation),
          collectionId: attempt.reservation.collectionId,
          assignmentId: attempt.reservation.assignmentId,
          taskId: task.taskId,
          taskSha256: hashJson(task),
          planSha256: attempt.planSha256,
          publicDispatchSha256: hashJson(publicDispatch),
          baselineSha256: data.baselineSha256,
          ...(v2
            ? {
                scopeSha256: data.scopeSha256,
                baselineTreeSha256: data.baselineTreeSha256,
              }
            : {}),
          oracleSha256: data.oracleSha256,
          recipeSha256: data.recipeSha256,
          callId: call.callId,
          callReservationSha256: hashJson(call),
          callReceiptSha256: hashJson(receipt),
          responseSha256: receipt.responseSha256,
          proposalDerivation: "openai-chat-content-utf8-v1",
          proposalSha256: data.proposalSha256,
          resultSourceSha256: data.resultSourceSha256,
          resultSourceFormat: v2
            ? "sealed-repository-execution-tree-v2"
            : "sealed-repository-tree-v1",
          verifierKind: v2
            ? "sealed-repository-blackbox-v2"
            : "sealed-repository-blackbox-v1",
          imageId: data.imageId,
          claimedAt: now(),
        });
        this.#assertOracleInvocation(
          claim,
          attempt.reservation,
          attempt.plan,
          publicDispatch,
        );
        this.#db
          .prepare("INSERT INTO oracle_invocations VALUES(?,?)")
          .run(reservationId, canonicalJson(claim));
        this.#event(
          attempt.reservation.collectionId,
          v2
            ? "call-bound-repository-v2-invocation-claimed"
            : "call-bound-repository-invocation-claimed",
          claim,
        );
        return snapshot(claim);
      })
      .immediate();
  }
  /** Retain only a private artifact reference; the verdict never reaches the model. */
  retainOracleVerdict(reservationId, input) {
    const data = decodeJson(input);
    if (
      !data ||
      Array.isArray(data) ||
      Object.keys(data).sort().join(",") !==
        "claimSha256,verificationReference" ||
      typeof data.claimSha256 !== "string" ||
      !sha256.test(data.claimSha256) ||
      !data.verificationReference ||
      Array.isArray(data.verificationReference) ||
      Object.keys(data.verificationReference).sort().join(",") !==
        "bytes,sha256" ||
      typeof data.verificationReference.sha256 !== "string" ||
      !sha256.test(data.verificationReference.sha256) ||
      !Number.isSafeInteger(data.verificationReference.bytes) ||
      data.verificationReference.bytes < 1 ||
      data.verificationReference.bytes > 8192
    )
      throw new Error(
        "Oracle verdict needs exact bounded private reference and claim",
      );
    return this.#db
      .transaction(() => {
        const attempt = this.#attempt(reservationId, { open: true });
        const row = this.#db
          .prepare(
            "SELECT claim_json FROM oracle_invocations WHERE reservation_id=?",
          )
          .get(reservationId);
        if (!row) throw new Error("Oracle verdict requires a durable claim");
        if (
          this.#db
            .prepare("SELECT 1 FROM oracle_verdicts WHERE reservation_id=?")
            .get(reservationId)
        )
          throw new Error("Oracle verdict already retained; never replace");
        const claim = oracleInvocationClaimSchema.parse(
          decodeJson(row.claim_json),
        );
        if (
          claim.kind !== "sealed-call-bound-module-graph-invocation-claim" &&
          claim.kind !== "sealed-call-bound-repository-invocation-claim" &&
          claim.kind !== "sealed-call-bound-repository-v2-invocation-claim" &&
          data.verificationReference.bytes > 4096
        )
          throw new Error(
            "Existing oracle verdict remains bounded to 4096 bytes",
          );
        if (
          ![
            "sealed-call-bound-oracle-invocation-claim",
            "sealed-call-bound-engineering-invocation-claim",
            "sealed-call-bound-module-graph-invocation-claim",
            "sealed-call-bound-repository-invocation-claim",
            "sealed-call-bound-repository-v2-invocation-claim",
          ].includes(claim.kind) ||
          hashJson(claim) !== data.claimSha256
        )
          throw new Error("Oracle verdict differs from call-bound claim");
        const record = oracleVerdictRecordSchema.parse({
          version: "1.0.0",
          kind: "sealed-private-oracle-verdict-reference",
          reservationId,
          claimSha256: data.claimSha256,
          verificationSha256: data.verificationReference.sha256,
          verificationBytes: data.verificationReference.bytes,
          recordedAt: now(),
        });
        if (Date.parse(record.recordedAt) < Date.parse(claim.claimedAt))
          throw new Error("Oracle verdict predates its claim");
        this.#db
          .prepare("INSERT INTO oracle_verdicts VALUES(?,?)")
          .run(reservationId, canonicalJson(record));
        this.#event(
          attempt.reservation.collectionId,
          "oracle-verdict-retained",
          record,
        );
        return snapshot(record);
      })
      .immediate();
  }
  reserveCall(reservationId, input) {
    const data = decodeJson(input);
    return this.#db
      .transaction(() => {
        const attempt = this.#attempt(reservationId, { open: true }),
          config = attempt.plan.configurations[attempt.reservation.arm];
        if (
          this.#db
            .prepare("SELECT 1 FROM oracle_invocations WHERE reservation_id=?")
            .get(reservationId)
        )
          throw new Error(
            "Oracle opportunity consumed; no further model calls",
          );
        if (
          Date.now() < Date.parse(attempt.reservation.reservedAt) ||
          Date.now() >= Date.parse(attempt.plan.expiresAt) ||
          Date.now() - Date.parse(attempt.reservation.reservedAt) >=
            config.maxDurationMs
        )
          throw new Error(
            "Frozen attempt deadline has expired or clock moved backwards",
          );
        const calls = this.#db
          .prepare(
            "SELECT reservation_json FROM calls WHERE reservation_id=? ORDER BY ordinal",
          )
          .all(reservationId)
          .map((row) =>
            callReservationSchema.parse(decodeJson(row.reservation_json)),
          );
        for (const prior of this.#db
          .prepare(
            "SELECT reservation_json,receipt_json FROM calls WHERE reservation_id=? AND receipt_json IS NOT NULL",
          )
          .all(reservationId)) {
          const reserved = callReservationSchema.parse(
            decodeJson(prior.reservation_json),
          );
          const receipt = callReceiptSchema.parse(
            decodeJson(prior.receipt_json),
          );
          if (
            reserved.reservedCostUsd !== null &&
            [
              receipt.usage.costUsd,
              receipt.usage.reportedCostUsd,
              receipt.usage.chargedCostUsd,
            ].some(
              (amount) => amount !== null && amount > reserved.reservedCostUsd,
            )
          )
            throw new Error(
              "Known spend overrun prohibits further call reservations",
            );
        }
        // Caller may supply only call identity and frozen request/budget fields.
        if (
          !data ||
          Array.isArray(data) ||
          Object.keys(data).sort().join(",") !==
            "callId,providerId,requestSha256,requestedModel,reservedCostUsd"
        )
          throw new Error("Unexpected call reservation fields");
        const provider = config.providers.find(
          (item) =>
            item.providerId === data.providerId &&
            item.requestedModel === data.requestedModel,
        );
        if (calls.length >= config.maxCallsPerAttempt || !provider)
          throw new Error("Call exceeds frozen configuration");
        const spendClass = providerSpendClass(provider);
        let authorizationFields = {};
        if (spendClass === "paid") {
          const registered = this.#authorizationForCollection(
            attempt.reservation.collectionId,
          );
          if (!registered)
            throw new Error(
              "Paid provider dispatch requires a registered spending authorization",
            );
          const { authorization, sha256 } = registered;
          const timestamp = Date.now();
          if (
            timestamp < Date.parse(authorization.notBefore) ||
            timestamp >= Date.parse(authorization.expiresAt)
          )
            throw new Error(
              "Spending authorization is outside its approved time window",
            );
          if (
            provider.pricingSha256 === null ||
            provider.modelIdentity.kind !== "provider-snapshot" ||
            !authorization.providers.some((item) =>
              same(item, paidScope(provider)),
            )
          )
            throw new Error(
              "Paid provider model, origin or pricing drifted from authorization",
            );
          if (
            data.reservedCostUsd === null ||
            data.reservedCostUsd === undefined
          )
            throw new Error(
              "Paid provider requires a finite positive cost reservation",
            );
          const newMicros = microUsd(data.reservedCostUsd);
          if (newMicros <= 0n)
            throw new Error(
              "Paid provider requires a positive cost reservation",
            );
          const session = this.#sessionState(authorization);
          if (session.knownOverrun || session.ambiguousCalls)
            throw new Error(
              "Spending session has an overrun or ambiguous bill; further dispatch is stopped",
            );
          if (
            session.reservedMicros + newMicros >
            microUsd(authorization.totalCapUsd)
          )
            throw new Error("Call exceeds the total authorized session cap");
          authorizationFields = {
            authorizationId: authorization.authorizationId,
            authorizationSha256: sha256,
            sessionId: authorization.sessionId,
          };
        }
        const call = callReservationSchema.parse({
          ...data,
          ...authorizationFields,
          version: "1.0.0",
          kind: "sealed-call-reservation",
          reservationId,
          ordinal: calls.length,
          reservedAt: now(),
        });
        if (
          config.maxCostUsdPerAttempt !== null &&
          (call.reservedCostUsd === null ||
            calls.some((item) => item.reservedCostUsd === null) ||
            calls.reduce((sum, item) => sum + item.reservedCostUsd, 0) +
              call.reservedCostUsd >
              config.maxCostUsdPerAttempt)
        )
          throw new Error("Call exceeds conservative reserved budget");
        this.#db
          .prepare("INSERT INTO calls VALUES(?,?,?,?,NULL)")
          .run(call.callId, reservationId, call.ordinal, canonicalJson(call));
        this.#event(attempt.reservation.collectionId, "call-reserved", call);
        return snapshot(call);
      })
      .immediate();
  }
  #settleCall(input) {
    const receipt = callReceiptSchema.parse(decodeJson(input)),
      row = this.#db
        .prepare("SELECT * FROM calls WHERE id=?")
        .get(receipt.callId);
    if (!row || row.receipt_json)
      throw new Error("Unknown or already settled call");
    const attempt = this.#attempt(row.reservation_id, { open: true }),
      reservation = callReservationSchema.parse(
        decodeJson(row.reservation_json),
      );
    if (
      receipt.reservationSha256 !== hashJson(reservation) ||
      Date.parse(receipt.finishedAt) < Date.parse(reservation.reservedAt) ||
      Date.parse(receipt.finishedAt) > Date.now() + 60000
    )
      throw new Error("Call receipt identity or chronology mismatch");
    if (
      receipt.status === "completed" &&
      (!receipt.responseSha256 || !receipt.reportedModel)
    )
      throw new Error("Completed call needs original response/model identity");
    if (receipt.usage.basis === "aggregate")
      throw new Error("Individual call usage cannot be an aggregate");
    const provider = attempt.plan.configurations[
      attempt.reservation.arm
    ].providers.find((item) => item.providerId === reservation.providerId);
    if (
      providerSpendClass(provider) === "paid" &&
      receipt.status === "completed" &&
      receipt.reportedModel !== reservation.requestedModel
    )
      throw new Error(
        "Paid response model differs from the authorized snapshot",
      );
    if (receipt.usage.basis === "local-no-api-charge") {
      const endpoint = new URL(provider.endpointOrigin);
      if (
        !["local", "laya"].includes(provider.kind) ||
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        !["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname)
      )
        throw new Error(
          "Local no-API-charge accounting requires a frozen loopback provider",
        );
    }
    if (
      receipt.usage.basis === "reviewed-rate-card" &&
      receipt.usage.pricingSha256 !== provider.pricingSha256
    )
      throw new Error("Call pricing differs from its frozen configuration");
    this.#db
      .prepare("UPDATE calls SET receipt_json=? WHERE id=?")
      .run(canonicalJson(receipt), receipt.callId);
    this.#event(attempt.reservation.collectionId, "call-settled", receipt);
    return receipt;
  }
  completeCall(input) {
    return this.#db
      .transaction(() => snapshot(this.#settleCall(input)))
      .immediate();
  }
  #settleAttempt(input) {
    const receipt = attemptReceiptSchema.parse(decodeJson(input)),
      attempt = this.#attempt(receipt.reservationId, { open: true }),
      reservation = attempt.reservation;
    const oracleRow = this.#db
      .prepare(
        "SELECT claim_json FROM oracle_invocations WHERE reservation_id=?",
      )
      .get(reservation.reservationId);
    if (oracleRow) {
      const oracleClaim = oracleInvocationClaimSchema.parse(
        decodeJson(oracleRow.claim_json),
      );
      if (
        [
          "sealed-call-bound-oracle-invocation-claim",
          "sealed-call-bound-engineering-invocation-claim",
          "sealed-call-bound-module-graph-invocation-claim",
          "sealed-call-bound-repository-invocation-claim",
          "sealed-call-bound-repository-v2-invocation-claim",
        ].includes(oracleClaim.kind) &&
        (receipt.status === "completed" || receipt.outcome.success !== null)
      )
        throw new Error(
          "Call-bound oracle is non-authorizing and cannot settle measured attempt success",
        );
    }
    const calls = this.#db
      .prepare("SELECT * FROM calls WHERE reservation_id=? ORDER BY ordinal")
      .all(reservation.reservationId);
    if (calls.some((row) => !row.receipt_json))
      throw new Error("All reserved calls require terminal accounting");
    const callReceipts = calls.map((row) =>
      callReceiptSchema.parse(decodeJson(row.receipt_json)),
    );
    if (
      callReceipts.some(
        (call) => Date.parse(call.finishedAt) > Date.parse(receipt.finishedAt),
      )
    )
      throw new Error("Attempt cannot finish before its original calls");
    if (
      receipt.reservationSha256 !== hashJson(reservation) ||
      !same(receipt.callReceiptSha256s, callReceipts.map(hashJson)) ||
      Date.parse(receipt.finishedAt) < Date.parse(reservation.reservedAt) ||
      Date.parse(receipt.finishedAt) > Date.now() + 60000
    )
      throw new Error(
        "Attempt receipt identity, complete call inventory or chronology mismatch",
      );
    const total = (field) =>
      !calls.length || callReceipts.some((call) => call.usage[field] === null)
        ? null
        : callReceipts.reduce((sum, call) => sum + call.usage[field], 0);
    for (const field of [
      "inputTokens",
      "outputTokens",
      "costUsd",
      "reportedCostUsd",
      "chargedCostUsd",
    ])
      if (receipt.usage[field] !== total(field))
        throw new Error(
          "Attempt usage must account for every call exactly once",
        );
    const task = attempt.plan.tasks.find(
        (item) => item.taskId === reservation.taskId,
      ),
      records = new Set();
    for (const observation of receipt.observations) {
      if (
        records.has(observation.recordId) ||
        observation.category !== task.category ||
        observation.stateFormatVersion !== task.stateFormatVersion ||
        !calls.some((row) => row.id === observation.callId) ||
        new Set(observation.candidates).size !==
          observation.candidates.length ||
        (observation.selected !== null &&
          !observation.candidates.includes(observation.selected))
      )
        throw new Error(
          "Observation identity or candidate set differs from the frozen task/calls",
        );
      records.add(observation.recordId);
      const call = callReservationSchema.parse(
        decodeJson(
          calls.find((row) => row.id === observation.callId).reservation_json,
        ),
      );
      if (call.providerId !== observation.providerId)
        throw new Error("Observation provider differs from its call");
      const original = callReceipts.find(
        (item) => item.callId === observation.callId,
      );
      if (
        original.reportedModel !== null &&
        original.reportedModel !== observation.model
      )
        throw new Error(
          "Observation model differs from the original reported model",
        );
      if (
        Date.parse(observation.observedAt) < Date.parse(call.reservedAt) ||
        Date.parse(observation.observedAt) > Date.parse(receipt.finishedAt)
      )
        throw new Error(
          "Observation chronology differs from its original attempt",
        );
    }
    if (
      receipt.publicRequestSha256 !== null &&
      receipt.publicRequestSha256 !== task.publicPacketSha256
    )
      throw new Error(
        "Public worker packet differs from its frozen commitment",
      );
    if (receipt.usage.basis !== "aggregate")
      throw new Error(
        "Attempt usage is an aggregate of original call receipts, never independent billing evidence",
      );
    if (
      calls.some((row, index) => {
        const reserved = decodeJson(row.reservation_json).reservedCostUsd;
        return (
          reserved !== null &&
          [
            callReceipts[index].usage.costUsd,
            callReceipts[index].usage.reportedCostUsd,
            callReceipts[index].usage.chargedCostUsd,
          ].some((amount) => amount !== null && amount > reserved)
        );
      }) &&
      !receipt.outcome.policyViolation
    )
      throw new Error(
        "Reported spend beyond a reservation requires a policy-violation outcome",
      );
    if (
      receipt.status === "completed" &&
      (!calls.length ||
        !receipt.publicRequestSha256 ||
        !receipt.proposalSha256 ||
        !receipt.resultSourceSha256 ||
        receipt.outcome.success === null ||
        !receipt.outcome.verificationSha256 ||
        !receipt.outcome.runtimeSha256)
    )
      throw new Error(
        "Completed attempt needs independently checkable artifact references",
      );
    if (receipt.status !== "completed" && receipt.outcome.success === true)
      throw new Error(
        "A noncompleted attempt cannot claim a successful outcome",
      );
    if (
      ["collector-crashed", "infrastructure-error"].includes(receipt.status) &&
      receipt.outcome.success !== null
    )
      throw new Error(
        "Infrastructure ambiguity cannot become a measured outcome",
      );
    this.#db
      .prepare("UPDATE attempts SET receipt_json=? WHERE id=?")
      .run(canonicalJson(receipt), reservation.reservationId);
    this.#event(reservation.collectionId, "attempt-settled", receipt);
    return receipt;
  }
  completeAttempt(input) {
    return this.#db
      .transaction(() => snapshot(this.#settleAttempt(input)))
      .immediate();
  }
  recoverCollection(collectionId, { abandonOutstanding = false } = {}) {
    if (abandonOutstanding !== true)
      throw new Error(
        "Recovery requires explicit abandonment; it never reissues requests",
      );
    return this.#db
      .transaction(() => {
        this.#collection(collectionId, { open: true });
        const recovered = [];
        for (const row of this.#db
          .prepare(
            "SELECT * FROM attempts WHERE collection_id=? AND receipt_json IS NULL ORDER BY rowid",
          )
          .all(collectionId)) {
          for (const call of this.#db
            .prepare(
              "SELECT * FROM calls WHERE reservation_id=? AND receipt_json IS NULL ORDER BY ordinal",
            )
            .all(row.id))
            this.#settleCall({
              version: "1.0.0",
              kind: "sealed-call-receipt",
              callId: call.id,
              reservationSha256: hashJson(decodeJson(call.reservation_json)),
              status: "ambiguous",
              responseSha256: null,
              reportedModel: null,
              usage: unknownUsage(),
              finishedAt: now(),
            });
          const calls = this.#db
            .prepare(
              "SELECT receipt_json FROM calls WHERE reservation_id=? ORDER BY ordinal",
            )
            .all(row.id)
            .map((call) => decodeJson(call.receipt_json));
          const knownOverrun = this.#db
            .prepare(
              "SELECT reservation_json,receipt_json FROM calls WHERE reservation_id=?",
            )
            .all(row.id)
            .some((call) => {
              const reserved = decodeJson(
                call.reservation_json,
              ).reservedCostUsd;
              const usage = decodeJson(call.receipt_json).usage;
              return (
                reserved !== null &&
                [
                  usage.costUsd,
                  usage.reportedCostUsd,
                  usage.chargedCostUsd,
                ].some((amount) => amount !== null && amount > reserved)
              );
            });
          const usage = unknownUsage();
          for (const field of [
            "inputTokens",
            "outputTokens",
            "costUsd",
            "reportedCostUsd",
            "chargedCostUsd",
          ])
            usage[field] =
              !calls.length || calls.some((call) => call.usage[field] === null)
                ? null
                : calls.reduce((sum, call) => sum + call.usage[field], 0);
          usage.basis = "aggregate";
          recovered.push(
            this.#settleAttempt({
              version: "1.0.0",
              kind: "sealed-attempt-receipt",
              reservationId: row.id,
              reservationSha256: hashJson(decodeJson(row.reservation_json)),
              status: "collector-crashed",
              finishedAt: now(),
              publicRequestSha256: null,
              proposalSha256: null,
              resultSourceSha256: null,
              observations: [],
              callReceiptSha256s: calls.map(hashJson),
              outcome: {
                success: null,
                policyViolation: knownOverrun,
                verificationSha256: null,
                runtimeSha256: null,
              },
              usage,
              limitations: [
                "Outstanding reservation explicitly abandoned; dispatch and outcome may be unknown. No request was reissued.",
              ],
            }),
          );
        }
        return snapshot(recovered);
      })
      .immediate();
  }
  #inspect(collectionId) {
    const collection = this.#collection(collectionId),
      events = this.#db
        .prepare("SELECT * FROM events WHERE collection_id=? ORDER BY sequence")
        .all(collectionId);
    let previous = null;
    for (const [index, row] of events.entries()) {
      const event = eventSchema.parse(decodeJson(row.json));
      if (
        event.sequence !== index + 1 ||
        event.previousSha256 !== previous ||
        hashJson(event) !== row.hash
      )
        throw new Error("Ledger event chain mismatch");
      previous = row.hash;
    }
    if (!events.length) throw new Error("Missing ledger event inventory");
    const assignments = collection.plan.assignments.map((assignment) => {
      const row = this.#db
        .prepare(
          "SELECT * FROM attempts WHERE collection_id=? AND assignment_id=?",
        )
        .get(collectionId, assignment.assignmentId);
      const reservation = row
        ? reservationSchema.parse(decodeJson(row.reservation_json))
        : null;
      const dispatchRow = row
        ? this.#db
            .prepare(
              "SELECT claim_json FROM public_dispatches WHERE reservation_id=?",
            )
            .get(row.id)
        : null;
      const publicDispatch = dispatchRow
        ? publicDispatchClaim(dispatchRow.claim_json)
        : null;
      if (publicDispatch)
        this.#assertPublicDispatch(
          publicDispatch,
          reservation,
          collection.plan,
        );
      const oracleRow = row
        ? this.#db
            .prepare(
              "SELECT claim_json FROM oracle_invocations WHERE reservation_id=?",
            )
            .get(row.id)
        : null;
      const oracleInvocation = oracleRow
        ? oracleInvocationClaimSchema.parse(decodeJson(oracleRow.claim_json))
        : null;
      if (oracleInvocation) {
        this.#assertOracleInvocation(
          oracleInvocation,
          reservation,
          collection.plan,
          publicDispatch,
        );
        if (
          row.receipt_json &&
          Date.parse(oracleInvocation.claimedAt) >
            Date.parse(decodeJson(row.receipt_json).finishedAt)
        )
          throw new Error("Oracle claim follows terminal attempt");
      }
      const verdictRow = row
        ? this.#db
            .prepare(
              "SELECT record_json FROM oracle_verdicts WHERE reservation_id=?",
            )
            .get(row.id)
        : null;
      const oracleVerdict = verdictRow
        ? oracleVerdictRecordSchema.parse(decodeJson(verdictRow.record_json))
        : null;
      if (
        oracleVerdict &&
        (!oracleInvocation ||
          ![
            "sealed-call-bound-oracle-invocation-claim",
            "sealed-call-bound-engineering-invocation-claim",
            "sealed-call-bound-module-graph-invocation-claim",
            "sealed-call-bound-repository-invocation-claim",
            "sealed-call-bound-repository-v2-invocation-claim",
          ].includes(oracleInvocation.kind) ||
          oracleVerdict.reservationId !== row.id ||
          oracleVerdict.claimSha256 !== hashJson(oracleInvocation) ||
          Date.parse(oracleVerdict.recordedAt) <
            Date.parse(oracleInvocation.claimedAt) ||
          (row.receipt_json &&
            Date.parse(oracleVerdict.recordedAt) >
              Date.parse(decodeJson(row.receipt_json).finishedAt)))
      )
        throw new Error("Oracle verdict reference differs from its claim");
      const calls = row
        ? this.#db
            .prepare(
              "SELECT * FROM calls WHERE reservation_id=? ORDER BY ordinal",
            )
            .all(row.id)
        : [];
      return {
        assignment,
        reservation,
        publicDispatch,
        oracleInvocation,
        oracleVerdict,
        receipt: row?.receipt_json
          ? attemptReceiptSchema.parse(decodeJson(row.receipt_json))
          : null,
        calls: calls.map((call) => ({
          reservation: callReservationSchema.parse(
            decodeJson(call.reservation_json),
          ),
          receipt: call.receipt_json
            ? callReceiptSchema.parse(decodeJson(call.receipt_json))
            : null,
        })),
      };
    });
    const closure = collection.closure_json
      ? closureSchema.parse(decodeJson(collection.closure_json))
      : null;
    const artifacts = [{ type: "registered", payload: collection.plan }];
    for (const item of assignments) {
      if (item.reservation)
        artifacts.push({ type: "attempt-reserved", payload: item.reservation });
      if (item.publicDispatch)
        artifacts.push({
          type: "public-dispatch-claimed",
          payload: item.publicDispatch,
        });
      if (item.oracleInvocation)
        artifacts.push({
          type:
            item.oracleInvocation.kind ===
            "sealed-call-bound-oracle-invocation-claim"
              ? "call-bound-oracle-invocation-claimed"
              : item.oracleInvocation.kind ===
                  "sealed-call-bound-engineering-invocation-claim"
                ? "call-bound-engineering-invocation-claimed"
                : item.oracleInvocation.kind ===
                    "sealed-call-bound-module-graph-invocation-claim"
                  ? "call-bound-module-graph-invocation-claimed"
                  : item.oracleInvocation.kind ===
                      "sealed-call-bound-repository-invocation-claim"
                    ? "call-bound-repository-invocation-claimed"
                    : item.oracleInvocation.kind ===
                        "sealed-call-bound-repository-v2-invocation-claim"
                      ? "call-bound-repository-v2-invocation-claimed"
                      : "oracle-invocation-claimed",
          payload: item.oracleInvocation,
        });
      if (item.oracleVerdict)
        artifacts.push({
          type: "oracle-verdict-retained",
          payload: item.oracleVerdict,
        });
      for (const call of item.calls) {
        artifacts.push({ type: "call-reserved", payload: call.reservation });
        if (call.receipt)
          artifacts.push({ type: "call-settled", payload: call.receipt });
      }
      if (item.receipt)
        artifacts.push({ type: "attempt-settled", payload: item.receipt });
    }
    if (closure) artifacts.push({ type: "closed", payload: closure });
    const identities = artifacts
      .map((item) => `${item.type}:${hashJson(item.payload)}`)
      .sort();
    const recorded = events
      .map((row) => {
        const event = decodeJson(row.json);
        return `${event.type}:${event.payloadSha256}`;
      })
      .sort();
    if (!same(identities, recorded))
      throw new Error("Ledger artifact/event inventory mismatch");
    const registered = this.#db
      .prepare(
        "SELECT json FROM assignments WHERE collection_id=? ORDER BY ordinal",
      )
      .all(collectionId)
      .map((row) => decodeJson(row.json));
    if (
      !same(
        registered,
        [...collection.plan.assignments].sort((a, b) => a.ordinal - b.ordinal),
      )
    )
      throw new Error("Frozen assignment inventory mismatch");
    if (closure) {
      const beforeClose = events.at(-2)?.hash;
      const expected = assignments.map((item) => ({
        assignmentId: item.assignment.assignmentId,
        taskId: item.assignment.taskId,
        arm: item.assignment.arm,
        ordinal: item.assignment.ordinal,
        status: item.receipt ? "terminal" : "not-attempted",
        reservationSha256: item.reservation ? hashJson(item.reservation) : null,
        receiptSha256: item.receipt ? hashJson(item.receipt) : null,
        callReservationSha256s: item.calls.map((call) =>
          hashJson(call.reservation),
        ),
        callReceiptSha256s: item.calls.map((call) =>
          call.receipt ? hashJson(call.receipt) : null,
        ),
      }));
      if (
        closure.eventHeadSha256 !== beforeClose ||
        closure.planSha256 !== collection.planSha256 ||
        !same(closure.inventory, expected) ||
        closure.complete !== assignments.every((item) => !!item.receipt)
      )
        throw new Error(
          "Closure does not cover the complete assignment inventory",
        );
    }
    return {
      plan: collection.plan,
      planSha256: collection.planSha256,
      registry: collection.registry,
      assignments,
      events: events.map((row) => ({
        event: decodeJson(row.json),
        sha256: row.hash,
      })),
      closure,
      promotionEligible: false,
    };
  }
  inspectCollection(collectionId) {
    return this.#db
      .transaction(() => snapshot(this.#inspect(collectionId)))
      .deferred();
  }
  closeCollection(collectionId) {
    return this.#db
      .transaction(() => {
        this.#collection(collectionId, { open: true });
        const inspection = this.#inspect(collectionId);
        if (
          inspection.assignments.some(
            (item) => item.reservation && !item.receipt,
          )
        )
          throw new Error(
            "Recover or settle every outstanding reservation before closure",
          );
        const closure = closureSchema.parse({
          version: "1.0.0",
          kind: "sealed-collection-closure",
          collectionId,
          planSha256: inspection.planSha256,
          closedAt: now(),
          complete: inspection.assignments.every((item) => !!item.receipt),
          promotionEligible: false,
          inventory: inspection.assignments.map((item) => ({
            assignmentId: item.assignment.assignmentId,
            taskId: item.assignment.taskId,
            arm: item.assignment.arm,
            ordinal: item.assignment.ordinal,
            status: item.receipt ? "terminal" : "not-attempted",
            reservationSha256: item.reservation
              ? hashJson(item.reservation)
              : null,
            receiptSha256: item.receipt ? hashJson(item.receipt) : null,
            callReservationSha256s: item.calls.map((call) =>
              hashJson(call.reservation),
            ),
            callReceiptSha256s: item.calls.map((call) =>
              hashJson(call.receipt),
            ),
          })),
          eventHeadSha256: inspection.events.at(-1).sha256,
          limitations: LIMITATIONS,
        });
        this.#db
          .prepare("UPDATE collections SET closure_json=? WHERE id=?")
          .run(canonicalJson(closure), collectionId);
        this.#event(collectionId, "closed", closure);
        return snapshot(closure);
      })
      .immediate();
  }
}
