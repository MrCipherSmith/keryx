import { useEffect, useRef, useState } from "react";
import { Dialog, Spinner } from "../components/ui";
import { basename, errMessage } from "../lib/format";
import { setupRequestForFinding } from "../platform/projectDiagnostics";
import {
  applyProjectSetup, inspectProjectSetup, planProjectSetup, ProjectSetupError,
  type GraphAction, type SetupActionId, type SetupInspection, type SetupPlan, type SetupRequest, type SetupResult,
} from "../platform/projectSetup";

const graphLabels: Record<GraphAction, string> = {
  none: "Leave graph as is",
  check: "Check graph freshness",
  rebuild: "Rebuild graph",
  "check-and-rebuild": "Check and rebuild if stale",
};

const stepLabels: Record<string, string> = {
  init: "Initialize Metaproject",
  update: "Refresh managed files",
  configure: "Apply configuration and refresh managed files",
  gitignore: "Add shared ignore rule",
  graph: "Code graph",
  health: "Run Code Health",
  testingContext: "Refresh testing context",
  projectChecks: "Run changed-file tests",
  wikiCollect: "Collect wiki drafts",
  wikiIndex: "Index the wiki",
  wikiValidate: "Validate the wiki",
  wikiFreshness: "Recheck wiki freshness",
};

function emptyRequest(): SetupRequest {
  return { schemaVersion: 1, modules: {}, graph: "none", actions: [], gitignore: false, sharedAgents: false };
}

interface Props {
  cwd: string;
  opening?: boolean;
  initialInspection?: SetupInspection | null;
  initialError?: string;
  finding?: string;
  onClose: () => void;
  onResult?: (result: SetupResult) => void;
}

