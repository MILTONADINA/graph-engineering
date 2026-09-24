// NON-AUTHORIZING reference protocol. This process-local state machine is not
// persistent, independently operated, or a source of promotion authority.
import { sign, type KeyObject } from "node:crypto";
import { z } from "zod";
import {
  canonicalJson,
  closureSchema,
  decodeJson,
  digestSchema,
  eventSchema,
  freezeJson,
  hashJson,
} from "./sealed-collection-schema.js";
import { SIGNED_CURRENT_WITNESS_DOMAIN } from "./sealed-signed-current-witness.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const registrationSchema = z
  .object({
    projectId: id,
    collectionId: id,
    planSha256: digestSchema,
    registrySha256: digestSchema,
    firstEvent: eventSchema,
  })
  .strict();
const populationSchema = z
  .object({
    sourceInventorySha256: digestSchema,
    signedManifestSha256: digestSchema,
    populationTrustSha256: digestSchema,
  })
  .strict();
const trustSchema = z
  .object({
    rowTrustSha256: digestSchema,
    aggregateTrustSha256: digestSchema,
  })
  .strict();
const querySchema = z
  .object({
    witnessId: id,
    projectId: id,
    collectionId: id,
    challenge: digestSchema,
  })
  .strict();

type Registration = z.infer<typeof registrationSchema> & {
  revision: number;
  firstEventSha256: string;
};
type Population = z.infer<typeof populationSchema> & { revision: number };
type Trust = z.infer<typeof trustSchema> & { revision: number };
type Event = z.infer<typeof eventSchema>;

/**
 * A small reference for the external witness's append protocol. It accepts
 * complete event bytes, not caller-supplied event hashes; each append verifies
 * sequence and previous-hash continuity. In-process ordering is not evidence
 * that registration happened before a real-world attempt: replaying a finished
 * collection into a new instance would pass these same checks.
 */
export class ReferenceSealedWitness {
  readonly #witnessId: string;
  readonly #keyId: string;
  readonly #privateKey: KeyObject;
  readonly #maxEvents: number;
  #revision = 0;
  #registration?: Registration;
  #population?: Population;
  #trust?: Trust;
  #firstAttempt?: { revision: number; eventSha256: string };
  #events: Array<Readonly<{ event: Event; sha256: string }>> = [];
  #closureSha256?: string;

  constructor(options: {
    witnessId: string;
    keyId: string;
    privateKey: KeyObject;
    /** Testable ceiling; never higher than the full-cohort schema's limit. */
    maxEvents?: number;
  }) {
    this.#witnessId = id.parse(options.witnessId);
    this.#keyId = id.parse(options.keyId);
    this.#maxEvents = z
      .number()
      .int()
      .min(2)
      .max(100_000)
      .default(100_000)
      .parse(options.maxEvents);
    if (
      options.privateKey?.type !== "private" ||
      options.privateKey.asymmetricKeyType !== "ed25519"
    )
      throw new Error("Reference witness requires an Ed25519 private key");
    this.#privateKey = options.privateKey;
  }

