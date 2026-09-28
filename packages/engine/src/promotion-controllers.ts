// Controller interfaces for the promotion trust boundary
// (docs/promotion-trust-boundary.md, "Controller interfaces"). Selection is by
// the closed registries below, named only in the root-owned D3 trust anchor.
// No environment variable, CLI flag, project setting, constructor argument or
// data-dir file can add or select a controller. Every registry holds only
// "none", which refuses, so no witness, signer key or model identity can be
// obtained in this build.

export type EvidenceSignerRole =
  | "curator"
  | "selector"
  | "auditor"
  | "source"
  | "labeler"
  | "reviewer"
  | "collector"
  | "aggregate-reviewer"
  | "worker"
  | "oracle"
  | "approver"
  | "issuer";

export interface PublicKeyPin {
  keyId: string;
  actorId: string;
  role: EvidenceSignerRole;
  publicKeySha256: string;
}

export interface SignedCollectionCheckpoint {
  witnessId: string;
  projectId: string;
  collectionId: string;
  challenge: string;
  /** ISO times; a reply is fresh only inside a short bounded window. */
  issuedAt: string;
  expiresAt: string;
  checkpointSha256: string;
  frozenDigests: Readonly<Record<string, string>>;
}

export interface SignedGrantStatus {
  witnessId: string;
  projectId: string;
  grantId: string;
  challenge: string;
  status: "unregistered" | "active" | "revoked";
  issuedAt: string;
  expiresAt: string;
}

export interface AttestedModelIdentity {
  evidence: "runtime-attestation";
  modelIdentitySha256: string;
}

export interface WitnessController {
  readonly kind: "none";
  readCollectionCheckpoint(request: {
    witnessId: string;
    projectId: string;
    collectionId: string;
    challenge: string;
  }): Promise<SignedCollectionCheckpoint>;
  /**
   * The current governance checkpoint the sealed readiness audit (step 5)
   * parses: the `sealed-governance-current-checkpoint` v1/v2 shape in
   * sealed-governance-witness.ts, answering the same kind of fresh challenge.
   * It is a different document from `readCollectionCheckpoint`'s reply, so a
   * real witness adapter must supply both; the importer never converts one
   * into the other.
   */
  readGovernanceCheckpoint(request: {
    witnessId: string;
    projectId: string;
    collectionId: string;
    challenge: string;
  }): Promise<unknown>;
  readGrantStatus(request: {
    witnessId: string;
    projectId: string;
    grantId: string;
    challenge: string;
  }): Promise<SignedGrantStatus>;
}

export interface SignerCustody {
  readonly kind: "none";
  resolveVerificationKey(
    role: EvidenceSignerRole,
    keyId: string,
    atMs: number,
  ): Promise<PublicKeyPin | undefined>;
}

export interface ModelIdentityAttestor {
  readonly kind: "none";
  attest(route: {
    providerKind: "laya" | "jev";
    endpointOrigin: string;
    requestedModel: string;
  }): Promise<AttestedModelIdentity | undefined>;
}

/** The rejection every "none" witness raises. */
export class WitnessNotSelectedError extends Error {
  readonly code = "witness-not-selected" as const;
  constructor() {
    super("witness-not-selected: no independently operated witness exists");
    this.name = "WitnessNotSelectedError";
  }
}

const noneWitness: WitnessController = Object.freeze({
  kind: "none" as const,
  async readCollectionCheckpoint(): Promise<SignedCollectionCheckpoint> {
    throw new WitnessNotSelectedError();
  },
  async readGovernanceCheckpoint(): Promise<unknown> {
    throw new WitnessNotSelectedError();
  },
  async readGrantStatus(): Promise<SignedGrantStatus> {
    throw new WitnessNotSelectedError();
  },
});
const noneCustody: SignerCustody = Object.freeze({
  kind: "none" as const,
  async resolveVerificationKey(): Promise<PublicKeyPin | undefined> {
    return undefined;
  },
});
const noneAttestor: ModelIdentityAttestor = Object.freeze({
  kind: "none" as const,
  async attest(): Promise<AttestedModelIdentity | undefined> {
    return undefined;
  },
});

/** Closed registries. Adding an entry is a reviewed source change (PR-5). */
export const WITNESS_CONTROLLERS = Object.freeze({ none: noneWitness });
export const SIGNER_CUSTODIES = Object.freeze({ none: noneCustody });
export const MODEL_IDENTITY_ATTESTORS = Object.freeze({ none: noneAttestor });

export type WitnessControllerName = keyof typeof WITNESS_CONTROLLERS;
export type SignerCustodyName = keyof typeof SIGNER_CUSTODIES;
export type ModelIdentityAttestorName = keyof typeof MODEL_IDENTITY_ATTESTORS;

export interface PromotionControllers {
  witness: WitnessController;
  custody: SignerCustody;
  attestor: ModelIdentityAttestor;
}

/** Look controllers up by the names the D3 anchor pins; nothing else selects them. */
export function promotionControllersFor(names: {
  witness: WitnessControllerName;
  custody: SignerCustodyName;
  modelIdentity: ModelIdentityAttestorName;
}): PromotionControllers {
  const witness = Object.hasOwn(WITNESS_CONTROLLERS, names.witness)
    ? WITNESS_CONTROLLERS[names.witness]
    : undefined;
  const custody = Object.hasOwn(SIGNER_CUSTODIES, names.custody)
    ? SIGNER_CUSTODIES[names.custody]
    : undefined;
  const attestor = Object.hasOwn(MODEL_IDENTITY_ATTESTORS, names.modelIdentity)
    ? MODEL_IDENTITY_ATTESTORS[names.modelIdentity]
    : undefined;
  if (!witness || !custody || !attestor)
    throw new Error("Promotion controller is not in the closed registry");
  return { witness, custody, attestor };
}

/** True while any controller is still "none", which is every build today. */
export function anyControllerUnselected(
  controllers: PromotionControllers,
): boolean {
  return (
    controllers.witness.kind === "none" ||
    controllers.custody.kind === "none" ||
    controllers.attestor.kind === "none"
  );
}
