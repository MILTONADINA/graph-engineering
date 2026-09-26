import type { OutcomeSummary } from "./types";
import { readable } from "./view-model";

/** How runs turned out: recorded counts for people to read, not scores. */
export function InsightsPanel({ summary }: { summary: OutcomeSummary }) {
  if (!summary.runs)
    return (
      <section className="panel insights-panel" aria-label="Run outcomes">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">RUN OUTCOMES</div>
            <h2>No finished runs yet.</h2>
          </div>
        </div>
      </section>
    );
  const { gates, acceptance } = summary;
  return (
    <section className="panel insights-panel" aria-label="Run outcomes">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">RUN OUTCOMES</div>
          <h2>How {summary.runs} runs turned out</h2>
          <p>{summary.note}</p>
        </div>
      </div>
      <dl className="insights-grid">
        <div>
          <dt>Status</dt>
          <dd>
            {Object.entries(summary.byStatus)
              .map(([status, count]) => `${count} ${readable(status)}`)
              .join(" · ")}
          </dd>
        </div>
        <div>
          <dt>Your decisions</dt>
          <dd>
            {acceptance.accepted} accepted · {acceptance.rejected} rejected ·{" "}
            {acceptance.pending} pending
          </dd>
        </div>
        <div>
          <dt>Required checks</dt>
          <dd>
            {gates.checks.passed} passed · {gates.checks.failed} failed ·{" "}
            {gates.checks.notRun} not run
          </dd>
        </div>
        <div>
          <dt>Code review</dt>
          <dd>
            {gates.review.approved} approved · {gates.review.changesRequested}{" "}
            changes requested · {gates.review.notRun} not run
          </dd>
        </div>
        <div>
          <dt>Security gate</dt>
          <dd>
            {gates.security.passed} passed · {gates.security.failed} failed ·{" "}
            {gates.security.notRun} not run
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>
            ${summary.cost.knownUsd.toFixed(4)} known
            {summary.cost.runsWithUnknownCost
              ? ` · ${summary.cost.runsWithUnknownCost} runs with unknown cost`
              : ""}
          </dd>
        </div>
      </dl>
      {summary.decisions.length > 0 && (
        <table className="insights-table">
          <caption>Runs by decision option</caption>
          <thead>
            <tr>
              <th scope="col">Decision</th>
              <th scope="col">Option used</th>
              <th scope="col">Runs</th>
              <th scope="col">Succeeded</th>
              <th scope="col">Accepted</th>
            </tr>
          </thead>
          <tbody>
            {summary.decisions.slice(0, 20).map((row) => (
              <tr key={`${row.category}-${row.option}-${row.mode}`}>
                <td>{readable(row.category)}</td>
                <td className="mono">
                  {row.option}
                  {row.mode === "shadow" ? " (baseline)" : ""}
                </td>
                <td>{row.tally.runs}</td>
                <td>{row.tally.succeeded}</td>
                <td>{row.tally.accepted}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {summary.memories.length > 0 && (
        <table className="insights-table">
          <caption>Runs by project memory in context</caption>
          <thead>
            <tr>
              <th scope="col">Memory</th>
              <th scope="col">Runs</th>
              <th scope="col">Succeeded</th>
              <th scope="col">Accepted</th>
              <th scope="col">Rejected</th>
            </tr>
          </thead>
          <tbody>
            {summary.memories.slice(0, 20).map((row) => (
              <tr key={row.memoryId}>
                <td className="mono">{row.memoryId}</td>
                <td>{row.tally.runs}</td>
                <td>{row.tally.succeeded}</td>
                <td>{row.tally.accepted}</td>
                <td>{row.tally.rejected}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
