import { issueSourceUrl } from "../flow/issue-source";
import { graphSummary, issueFields, type GithubIssue } from "./issues-board";
import { denied, type IssueAccount } from "./issues-github";
import type { IssueDetail } from "./issues-contract";

/** Re-read the GitHub source of an existing Flow under the selected credential. */
export async function readIssueSource(account: IssueAccount, url: string): Promise<IssueDetail> {
  const [, owner, repo, , number] = new URL(url).pathname.split("/");
  const { repository } = await account.api.graphql<{
    repository: {issue: (GithubIssue & {body:string; stateReason:string|null}) | null} | null;
  }>(
    `query($owner:String!,$repo:String!,$number:Int!) { repository(owner:$owner,name:$repo) { issue(number:$number) { ${issueFields} body stateReason } } }`,
    { owner, repo, number: Number(number) },
  );
  const row = repository?.issue;
  if (row?.__typename !== "Issue" || issueSourceUrl(row.url) !== url) throw new Error(denied);
  return { ...graphSummary(row), body: row.body, ...(row.stateReason ? { stateReason: row.stateReason } : {}) };
}
