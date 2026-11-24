import { describe, expect, test } from "bun:test";
import {
  displayReason,
  type IssueRef,
  type IssueViewer,
  isIssueRef,
  isIssueViewer,
  issueFlowKey,
  issueKey,
  issueSessionKey,
  issueViewerKey,
  matchesIssueSource,
} from "./issues-contract";

const issue: IssueRef = {
  host: "github.com", owner: "Example", repo: "frontend", number: 42,
  nodeId: "I_a", repositoryId: "R_a", url: "https://github.com/Example/frontend/issues/42",
};
const other: IssueRef = {
  ...issue, repo: "backend", nodeId: "I_b", repositoryId: "R_b", url: "https://github.com/Example/backend/issues/42",
};
const viewer: IssueViewer = { host: issue.host, nodeId: "U_a", login: "dev" };

describe("GitHub issue identity", () => {
  test("equal numbers identify different issues across repositories and hosts", () => {
    expect(issueKey(issue)).not.toBe(issueKey(other));
    expect(issueKey(issue)).not.toBe(issueKey({ ...issue, host: "enterprise.example" }));
    expect(isIssueRef(issue)).toBe(true);
    expect(isIssueRef({ ...issue, url: other.url })).toBe(false);
    expect(isIssueRef({ ...issue, nodeId: "" })).toBe(false);
  });

  test("renames and transfers retain the verified node identity", () => {
    expect(issueKey({ ...other, nodeId: issue.nodeId })).toBe(issueKey(issue));
    expect(issueViewerKey({ ...viewer, login: "renamed" })).toBe(issueViewerKey(viewer));
    expect(isIssueViewer({ login: "dev" })).toBe(false);
  });

  test("two worktrees share a package while private session keys isolate viewer and local profile", () => {
    const ref = issueFlowKey("clone", issue);
    expect(issueFlowKey("other clone", issue)).not.toBe(ref);
    expect(issueFlowKey("clone", other)).not.toBe(ref);
    const session = issueSessionKey("profile", viewer, "clone", issue);
    expect(issueSessionKey("profile", { ...viewer, nodeId: "U_b" }, "clone", issue)).not.toBe(session);
    expect(issueSessionKey("another profile", viewer, "clone", issue)).not.toBe(session);
    expect(issueSessionKey("profile", viewer, "clone", { ...issue, host: "GITHUB.COM" })).toBe(session);
  });
});

describe("adopting historical Flow.source records", () => {
  test("reads the original URL-only source form and accepts links to comments", () => {
    const source = { type: "github-issue", ref: "https://GitHub.com/example/Frontend/issues/42/#issuecomment-1" };
    expect(matchesIssueSource(source, issue)).toBe(true);
    expect(matchesIssueSource(source, other)).toBe(false);
    expect(matchesIssueSource({ type: "description", ref: issue.url }, issue)).toBe(false);
    expect(matchesIssueSource({ type: "description", ref: null }, issue)).toBe(false);
  });

  test.each([
    "https://example.org/Example/frontend/issues/42",
    "https://github.com/Example/frontend/pull/42",
    "https://github.com/Example/frontend/issues/42/extra",
    "https://otheruser@github.com/Example/frontend/issues/42",
    "http://github.com/Example/frontend/issues/42",
    "#42",
  ])("rejects unqualified or mismatched sources: %s", (ref) => {
    expect(matchesIssueSource({ type: "github-issue", ref }, issue)).toBe(false);
  });
});

describe("displayReason", () => {
  test("drops the CLI's category prefix, including a hyphenated one", () => {
    expect(displayReason("configuration: GitHub has Issues turned off for o/r.")).toBe("GitHub has Issues turned off for o/r.");
    expect(displayReason("rate-limit: GitHub rate limit reached; retry at 10:00.")).toBe("GitHub rate limit reached; retry at 10:00.");
    expect(displayReason("source_unavailable: the Project is gone.")).toBe("the Project is gone.");
  });

  test("leaves a reason without a category, or with a colon later in the text, as it is", () => {
    expect(displayReason("Network unreachable")).toBe("Network unreachable");
    expect(displayReason("Open https://github.com/o/r: then retry")).toBe("Open https://github.com/o/r: then retry");
  });
});
