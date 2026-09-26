# Outcome insights

- ID: outcome-insights
- Status: implemented
- Area: quality
- Epic: AI agile team

## Problem

A team improves by looking back at how its work turned out. People need to
see, across finished runs, how often checks, review and the security gate
passed, what they accepted or rejected, what it cost, and how runs went for
each decision option and project memory in play, without the engine turning
those counts into judgments on its own.

## Acceptance criteria

- AC1: `graph-engine outcomes --summary` and the dashboard count each run once, by its latest outcome: statuses, human acceptance, gate results and known cost, with runs of unknown cost counted separately.
  - Test: packages/engine/tests/insights.test.ts :: counts each run once, by its latest outcome
  - Test: packages/engine/tests/outcomes.test.ts :: counts real runs once each, with gates, acceptance and cost
- AC2: Runs are grouped by the decision option actually used (the baseline in shadow mode) and by memory present in their context.
  - Test: packages/engine/tests/insights.test.ts :: groups runs by the decision option actually used and by memory
  - Test: packages/dashboard/src/InsightsPanel.test.tsx :: shows how runs turned out without presenting them as scores
- AC3: The dashboard shows the summary as recorded counts, labelled as not scores.
  - Test: packages/dashboard/src/InsightsPanel.test.tsx :: shows how runs turned out without presenting them as scores

## Security considerations

The summary is local: served on the loopback, token-protected dashboard API
and the CLI, never over MCP. It holds counts and identifiers, not source or
memory text.

## Non-goals

Scoring, ranking or weighting options, changing any decision baseline, or
counting as promotion evidence for a decision provider.
