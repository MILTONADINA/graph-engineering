import type { AccountingSummary } from "./types";
import { Badge } from "./components";
import { number } from "./view-model";

export function UsagePanel({ summary }: { summary: AccountingSummary }) {
  const planning = summary.planningOnly;
  return (
    <section
      className="panel accounting-panel"
      aria-label="Inference call accounting"
    >
      <div className="panel-heading">
        <div>
          <div className="eyebrow">DURABLE CALL LEDGER</div>
          <h2>Every attempt counts.</h2>
        </div>
        <Badge>{number(summary.callCount)} calls</Badge>
      </div>
      <dl className="accounting-grid">
        <div>
          <dt>Settled accounting</dt>
          <dd>{number(summary.settledCallCount)} calls</dd>
        </div>
        <div>
          <dt>Unresolved reservations</dt>
          <dd>
            {number(summary.unresolvedCallCount)} calls · $
            {summary.unresolvedReservedCostUsd.toFixed(4)} known
          </dd>
        </div>
        <div>
          <dt>Calls with unknown cost</dt>
          <dd>{number(summary.unknownCostCallCount)}</dd>
        </div>
        <div>
          <dt>Estimated call costs</dt>
          <dd>{number(summary.estimatedCallCount)}</dd>
        </div>
        <div>
          <dt>Planning-only calls</dt>
          <dd>{number(planning.callCount)}</dd>
        </div>
        <div>
          <dt>Planning-only cost</dt>
          <dd>
            {!planning.callCount
              ? "No calls"
              : planning.totals.costUsd === null
                ? `Unknown · $${planning.knownCostUsd.toFixed(4)} known`
                : `$${planning.totals.costUsd.toFixed(4)}${planning.totals.estimated ? " estimated" : " reported"}`}
          </dd>
        </div>
        <div>
          <dt>Total input tokens</dt>
          <dd>
            {summary.totals.inputTokens === null
              ? "Unknown"
              : summary.callCount
                ? number(summary.totals.inputTokens)
                : "—"}
          </dd>
        </div>
        <div>
          <dt>Total output tokens</dt>
          <dd>
            {summary.totals.outputTokens === null
              ? "Unknown"
              : summary.callCount
                ? number(summary.totals.outputTokens)
                : "—"}
          </dd>
        </div>
      </dl>
      <p className="small muted accounting-explanation">
        Includes calls made before a run starts, failed attempts, and retained
        reservations. Unresolved reserves are conservative estimates, not
        confirmed charges. Run summaries are not added again.
      </p>
      {planning.callCount > 0 && (
        <p className="small muted accounting-explanation">
          Planning only: {number(planning.savedPlanCallCount)} calls belong to
          saved plans with no run; {number(planning.unsavedPlanCallCount)} have
          no saved plan (including failed or interrupted planning).
        </p>
      )}
      {summary.untrackedRunCount > 0 && (
        <p className="notice notice-warning">
          {number(summary.untrackedRunCount)} runs have usage without call-level
          accounting. Their old counters are not added; the full total remains
          unknown.
        </p>
      )}
    </section>
  );
}
