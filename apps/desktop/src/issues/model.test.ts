import { describe, expect, test } from "bun:test";
import type { IssueSummary } from "../../../../src/integrations/issues-contract";
import type { SessionInfo } from "../acp/types";
import { DEFAULT_SOURCE, defaultFilters, groupForRow, issueGroups, issueSessions, issueSubject, SOURCES, visibleRows, type ProjectBoard, type Row } from "./model";

const issue: IssueSummary = {
  ref: { host: "github.com", nodeId: "I_a", repositoryId: "R_a", owner: "org", repo: "sample", number: 3, url: "https://github.com/org/sample/issues/3" },
  title: "Report the failing upload", state: "open", author: "sam", assignees: [], labels: [],
  createdAt: "2026-11-01", updatedAt: "2026-11-02",
};
const closed: IssueSummary = { ...issue, state: "closed", ref: { ...issue.ref, nodeId: "I_b", number: 4, url: "https://github.com/org/sample/issues/4" } };
const project: ProjectBoard = { id: "p", owner: "org", number: 1, title: "Board", fieldId: "f", canWrite: true, options: [{ id: "todo", name: "Todo" }] };

describe("issue grouping", () => {
  test("without a GitHub Project, issues group by GitHub state whatever their Flow stage", () => {
    expect(groupForRow({ issue: { ...issue, work: { stage: "done" } } }, false)).toBe("open");
    expect(groupForRow({ issue: closed }, false)).toBe("closed");
    expect(groupForRow({ issue }, false)).toBe("open");
  });

  test("the Closed lane is drawn only when the state filter includes closed issues", () => {
    expect(issueGroups(undefined, "open")).toEqual([{ id: "open", label: "Open" }]);
    expect(issueGroups(undefined, "closed")).toEqual([{ id: "open", label: "Open" }, { id: "closed", label: "Closed" }]);
    expect(issueGroups(undefined, "all")).toEqual([{ id: "open", label: "Open" }, { id: "closed", label: "Closed" }]);
  });

  test("a GitHub Project keeps grouping by its Status field", () => {
    expect(issueGroups(project, "open")).toEqual([{ id: "todo", label: "Todo" }, { id: "unassigned", label: "No status" }]);
    expect(groupForRow({ issue: closed, optionId: "todo" }, true)).toBe("todo");
    expect(groupForRow({ issue }, true)).toBe("unassigned");
  });
});

describe("issue filters and sources", () => {
  test("the Flow stage filter is gone", () => {
    expect(Object.keys(defaultFilters)).not.toContain("stage");
    const rows: Row[] = [{ issue: { ...issue, work: { stage: "done" } } }, { issue: { ...closed, work: { stage: "none" } } }];
    expect(visibleRows(rows, { ...defaultFilters, state: "all" })).toHaveLength(2);
  });

  test("the project repository is the default source and the viewer scopes stay selectable", () => {
    expect(DEFAULT_SOURCE).toBe("repository");
    expect(SOURCES.repository).toBe("Project repository");
    expect(Object.keys(SOURCES)).toEqual(["repository", "assigned", "created", "mentioned", "subscribed", "project"]);
  });
});

describe("issue sessions", () => {
  const session = (id: string, subject: unknown, extra: Record<string, unknown> = {}): SessionInfo =>
    ({ sessionId: id, cwd: "/p", updatedAt: "2026-11-0" + id, _meta: { keryx: { subject, ...extra } } }) as SessionInfo;

  test("the subject of an issue names its repository and number", () => {
    expect(issueSubject(issue)).toEqual({ kind: "issue", repo: "org/sample", number: 3, url: issue.ref.url, repositoryId: "R_a" });
  });

  test("bound sessions match kind, repository without case and number, and skip archived ones", () => {
    const sessions = [
      session("1", { kind: "issue", repo: "Org/Sample", number: 3, url: issue.ref.url }),
      session("2", { kind: "issue", repo: "org/sample", number: 3, url: issue.ref.url }),
      session("3", { kind: "pr", repo: "org/sample", number: 3, url: "https://github.com/org/sample/pull/3" }),
      session("4", { kind: "issue", repo: "org/sample", number: 4, url: closed.ref.url }),
      session("5", { kind: "issue", repo: "org/sample", number: 3, url: issue.ref.url }, { archivedAt: "2026-11-05" }),
    ];
    expect(issueSessions(sessions, issue).map(s => s.sessionId)).toEqual(["2", "1"]);
    expect(issueSessions([], issue)).toEqual([]);
  });
});
