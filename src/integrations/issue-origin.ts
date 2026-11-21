import { issueSourceUrl } from "../flow/issue-source";
import { listFlowDirs, readFlow } from "../flow/store";
import { sessionDir } from "../session";
import { FLOW_REF } from "../session/organize";
import { issueContextForSession } from "./issue-session";
import { graphSummary, issueDetail, issueFields, type GithubIssue } from "./issues-board";
import { issueViewerKey, type IssueDetail } from "./issues-contract";
import { denied, invalidInput, type IssueAccount } from "./issues-github";

/** Only return source metadata after rechecking access with the named account. */
export async function readIssueOrigin(cwd: string, account: IssueAccount, request: Record<string, unknown>, dataDir?: string) {
  const { sessionId, flowDir } = request;
  const { viewer } = account;
  if (Object.keys(request).length !== 1) throw new Error(invalidInput);
  let issue: IssueDetail | null = null;
  if (typeof sessionId === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) {
    const binding = issueContextForSession(sessionDir(cwd, sessionId, dataDir), dataDir);
    if (binding) {
      if (issueViewerKey(binding.launch.viewer) !== issueViewerKey(viewer)) throw new Error(denied);
      issue = (await issueDetail(account, binding.launch.issue)).issue;
    }
  } else if (typeof flowDir === "string" && FLOW_REF.test(flowDir)) {
    if (!(await listFlowDirs(cwd)).includes(flowDir)) throw new Error(invalidInput);
    const { source } = await readFlow(cwd, flowDir);
    if (source?.type === "github-issue" && source.ref) {
      const url = issueSourceUrl(source.ref);
      if (!url) throw new Error(invalidInput);
      const [, owner, repo, , number] = new URL(url).pathname.split("/");
      const { repository } = await account.api.graphql<{
        repository: {issue: (GithubIssue & {body:string; stateReason:string|null}) | null} | null;
      }>(
        `query($owner:String!,$repo:String!,$number:Int!) { repository(owner:$owner,name:$repo) { issue(number:$number) { ${issueFields} body stateReason } } }`,
        { owner, repo, number: Number(number) },
      );
      const row = repository?.issue;
      if (row?.__typename !== "Issue" || issueSourceUrl(row.url) !== url) throw new Error(denied);
      issue = { ...graphSummary(row), body: row.body, ...(row.stateReason ? { stateReason: row.stateReason } : {}) };
    }
  } else {
    throw new Error(invalidInput);
  }
  return { viewer, issue, ref: issue?.ref ?? null };
}
