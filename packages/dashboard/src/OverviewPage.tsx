import { useEffect } from "react";
import type { Api } from "./api";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNotice,
  Icon,
  Loading,
  PageHeading,
  Status,
  useResource,
} from "./components";
import type { OverviewCard, OverviewColumn, OverviewResponse } from "./types";
import { date } from "./view-model";

const COLUMNS: { id: OverviewColumn; title: string; hint: string }[] = [
  {
    id: "needs-you",
    title: "Needs you",
    hint: "Results to accept or reject, and stopped runs to inspect.",
  },
  {
    id: "in-progress",
    title: "In progress",
    hint: "What the graph is doing right now.",
  },
  {
    id: "done",
    title: "Done",
    hint: "Results a person decided on, and cancelled runs.",
  },
];

type Tone = "neutral" | "green" | "orange" | "red";
const GATE_TONES: Record<string, Tone> = {
  passed: "green",
  approved: "green",
  accepted: "green",
  failed: "red",
  "changes-requested": "red",
  rejected: "red",
  pending: "orange",
};

function Gate({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (
    <Badge tone={GATE_TONES[value] ?? "neutral"}>
      {label}: {value.replace(/-/g, " ")}
    </Badge>
  );
}

function RunCard({ card }: { card: OverviewCard }) {
  return (
    <article className="overview-card" aria-label={card.objective}>
      <div className="overview-card-head">
        <Status value={card.status} />
        <span className="small muted">{date(card.updatedAt)}</span>
      </div>
      <h3>{card.objective}</h3>
      <p className="overview-phase">
        {card.column === "in-progress" && (
          <span className="spinner" aria-hidden="true" />
        )}
        {card.phase}
      </p>
      {card.steps && (
        <ol className="overview-steps" aria-label="Plan steps">
          {card.steps.map((step) => (
            <li key={step.id} className={`overview-step step-${step.state}`}>
              {step.state === "done" && <Icon name="check" size={12} />}
              {step.id}
            </li>
          ))}
        </ol>
      )}
      <div className="overview-gates">
        <Gate label="Checks" value={card.gates.checks} />
        <Gate label="Review" value={card.gates.review} />
        <Gate label="Security" value={card.gates.security} />
        <Gate label="Acceptance" value={card.gates.acceptance} />
      </div>
      {card.error && <p className="overview-error">{card.error}</p>}
      <p className="overview-next">
        <strong>Next:</strong> {card.next}
      </p>
      {card.commands.map((command) => (
        <code key={command} className="overview-command">
          {command}
        </code>
      ))}
      <p className="small muted">
        Run {card.runId}
        {card.costUsd !== null && ` · $${card.costUsd.toFixed(4)}`}
      </p>
    </article>
  );
}

export function OverviewPage({ api, active }: { api: Api; active: boolean }) {
  const overview = useResource<OverviewResponse>(
    api,
    active ? "/api/overview" : null,
  );
  const working = (overview.data?.counts["in-progress"] ?? 0) > 0;
  const { reload } = overview;
  // Live while work is running; a slower heartbeat when idle.
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(reload, working ? 2500 : 10000);
    return () => clearInterval(interval);
  }, [active, working, reload]);
  const data = overview.data;
  return (
    <>
      <PageHeading
        eyebrow="OVERVIEW"
        title="What the graph is doing, and what needs you."
        action={
          <Button variant="secondary" onClick={reload}>
            <Icon name="refresh" size={16} />
            Refresh
          </Button>
        }
      >
        Every card comes from recorded run events. Passing the automated gates
        is not acceptance: a person accepts or rejects each result.
      </PageHeading>
      <ErrorNotice message={overview.error} retry={reload} />
      {!data && !overview.error && <Loading label="Loading the board…" />}
      {data && (
        <>
          <div className="metric-grid">
            {COLUMNS.map((column) => (
              <div className="metric" key={column.id}>
                <span className="metric-label">{column.title}</span>
                <strong>{data.counts[column.id]}</strong>
                <span className="metric-foot">{column.hint}</span>
              </div>
            ))}
          </div>
          <p className="small muted overview-project">
            Reviewer: {data.project.reviewer ?? "none configured"} · Parallel
            workers: up to {data.project.maxWorkers} · Decisions:{" "}
            {data.project.decisionMode} ·{" "}
            {data.project.workingSet
              ? `Working set: ${data.project.workingSet.join(", ")}`
              : "Whole repository"}
          </p>
          {data.cards.length === 0 ? (
            <EmptyState icon="run" title="Nothing on the board yet.">
              Create a plan from the Runs page, from the command line, or from
              the AI client connected to this project.
            </EmptyState>
          ) : (
            <div className="overview-board">
              {COLUMNS.map((column) => (
                <section
                  key={column.id}
                  className="overview-column"
                  aria-label={column.title}
                >
                  <h2>
                    {column.title}{" "}
                    <span className="muted">{data.counts[column.id]}</span>
                  </h2>
                  {data.cards
                    .filter((card) => card.column === column.id)
                    .map((card) => (
                      <RunCard key={card.runId} card={card} />
                    ))}
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
