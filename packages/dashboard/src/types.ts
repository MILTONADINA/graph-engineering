import type {
  ProjectConfig,
  ProviderConfig,
  Usage,
} from "@graph-engineering/contracts";

export interface AccountingGroup {
  totals: Usage;
  callCount: number;
  settledCallCount: number;
  unresolvedCallCount: number;
  unknownCostCallCount: number;
  estimatedCallCount: number;
  knownCostUsd: number;
  unresolvedReservedCostUsd: number;
}

export interface AccountingSummary extends AccountingGroup {
  source: "inference-call-ledger";
  untrackedRunCount: number;
  planningOnly: AccountingGroup & {
    savedPlanCallCount: number;
    unsavedPlanCallCount: number;
  };
}

export interface ProjectResponse {
  config: ProjectConfig;
  root: string;
  capabilities: {
    docker: boolean | { available: boolean; reason?: string };
    providers: ProviderConfig[];
    installedWorkers?: InstalledWorkerCapability[];
  };
}

export const dockerAvailable = (project: ProjectResponse) =>
  typeof project.capabilities.docker === "boolean"
    ? project.capabilities.docker
    : project.capabilities.docker.available;

export interface TemplateSummary {
  id: string;
  name: string;
  source: string;
  status: string;
}

export interface InstalledWorkerCapability {
  kind: "codex" | "claude" | "cursor";
  executable: string;
  installed: boolean;
  version: string | null;
  available: boolean;
  authentication: "api-key" | "native-login" | "unavailable";
  supportsSubscription: boolean;
  mode: "proposal-only" | "restricted-read" | "unavailable";
  reason: string | null;
  limits: string[];
}

export type OverviewColumn = "needs-you" | "in-progress" | "done";
export interface OverviewCard {
  runId: string;
  objective: string;
  status: string;
  column: OverviewColumn;
  phase: string;
  steps: { id: string; state: "waiting" | "working" | "done" }[] | null;
  gates: {
    checks: "passed" | "failed" | "pending" | "not-run";
    review:
      | "approved"
      | "changes-requested"
      | "not-configured"
      | "pending"
      | "not-run";
    security: "passed" | "failed" | "not-run" | "pending";
    acceptance: "pending" | "accepted" | "rejected" | null;
  };
  next: string;
  commands: string[];
  error: string | null;
  costUsd: number | null;
  updatedAt: string;
}
export interface OverviewResponse {
  counts: Record<OverviewColumn, number>;
  cards: OverviewCard[];
  project: {
    name: string;
    reviewer: string | null;
    workingSet: string[] | null;
    maxWorkers: number;
    decisionMode: string;
  };
}
