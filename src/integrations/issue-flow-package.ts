import path from "node:path";
import { readFile, access } from "node:fs/promises";
import { flowsRoot, parseAcceptanceCriteria, readFlow } from "../flow/service";
import type { IssueFlowRef, IssueWorkspace } from "./issues-contract";

export async function prepareAvailable(cwd: string): Promise<IssueWorkspace["problem"]> {
  const manifest = await readFile(path.join(cwd, ".metaproject/metaproject.json"), "utf8").catch(() => "");
  if (!manifest || JSON.parse(manifest)?.modules?.tasks?.enabled !== true)
    return { code: "tasks_module_unavailable", message: "Enable Task Manager in this project's Metaproject to prepare a Flow." };
  try { await access(path.join(cwd, ".metaproject/skills/gdskills/orchestration/flow-orchestrator/SKILL.md")); }
  catch { return { code: "capability_missing", message: "Install the flow-orchestrator skill in this project, then retry." }; }
}

export async function artifactsPrepared(ref: IssueFlowRef): Promise<boolean> {
  const root = path.join(flowsRoot(ref.cwd), ref.flowDir);
  try {
    const [flow, plan, ac] = await Promise.all([readFlow(ref.cwd, ref.flowDir),
      readFile(path.join(root, "plan.md"), "utf8"), readFile(path.join(root, "acceptance-criteria.md"), "utf8")]);
    const criteria = parseAcceptanceCriteria(ac);
    return flow.tasks.some(task => task.origin !== "scaffold") && !!plan.trim() && !plan.includes("Chosen approach and why (link brainstorm")
      && criteria.length > 0 && criteria.every(c => c.text && !c.text.includes("<replace"));
  } catch { return false; }
}

