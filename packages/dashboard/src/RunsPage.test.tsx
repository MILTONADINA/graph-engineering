import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunRecord } from "@graph-engineering/contracts";
import { CompletionNotice } from "./RunsPage";

const notice = (
  humanAcceptance: NonNullable<RunRecord["completion"]>["humanAcceptance"],
) =>
  renderToStaticMarkup(
    <CompletionNotice
      completion={{
        automatedChecksPassed: true,
        humanAcceptance,
        reviewScope: "normal",
      }}
    />,
  );

it("shows the person's recorded acceptance decision, never pending once they decide", () => {
  expect(notice("pending")).toContain("Human acceptance is pending.");
  for (const [decision, text] of [
    ["accepted", "Accepted by a person."],
    ["rejected", "Rejected by a person."],
  ] as const) {
    const html = notice(decision);
    expect(html).toContain("Automated checks passed.");
    expect(html).toContain(text);
    expect(html).not.toContain("pending");
    expect(html).toContain("This does not approve publication or merge.");
  }
});