export function ProjectSetupDialog({ cwd, opening, initialInspection, initialError, finding, onClose, onResult }: Props) {
  const [inspection, setInspection] = useState(initialInspection ?? null);
  const [requestedFinding] = useState(finding);
  const [request, setRequest] = useState(() => ({
    ...emptyRequest(), ...(initialInspection && setupRequestForFinding(initialInspection, requestedFinding)),
  }));
  const prefilled = useRef(initialInspection !== undefined && initialInspection !== null);
  const [preview, setPreview] = useState<{ plan: SetupPlan; request: SetupRequest } | null>(null);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [error, setError] = useState(initialError ?? "");
  const [pending, setPending] = useState<"inspect" | "plan" | "apply" | null>(null);
  const [reload, setReload] = useState(0);
  const mounted = useRef(false);
  const pendingLock = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (reload === 0 && (initialInspection || initialError)) return;
    let current = true;
    setPending("inspect");
    setInspection(null);
    void inspectProjectSetup(cwd).then((report) => {
      if (!current) return;
      setInspection(report);
      if (!prefilled.current) {
        prefilled.current = true;
        setRequest({ ...emptyRequest(), ...setupRequestForFinding(report, requestedFinding) });
      }
    }).catch((failure: unknown) => {
      if (current) setError(errMessage(failure));
    }).finally(() => {
      if (current) setPending(null);
    });
    return () => { current = false; };
  }, [cwd, initialError, initialInspection, reload, requestedFinding]);

  const retryInspection = () => {
    setError("");
    setPreview(null);
    setResult(null);
    setReload((n) => n + 1);
  };

  const prepare = async () => {
    if (!inspection || pending || pendingLock.current) return;
    pendingLock.current = true;
    setError("");
    setPending("plan");
    try {
      const plan = await planProjectSetup(cwd, request);
      if (!mounted.current) return;
      if (plan.root !== inspection.root) throw new Error("The project location changed. Check the folder again.");
      setPreview({ plan, request });
    } catch (failure) {
      if (mounted.current) setError(errMessage(failure));
    } finally {
      pendingLock.current = false;
      if (mounted.current) setPending(null);
    }
  };

  const apply = async () => {
    if (!preview || preview.plan.status !== "ready" || pending || pendingLock.current) return;
    pendingLock.current = true;
    setPending("apply");
    setError("");
    try {
      const applied = await applyProjectSetup(cwd, preview.request, preview.plan.planId);
      if (!mounted.current) return;
      if (applied.root !== preview.plan.root) throw new Error("The CLI returned a result for a different project.");
      setResult(applied);
      setPreview(null);
      onResult?.(applied);
    } catch (failure) {
      if (!mounted.current) return;
      setPreview(null);
      setError(failure instanceof ProjectSetupError && failure.code === "stale-plan"
        ? "Project files changed since the preview. Create a new preview before applying."
        : errMessage(failure));
      // The next preview uses a fresh inspection. Selections remain editable.
      setReload((n) => n + 1);
    } finally {
      pendingLock.current = false;
      if (mounted.current) setPending(null);
    }
  };

  const editAction = (id: SetupActionId, selected: boolean) => setRequest((current) => ({
    ...current, actions: selected ? [...current.actions, id] : current.actions.filter((action) => action !== id),
  }));
  const enabled = (name: string) => {
    const module = inspection?.modules.find((entry) => entry.name === name);
    return request.modules[name] ?? module?.enabled ?? module?.defaultEnabled ?? false;
  };
  const setModule = (name: string, selected: boolean) => setRequest((current) => {
    const unavailable = new Set(inspection?.actions.filter((action) => action.module === name).map((action) => action.id));
    return {
      ...current,
      modules: { ...current.modules, [name]: selected },
      maintenanceOnly: false,
      graph: name === "gdgraph" && !selected ? "none" : current.graph,
      actions: selected ? current.actions : current.actions.filter((id) => !unavailable.has(id)),
    };
  });
  const title = inspection?.state === "incomplete" ? "Repair Metaproject"
    : inspection?.compatibility === "older" ? "Update Metaproject"
    : inspection?.state === "initialized" ? "Configure Metaproject" : "Set up Metaproject";
  const canPreview = inspection && inspection.compatibility !== "newer" && !inspection.enclosingRoot;

  return (
    <Dialog title={title} icon="settings" width={760} onClose={pending === "apply" ? null : onClose} focusRoot
      footer={<>
        <button className="btn" disabled={pending === "apply"} onClick={onClose}>
          {opening ? (result ? "Open project" : "Open without setup") : result ? "Done" : "Cancel"}
        </button>
        {result?.status === "partial" ? <button className="btn" onClick={retryInspection}>Check project again</button> : null}
        {preview && !result ? <>
          <button className="btn" disabled={pending === "apply"} onClick={() => { setPreview(null); setError(""); }}>Back</button>
          <button className="btn btn-primary" disabled={pending !== null || preview.plan.status !== "ready"} onClick={() => void apply()}>
            {pending === "apply" ? <Spinner /> : null} Apply changes
          </button>
        </> : null}
        {!preview && !result && canPreview ? (
          <button className="btn btn-primary" disabled={pending !== null} onClick={() => void prepare()}>Preview changes</button>
        ) : !inspection && !result && pending === null && error ? <button className="btn" onClick={retryInspection}>Check again</button> : null}
      </>}
    >
      <div className="project-setup">
        <div>
          <strong>{basename(cwd)}</strong>
          <div className="project-setup-path mono">{inspection?.root ?? cwd}</div>
          {inspection ? <div className="field-hint">CLI {inspection.cliVersion} · {inspection.cliSource} · Project writer {inspection.writerVersion ?? "unknown"}</div> : null}
        </div>
        {pending ? <div className="loading-row" role="status"><Spinner /> {
          pending === "inspect" ? "Checking this project…" : pending === "plan" ? "Preparing preview…" : "Applying the approved setup…"
        }</div> : null}
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        {result ? <SetupOutcome result={result} /> : preview ? <SetupPreview plan={preview.plan} /> : inspection ? <>
          {inspection.findings.length > 0 ? (
            <details open={inspection.findings.some(({ severity }) => severity === "error") || undefined}>
              <summary>Project findings ({inspection.findings.length})</summary>
              <ul>{inspection.findings.map((finding, index) => <li key={`${finding.id}-${index}`}>{finding.message}</li>)}</ul>
            </details>
          ) : null}
          {inspection.enclosingRoot ? <p>Open the enclosing project at <code>{inspection.enclosingRoot}</code> to configure it.</p> : null}
          {canPreview ? <>
            {requestedFinding && inspection.state === "initialized" ? <label className="project-setup-option">
              <input type="checkbox" checked={!request.maintenanceOnly} disabled={pending !== null} onChange={(e) => {
                const refresh = e.target.checked;
                setRequest((current) => refresh ? { ...current, maintenanceOnly: false } : {
                  ...emptyRequest(), graph: current.graph, actions: current.actions, maintenanceOnly: true,
                });
              }} />
              <span>Refresh managed project files</span>
            </label> : null}
            {request.maintenanceOnly ? <p className="field-hint">
              Only the selected maintenance actions will run. Changing modules or project files adds a managed-file refresh.
            </p> : null}
            <fieldset className="project-setup-group" disabled={pending !== null}>
              <legend>Modules</legend>
              <div className="project-setup-modules">
                {inspection.modules.map((module) => (
                  <label className="project-setup-option" key={module.name}>
                    <input type="checkbox" checked={enabled(module.name)} onChange={(e) => setModule(module.name, e.target.checked)} />
                    <span><strong>{module.name}</strong><small>{module.description}</small></span>
                  </label>
                ))}
              </div>
              {enabled("gdskills") ? <label className="field">
                <span className="field-label">Skills profile</span>
                <select value={request.gdskillsProfile ?? inspection.gdskillsProfile} onChange={(e) => setRequest({ ...request, maintenanceOnly: false, gdskillsProfile: e.target.value || undefined })}>
                  {!inspection.gdskillsProfiles.includes(inspection.gdskillsProfile) ? <option value={inspection.gdskillsProfile} disabled>Current ({inspection.gdskillsProfile})</option> : null}
                  {inspection.gdskillsProfiles.map((profile) => <option key={profile}>{profile}</option>)}
                </select>
              </label> : null}
            </fieldset>
            <fieldset className="project-setup-group" disabled={pending !== null}>
              <legend>Project files</legend>
              <label className="project-setup-option">
                <input type="checkbox" checked={request.sharedAgents} onChange={(e) => setRequest({ ...request, sharedAgents: e.target.checked, maintenanceOnly: false })} />
                <span>Create or update shared <code>AGENTS.md</code></span>
              </label>
              <label className="project-setup-option">
                <input type="checkbox" checked={request.gitignore} onChange={(e) => setRequest({ ...request, gitignore: e.target.checked, maintenanceOnly: false })} />
                <span>Add <code>/.metaproject/</code> to <code>.gitignore</code></span>
              </label>
            </fieldset>
            <fieldset className="project-setup-group" disabled={pending !== null}>
              <legend>After setup</legend>
              <label className="field">
                <span className="field-label">Code graph</span>
                <select value={request.graph} disabled={!enabled("gdgraph")} onChange={(e) => {
                  const graph = inspection.graphActions.find((action) => action === e.target.value);
                  if (graph) setRequest({ ...request, graph });
                }}>
                  {inspection.graphActions.map((action) => <option value={action} key={action}>{graphLabels[action]}</option>)}
                </select>
              </label>
              {inspection.actions.map(({ id, module, runsProjectCommands }) => (
                <label className="project-setup-option" key={id}>
                  <input type="checkbox" disabled={!enabled(module)} checked={request.actions.includes(id)} onChange={(e) => editAction(id, e.target.checked)} />
                  <span>{stepLabels[id] ?? id}{runsProjectCommands ? <small>Runs project commands</small> : null}</span>
                </label>
              ))}
            </fieldset>
          </> : null}
        </> : null}
      </div>
    </Dialog>
  );
}

