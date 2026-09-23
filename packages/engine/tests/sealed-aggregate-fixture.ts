import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  evaluateFullCohort,
  freezeCohortCalibration,
} from "../src/full-cohort-evaluation.js";
import type { CohortInspection } from "../src/full-cohort-ledger.js";
import { inspectSealedHeldOutReviewSignatures } from "../src/promotion-authority.js";
import { canonicalJson, hashJson } from "../src/sealed-collection-schema.js";

export const day = "2026-01-02T00:00:00.000Z";
const labelerAt = "2026-01-02T01:00:00.000Z";
const reviewedAt = "2026-01-02T01:30:00.000Z";
const rowReviewerAt = "2026-01-02T02:00:00.000Z";
const collectedAt = "2026-01-02T03:00:00.000Z";
export const collectorAt = "2026-01-02T03:10:00.000Z";
export const aggregateReviewerAt = "2026-01-02T03:20:00.000Z";
export const nowMs = Date.parse("2026-01-03T00:00:00.000Z");
const sha256 = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
const limitation = ["Synthetic fixture; no protected execution or approval."];
type ModuleGraphFixtureOptions = {
  largeArtifacts?: boolean;
  badPath?: boolean;
  badManifest?: boolean;
  wrongBefore?: boolean;
  wrongResult?: boolean;
  wrongInputSha?: boolean;
  repeatedChallenge?: boolean;
  wrongCounts?: boolean;
  wrongCaseCount?: boolean;
  wrongStatus?: boolean;
  wrongVerdictResult?: boolean;
  wrongVerdictClaim?: boolean;
  reverseCases?: boolean;
  omitVerdict?: boolean;
};
type RepositoryClaimOptions = {
  v2?: boolean;
  runtimePublicKind?: "source" | "documentation";
  runtimePublicPath?: string;
  wrongResponse?: boolean;
  wrongResultTree?: boolean;
  wrongObservationBundle?: boolean;
  wrongCounters?: boolean;
  wrongRuntimeScope?: boolean;
};

