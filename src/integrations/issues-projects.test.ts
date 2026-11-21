import { expect, test } from "bun:test";
import { IssueGithub, type IssueAccount } from "./issues-github";
import { moveIssueProjectItem, readIssueProject, type MoveRequest } from "./issues-projects";

const viewer = { host: "github.com", login: "viewer", nodeId: "U_viewer" };
const issue = {
  __typename: "Issue",
  id: "I_shared",
  repository: { id: "R_1", owner: { login: "fixture" }, name: "sample" },
  number: 3,
  url: "https://github.com/fixture/sample/issues/3",
  title: "Project status fixture",
  state: "OPEN",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-02",
  author: null,
  assignees: { nodes: [] },
  labels: { nodes: [] },
};
interface Options {
  paginated?: boolean;
  readonly?: boolean;
  foreign?: boolean;
  lostResponse?: boolean;
  refused?: boolean;
  postWriteConflict?: boolean;
}
function fixture(flags: Options = {}) {
  const state = new Map<string, string | null>([
    ["P_1", null],
    ["P_2", "done"],
  ]);
  let writes = 0,
    reads = 0;
  const api = new IssueGithub("fixture", async (_url, opts) => {
    const { query, variables } = JSON.parse(String(opts.body));
    const projectId =
      variables.id ??
      (variables.item ? variables.item.replace(/^ITEM_/, "") : variables.input?.projectId) ??
      "P_1";
    const optionId = state.get(projectId) ?? null;
    const field = {
      __typename: "ProjectV2SingleSelectField",
      id: "FIELD_" + projectId,
      options: [
        { id: "todo", name: "To do" },
        { id: "done", name: "Done" },
      ],
    };
    const project = {
      id: projectId,
      number: 1,
      title: "Project",
      owner: { login: "fixture" },
      field,
      viewerCanUpdate: !flags.readonly,
    };
    const item = {
      id: "ITEM_" + projectId,
      content: issue,
      project,
      status: optionId ? { optionId, field: { id: field.id } } : null,
      isArchived: false,
    };
    if (query.startsWith("mutation")) {
      writes++;
      if (flags.refused) return Response.json({ message: "forbidden" }, { status: 403 });
      state.set(
        projectId,
        flags.postWriteConflict ? "elsewhere" : (variables.input.value?.singleSelectOptionId ?? null),
      );
      if (flags.lostResponse) throw new Error("connection lost");
      return Response.json({ data: { ok: true } });
    }
    reads++;
    if (query.includes("ReadIssueProjectStatus"))
      return Response.json({
        data: { node: flags.foreign ? { ...item, project: { ...project, id: "P_foreign" } } : item },
      });
    const nodes = [
      item,
      { ...item, id: "PULL", content: { __typename: "PullRequest" } },
      { ...item, id: "DRAFT", content: { __typename: "DraftIssue" } },
      { ...item, id: "REDACTED", content: null },
      { ...item, id: "OLD", isArchived: true },
    ];
    const pageInfo =
      flags.paginated && !variables.after
        ? { hasNextPage: true, endCursor: "page2" }
        : { hasNextPage: false, endCursor: null };
    if (variables.after === "page2") {
      nodes[0] = { ...item, id: "ITEM_NEXT", content: { ...issue, id: "I_next" } };
    }
    return Response.json({ data: { node: { ...project, items: { nodes, pageInfo } } } });
  });
  return { account: { api, viewer } satisfies IssueAccount, state, writes: () => writes, reads: () => reads };
}
const move: MoveRequest = {
  projectId: "P_1",
  fieldId: "FIELD_P_1",
  itemId: "ITEM_P_1",
  issueNodeId: "I_shared",
  expectedOptionId: null,
  optionId: "done",
};

test("AC13 selected project owns its status, including unset; drafts, PR and archived items do not create cards", async () => {
  const { account } = fixture();
  const first = await readIssueProject(account, { projectId: "P_1" });
  const second = await readIssueProject(account, { projectId: "P_2" });
  expect(first.items).toHaveLength(1);
  expect(second.items).toHaveLength(1);
  expect(first.items[0]!.issue.ref.nodeId).toBe(second.items[0]!.issue.ref.nodeId);
  expect(first.items[0]!.optionId).toBeNull();
  expect(second.items[0]!.optionId).toBe("done");
  expect(first.incomplete).toBe(true);
  expect(first.project.options).toHaveLength(2);
  expect(first.project.fieldId).toBe("FIELD_P_1");
});

test("AC14 move and clear reread the selected project item without changing another project's value", async () => {
  const f = fixture();
  expect((await moveIssueProjectItem(f.account, move)).outcome).toBe("updated");
  expect(
    (await moveIssueProjectItem(f.account, { ...move, expectedOptionId: "done", optionId: null })).optionId,
  ).toBeNull();
  expect(f.state.get("P_2")).toBe("done");
  expect(f.reads()).toBe(4);
  expect(f.writes()).toBe(2);
});

test("AC14 stale status, foreign item and read-only Project cannot write", async () => {
  const stale = fixture();
  stale.state.set("P_1", "todo");
  expect((await moveIssueProjectItem(stale.account, move)).optionId).toBe("todo");
  expect(stale.writes()).toBe(0);
  for (const flags of [{ readonly: true }, { foreign: true }]) {
    const f = fixture(flags);
    await expect(moveIssueProjectItem(f.account, move)).rejects.toThrow("access:");
    expect(f.writes()).toBe(0);
  }
});

test("AC14 lost reply, refused mutation and concurrent post-write change are reconciled without automatic retries", async () => {
  const f = fixture({ lostResponse: true });
  expect((await moveIssueProjectItem(f.account, move)).outcome).toBe("reconciled");
  expect(f.reads()).toBe(2);
  expect(f.writes()).toBe(1);
  const refused = fixture({ refused: true });
  await expect(moveIssueProjectItem(refused.account, move)).rejects.toThrow("access:");
  expect(refused.reads()).toBe(2);
  expect(refused.writes()).toBe(1);
  const concurrent = fixture({ postWriteConflict: true });
  expect(await moveIssueProjectItem(concurrent.account, move)).toMatchObject({
    outcome: "conflict",
    optionId: "elsewhere",
  });
  expect(concurrent.writes()).toBe(1);
});

test("AC13 Project items paginate only inside the same account and project", async () => {
  const { account } = fixture({ paginated: true });
  const first = await readIssueProject(account, { projectId: "P_1" });
  expect(first.nextCursor).toBeTruthy();
  const second = await readIssueProject(account, { projectId: "P_1", cursor: first.nextCursor });
  expect(second.items.map((item) => item.issue.ref.nodeId)).toEqual(["I_next"]);
  expect(second.nextCursor).toBeNull();
  await expect(readIssueProject(account, { projectId: "P_2", cursor: first.nextCursor })).rejects.toThrow(
    "Refresh",
  );
  const otherAccount = { ...account, viewer: { ...viewer, nodeId: "U_other" } };
  await expect(readIssueProject(otherAccount, { projectId: "P_1", cursor: first.nextCursor })).rejects.toThrow(
    "Refresh",
  );
});
