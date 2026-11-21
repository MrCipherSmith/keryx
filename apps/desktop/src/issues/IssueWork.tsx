import { useCallback, useEffect, useRef, useState } from "react";
import type { IssueFlowRef, IssueRef, IssueWorkspace } from "../../../../src/integrations/issues-contract";
import { Dialog } from "../components/ui";
import { isTauri, invoke, listen } from "../platform/backend";
import { pickFolder } from "../platform/commands";
import { requestIssues } from "../platform/issues";
import { errMessage } from "../lib/format";

export type WorkAction = "open-session" | "prepare-flow" | "open-flow";
interface Intent { action: WorkAction; login: string; ref: IssueRef; flowDir?: string }
interface Choice { intent: Intent; projects?: string[]; flows?: IssueFlowRef[] }
interface Host {
  cwd: string;
  ready: boolean;
  canPrepare: boolean;
  showSession: (id: string, turn?: {launchId: string; text: string}) => Promise<void>;
  showFlow: (dir: string) => void;
  notifyError: (error: string) => void;
}

export function useIssueWork(host: Host) {
  const current = useRef(host);
  current.current = host;
  const [choice, setChoice] = useState<Choice | null>(null);
  const run = useCallback(async (intent: Intent, selected = false) => {
    const {cwd, showSession, showFlow, canPrepare} = current.current;
    const params = {ref: intent.ref, flowDir: intent.flowDir, ...(selected ? {selectedCwd:cwd} : {})};
    const workspace = await requestIssues<IssueWorkspace>(cwd, intent.login, "workspace", params);
    const projects = workspace.projects.map(p => p.cwd);
    if (!selected && projects.length !== 1) {
      setChoice({ intent, projects });
      return;
    }
    const target = selected ? cwd : projects[0]!;
    if (target !== cwd) {
      await invoke("issues_transfer", {target, intent});
      return;
    }
    if (selected && workspace.problem && ["project_required", "project_ambiguous", "account_mismatch"].includes(workspace.problem.code)) throw new Error(workspace.problem.message);
    if (intent.action !== "open-session" && !intent.flowDir && workspace.flows.length > 1) {
      setChoice({intent, flows:workspace.flows});
      return;
    }
    const linked = workspace.flows.find(f => f.flowDir === (intent.flowDir ?? workspace.launch?.flow?.flowDir)) ?? (workspace.flows.length === 1 ? workspace.flows[0] : undefined);
    if (intent.action === "prepare-flow" && linked && linked.cwd !== cwd) {
      await invoke("issues_transfer", {target: linked.cwd, intent: {...intent, flowDir: linked.flowDir}});
      return;
    }
    if (intent.action === "open-flow") {
      const flow = workspace.flows.find(f => !intent.flowDir || f.flowDir === intent.flowDir);
      if (!flow) throw new Error("The linked Flow is unavailable. Refresh the issue.");
      if (flow.cwd !== cwd) await invoke("issues_transfer", {target:flow.cwd, intent:{...intent, flowDir:flow.flowDir}});
      else showFlow(flow.flowDir);
      return;
    }
    if (intent.action === "prepare-flow" && !canPrepare) throw new Error("This session provider cannot prepare issue Flows. Select the bundled Keryx CLI in Settings.");
    const result = await requestIssues<IssueWorkspace>(cwd, intent.login, intent.action, {...params, selectedCwd:cwd});
    const inspecting = intent.action === "open-session" && result.session && result.problem && ["resume_required", "launch_outcome_unknown"].includes(result.problem.code);
    if (result.problem && !inspecting) throw new Error(result.problem.message);
    if (!result.session) throw new Error("Keryx could not open the linked session. Refresh the issue and try again.");
    if (result.session.project.cwd !== cwd) {
      await invoke("issues_transfer", {target:result.session.project.cwd, intent});
      return;
    }
    await showSession(result.session.sessionId, intent.action === "prepare-flow" ? result.initialTurn : undefined);
  }, []);

  useEffect(() => {
    if (!host.ready || !isTauri()) return;
    let active = true;
    const take = async () => {
      const intent = await invoke<Intent | null>("issues_take_transfer");
      if (active && intent) await run(intent, true);
    };
    const receive = () => { void take().catch(error => {if (active) current.current.notifyError(errMessage(error));}); };
    const off = listen("issues://transfer", receive, "app");
    void off.then(receive).catch(error => { if (active) current.current.notifyError(errMessage(error)); });
    return () => {active = false; void off.then(remove => remove()).catch(() => {});};
  }, [host.ready, host.cwd, run]);

  const select = (target: string, intent: Intent, folder: boolean) => {
    setChoice(null);
    const promise = folder && target !== host.cwd ? invoke("issues_transfer", {target,intent}) : run(intent,true);
    void promise.catch(error => current.current.notifyError(errMessage(error)));
  };
  const chooser = choice && <Dialog title={choice.projects ? "Choose the issue checkout" : "Choose the linked Flow"} icon="folderOpen" onClose={() => setChoice(null)}>
    {choice.projects?.map(path => <button className="btn" key={path} onClick={() => select(path,choice.intent,true)}>{path}</button>)}
    {choice.projects?.length === 0 && <><p>Open a checkout of {choice.intent.ref.owner}/{choice.intent.ref.repo} to work on this issue.</p>
      <button className="btn" onClick={() => void pickFolder().then(path => {if(path) select(path,choice.intent,true);})}>Choose folder…</button></>}
    {choice.flows?.map(flow => <button className="btn" key={flow.cwd + "/" + flow.flowDir} onClick={() => select(flow.cwd,{...choice.intent,flowDir:flow.flowDir},true)}>{flow.flowDir} · {flow.status}</button>)}
  </Dialog>;
  return {run, chooser};
}