export async function fixture(
  callBoundOracle = false,
  mismatchedResponse = false,
  malformedVerdict = false,
  lateClosedEvent = false,
  mismatchedRequest = false,
  wrongPacketIdentity = false,
  largeArtifacts = false,
  engineeringOracle = false,
  wrongEngineeringResult = false,
  wrongEngineeringCounts = false,
  omitEngineeringVerdict = false,
  reverseEngineeringCases = false,
  wrongEngineeringStatus = false,
  wrongEngineeringVerdictClaim = false,
  moduleGraphOptions?: ModuleGraphFixtureOptions,
  repositorySnapshotBaseline?: Buffer,
  repositoryClaimOptions?: RepositoryClaimOptions,
  declaredSelection = false,
) {
  const stateFormatVersion = repositorySnapshotBaseline
    ? "repo-snapshot-v1"
    : "worker-v1";
  const moduleGraphOracle = moduleGraphOptions !== undefined;
  const repositoryClaim = repositoryClaimOptions !== undefined;
  const repositoryV2 = repositoryClaim && repositoryClaimOptions.v2 === true;
  if (repositoryClaim && !repositorySnapshotBaseline)
    throw new Error("Repository claim fixture needs a snapshot baseline");
  const callBound =
    callBoundOracle ||
    engineeringOracle ||
    moduleGraphOracle ||
    repositoryClaim;
  const originals = new Map<string, string>();
  const retain = (bytes: Buffer) => {
    const digest = sha256(bytes);
    originals.set(digest, bytes.toString("base64"));
    return digest;
  };
  const original = (name: string) =>
    retain(
      largeArtifacts && name.startsWith("result-")
        ? Buffer.alloc(1_100_000, name)
        : largeArtifacts &&
            moduleGraphOracle &&
            name === "verification-baseline"
          ? Buffer.alloc(500_000, name)
          : Buffer.from(`synthetic-original:${name}`),
    );
  const source = engineeringOracle
    ? "module.exports.solve = (input) => input.value + 1;"
    : "const value = 1;";
  const changedSource = engineeringOracle
    ? "module.exports.solve = (input) => input.value + 2;"
    : "const value = 2;";
  const graphHelperPath = moduleGraphOptions?.badPath
    ? "src/helper?.js"
    : "src/helper.js";
  const graphFiles = [
    {
      path: graphHelperPath,
      source: "export const adjust = (value) => value + 1;\n",
    },
    {
      path: "src/task.js",
      source:
        "import { adjust } from './helper.js';\nexport function solve(input) { return adjust(input.value); }\n",
    },
  ];
  const graphChangedSource = "export const adjust = (value) => value + 2;\n";
  const graphResultFiles = graphFiles.map((file) => ({
    path: file.path,
    source:
      file.path === graphHelperPath
        ? moduleGraphOptions?.wrongResult
          ? "export const adjust = (value) => value + 3;\n"
          : graphChangedSource
        : file.source,
  }));
  const baselineSha256 = repositorySnapshotBaseline
    ? retain(repositorySnapshotBaseline)
    : moduleGraphOracle
      ? retain(
          Buffer.from(
            canonicalJson({
              kind: "sealed-js-module-graph-baseline",
              version: "1.0.0",
              entry: "src/task.js",
              files: graphFiles,
            }),
          ),
        )
      : engineeringOracle
        ? retain(
            Buffer.from(
              canonicalJson({
                kind: "sealed-engineering-baseline",
                path: "source.ts",
                source,
                version: "1.0.0",
              }),
            ),
          )
        : original("baseline");
  const publicPacketSha256 = retain(
    Buffer.from(
      canonicalJson({
        version: "1.0.0",
        kind: "sealed-public-task-packet",
        taskId: wrongPacketIdentity ? "foreign-task" : "held-task",
        repositoryId: "repo",
        baselineSha256,
        objective:
          "Change the example value in the selected public source file.",
        acceptance: [
          "The bounded selected source change is represented as a proposal.",
        ],
        files: moduleGraphOracle
          ? [
              ...graphFiles.map((file) => ({
                path: file.path,
                kind: "source",
                sha256: sha256(Buffer.from(file.source)),
                content: file.source,
              })),
              {
                path: "module-graph.manifest.json",
                kind: "documentation",
                content: canonicalJson({
                  kind: "sealed-js-module-graph-public-manifest",
                  version: "1.0.0",
                  entry: "src/task.js",
                  paths: moduleGraphOptions?.badManifest
                    ? ["src/foreign.js", "src/task.js"]
                    : graphFiles.map((file) => file.path),
                }),
              },
            ].map((file) => ({
              ...file,
              sha256: sha256(Buffer.from(file.content)),
            }))
          : [
              {
                path: "source.ts",
                kind: "source",
                sha256: sha256(Buffer.from(source)),
                content: source,
              },
              ...(repositoryV2 && repositoryClaimOptions?.runtimePublicKind
                ? [
                    {
                      path:
                        repositoryClaimOptions.runtimePublicPath ??
                        "runtime/data.bin",
                      kind: repositoryClaimOptions.runtimePublicKind,
                      content: "Published operator-declared runtime file",
                      sha256: sha256(
                        Buffer.from("Published operator-declared runtime file"),
                      ),
                    },
                  ]
                : []),
            ],
      }),
    ),
  );
  const proposalText = canonicalJson({
    summary: "Update the selected value",
    changes: moduleGraphOracle
      ? [
          {
            path: graphHelperPath,
            before: moduleGraphOptions?.wrongBefore
              ? "value + 1"
              : graphFiles[0]!.source,
            after: graphChangedSource,
          },
        ]
      : [{ path: "source.ts", before: source, after: changedSource }],
    requests: [],
  });
  const alternateProposalText = canonicalJson({
    summary: "Different selected value",
    changes: [{ path: "source.ts", before: source, after: "const value = 3;" }],
    requests: [],
  });
  const proposalSha256 = retain(Buffer.from(proposalText));
  const engineeringCases = [
    { id: "first", input: { value: 1 }, expected: 3 },
    { id: "second", input: { value: 4 }, expected: 6 },
  ];
  const repositoryCases = [
    { id: "first", input: { value: 1 }, expected: 2 },
    { id: "second", input: { value: 4 }, expected: 2 },
  ];
  const runtimeBytes = Buffer.from([0, 255, 42]);
  const repositoryV2Scope = repositoryV2
    ? {
        kind: "sealed-repository-execution-scope" as const,
        version: "2.0.0" as const,
        baselineSnapshot: {
          sha256: baselineSha256,
          bytes: repositorySnapshotBaseline!.length,
        },
        entries: [
          { path: "runtime", type: "directory" as const, mode: 0o755 },
          {
            path: "runtime/data.bin",
            type: "file" as const,
            mode: 0o644,
            bytes: runtimeBytes.length,
            sha256: repositoryClaimOptions?.wrongRuntimeScope
              ? sha256(Buffer.from("different runtime bytes"))
              : sha256(runtimeBytes),
            class: "operator-declared-runtime" as const,
          },
          {
            path: "source.ts",
            type: "file" as const,
            mode: 0o644,
            bytes: Buffer.byteLength(source),
            sha256: sha256(Buffer.from(source)),
            class: "public-editable" as const,
          },
        ],
      }
    : null;
  const repositoryV2ScopeSha256 = repositoryV2Scope
    ? retain(Buffer.from(canonicalJson(repositoryV2Scope)))
    : null;
  const repositoryRecipeV1 = {
    kind: "sealed-repository-blackbox-recipe" as const,
    version: "1.0.0" as const,
    imageId: `sha256:${hashJson({ fixture: "oracle-image" })}`,
    buildArgv: [],
    runArgv: ["node", "source.ts"],
    cwd: ".",
    env: {},
    buildTimeoutMs: 1000,
    runTimeoutMs: 1000,
    sourcePaths: ["source.ts"],
  };
  const repositoryRecipeV2 = {
    kind: "sealed-repository-blackbox-recipe" as const,
    version: "2.0.0" as const,
    imageId: repositoryRecipeV1.imageId,
    scopeSha256: repositoryV2ScopeSha256!,
    buildArgv: [],
    runArgv: ["node", "source.ts"],
    cwd: ".",
    env: {},
    buildTimeoutMs: 1000,
    runTimeoutMs: 1000,
  };
  const repositoryRecipe = repositoryV2
    ? repositoryRecipeV2
    : repositoryRecipeV1;
  const oracleBytes = repositoryClaim
    ? Buffer.from(
        canonicalJson({
          kind: "sealed-repository-blackbox-oracle",
          version: repositoryV2 ? "2.0.0" : "1.0.0",
          recipe: repositoryRecipe,
          cases: repositoryCases,
        }),
      )
    : moduleGraphOracle
      ? Buffer.from(
          canonicalJson({
            kind: "sealed-js-module-graph-oracle",
            version: "1.0.0",
            cases: engineeringCases,
          }),
        )
      : engineeringOracle
        ? Buffer.from(
            canonicalJson({
              kind: "sealed-json-function-oracle",
              path: "source.ts",
              cases: engineeringCases,
              version: "1.0.0",
            }),
          )
        : Buffer.from(
            JSON.stringify({
              expectedSha256: proposalSha256,
              kind: "sealed-digest-oracle",
              version: "1.0.0",
            }),
          );
  const oracleSha256 = retain(oracleBytes);
  const engineeringResultSha256 = engineeringOracle
    ? retain(
        Buffer.from(
          canonicalJson({
            kind: "sealed-engineering-baseline",
            path: "source.ts",
            source: wrongEngineeringResult
              ? "module.exports.solve = (input) => input.value + 3;"
              : changedSource,
            version: "1.0.0",
          }),
        ),
      )
    : null;
  const moduleGraphResultSha256 = moduleGraphOracle
    ? retain(
        Buffer.from(
          canonicalJson({
            kind: "sealed-js-module-graph-baseline",
            version: "1.0.0",
            entry: "src/task.js",
            files: graphResultFiles,
          }),
        ),
      )
    : null;
  const repositoryTree = (sourceText: string) =>
    Buffer.from(
      canonicalJson({
        ...(repositoryV2
          ? {
              kind: "sealed-repository-execution-tree",
              version: "2.0.0",
              entries: [
                { path: "runtime", type: "directory", mode: 0o755 },
                {
                  path: "runtime/data.bin",
                  type: "file",
                  mode: 0o644,
                  bytes: runtimeBytes.length,
                  sha256: repositoryClaimOptions?.wrongRuntimeScope
                    ? sha256(Buffer.from("different runtime bytes"))
                    : sha256(runtimeBytes),
                },
                {
                  path: "source.ts",
                  type: "file",
                  mode: 0o644,
                  bytes: Buffer.byteLength(sourceText),
                  sha256: sha256(Buffer.from(sourceText)),
                },
              ],
            }
          : {
              kind: "sealed-repository-tree",
              version: "1.0.0",
              files: [
                {
                  path: "source.ts",
                  bytes: Buffer.byteLength(sourceText),
                  mode: 0o644,
                  sha256: sha256(Buffer.from(sourceText)),
                },
              ],
            }),
      }),
    );
  const repositoryBaselineTreeSha256 = repositoryClaim
    ? sha256(repositoryTree(source))
    : null;
  const repositoryResultSha256 = repositoryClaim
    ? retain(
        repositoryTree(
          repositoryClaimOptions?.wrongResultTree
            ? "const value = 3;"
            : changedSource,
        ),
      )
    : null;
  const verdictBytes = malformedVerdict
    ? Buffer.from("not a digest verdict")
    : Buffer.from(
        `${JSON.stringify({
          version: "1.0.0",
          kind: "sealed-digest-verification",
          oracleSha256,
          nonce: "ab".repeat(16),
          status: "pass",
        })}\n`,
      );
  const verdictSha256 = retain(verdictBytes);
  const rowLabeler = generateKeyPairSync("ed25519");
  const rowReviewer = generateKeyPairSync("ed25519");
  const collector = generateKeyPairSync("ed25519");
  const aggregateReviewer = generateKeyPairSync("ed25519");
  const pem = (pair: ReturnType<typeof generateKeyPairSync>) =>
    pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const rowTrust = {
    version: "1.0.0" as const,
    keys: [
      {
        keyId: "row-labeler",
        actorId: "row-labeler",
        roles: ["labeler"],
        publicKeyPem: pem(rowLabeler),
      },
      {
        keyId: "row-reviewer",
        actorId: "row-reviewer",
        roles: ["reviewer"],
        publicKeyPem: pem(rowReviewer),
      },
    ],
    revokedKeyIds: [] as string[],
  };
  const aggregateTrust = {
    version: "1.0.0" as const,
    keys: [
      {
        keyId: "aggregate-collector",
        actorId: "independent-collector",
        roles: ["collector"],
        publicKeyPem: pem(collector),
      },
      {
        keyId: "aggregate-reviewer",
        actorId: "independent-aggregate-reviewer",
        roles: ["reviewer"],
        publicKeyPem: pem(aggregateReviewer),
      },
    ],
    revokedKeyIds: [] as string[],
  };
  const calibration = {
    version: "1.0.0" as const,
    provenance: {
      origin: "synthetic" as const,
      datasetId: "aggregate-fixture-calibration",
      population: "Synthetic fixture only; no real held-out population.",
      repositoryIds: ["repo"],
      riskStrata: ["low"],
      reviewedBy: "fixture-reviewer",
      reviewedAt: day,
      limitations: limitation,
    },
    rows: [
      {
        split: "calibration" as const,
        category: "worker",
        provider: "laya",
        model: "weights-v1",
        selected: "safe",
        expected: "safe",
        confidence: 1,
        caseId: "calibration-case",
        taskId: "calibration-task",
        baselineSuccess: true,
        candidateSuccess: true,
        baselineCost: 2,
        candidateCost: 1,
        policyViolation: false,
      },
    ],
  };
  const thresholds = freezeCohortCalibration(calibration);
  const registry: CohortInspection["registry"] = {
    version: "1.0.0",
    kind: "sealed-exposure-registry",
    registryId: "aggregate-registry",
    createdAt: declaredSelection ? "2025-12-31T00:00:00.000Z" : day,
    entries: [],
  };
  const candidate: CohortInspection["plan"]["configurations"]["candidate"] = {
    version: "1.0.0",
    kind: "sealed-frozen-configuration",
    configurationId: "candidate-config",
    implementationSha256: original("implementation"),
    policySha256: original("policy"),
    promptSha256: original("prompt"),
    contextImplementationSha256: original("context-implementation"),
    categoryStateVersions: [{ category: "worker", stateFormatVersion }],
    providers: [
      {
        providerId: "laya-worker",
        kind: "laya",
        endpointOrigin: "http://127.0.0.1:7337",
        requestedModel: "weights-v1",
        modelIdentity: {
          kind: "local-weights",
          weightsSha256: original("weights"),
          tokenizerSha256: original("tokenizer"),
          runtimeSha256: original("provider-runtime"),
        },
        effort: null,
        maxOutputTokens: 1000,
        samplingSha256: original("sampling"),
        pricingSha256: null,
      },
    ],
    maxCallsPerAttempt: 2,
    maxCostUsdPerAttempt: 10,
    maxDurationMs: 3_600_000,
  };
  if (callBound)
    candidate.providers.push({
      ...structuredClone(candidate.providers[0]!),
      providerId: "local-worker",
      kind: "local",
      endpointOrigin: "http://127.0.0.1:7338",
    });
  const requestModule = await import(
    new URL(
      "../../../evaluation/sealed/worker-runtime/model-request.mjs",
      import.meta.url,
    ).href
  );
  const publicBytes = Buffer.from(originals.get(publicPacketSha256)!, "base64");
  const exactRequest = requestModule.buildLocalModelRequest(
    publicBytes,
    "weights-v1",
    1000,
  ) as Buffer;
  const exactRequestSha256 = retain(Buffer.from(exactRequest));
  exactRequest.fill(0);
  publicBytes.fill(0);
  const task: CohortInspection["plan"]["tasks"][number] = {
    version: "1.0.0",
    kind: "sealed-task-commitment",
    taskId: "held-task",
    stableTaskId: "stable-task",
    stableFamilyId: "stable-family",
    exposureDomain: "fixture-domain",
    repositoryId: "repo",
    exposure: "sealed-unseen",
    baselineSha256,
    publicPacketSha256,
    oracleSha256,
    referenceRepairSha256: null,
    ...(repositoryV2 ? { executionScopeSha256: repositoryV2ScopeSha256! } : {}),
    category: "worker",
    stateFormatVersion,
    risk: "low",
    allowedOutputPaths: moduleGraphOracle
      ? graphFiles.map((file) => file.path)
      : ["source.ts"],
    curatorId: "fixture-curator",
  };
  const plan: CohortInspection["plan"] = {
    version: "1.0.0",
    kind: "sealed-collection-plan",
    collectionId: "aggregate-collection",
    projectId: "aggregate-project",
    createdAt: declaredSelection ? "2026-01-01T00:00:00.000Z" : day,
    notBefore: day,
    expiresAt: "2099-01-01T00:00:00.000Z",
    population: "Synthetic fixture only; no real held-out population.",
    samplingRule: declaredSelection
      ? canonicalJson({
          version: "2.0.0",
          kind: "sealed-declared-inventory-hash-rank-selection",
          seed: "0".repeat(64),
          strata: [{ stratum: "low", taskCount: 1 }],
          assignmentOrder: "ranked-task-pairs-with-hashed-arm-order",
        })
      : "Preassign one synthetic task to both arms in fixed order.",
    exposureRegistrySha256: hashJson(registry),
    trustPolicySha256: hashJson(rowTrust),
    calibrationDatasetSha256: hashJson(calibration),
    thresholdsSha256: hashJson(thresholds),
    configurations: {
      baseline: {
        ...structuredClone(candidate),
        configurationId: "baseline-config",
      },
      candidate,
    },
    tasks: [task],
    assignments: [
      {
        assignmentId: "baseline",
        taskId: task.taskId,
        arm: "baseline",
        ordinal: 0,
      },
      {
        assignmentId: "candidate",
        taskId: task.taskId,
        arm: "candidate",
        ordinal: 1,
      },
    ],
    producerIds: ["fixture-producer"],
    limitations: limitation,
  };
  const planSha256 = hashJson(plan);
  const inspection: CohortInspection = {
    plan,
    planSha256,
    registry,
    assignments: [],
    events: [],
    closure: null,
    promotionEligible: false,
  };
  inspection.assignments = plan.assignments.map((assignment) => {
    const reservation = {
      version: "1.0.0" as const,
      kind: "sealed-attempt-reservation" as const,
      reservationId: assignment.assignmentId,
      collectionId: plan.collectionId,
      assignmentId: assignment.assignmentId,
      taskId: task.taskId,
      stableTaskId: task.stableTaskId,
      stableFamilyId: task.stableFamilyId,
      exposureDomain: task.exposureDomain,
      arm: assignment.arm,
      ordinal: assignment.ordinal,
      attemptOrdinal: 1 as const,
      planSha256,
      configurationSha256: hashJson(plan.configurations[assignment.arm]),
      taskSha256: hashJson(task),
      reservedAt: day,
    };
    const callReservation = {
      version: "1.0.0" as const,
      kind: "sealed-call-reservation" as const,
      callId: `call-${assignment.assignmentId}`,
      reservationId: reservation.reservationId,
      ordinal: 0,
      providerId:
        callBound && assignment.arm === "candidate"
          ? "local-worker"
          : "laya-worker",
      requestedModel: "weights-v1",
      requestSha256:
        callBound && assignment.arm === "candidate" && !mismatchedRequest
          ? exactRequestSha256
          : original(`request-${assignment.assignmentId}`),
      reservedCostUsd: 0,
      reservedAt: day,
    };
    const usage = {
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      reportedCostUsd: 0,
      chargedCostUsd: 0,
      basis: "local-no-api-charge" as const,
      pricingSha256: null,
    };
    const callReceipt = {
      version: "1.0.0" as const,
      kind: "sealed-call-receipt" as const,
      callId: callReservation.callId,
      reservationSha256: hashJson(callReservation),
      status: "completed" as const,
      responseSha256:
        callBound && assignment.arm === "candidate"
          ? retain(
              Buffer.from(
                canonicalJson({
                  model: "weights-v1",
                  choices: [
                    {
                      message: {
                        content:
                          mismatchedResponse ||
                          repositoryClaimOptions?.wrongResponse
                            ? alternateProposalText
                            : proposalText,
                      },
                    },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 1 },
                }),
              ),
            )
          : original(`response-${assignment.assignmentId}`),
      reportedModel: "weights-v1",
      usage,
      finishedAt: day,
    };
    const observation = {
      recordId: "held-observation",
      caseId: "held-case",
      category: "worker",
      providerId: callReservation.providerId,
      model: "weights-v1",
      stateFormatVersion,
      stateHash: hashJson({ fixture: "state" }),
      candidates: ["safe", "unsafe"],
      selected: "safe",
      confidence: 1,
      observedAt: day,
      callId: callReservation.callId,
    };
    const isOracle = callBound && assignment.arm === "candidate";
    const publicDispatch = isOracle
      ? {
          version: "1.0.0" as const,
          kind: "sealed-public-dispatch-claim" as const,
          reservationId: reservation.reservationId,
          reservationSha256: hashJson(reservation),
          collectionId: plan.collectionId,
          assignmentId: assignment.assignmentId,
          taskId: task.taskId,
          taskSha256: hashJson(task),
          planSha256,
          publicPacketSha256: task.publicPacketSha256,
          publicPacketBytes: Buffer.from(
            originals.get(task.publicPacketSha256)!,
            "base64",
          ).length,
          claimedAt: day,
        }
      : null;
    const oracleInvocation = isOracle
      ? {
          version: "1.0.0" as const,
          kind: repositoryClaim
            ? repositoryV2
              ? ("sealed-call-bound-repository-v2-invocation-claim" as const)
              : ("sealed-call-bound-repository-invocation-claim" as const)
            : moduleGraphOracle
              ? ("sealed-call-bound-module-graph-invocation-claim" as const)
              : engineeringOracle
                ? ("sealed-call-bound-engineering-invocation-claim" as const)
                : ("sealed-call-bound-oracle-invocation-claim" as const),
          reservationId: reservation.reservationId,
          reservationSha256: hashJson(reservation),
          collectionId: plan.collectionId,
          assignmentId: assignment.assignmentId,
          taskId: task.taskId,
          taskSha256: hashJson(task),
          planSha256,
          publicDispatchSha256: hashJson(publicDispatch),
          oracleSha256: task.oracleSha256,
          ...(repositoryClaim
            ? {
                baselineSha256: task.baselineSha256,
                ...(repositoryV2
                  ? {
                      baselineTreeSha256: repositoryBaselineTreeSha256!,
                      scopeSha256: repositoryV2ScopeSha256!,
                    }
                  : {}),
                recipeSha256: sha256(
                  Buffer.from(canonicalJson(repositoryRecipe)),
                ),
                resultSourceSha256: repositoryResultSha256!,
                resultSourceFormat: repositoryV2
                  ? ("sealed-repository-execution-tree-v2" as const)
                  : ("sealed-repository-tree-v1" as const),
                verifierKind: repositoryV2
                  ? ("sealed-repository-blackbox-v2" as const)
                  : ("sealed-repository-blackbox-v1" as const),
              }
            : engineeringOracle || moduleGraphOracle
              ? {
                  baselineSha256: task.baselineSha256,
                  resultSourceSha256: moduleGraphOracle
                    ? moduleGraphResultSha256!
                    : engineeringResultSha256!,
                  verifierKind: moduleGraphOracle
                    ? ("sealed-js-module-graph-v1" as const)
                    : ("sealed-json-function-v1" as const),
                }
              : {}),
          callId: callReservation.callId,
          callReservationSha256: hashJson(callReservation),
          callReceiptSha256: hashJson(callReceipt),
          responseSha256: callReceipt.responseSha256,
          proposalDerivation: "openai-chat-content-utf8-v1" as const,
          proposalSha256,
          imageId: `sha256:${hashJson({ fixture: "oracle-image" })}`,
          claimedAt: day,
        }
      : null;
    const engineeringCaseResults = engineeringCases.map((item) => ({
      id: item.id,
      baselineStatus: "completed" as const,
      baselineValueSha256: sha256(
        Buffer.from(canonicalJson(item.input.value + 1)),
      ),
      candidateStatus: "completed" as const,
      candidateValueSha256: sha256(Buffer.from(canonicalJson(item.expected))),
    }));
    if (reverseEngineeringCases) engineeringCaseResults.reverse();
    const moduleGraphCaseResults = engineeringCases.map((item, index) => ({
      id: item.id,
      inputSha256: moduleGraphOptions?.wrongInputSha
        ? hashJson({ wrong: item.id })
        : sha256(Buffer.from(canonicalJson(item.input))),
      baselineChallenge: String(index + 1).repeat(32),
      candidateChallenge: moduleGraphOptions?.repeatedChallenge
        ? String(index + 1).repeat(32)
        : String(index + 3).repeat(32),
      baselineStatus: "completed" as const,
      baselineValueSha256: sha256(
        Buffer.from(canonicalJson(item.input.value + 1)),
      ),
      candidateStatus: "completed" as const,
      candidateValueSha256: sha256(Buffer.from(canonicalJson(item.expected))),
    }));
    if (moduleGraphOptions?.reverseCases) moduleGraphCaseResults.reverse();
    const repositoryRecords = repositoryCases.map((item, index) => {
      const inputSha256 = sha256(Buffer.from(canonicalJson(item.input)));
      const observation = (arm: "baseline" | "candidate") => ({
        kind: "sealed-repository-blackbox-observation" as const,
        version: (repositoryV2 ? "2.0.0" : "1.0.0") as "1.0.0" | "2.0.0",
        challenge: String(index + (arm === "baseline" ? 1 : 3)).repeat(32),
        arm,
        caseIndex: index,
        treeSha256:
          arm === "baseline"
            ? repositoryBaselineTreeSha256!
            : repositoryClaimOptions?.wrongObservationBundle
              ? "f".repeat(64)
              : repositoryResultSha256!,
        recipeSha256: sha256(Buffer.from(canonicalJson(repositoryRecipe))),
        inputSha256,
        stage: "run" as const,
        status: "completed" as const,
        value: arm === "baseline" ? 1 : 2,
      });
      return {
        id: item.id,
        baseline: observation("baseline"),
        candidate: observation("candidate"),
      };
    });
    const repositoryObservationBundle =
      repositoryClaim && isOracle
        ? Buffer.from(
            canonicalJson({
              kind: "sealed-repository-observation-bundle",
              version: repositoryV2 ? "2.0.0" : "1.0.0",
              claimSha256: hashJson(oracleInvocation),
              caseCount: repositoryCases.length,
              records: repositoryRecords,
            }),
          )
        : null;
    const repositoryObservationBundleRef = repositoryObservationBundle
      ? {
          sha256: retain(repositoryObservationBundle),
          bytes: repositoryObservationBundle.length,
        }
      : null;
    const repositoryCaseResults = repositoryRecords.map((record) => ({
      id: record.id,
      inputSha256: record.baseline.inputSha256,
      baselineChallenge: record.baseline.challenge,
      candidateChallenge: record.candidate.challenge,
      baselineStatus: record.baseline.status,
      baselineValueSha256: sha256(
        Buffer.from(canonicalJson(record.baseline.value)),
      ),
      candidateStatus: record.candidate.status,
      candidateValueSha256: sha256(
        Buffer.from(canonicalJson(record.candidate.value)),
      ),
    }));
    const selectedVerdictBytes =
      isOracle && repositoryClaim
        ? Buffer.from(
            canonicalJson({
              kind: "sealed-repository-blackbox-verification",
              version: repositoryV2 ? "2.0.0" : "1.0.0",
              claimSha256: hashJson(oracleInvocation),
              oracleSha256: task.oracleSha256,
              baselineSha256: task.baselineSha256,
              ...(repositoryV2
                ? {
                    scopeSha256: repositoryV2ScopeSha256,
                    baselineTreeSha256: repositoryBaselineTreeSha256,
                  }
                : {}),
              recipeSha256: sha256(
                Buffer.from(canonicalJson(repositoryRecipe)),
              ),
              resultSourceSha256: repositoryResultSha256,
              observationBundle: repositoryObservationBundleRef,
              baselineFailed: repositoryCases.length,
              passed: repositoryClaimOptions?.wrongCounters
                ? repositoryCases.length - 1
                : repositoryCases.length,
              caseCount: repositoryCases.length,
              status: "pass",
              caseResults: repositoryCaseResults,
            }),
          )
        : isOracle && moduleGraphOracle
          ? malformedVerdict
            ? Buffer.from("not a module graph verdict")
            : Buffer.from(
                canonicalJson({
                  kind: "sealed-js-module-graph-verification",
                  version: "1.0.0",
                  claimSha256: moduleGraphOptions?.wrongVerdictClaim
                    ? hashJson({ forged: "module-graph-claim" })
                    : hashJson(oracleInvocation),
                  oracleSha256: task.oracleSha256,
                  baselineSha256: task.baselineSha256,
                  resultSourceSha256: moduleGraphOptions?.wrongVerdictResult
                    ? task.baselineSha256
                    : moduleGraphResultSha256,
                  baselineFailed: engineeringCases.length,
                  passed: moduleGraphOptions?.wrongCounts
                    ? engineeringCases.length - 1
                    : engineeringCases.length,
                  caseCount: moduleGraphOptions?.wrongCaseCount
                    ? engineeringCases.length + 1
                    : engineeringCases.length,
                  status:
                    moduleGraphOptions?.wrongCounts ||
                    moduleGraphOptions?.wrongStatus
                      ? "fail"
                      : "pass",
                  caseResults: moduleGraphCaseResults,
                }),
              )
          : isOracle && engineeringOracle
            ? malformedVerdict
              ? Buffer.from("not an engineering verdict")
              : Buffer.from(
                  canonicalJson({
                    baselineFailed: engineeringCases.length,
                    caseCount: engineeringCases.length,
                    caseResults: engineeringCaseResults,
                    claimSha256: wrongEngineeringVerdictClaim
                      ? hashJson({ forged: "engineering-claim" })
                      : hashJson(oracleInvocation),
                    kind: "sealed-engineering-verification",
                    nonce: "ab".repeat(16),
                    oracleSha256: task.oracleSha256,
                    passed: wrongEngineeringCounts
                      ? engineeringCases.length - 1
                      : engineeringCases.length,
                    resultSourceSha256: engineeringResultSha256,
                    status:
                      wrongEngineeringCounts || wrongEngineeringStatus
                        ? "fail"
                        : "pass",
                    version: "1.0.0",
                  }),
                )
            : verdictBytes;
    const selectedVerdictSha256 = isOracle
      ? retain(selectedVerdictBytes)
      : verdictSha256;
    const oracleVerdict =
      isOracle &&
      !(engineeringOracle && omitEngineeringVerdict) &&
      !(moduleGraphOracle && moduleGraphOptions?.omitVerdict)
        ? {
            version: "1.0.0" as const,
            kind: "sealed-private-oracle-verdict-reference" as const,
            reservationId: reservation.reservationId,
            claimSha256: hashJson(oracleInvocation),
            verificationSha256: selectedVerdictSha256,
            verificationBytes: selectedVerdictBytes.length,
            recordedAt: day,
          }
        : null;
    const receipt = {
      version: "1.0.0" as const,
      kind: "sealed-attempt-receipt" as const,
      reservationId: reservation.reservationId,
      reservationSha256: hashJson(reservation),
      status: isOracle
        ? ("candidate-rejected" as const)
        : ("completed" as const),
      finishedAt: day,
      publicRequestSha256: task.publicPacketSha256,
      proposalSha256:
        oracleInvocation?.proposalSha256 ??
        original(`proposal-${assignment.assignmentId}`),
      resultSourceSha256:
        isOracle && (engineeringOracle || moduleGraphOracle || repositoryClaim)
          ? repositoryClaim
            ? repositoryResultSha256!
            : moduleGraphOracle
              ? moduleGraphResultSha256!
              : engineeringResultSha256!
          : original(`result-${assignment.assignmentId}`),
      observations: assignment.arm === "candidate" ? [observation] : [],
      callReceiptSha256s: [hashJson(callReceipt)],
      outcome: {
        success: isOracle ? null : true,
        policyViolation: false,
        verificationSha256: isOracle
          ? (engineeringOracle && !omitEngineeringVerdict) ||
            (moduleGraphOracle && !moduleGraphOptions?.omitVerdict) ||
            repositoryClaim
            ? selectedVerdictSha256
            : null
          : original(`verification-${assignment.assignmentId}`),
        runtimeSha256: isOracle
          ? null
          : original(`verification-runtime-${assignment.assignmentId}`),
      },
      usage: { ...usage, basis: "aggregate" as const },
      limitations: limitation,
    };
    return {
      assignment,
      reservation,
      publicDispatch,
      oracleInvocation,
      oracleVerdict,
      receipt,
      calls: [{ reservation: callReservation, receipt: callReceipt }],
    };
  });
  const append = (
    type: CohortInspection["events"][number]["event"]["type"],
    payload: unknown,
  ) => {
    const event = {
      version: "1.0.0" as const,
      kind: "sealed-ledger-event" as const,
      collectionId: plan.collectionId,
      sequence: inspection.events.length + 1,
      type,
      createdAt: day,
      previousSha256: inspection.events.at(-1)?.sha256 ?? null,
      payloadSha256: hashJson(payload),
    };
    inspection.events.push({ event, sha256: hashJson(event) });
  };
  append("registered", plan);
  for (const item of inspection.assignments) {
    append("attempt-reserved", item.reservation);
    if (item.publicDispatch)
      append("public-dispatch-claimed", item.publicDispatch);
    append("call-reserved", item.calls[0]!.reservation);
    append("call-settled", item.calls[0]!.receipt);
    if (item.oracleInvocation)
      append(
        item.oracleInvocation.kind ===
          "sealed-call-bound-repository-invocation-claim"
          ? "call-bound-repository-invocation-claimed"
          : item.oracleInvocation.kind ===
              "sealed-call-bound-repository-v2-invocation-claim"
            ? "call-bound-repository-v2-invocation-claimed"
            : item.oracleInvocation.kind ===
                "sealed-call-bound-engineering-invocation-claim"
              ? "call-bound-engineering-invocation-claimed"
              : item.oracleInvocation.kind ===
                  "sealed-call-bound-module-graph-invocation-claim"
                ? "call-bound-module-graph-invocation-claimed"
                : "call-bound-oracle-invocation-claimed",
        item.oracleInvocation,
      );
    if (item.oracleVerdict)
      append("oracle-verdict-retained", item.oracleVerdict);
    append("attempt-settled", item.receipt);
  }
  inspection.closure = {
    version: "1.0.0",
    kind: "sealed-collection-closure",
    collectionId: plan.collectionId,
    planSha256,
    closedAt: day,
    complete: true,
    promotionEligible: false,
    inventory: inspection.assignments.map((item) => ({
      assignmentId: item.assignment.assignmentId,
      taskId: item.assignment.taskId,
      arm: item.assignment.arm,
      ordinal: item.assignment.ordinal,
      status: "terminal" as const,
      reservationSha256: hashJson(item.reservation),
      receiptSha256: hashJson(item.receipt),
      callReservationSha256s: item.calls.map((call) =>
        hashJson(call.reservation),
      ),
      callReceiptSha256s: item.calls.map((call) => hashJson(call.receipt)),
    })),
    eventHeadSha256: inspection.events.at(-1)!.sha256,
    limitations: limitation,
  };
  append("closed", inspection.closure);
  if (lateClosedEvent) {
    const final = inspection.events.at(-1)!;
    final.event.createdAt = "2026-01-02T04:00:00.000Z";
    final.sha256 = hashJson(final.event);
  }
  const originalObservation =
    inspection.assignments[1]!.receipt!.observations[0]!;
  const label = {
    recordId: originalObservation.recordId,
    observationSha256: hashJson(originalObservation),
    expected: "safe",
    reviewerId: "row-reviewer",
    reviewedAt,
    evidenceSha256s: [original("row-review-evidence")],
  };
  const pins = {
    planSha256,
    registrySha256: hashJson(registry),
    baselineConfigurationSha256: hashJson(plan.configurations.baseline),
    candidateConfigurationSha256: hashJson(candidate),
  };
  const cohort = {
    inspection,
    pins,
    calibration,
    thresholds,
    labels: [label],
    evaluation: null as unknown,
  };
  cohort.evaluation = evaluateFullCohort(cohort);
  const preflightPins = {
    projectId: plan.projectId,
    policyVersion: candidate.policySha256,
    collectionId: plan.collectionId,
    planSha256,
    candidateConfigurationSha256: pins.candidateConfigurationSha256,
    trustPolicySha256: plan.trustPolicySha256,
    evaluationArtifactSha256: hashJson(cohort.evaluation),
    category: "worker",
    stateFormatVersion,
    providerId: "laya-worker",
    providerKind: "laya" as const,
    requestedModel: "weights-v1",
    modelIdentitySha256: hashJson(candidate.providers[0]!.modelIdentity),
  };
  const rowPayload = {
    version: "1.0.0",
    kind: "sealed-held-out-label-review",
    projectId: plan.projectId,
    collectionId: plan.collectionId,
    planSha256,
    assignmentId: "candidate",
    taskId: task.taskId,
    labelerId: "row-labeler",
    producerIds: plan.producerIds,
    label,
  };
  const signed = (
    keyId: string,
    role: string,
    signedAt: string,
    payloadSha256: string,
    purpose: string,
    privateKey: typeof rowLabeler.privateKey,
  ) => {
    const envelope = { keyId, role, signedAt, payloadSha256 };
    return {
      ...envelope,
      signature: sign(
        null,
        Buffer.from(`${purpose}\n${canonicalJson(envelope)}`),
        privateKey,
      ).toString("base64"),
    };
  };
  const rowReviewBundles = [
    {
      payload: rowPayload,
      attestations: [
        signed(
          "row-labeler",
          "labeler",
          labelerAt,
          hashJson(rowPayload),
          "graph-engineering/sealed-held-out-review/v1",
          rowLabeler.privateKey,
        ),
        signed(
          "row-reviewer",
          "reviewer",
          rowReviewerAt,
          hashJson(rowPayload),
          "graph-engineering/sealed-held-out-review/v1",
          rowReviewer.privateKey,
        ),
      ],
    },
  ];
  const rowReceipt = await inspectSealedHeldOutReviewSignatures(
    cohort,
    preflightPins,
    rowTrust,
    { expectedTrustSha256: hashJson(rowTrust) },
    rowReviewBundles,
    { nowMs },
  );
  const originalArtifacts: {
    role: string;
    sha256: string;
    bytesBase64: string;
  }[] = [];
  const add = (role: string, digest: string | null) => {
    if (digest === null) return;
    originalArtifacts.push({
      role,
      sha256: digest,
      bytesBase64: originals.get(digest)!,
    });
  };
  add(`task/${task.taskId}/baseline`, task.baselineSha256);
  if (task.executionScopeSha256)
    add(`task/${task.taskId}/execution-scope`, task.executionScopeSha256);
  add(`task/${task.taskId}/public-packet`, task.publicPacketSha256);
  add(`task/${task.taskId}/private-oracle`, task.oracleSha256);
  for (const item of inspection.assignments) {
    const call = item.calls[0]!;
    add(
      `call/${call.reservation.callId}/request`,
      call.reservation.requestSha256,
    );
    add(
      `call/${call.reservation.callId}/response`,
      call.receipt!.responseSha256,
    );
    const prefix = `attempt/${item.assignment.assignmentId}`;
    add(`${prefix}/proposal`, item.receipt!.proposalSha256);
    add(`${prefix}/result-source`, item.receipt!.resultSourceSha256);
    add(`${prefix}/verification`, item.receipt!.outcome.verificationSha256);
    if (
      item.oracleInvocation?.kind ===
      "sealed-call-bound-oracle-invocation-claim"
    )
      add(
        `oracle/v1/${item.assignment.assignmentId}/derived-proposal`,
        item.oracleInvocation.proposalSha256,
      );
    if (
      item.oracleInvocation?.kind ===
        "sealed-call-bound-engineering-invocation-claim" ||
      item.oracleInvocation?.kind ===
        "sealed-call-bound-module-graph-invocation-claim" ||
      item.oracleInvocation?.kind ===
        "sealed-call-bound-repository-invocation-claim" ||
      item.oracleInvocation?.kind ===
        "sealed-call-bound-repository-v2-invocation-claim"
    ) {
      const role = `oracle/${item.oracleInvocation.kind === "sealed-call-bound-repository-v2-invocation-claim" ? "repository-v2" : item.oracleInvocation.kind === "sealed-call-bound-repository-invocation-claim" ? "repository-v1" : item.oracleInvocation.kind === "sealed-call-bound-module-graph-invocation-claim" ? "module-graph-v1" : "engineering-v1"}/${item.assignment.assignmentId}`;
      add(`${role}/derived-proposal`, item.oracleInvocation.proposalSha256);
      add(`${role}/result-source`, item.oracleInvocation.resultSourceSha256);
    }
    if (item.oracleVerdict)
      add(
        `${item.oracleInvocation?.kind === "sealed-call-bound-repository-v2-invocation-claim" ? "oracle/repository-v2" : item.oracleInvocation?.kind === "sealed-call-bound-repository-invocation-claim" ? "oracle/repository-v1" : item.oracleInvocation?.kind === "sealed-call-bound-module-graph-invocation-claim" ? "oracle/module-graph-v1" : item.oracleInvocation?.kind === "sealed-call-bound-engineering-invocation-claim" ? "oracle/engineering-v1" : "oracle/v1"}/${item.assignment.assignmentId}/private-verdict`,
        item.oracleVerdict.verificationSha256,
      );
  }
  const manifestEntries = originalArtifacts
    .map(({ role, sha256, bytesBase64 }) => ({
      role,
      sha256,
      bytes: Buffer.from(bytesBase64, "base64").length,
    }))
    .sort((a, b) => {
      return a.role < b.role ? -1 : a.role > b.role ? 1 : 0;
    });
  const manifest = {
    version: "1.0.0",
    kind: "sealed-original-byte-manifest",
    collectionId: plan.collectionId,
    planSha256,
    entries: manifestEntries,
  };
  const identityOnlyInventory = {
    configurations: (["baseline", "candidate"] as const).map((arm) => {
      const config = plan.configurations[arm];
      return {
        arm,
        implementationSha256: config.implementationSha256,
        policySha256: config.policySha256,
        promptSha256: config.promptSha256,
        contextImplementationSha256: config.contextImplementationSha256,
        providers: config.providers.map((provider) => ({
          providerId: provider.providerId,
          modelIdentity: provider.modelIdentity,
          samplingSha256: provider.samplingSha256,
          pricingSha256: provider.pricingSha256,
        })),
      };
    }),
    attemptRuntimeIdentities: inspection.assignments.map((item) => ({
      assignmentId: item.assignment.assignmentId,
      runtimeSha256: item.receipt?.outcome.runtimeSha256 ?? null,
    })),
    labelEvidence: [
      { recordId: label.recordId, evidenceSha256s: label.evidenceSha256s },
    ],
  };
  const assignmentInventory = inspection.assignments.map((item) => ({
    assignment: item.assignment,
    reservationSha256: hashJson(item.reservation),
    publicDispatchSha256: item.publicDispatch
      ? hashJson(item.publicDispatch)
      : null,
    oracleInvocationSha256: item.oracleInvocation
      ? hashJson(item.oracleInvocation)
      : null,
    oracleVerdictSha256: item.oracleVerdict
      ? hashJson(item.oracleVerdict)
      : null,
    receiptSha256: hashJson(item.receipt),
    outcome: item.receipt!.outcome,
    calls: item.calls.map((call) => ({
      reservationSha256: hashJson(call.reservation),
      receiptSha256: hashJson(call.receipt),
      status: call.receipt!.status,
      usage: call.receipt!.usage,
    })),
  }));
  const payload = {
    version: "1.0.0",
    kind: "sealed-aggregate-provenance",
    projectId: plan.projectId,
    policySha256: candidate.policySha256,
    collectionId: plan.collectionId,
    planSha256,
    registrySha256: hashJson(registry),
    baselineConfigurationSha256: pins.baselineConfigurationSha256,
    candidateConfigurationSha256: pins.candidateConfigurationSha256,
    modelInventorySha256: hashJson(
      (["baseline", "candidate"] as const).flatMap((arm) =>
        plan.configurations[arm].providers.map((provider) => ({
          arm,
          provider,
        })),
      ),
    ),
    calibrationSha256: hashJson(calibration),
    thresholdsSha256: hashJson(thresholds),
    labelsSha256: hashJson([label]),
    inspectionSha256: hashJson(inspection),
    closureSha256: hashJson(inspection.closure),
    eventHeadSha256: inspection.events.at(-1)!.sha256,
    assignmentOutcomeInventorySha256: hashJson(assignmentInventory),
    originalByteManifestSha256: hashJson(manifest),
    identityOnlyInventorySha256: hashJson(identityOnlyInventory),
    rowSignatureInventorySha256: rowReceipt.reviewInventorySha256,
    rowTrustSha256: hashJson(rowTrust),
    aggregateTrustSha256: hashJson(aggregateTrust),
    evaluationSha256: hashJson(cohort.evaluation),
    collectedAt,
  };
  const bundle = {
    payload,
    attestations: [
      signed(
        "aggregate-collector",
        "collector",
        collectorAt,
        hashJson(payload),
        "graph-engineering/sealed-aggregate-provenance/v1",
        collector.privateKey,
      ),
      signed(
        "aggregate-reviewer",
        "reviewer",
        aggregateReviewerAt,
        hashJson(payload),
        "graph-engineering/sealed-aggregate-provenance/v1",
        aggregateReviewer.privateKey,
      ),
    ],
  };
  const input = {
    cohort,
    preflightPins,
    rowTrust,
    rowReviewBundles,
    aggregateTrust,
    aggregateTrustPin: {
      expectedAggregateTrustSha256: hashJson(aggregateTrust),
    },
    originalArtifacts,
    bundle,
  };
  return {
    input,
    retainedBlobs: new Map(originals),
    keys: { rowLabeler, rowReviewer, collector, aggregateReviewer },
    signed,
  };
}

