import type { AccountingSummary } from "./types";

export const number = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
export const shortId = (value?: string | null) =>
  value ? value.slice(0, 8) : "Uncommitted";
export const readable = (value: string) => value.replace(/[_-]/g, " ");
export function date(value?: string) {
  if (!value) return "Not yet";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

export function accountingCost(summary: AccountingSummary | null | undefined) {
  if (!summary)
    return {
      label: "Ledger cost",
      value: "—",
      detail: "Awaiting call accounting",
    };
  if (!summary.callCount && !summary.untrackedRunCount)
    return {
      label: "Ledger cost",
      value: "—",
      detail: "No inference calls recorded",
    };
  if (summary.totals.costUsd === null)
    return {
      label: "Total cost unknown",
      value: "Unknown",
      detail: `Known subtotal $${summary.knownCostUsd.toFixed(4)}; some usage is unreported`,
    };
  return {
    label: summary.totals.estimated
      ? "Estimated total + reserves"
      : "Reported total cost",
    value: `$${summary.totals.costUsd.toFixed(4)}`,
    detail: `${number(summary.callCount)} ledger calls, counted once`,
  };
}

export function getError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}

export const activeRun = (status: string) =>
  status === "running" || status === "verifying";