function SetupPreview({ plan }: { plan: SetupPlan }) {
  const changedModules = plan.modules.filter((module) => module.selected !== module.enabled);
  const edits = [...plan.entrypoints, ...(plan.gitignore ? [plan.gitignore] : [])];
  const changes = plan.files.filter(({ outcome }) => outcome !== "skip");
  return <>
    <h3>Review setup changes</h3>
    {plan.blocked.length > 0 ? <ul className="field-error" role="alert">
      {plan.blocked.map(({ id, message }, index) => <li key={`${id}-${index}`}>{message}</li>)}
    </ul> : null}
    <div>
      <h4>Modules</h4>
      {changedModules.length ? <ul>{changedModules.map((module) => <li key={module.name}>{module.name} · {module.selected ? "Enable" : "Disable"}</li>)}</ul>
        : <p>No module selections changed.</p>}
    </div>
    <div>
      <h4>Operations</h4>
      <ul>{plan.steps.map((step) => <li key={step.id}>
        {stepLabels[step.id] ?? step.id}{step.status === "skipped" ? " · Skipped" : ""}{step.detail ? ` · ${step.detail}` : ""}
      </li>)}</ul>
      {plan.mode !== "maintenance" ? <p className="field-hint">Keryx may reconcile its managed hooks. Their exact changes depend on the existing hook files.</p> : null}
    </div>
    {edits.length > 0 || changes.length > 0 || plan.ignore?.exclude ? <div>
      <h4>Files</h4>
      {edits.map((edit) => <details key={edit.path}>
        <summary><code>{edit.path}</code> · {edit.action}</summary>
        {edit.detail ? <p>{edit.detail}</p> : null}
        {edit.before !== undefined && edit.before !== null && edit.before !== edit.after ? <>
          <h5>Current text</h5><pre>{edit.before}</pre>
        </> : null}
        {edit.after !== undefined ? <><h5>Planned text</h5><pre>{edit.after}</pre></> : null}
      </details>)}
      {changes.length > 0 ? <details>
        <summary>Managed files ({changes.length})</summary>
        <ul>{changes.map((file) => <li key={file.path}><code>{file.path}</code> · {file.outcome}</li>)}</ul>
      </details> : null}
      {plan.ignore?.exclude ? <details>
        <summary>Local Git exclude · {plan.ignore.exclude.status}</summary>
        <ul>
          {plan.ignore.exclude.added?.map((line) => <li key={`add:${line}`}>Add <code>{line}</code></li>)}
          {plan.ignore.exclude.removed?.map((line) => <li key={`remove:${line}`}>Remove <code>{line}</code></li>)}
        </ul>
      </details> : null}
      {plan.trackedMetaproject && plan.trackedMetaproject.count > 0 ? <details>
        <summary>{plan.trackedMetaproject.count} Metaproject files already tracked by Git</summary>
        <p>They will stay tracked.</p>
        <ul>{plan.trackedMetaproject.examples.map((filename) => <li key={filename}><code>{filename}</code></li>)}</ul>
      </details> : null}
    </div> : null}
  </>;
}

function SetupOutcome({ result }: { result: SetupResult }) {
  return <>
    <h3 role="status">{result.status === "completed" ? "Setup completed" : "Setup needs attention"}</h3>
    <ul>{result.steps.map((step) => <li key={step.id}>
      <strong>{stepLabels[step.id] ?? step.id}</strong> · {step.status}
      {step.detail ? ` · ${step.detail}` : step.exitCode ? ` · Exit ${step.exitCode}` : ""}
    </li>)}</ul>
    {result.status === "partial" ? <p>Check the project again before retrying. The completed steps may have changed project files.</p> : null}
    {!result.journaled ? <p className="field-error">Keryx could not save the setup receipt.</p> : null}
  </>;
}