export function engineeringFixture(
  options: {
    malformedVerdict?: boolean;
    wrongResult?: boolean;
    wrongCounts?: boolean;
    omitVerdict?: boolean;
    reverseCases?: boolean;
    wrongStatus?: boolean;
    wrongVerdictClaim?: boolean;
  } = {},
) {
  return fixture(
    false,
    false,
    options.malformedVerdict ?? false,
    false,
    false,
    false,
    false,
    true,
    options.wrongResult ?? false,
    options.wrongCounts ?? false,
    options.omitVerdict ?? false,
    options.reverseCases ?? false,
    options.wrongStatus ?? false,
    options.wrongVerdictClaim ?? false,
  );
}

/** Synthetic signed cohort with an opt-in frozen repository baseline root. */
export function repositorySnapshotFixture(rootBytes: Buffer) {
  return fixture(
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    undefined,
    rootBytes,
  );
}

/** Synthetic signed repository claim with retained private observation bytes. */
export function repositoryClaimFixture(
  rootBytes: Buffer,
  options: RepositoryClaimOptions = {},
) {
  return fixture(
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    undefined,
    rootBytes,
    options,
  );
}

/** Synthetic signed V2 claim; its runtime bytes are explicit operator declarations. */
export function repositoryV2ClaimFixture(
  rootBytes: Buffer,
  options: Omit<RepositoryClaimOptions, "v2"> = {},
) {
  return repositoryClaimFixture(rootBytes, { ...options, v2: true });
}

