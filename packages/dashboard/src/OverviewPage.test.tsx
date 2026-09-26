import { expect, it } from "vitest";
import { overviewRefreshMs } from "./OverviewPage";

it("refreshes the board every 2.5 seconds while work runs and every 10 seconds when idle", () => {
  expect(overviewRefreshMs(true)).toBe(2500);
  expect(overviewRefreshMs(false)).toBe(10000);
});
