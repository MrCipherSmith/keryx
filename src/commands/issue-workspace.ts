import path from "node:path";
import { parseArgs } from "node:util";
import { createFlowService, githubAdapter } from "../flow/service";
import { readGithubIssue, isIssueRef } from "../integrations/issues/service";
import { issueWorkspace, type IssueWorkRequest, type IssueWorkAction } from "../session/issues/issues-launch";
import { flowServiceDeps } from "./flow";

export async function runIssueWorkspaceCommand(action: IssueWorkAction, argv: string[], cwd = process.cwd()): Promise<void> {
  const { values } = parseArgs({ args: argv, options: {
    login: { type: "string" }, request: { type: "string" }, json: { type: "boolean" },
  } });
  if (!values.login || !values.request || values.request.length > 64000) throw new Error("Provide --login LOGIN and --request JSON.");
  const request = JSON.parse(values.request) as IssueWorkRequest;
  if (!request || !isIssueRef(request.ref) || [request.selectedCwd, request.flowDir, request.baseBranch].some(v => v !== undefined && typeof v !== "string"))
    throw new Error("configuration: Invalid issue workspace request.");
  const result = await issueWorkspace(action, cwd, values.login, request, {
    read: readGithubIssue,
    async init(project, issue) {
      const service = createFlowService({ ...flowServiceDeps(), tracker: { ...githubAdapter,
        detect: async () => true, fetchIssue: async () => ({ title: issue.title, body: issue.body }) } });
      const initialized = await service.init({ cwd: project.cwd, title: issue.title, issue: issue.ref.url, baseBranch: project.baseBranch });
      return { cloneId: project.cloneId, cwd: initialized.existingCwd ?? project.cwd, id: initialized.flow.id,
        flowDir: path.basename(initialized.dir), status: initialized.flow.status, baseBranch: initialized.flow.baseBranch ?? project.baseBranch };
    },
  });
  if (values.json || action === "workspace") {
    await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(result) + "\n", err => err ? reject(err) : resolve()));
    return;
  }
  if (!result.session || (result.problem && result.problem.code !== "resume_required")) throw new Error(result.problem?.message ?? "Open a matching checkout first.");
  const { shellCommand } = await import("./shell");
  const { sessionId, project } = result.session;
  if (process.cwd() !== project.cwd) process.chdir(project.cwd);
  const first = action === "prepare-flow" ? result.initialTurn : undefined;
  await shellCommand(["--resume", sessionId, ...(first ? ["--", first.text] : [])], first ? { issuePreparation: { sessionId, launchId: first.launchId } } : {});
}
