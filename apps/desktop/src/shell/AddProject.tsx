import { useState, type FormEvent } from "react";
import { Dialog } from "../components/ui";
import { basename, errMessage } from "../lib/format";
import { pickFolder } from "../platform/commands";
import { validProject, absolutePath, type ProjectConfig } from "./projectConfig";

export function AddProject({ onClose, onOpen, allowSsh }: {
  onClose: () => void; onOpen: (project: ProjectConfig) => Promise<void>; allowSsh: boolean;
}) {
  const [ssh, setSsh] = useState(false);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [local, setLocal] = useState({ path: "", references: [] as string[] });
  const [remote, setRemote] = useState({ path: "", references: [] as string[] });
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { path, references } = ssh ? remote : local;
  const setDraft = ssh ? setRemote : setLocal;
  const project = { path, references, name: name.trim() || basename(path) || path, ...(ssh ? { host: host.trim() } : {}) };
  const ready = !busy && validProject(project) && (!ssh || !reference);

  const add = (folder: string) => {
    if (!absolutePath(folder)) return;
    setDraft(draft => ({ ...draft, references: [...new Set([...draft.references, folder])].slice(0, 16) }));
    setReference("");
  };
  const pick = async (ref: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const folder = await pickFolder(ref ? "Choose a reference folder" : "Choose the project folder");
      if (folder) ref ? add(folder) : setLocal(draft => ({ ...draft, path: folder }));
    } catch (cause) { setError(errMessage(cause)); }
    finally { setBusy(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try { await onOpen(project); }
    catch (cause) { setError(errMessage(cause)); setBusy(false); }
  };

  return <Dialog title="Add Project" onClose={() => { if (!busy) onClose(); }} footer={<>
    <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
    <button className="btn btn-primary" form="add-project-form" type="submit" disabled={!ready}>{ssh ? "Connect" : "Open Project"}</button>
  </>}><form id="add-project-form" className="ssh-project-form" onSubmit={submit}>
    <label>Project name<input disabled={busy} value={name} onChange={e => setName(e.target.value)} placeholder="Defaults to the folder name" /></label>
    {allowSsh && <label><span><input type="checkbox" disabled={busy} checked={ssh} onChange={e => { setSsh(e.target.checked); setReference(""); }} /> Connect via SSH</span></label>}
    {ssh ? <><label>SSH host alias<input disabled={busy} value={host} onChange={e => setHost(e.target.value)} placeholder="devbox" /></label>
      <label>Absolute remote project path<input disabled={busy} value={path} onChange={e => setRemote(draft => ({ ...draft, path: e.target.value }))} /></label></>
      : <div><button type="button" className="btn" disabled={busy} onClick={() => void pick(false)}>Choose project folder…</button> {path}</div>}
    <fieldset disabled={busy}><legend>Reference folders (read-only)</legend>
      <ul>{references.map(folder => <li key={folder}>{folder} <button type="button" className="btn btn-sm" aria-label={`Remove ${folder}`} onClick={() => setDraft(draft => ({ ...draft, references: draft.references.filter(item => item !== folder) }))}>Remove</button></li>)}</ul>
      {ssh && <label>Absolute remote reference path<input value={reference} onChange={e => setReference(e.target.value)} placeholder="/home/me/docs" /></label>}
      <button type="button" className="btn" disabled={references.length >= 16 || (ssh && !absolutePath(reference))} onClick={() => ssh ? add(reference) : void pick(true)}>Add reference folder</button>
    </fieldset>{error && <p role="alert">{error}</p>}
  </form></Dialog>;
}
