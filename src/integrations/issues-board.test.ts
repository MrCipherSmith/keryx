import { defaultFilters, groupForRow, mergeRows, visibleRows, type Row } from "../../apps/desktop/src/issues/model";
import { expect, test } from "bun:test";
import { issueComments, issueDetail, listIssuePage } from "./issues-board";
import { authenticatedAccount, IssueGithub, type FetchIssues } from "./issues-github";
import { issueKey, type IssueRef } from "./issues-contract";

function json(value: unknown, init?: ResponseInit) {
  return Response.json(value, init);
}
function row(repo: string, node: string) {
  return {
    node_id: node,
    html_url: `https://github.com/org/${repo}/issues/8`,
    number: 8,
    title: "Equal issue numbers",
    state: "open",
    user: { login: "owner" },
    assignees: [],
    labels: ["bug"],
    created_at: "2026-01-01",
    updated_at: "2026-01-02",
    repository: { node_id: "R_" + repo, name: repo, owner: { login: "org" } },
  };
}
const ref: IssueRef = {
  host: "github.com",
  nodeId: "I_a",
  repositoryId: "R_a",
  owner: "org",
  repo: "a",
  number: 8,
  url: "https://github.com/org/a/issues/8",
};
const graphIssue = {
  __typename: "Issue",
  id: ref.nodeId,
  number: ref.number,
  repository: { id: ref.repositoryId, name: "a", owner: { login: "org" } },
  url: ref.url,
  title: "Example",
  state: "OPEN",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-02",
  author: null,
  assignees: { nodes: [] },
  labels: { nodes: [] },
  body: "",
  stateReason: null,
};

async function account(fetcher: FetchIssues) {
  const api = new IssueGithub("test-selected", async (url, options) => {
    expect(url.origin).toBe("https://api.github.com");
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer test-selected");
    expect(options.redirect).toBe("error");
    return url.pathname === "/user" ? json({ login: "viewer", node_id: "U_v" }) : fetcher(url, options);
  });
  return authenticatedAccount("viewer", api);
}

test("AC1 all four account sources preserve repository identities and exclude pull requests", async () => {
  const filters: string[] = [];
  const auth = await account(async (url) => {
    filters.push(url.searchParams.get("filter")!);
    return json([row("one", "I_1"), row("two", "I_2"), { ...row("three", "P_3"), pull_request: {} }]);
  });
  for (const source of ["assigned", "created", "mentioned", "subscribed"] as const) {
    const page = await listIssuePage(auth, { source });
    expect(page.viewer.nodeId).toBe("U_v");
    expect(page.items.map((i) => [i.ref.repo, i.ref.number])).toEqual([
      ["one", 8],
      ["two", 8],
    ]);
    expect(new Set(page.items.map((i) => issueKey(i.ref))).size).toBe(2);
  }
  expect(filters).toEqual(["assigned", "created", "mentioned", "subscribed"]);
});

test("AC2 three pages load on demand with query-bound continuations and no discussion requests", async () => {
  const paths: string[] = [];
  const auth = await account(async (url) => {
    paths.push(url.pathname);
    const n = Number(url.searchParams.get("page") ?? 1);
    expect(url.searchParams.get("since")).toBe("2026-01-01T00:00:00.000Z");
    return json(
      [row("a", "I_" + n), row("a", "I_" + n)],
      n < 3 ? { headers: { link: `<https://api.github.com/issues?page=${n + 1}>; rel="next"` } } : {},
    );
  });
  const request = { source: "created", updatedSince: "2026-01-01", sort: "asc" } as const;
  let cursor: string | null = null;
  for (let n = 1; n <= 3; n++) {
    const page = await listIssuePage(auth, { ...request, cursor });
    expect(page.items.map((i) => i.ref.nodeId)).toEqual(["I_" + n]);
    expect(paths).toHaveLength(n);
    cursor = page.nextCursor;
    if (n === 1)
      await expect(listIssuePage(auth, { ...request, sort: "desc", cursor })).rejects.toThrow("Refresh");
  }
  expect(cursor).toBeNull();
  expect(paths).toEqual(["/issues", "/issues", "/issues"]);
});

test("AC3 denied, offline, empty and rate limited requests are distinguishable", async () => {
  for (const [status, kind] of [
    [403, "access:"],
    [404, "access:"],
    [429, "rate-limit:"],
  ] as const) {
    const auth = await account(async () => new Response("", { status }));
    await expect(listIssuePage(auth, { source: "assigned" })).rejects.toThrow(kind);
  }
  const revoked = await account(async () =>
    new Response("Resource not accessible", { status: 404, headers: { "x-ratelimit-remaining": "0" } }),
  );
  await expect(listIssuePage(revoked, { source: "assigned" })).rejects.toThrow("access:");
  const offline = await account(async () => {
    throw new TypeError("offline");
  });
  await expect(listIssuePage(offline, { source: "assigned" })).rejects.toThrow("offline:");
  const empty = await listIssuePage(await account(async () => json([])), { source: "assigned" });
  expect(empty.items).toEqual([]);
  expect(empty.nextCursor).toBeNull();
});

