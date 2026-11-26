import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { Spinner } from "../components/ui";
import { errMessage } from "../lib/format";
import { pickFolder } from "../platform/commands";
import { addLinkedProject, listLinkedProjects, removeLinkedProject, type LinkedProject, type LinkedProjectsResult } from "../platform/linkedProjects";

/** One line of what keryx read about a linked project: its stack, its keryx context, its agent rules. */
export function linkedProjectFacts(project: LinkedProject): string {
  if (!project.exists) return "Folder not found on this machine";
  return [
    project.stack.join(", "),
    project.keryxIndex ? "keryx context" : "",
    project.instructions.join(", "),
  ].filter((fact) => fact.length > 0).join(" · ");
}

/**
 * Project Settings → Linked projects: the folders this project organises. The agent's system prompt
 * names each with its summary, and a subagent can be started in one. Same list as `/ref` and `keryx ref`.
 */
export function LinkedProjectsSettings({ cwd }: { cwd: string }) {
  const [result, setResult] = useState<LinkedProjectsResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async (key: string, action: () => Promise<LinkedProjectsResult>) => {
    setBusy(key);
    setError("");
    try {
      setResult(await action());
    } catch (failure) {
      setError(errMessage(failure));
    } finally {
      setBusy(null);
    }
  }, []);
  useEffect(() => {
    let mounted = true;
    void listLinkedProjects(cwd).then(
      (loaded) => { if (mounted) setResult(loaded); },
      (failure: unknown) => { if (mounted) setError(errMessage(failure)); },
    );
    return () => { mounted = false; };
  }, [cwd]);
  const add = async () => {
    const folder = await pickFolder("Link a folder to this project");
    if (folder) await run("add", () => addLinkedProject(cwd, folder));
  };
  return (
    <section className="linked-projects" aria-label="Linked projects">
      <div className="field-label">Linked projects</div>
      <p className="settings-row-help">
        Folders this project organises, usually sibling repositories. The agent is told what each one is
        and can start a subagent in it. The same list as <code>/ref</code> in the shell.
      </p>
      {result === null && !error ? <div className="loading-row"><Spinner /> Loading linked projects…</div> : null}
      {result !== null && result.projects.length === 0 ? <p className="settings-row-help">No linked projects yet.</p> : null}
      {result !== null && result.projects.length > 0 ? (
        <ul className="linked-project-list">
          {result.projects.map((project) => (
            <li key={project.name} className="linked-project-row">
              <Icon name={project.exists ? "folder" : "alert"} size={14} />
              <div className="linked-project-text">
                <div className="truncate"><strong>{project.name}</strong> <span className="dim" title={project.root}>{project.path}</span></div>
                {project.description ? <div className="settings-row-help truncate" title={project.description}>{project.description}</div> : null}
                <div className="settings-row-help truncate">{linkedProjectFacts(project)}</div>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null}
                aria-label={`Remove ${project.name}`} title="Unlink (the folder is not touched)"
                onClick={() => void run(`remove:${project.name}`, () => removeLinkedProject(cwd, project.name))}>
                {busy === `remove:${project.name}` ? <Spinner /> : <Icon name="x" size={13} />}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {result?.warnings.map((warning) => <p key={warning} className="settings-row-help">{warning}</p>)}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="settings-actions">
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void add()}>
          {busy === "add" ? <Spinner /> : <Icon name="plus" size={13} />} Add folder…
        </button>
      </div>
    </section>
  );
}
