import { basename, useAcpSession } from "../session/useAcpSession";
import { AskUserDialog, FatalDialog, PermissionDialog } from "./Dialogs";
import { Composer } from "./Composer";
import { SidePanel } from "./SidePanel";
import { Transcript } from "./Transcript";
import { acpStop, pickFolder, windowOpenProject } from "../platform/commands";

interface Props {
  cwd: string;
  onSettings: () => void;
  onClose: () => void;
}

export function SessionScreen({ cwd, onSettings, onClose }: Props) {
  const s = useAcpSession(cwd);
  const { state } = s;
  const running = state.phase === "ready";

  const openAnother = async () => {
    const picked = await pickFolder();
    if (picked) await windowOpenProject(picked);
  };

  const topPermission = s.permissions[0];
  const topAsk = s.asks[0];

  return (
    <div className="session">
      <header className="toolbar">
        <button className="btn btn-small" onClick={onClose} title="Back to the welcome screen">‹ Projects</button>
        <div className="toolbar-title">
          <strong>{basename(cwd)}</strong>
          <span className="muted path" title={cwd}>{cwd}</span>
        </div>
        <span className="muted">{state.title ?? ""}</span>
        <div className="grow" />
        <button className="btn btn-small" onClick={openAnother}>Open Folder…</button>
        <button className="btn btn-small" onClick={onSettings}>Settings</button>
      </header>

      {state.banners.map((b) => (
        <div key={b.id} className={`banner banner-${b.level}`}>{b.text}</div>
      ))}
      {state.phase === "exited" ? (
        <div className="banner banner-error">
          <span>
            keryx exited{state.exit?.code != null ? ` (code ${state.exit.code})` : ""}.
            {state.exit?.stderrTail ? <code className="stderr">{state.exit.stderrTail.trim().split("\n").slice(-3).join(" ⏎ ")}</code> : null}
          </span>
          <button className="btn btn-small" onClick={s.restart}>Restart</button>
        </div>
      ) : null}
      {state.phase === "starting" ? <div className="banner banner-info">Starting keryx…</div> : null}

      <div className="body">
        <main className="main">
          <Transcript items={state.items} busy={state.busy} />
          <Composer
            busy={state.busy}
            disabled={!running || s.fatal?.kind === "incompatible"}
            commands={state.commands}
            onSend={(t) => void s.sendPrompt(t)}
            onStop={s.cancel}
          />
        </main>
        <SidePanel
          state={state}
          onNew={() => void s.newSession()}
          onLoad={(id) => void s.loadSession(id)}
          onMode={(id) => void s.setMode(id)}
          onModel={(c, v) => void s.setModel(c, v)}
        />
      </div>

      {s.fatal ? (
        <FatalDialog
          fatal={s.fatal}
          agentVersion={state.agentVersion}
          onContinue={s.continueAnyway}
          onNewSession={() => void s.newSession()}
          onDismiss={s.dismissFatal}
          onClose={() => { void acpStop(); onClose(); }}
        />
      ) : null}
      {!s.fatal && topPermission ? <PermissionDialog key={topPermission.req.toolCall.toolCallId + s.permissions.length} pending={topPermission} onAnswer={s.answerPermission} /> : null}
      {!s.fatal && !topPermission && topAsk ? <AskUserDialog pending={topAsk} onAnswer={s.answerAsk} /> : null}
    </div>
  );
}
