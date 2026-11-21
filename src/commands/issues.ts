import { parseArgs } from "node:util";
import {
  connectIssueAccount,
  readIssueOrigin,
  issueComments,
  issueDetail,
  issueKey,
  listIssuePage,
  readIssueProject,
  moveIssueProjectItem,
  type ProjectRequest,
  type MoveRequest,
  type IssueRef,
  type IssueSummary,
  type IssueViewer,
  type ListIssueRequest,
} from "../integrations/issues/service";

const usage =
  "keryx issues <viewer|origin|list|detail|comments|project|move|workspace|open-session|prepare-flow> --login LOGIN --request JSON --json";

export async function issuesCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const [action, ...flags] = args;
  if (!action || action === "help" || action === "--help" || action === "-h") {
    console.log(usage);
    return;
  }
  if (action === "workspace" || action === "open-session" || action === "prepare-flow") {
    const { runIssueWorkspaceCommand } = await import("./issue-workspace");
    return runIssueWorkspaceCommand(action, flags, cwd);
  }
  const { values } = parseArgs({
    args: flags,
    options: { login: { type: "string" }, request: { type: "string" }, json: { type: "boolean" } },
  });
  if (!values.login || !values.request || !values.json || values.request.length > 64000) throw new Error(usage);
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(values.request);
  } catch {
    throw new Error(usage);
  }
  if (!request || Array.isArray(request) || typeof request !== "object") throw new Error(usage);
  const account = await connectIssueAccount(cwd, values.login);
  let result;
  switch (action) {
    case "viewer":
      result = { viewer: account.viewer };
      break;
    case "origin":
      result = await readIssueOrigin(cwd, account, request);
      break;
    case "list": {
      const page = await listIssuePage(account, request as unknown as ListIssueRequest);
      await attachStages(cwd, page.viewer, page.items);
      result = page;
      break;
    }
    case "project": {
      const page = await readIssueProject(account, request as ProjectRequest);
      await attachStages(
        cwd,
        page.viewer,
        page.items.map((item) => item.issue),
      );
      result = page;
      break;
    }
    case "move":
      result = await moveIssueProjectItem(account, request as unknown as MoveRequest);
      break;
    case "detail":
      result = await issueDetail(account, request.ref as IssueRef);
      break;
    case "comments":
      result = await issueComments(account, request.ref as IssueRef, request.cursor as string | null);
      break;
    default:
      throw new Error(usage);
  }
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(JSON.stringify(result) + "\n", (error) => (error ? reject(error) : resolve())),
  );
}

async function attachStages(cwd: string, viewer: IssueViewer, items: IssueSummary[]) {
  const { issueWorkspaceStages } = await import("../integrations/issues/service");
  const stages = await issueWorkspaceStages(
    cwd,
    viewer,
    items.map((i) => i.ref),
  );
  for (const item of items) {
    const work = stages[issueKey(item.ref)];
    if (work) item.work = work;
  }
}
