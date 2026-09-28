import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunRecord } from "@graph-engineering/contracts";
import { CompletionNotice, PlanVerification } from "./RunsPage";

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

it("explains a plan without checks once: in its warning when the server sent one, else in the verification panel", () => {
  const explanation =
    "This plan has no verification commands, so it cannot run.";
  const warned = renderToStaticMarkup(
    <PlanVerification
      plan={{
        verification: [],
        warnings: [
          "This plan has no verification commands, so it cannot run: a plan keeps the commands configured when it was created. Add a check with graph-engine check-add <image> <command...>, then create a new plan.",
        ],
      }}
    />,
  );
  expect(warned).toContain("None.");
  expect(warned).not.toContain(explanation);
  expect(
    renderToStaticMarkup(<PlanVerification plan={{ verification: [] }} />),
  ).toContain(explanation);
  const checked = renderToStaticMarkup(
    <PlanVerification
      plan={{
        verification: [{ image: "fixture:local", argv: ["node", "--test"] }],
      }}
    />,
  );
  expect(checked).toContain("node --test");
  expect(checked).not.toContain("None.");
});