export function moduleGraphFixture(options: ModuleGraphFixtureOptions = {}) {
  return fixture(
    false,
    false,
    false,
    false,
    false,
    false,
    options.largeArtifacts ?? false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    options,
  );
}

/** Signed synthetic aggregate with a matching pre-run v2 selection window. */
export function declaredSelectionAggregateFixture() {
  return fixture(
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    undefined,
    undefined,
    undefined,
    true,
  );
}

/** Re-sign this synthetic fixture after a real SealedStore chose IDs and times. */
export async function signAggregateForInspection(
  template: Awaited<ReturnType<typeof fixture>>,
  actualInspection: CohortInspection,
) {
  const input = structuredClone(template.input);
  input.cohort.inspection = structuredClone(actualInspection);
  const candidate = actualInspection.assignments.find(
    (item) => item.assignment.arm === "candidate",
  );
  const observation = candidate?.receipt?.observations[0];
  if (!candidate || !observation || !actualInspection.closure)
    throw new Error(
      "Synthetic aggregate fixture needs a closed candidate observation",
    );
  const start =
    Math.max(
      Date.now(),
      Date.parse(actualInspection.closure.closedAt),
      Date.parse(actualInspection.events.at(-1)!.event.createdAt),
      Date.parse(observation.observedAt),
    ) + 1_000;
  const at = (offsetMs: number) => new Date(start + offsetMs).toISOString();
  const labelerSignedAt = at(0);
  const labelReviewedAt = at(500);
  const reviewerSignedAt = at(1_000);
  const collectedAt = at(2_000);
  const collectorSignedAt = at(3_000);
  const aggregateReviewerSignedAt = at(4_000);
  const verificationNowMs = start + 5_000;
  const label = input.cohort.labels[0]!;
  label.observationSha256 = hashJson(observation);
  label.reviewedAt = labelReviewedAt;
  input.cohort.evaluation = evaluateFullCohort(input.cohort);
  input.preflightPins.evaluationArtifactSha256 = hashJson(
    input.cohort.evaluation,
  );
  const rowBundle = input.rowReviewBundles[0]!;
  rowBundle.payload.assignmentId = candidate.assignment.assignmentId;
  rowBundle.payload.taskId = candidate.assignment.taskId;
  rowBundle.payload.label = label;
  const rowPayloadSha256 = hashJson(rowBundle.payload);
  rowBundle.attestations = [
    template.signed(
      "row-labeler",
      "labeler",
      labelerSignedAt,
      rowPayloadSha256,
      "graph-engineering/sealed-held-out-review/v1",
      template.keys.rowLabeler.privateKey,
    ),
    template.signed(
      "row-reviewer",
      "reviewer",
      reviewerSignedAt,
      rowPayloadSha256,
      "graph-engineering/sealed-held-out-review/v1",
      template.keys.rowReviewer.privateKey,
    ),
  ];
  const rowReceipt = await inspectSealedHeldOutReviewSignatures(
    input.cohort,
    input.preflightPins,
    input.rowTrust,
    { expectedTrustSha256: hashJson(input.rowTrust) },
    input.rowReviewBundles,
    { nowMs: verificationNowMs },
  );
  const manifest = {
    version: "1.0.0" as const,
    kind: "sealed-original-byte-manifest" as const,
    collectionId: actualInspection.plan.collectionId,
    planSha256: actualInspection.planSha256,
    entries: input.originalArtifacts
      .map(({ role, sha256, bytesBase64 }) => ({
        role,
        sha256,
        bytes: Buffer.from(bytesBase64, "base64").length,
      }))
      .sort((left, right) =>
        left.role < right.role ? -1 : left.role > right.role ? 1 : 0,
      ),
  };
  const assignmentInventory = actualInspection.assignments.map((item) => ({
    assignment: item.assignment,
    reservationSha256: item.reservation && hashJson(item.reservation),
    publicDispatchSha256: item.publicDispatch
      ? hashJson(item.publicDispatch)
      : null,
    oracleInvocationSha256: item.oracleInvocation
      ? hashJson(item.oracleInvocation)
      : null,
    oracleVerdictSha256: item.oracleVerdict
      ? hashJson(item.oracleVerdict)
      : null,
    receiptSha256: item.receipt && hashJson(item.receipt),
    outcome: item.receipt?.outcome ?? null,
    calls: item.calls.map((call) => ({
      reservationSha256: hashJson(call.reservation),
      receiptSha256: call.receipt && hashJson(call.receipt),
      status: call.receipt?.status ?? null,
      usage: call.receipt?.usage ?? null,
    })),
  }));
  const identityOnlyInventory = {
    configurations: (["baseline", "candidate"] as const).map((arm) => {
      const config = actualInspection.plan.configurations[arm];
      return {
        arm,
        implementationSha256: config.implementationSha256,
        policySha256: config.policySha256,
        promptSha256: config.promptSha256,
        contextImplementationSha256: config.contextImplementationSha256,
        providers: config.providers.map((provider) => ({
          providerId: provider.providerId,
          modelIdentity: provider.modelIdentity,
          samplingSha256: provider.samplingSha256,
          pricingSha256: provider.pricingSha256,
        })),
      };
    }),
    attemptRuntimeIdentities: actualInspection.assignments.map((item) => ({
      assignmentId: item.assignment.assignmentId,
      runtimeSha256: item.receipt?.outcome.runtimeSha256 ?? null,
    })),
    labelEvidence: [
      {
        recordId: label.recordId,
        evidenceSha256s: label.evidenceSha256s,
      },
    ],
  };
  const payload = input.bundle.payload;
  payload.labelsSha256 = hashJson(input.cohort.labels);
  payload.inspectionSha256 = hashJson(actualInspection);
  payload.closureSha256 = hashJson(actualInspection.closure);
  payload.eventHeadSha256 = actualInspection.events.at(-1)!.sha256;
  payload.assignmentOutcomeInventorySha256 = hashJson(assignmentInventory);
  payload.originalByteManifestSha256 = hashJson(manifest);
  payload.identityOnlyInventorySha256 = hashJson(identityOnlyInventory);
  payload.rowSignatureInventorySha256 = rowReceipt.reviewInventorySha256;
  payload.evaluationSha256 = hashJson(input.cohort.evaluation);
  payload.collectedAt = collectedAt;
  const aggregatePayloadSha256 = hashJson(payload);
  input.bundle.attestations = [
    template.signed(
      "aggregate-collector",
      "collector",
      collectorSignedAt,
      aggregatePayloadSha256,
      "graph-engineering/sealed-aggregate-provenance/v1",
      template.keys.collector.privateKey,
    ),
    template.signed(
      "aggregate-reviewer",
      "reviewer",
      aggregateReviewerSignedAt,
      aggregatePayloadSha256,
      "graph-engineering/sealed-aggregate-provenance/v1",
      template.keys.aggregateReviewer.privateKey,
    ),
  ];
  return { input, manifest, nowMs: verificationNowMs };
}