test("AC6 authenticated empty descriptions are distinct from access errors and untrusted link destinations", async () => {
  const auth = await account(async (url, opts) => {
    if (url.pathname === "/issues")
      return json([], { headers: { link: '<https://invalid.example/issues?page=2>; rel="next"' } });
    const payload = JSON.parse(String(opts.body));
    expect(payload.variables.id).toBe(ref.nodeId);
    return json({ data: { node: graphIssue } });
  });
  expect((await issueDetail(auth, ref)).issue.body).toBe("");
  await expect(issueDetail(auth, { ...ref, repositoryId: "other" })).rejects.toThrow("access:");
  await expect(listIssuePage(auth, { source: "assigned" })).rejects.toThrow("configuration:");
  await expect(issueComments(auth, { ...ref, url: "file:///private/demo" })).rejects.toThrow("configuration:");
  const badAccount = new IssueGithub("test-other", async () => json({ login: "other", node_id: "U_other" }));
  await expect(authenticatedAccount("viewer", badAccount)).rejects.toThrow("access:");
});

test("AC5 GitHub state, Project Status and Keryx stage stay independent on refresh", async () => {
  const page = await listIssuePage(await account(async () => json([row("a", "I_a"), row("b", "I_b")])), {source: "assigned"});
  const openDone: Row = { issue: { ...page.items[0]!, work: { stage: "done" } }, optionId: "in-progress" };
  const closedActive: Row = { issue: { ...page.items[1]!, state: "closed", work: { stage: "active" } } };
  const selected = issueKey(closedActive.issue.ref);
  const refreshed = mergeRows([openDone, closedActive], [
    { ...closedActive, issue: { ...closedActive.issue, work: {stage: "needs_answer", reason: "Choose the execution branch"} } },
  ]);
  expect(groupForRow(openDone, false)).toBe("done");
  expect(groupForRow(openDone, true)).toBe("in-progress");
  expect(groupForRow(closedActive, false)).toBe("active");
  expect(visibleRows(refreshed, defaultFilters)).toEqual([openDone]);
  const shown = visibleRows(refreshed, { ...defaultFilters, state: "all" }).find(r => issueKey(r.issue.ref) === selected)!;
  expect(groupForRow(shown, false)).toBe("needs_answer");
  expect(shown.issue.work?.reason).toBe("Choose the execution branch");
  expect(shown.issue.state).toBe("closed");
});

test("AC3 source links reopen a private session or legacy Flow only after the selected account can read the ticket", async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readIssueOrigin } = await import("./issue-origin");
  const { withIssueBinding } = await import("./issue-session");
  const { readSessionFlags } = await import("../session/organize");
  const { sessionDir } = await import("../session/paths");
  const root = await mkdtemp(join(tmpdir(), "issue-origin-"));
  const profile = join(root, "profile");
  const flowDir = "007-existing-issue";
  const auth = await account(async (_url, options) => {
    const variables = JSON.parse(String(options.body)).variables;
    return json({ data: variables.id
      ? { node: { ...graphIssue, body: "Authoritative body" } }
      : { repository: { issue: { ...graphIssue, body: "Authoritative body" } } } });
  });
  try {
    const live = (await issueDetail(auth, ref)).issue;
    const project = { cwd: root, projectId: "p", cloneId: "c", baseBranch: "main" };
    const sessionId = await withIssueBinding(auth.viewer, project, { ...live, body: "Old private body" }, profile,
      async record => record.launch.sessionId!);
    expect(readSessionFlags(sessionDir(root, sessionId, profile)).hasIssue).toBe(true);
    expect((await readIssueOrigin(root, auth, {sessionId}, profile)).issue?.body).toBe("Authoritative body");
    const wrongUser = { ...auth, viewer: { ...auth.viewer, nodeId: "other-viewer" } };
    await expect(readIssueOrigin(root, wrongUser, {sessionId}, profile)).rejects.toThrow("access:");
    const pkg = join(root, ".metaproject", "flows", flowDir);
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, "flow.json"), JSON.stringify({ schemaVersion: 2, source: { type: "github-issue", ref: ref.url } }));
    expect((await readIssueOrigin(root, auth, {flowDir}, profile)).ref).toEqual(ref);
    const denied = await account(async () => json({}, { status: 404 }));
    await expect(readIssueOrigin(root, denied, {flowDir}, profile)).rejects.toThrow("access:");
    await expect(readIssueOrigin(root, denied, {sessionId}, profile)).rejects.toThrow("access:");
    await expect(readIssueOrigin(root, auth, {flowDir: "../outside"}, profile)).rejects.toThrow("Invalid Issues request");
    await expect(readIssueOrigin(root, auth, {sessionId,flowDir}, profile)).rejects.toThrow("Invalid Issues request");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
