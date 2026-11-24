import { useEffect } from "react";
import { Spinner } from "../components/ui";
import { usePrefs } from "../lib/prefs";
import { setWindowTitle } from "../platform/commands";
import { AskUserDialog, PermissionDialog } from "../session/Approvals";
import { Composer } from "../session/Composer";
import { Transcript } from "../session/Transcript";
import { modelOption, useAcpSession } from "../session/useAcpSession";

import type { ProjectConfig } from "./projectConfig";

export function SshProjectWindow({ project, onClose }: { project: ProjectConfig & { host: string }; onClose: () => void }) {
  const { host, path } = project;
  const s = useAcpSession(path, host, project.references);
  const { state, fatal } = s;
  const { sendKey } = usePrefs();
  const ready = state.phase === "ready" && (!fatal || fatal.kind === "leased");
  const permission = s.permissions[0];
  const ask = s.asks[0];
  const target = `${host}:${path}`;
  useEffect(() => {
    void setWindowTitle(`${project.name} — Keryx`);
    return () => { void setWindowTitle("Keryx"); };
  }, [project.name]);

  return <main className="ssh-project">
    <header className="ssh-project-bar" data-tauri-drag-region><strong className="truncate" title={target}>{project.name}</strong><button className="btn" onClick={onClose}>Disconnect</button></header>
    <div className="ssh-project-bar ssh-project-sessions">
      <select aria-label="Remote sessions" value={state.sessions.some(item => item.sessionId === state.sessionId) ? state.sessionId ?? "" : ""}
        disabled={!ready || state.opening} onChange={event => { if (event.target.value) void s.loadSession(event.target.value); }}>
        <option value="" disabled>Open a saved session…</option>
        {state.sessions.map(item => <option key={item.sessionId} value={item.sessionId}>{item.title?.trim() || `Session ${item.sessionId}`}</option>)}
      </select>
      <button className="btn" disabled={!ready || state.opening} onClick={() => void s.newSession()}>New session</button>
    </div>
    <section className="session-main" aria-label="Remote conversation">
      {state.phase === "starting" && !fatal && <div className="inline-banner" role="status"><Spinner /> Connecting over SSH…</div>}
      {state.banners.map(banner => <div key={banner.id} className="inline-banner" role="status">{banner.text}<button className="btn" onClick={() => s.dismissBanner(banner.id)}>Dismiss</button></div>)}
      {fatal?.kind === "leased" && <div className="inline-banner" role="alert">That session is open in another Keryx process.</div>}
      {state.phase === "exited" || (fatal && fatal.kind !== "leased") ? <div className="session-banners" role="alert"><div className="inline-banner">{fatal?.kind === "noShell" ? "Remote Keryx must support the shell profile and live sessions." : "SSH or ACP startup failed. Check the host, project path and remote Keryx version."}<button className="btn" onClick={s.restart}>Reconnect</button></div>{state.exit?.stderrTail && <pre className="exit-tail">{state.exit.stderrTail}</pre>}</div>
        : ready && state.sessionId && !state.held && !state.opening && <div className="inline-banner">Session closed.<button className="btn" onClick={s.reopen}>Reopen</button></div>}
      <Transcript key={state.sessionId ?? ""} hideLocalAttachments items={state.items} busy={state.busy} replaying={state.replaying} empty={null} />
      <div className="composer-dock"><Composer sessionId={state.sessionId} busy={state.busy} commands={[]} modes={state.modes}
        model={modelOption(state.configOptions)} sendKey={sendKey} disabledReason={ready && state.held && !state.replaying ? null : "Open a remote session to chat."}
        onSend={text => s.sendPrompt(text)} onStop={s.cancel} onMode={id => void s.setMode(id)} onModel={(id, value) => void s.setModel(id, value)} /></div>
    </section>
    {permission ? <PermissionDialog key={permission.id} pending={permission} modeId={state.modes?.currentModeId ?? null} queued={s.permissions.length - 1} onAnswer={s.answerPermission} />
      : ask ? <AskUserDialog key={ask.id} pending={ask} onAnswer={s.answerAsk} /> : null}
  </main>;
}
