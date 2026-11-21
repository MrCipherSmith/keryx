import { issueSourceUrl, listFlowDirs, readFlow } from "../../flow/service";
import { sessionDir } from "../index";
import { FLOW_REF } from "../organize";
import { issueContextForSession } from "./issue-session";
import { issueDetail, readIssueSource, denied, invalidInput, type IssueAccount } from "../../integrations/issues/service";
import { issueViewerKey, type IssueDetail } from "../../integrations/issue-context/service";

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
      issue = await readIssueSource(account, url);
    }
  } else {
    throw new Error(invalidInput);
  }
  return { viewer, issue, ref: issue?.ref ?? null };
}
