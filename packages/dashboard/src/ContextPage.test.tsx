import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SCHEMA_VERSION,
  type RepositorySnapshot,
} from "@graph-engineering/contracts";
import type { Api } from "./api";
import type { ProjectResponse } from "./types";

const resource = vi.hoisted(() => vi.fn());
vi.mock("./components", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./components")>()),
  useResource: resource,
}));

import { ContextPage } from "./ContextPage";

it("renders the explicitly active snapshot rather than sorting by creation time", () => {
  const active: RepositorySnapshot = {
    version: SCHEMA_VERSION,
    id: "older-active-snapshot",
    projectId: "project",
    worktreeId: "worktree",
    revision: "oldrev42-current",
    contentHash: "content",
    createdAt: "2026-09-01T00:00:00.000Z",
    fileCount: 3,
    languages: ["typescript"],
    coverage: { parsed: 3, textOnly: 0, errors: [] },
  };
  resource.mockReturnValue({
    data: active,
    error: null,
    loading: false,
    reload: vi.fn(),
  });
  const api = vi.fn() as unknown as Api;
  const project = {
    config: { policy: { maxContextTokens: 16_000 } },
  } as unknown as ProjectResponse;
  const html = renderToStaticMarkup(
    <ContextPage api={api} project={project} indexed={vi.fn()} />,
  );
  expect(resource).toHaveBeenCalledWith(api, "/api/snapshots/current");
  expect(html).toContain("oldrev42");
  expect(html).toContain("3 parsed");
  expect(html).not.toContain("newer-inactive-revision");
});