  register(input: unknown): void {
    if (this.#registration)
      throw new Error("Reference witness registration is immutable");
    const registration = registrationSchema.parse(decodeJson(input));
    const first = registration.firstEvent;
    if (
      first.type !== "registered" ||
      first.sequence !== 1 ||
      first.previousSha256 !== null ||
      first.collectionId !== registration.collectionId ||
      first.payloadSha256 !== registration.planSha256
    )
      throw new Error(
        "Reference witness needs the original registration event",
      );
    const firstEventSha256 = hashJson(first);
    this.#registration = freezeJson({
      ...registration,
      revision: ++this.#revision,
      firstEventSha256,
    });
    this.#events.push(freezeJson({ event: first, sha256: firstEventSha256 }));
  }

  precommitPopulation(input: unknown): void {
    if (!this.#registration || this.#population || this.#firstAttempt)
      throw new Error(
        "Reference witness population must precede first attempt",
      );
    this.#population = freezeJson({
      ...populationSchema.parse(decodeJson(input)),
      revision: ++this.#revision,
    });
  }

  freezeTrust(input: unknown): void {
    if (!this.#population || this.#trust || this.#firstAttempt)
      throw new Error("Reference witness trust must precede first attempt");
    this.#trust = freezeJson({
      ...trustSchema.parse(decodeJson(input)),
      revision: ++this.#revision,
    });
  }

  appendEvent(eventInput: unknown, closureInput?: unknown): void {
    if (!this.#registration || !this.#population || !this.#trust)
      throw new Error(
        "Reference witness needs pre-run registration, population and trust",
      );
    if (this.#closureSha256)
      throw new Error("Reference witness closed collection is immutable");
    if (this.#events.length >= this.#maxEvents)
      throw new Error("Reference witness event limit reached");
    const event = eventSchema.parse(decodeJson(eventInput));
    const previous = this.#events.at(-1)!;
    if (
      event.collectionId !== this.#registration.collectionId ||
      event.sequence !== this.#events.length + 1 ||
      event.previousSha256 !== previous.sha256 ||
      Date.parse(event.createdAt) < Date.parse(previous.event.createdAt) ||
      event.type === "registered"
    )
      throw new Error(
        "Reference witness event chain is forked, replayed or out of order",
      );
    if (!this.#firstAttempt && event.type !== "attempt-reserved")
      throw new Error(
        "Reference witness first appended event must reserve an attempt",
      );
    let closureSha256: string | undefined;
    if (event.type === "closed") {
      const closure = closureSchema.parse(decodeJson(closureInput));
      closureSha256 = hashJson(closure);
      if (
        !closure.complete ||
        closure.collectionId !== this.#registration.collectionId ||
        closure.planSha256 !== this.#registration.planSha256 ||
        closure.eventHeadSha256 !== previous.sha256 ||
        event.payloadSha256 !== closureSha256 ||
        Date.parse(event.createdAt) < Date.parse(closure.closedAt)
      )
        throw new Error(
          "Reference witness closure differs from the chained head",
        );
    } else if (closureInput !== undefined) {
      throw new Error(
        "Reference witness closure is only valid on the closed event",
      );
    }
    const sha256 = hashJson(event);
    const revision = ++this.#revision;
    this.#events.push(freezeJson({ event, sha256 }));
    if (!this.#firstAttempt)
      this.#firstAttempt = freezeJson({ revision, eventSha256: sha256 });
    if (closureSha256) this.#closureSha256 = closureSha256;
  }

  /** Fresh signed response compatible with createSignedCurrentSealedWitnessReader. */
  current(queryInput: unknown): unknown {
    const query = querySchema.parse(decodeJson(queryInput));
    const registration = this.#registration;
    const population = this.#population;
    const trust = this.#trust;
    const firstAttempt = this.#firstAttempt;
    if (
      !registration ||
      !population ||
      !trust ||
      !firstAttempt ||
      !this.#closureSha256
    )
      throw new Error("Reference witness has no closed current checkpoint");
    if (
      query.witnessId !== this.#witnessId ||
      query.projectId !== registration.projectId ||
      query.collectionId !== registration.collectionId
    )
      throw new Error("Reference witness query identity differs");
    const issued = Date.now();
    const checkpoint = {
      version: "2.0.0" as const,
      kind: "sealed-governance-current-checkpoint" as const,
      ...query,
      issuedAt: new Date(issued).toISOString(),
      expiresAt: new Date(issued + 30_000).toISOString(),
      checkpointRevision: this.#revision,
      registration: {
        revision: registration.revision,
        planSha256: registration.planSha256,
        registrySha256: registration.registrySha256,
        firstEventSha256: registration.firstEventSha256,
      },
      population,
      firstAttempt,
      head: {
        revision: this.#revision,
        eventCount: this.#events.length,
        eventHeadSha256: this.#events.at(-1)!.sha256,
        closureSha256: this.#closureSha256,
      },
      currentTrust: trust,
    };
    const unsigned = {
      version: "1.0.0" as const,
      kind: "signed-sealed-governance-current-checkpoint" as const,
      keyId: this.#keyId,
      checkpoint,
    };
    const signature = sign(
      null,
      Buffer.from(SIGNED_CURRENT_WITNESS_DOMAIN + canonicalJson(unsigned)),
      this.#privateKey,
    ).toString("base64");
    return freezeJson({ ...unsigned, signature });
  }
}
