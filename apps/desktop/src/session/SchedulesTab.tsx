import { useCallback, useEffect, useState } from "react";
import { COMMAND_METHOD, parseCommandLine } from "../acp/commands";
import type { CommandResult, CommandView, ViewAction } from "../acp/types";
import { Icon } from "../components/Icon";
import { Dialog, Spinner } from "../components/ui";
import { ViewFormPanel } from "./CommandCard";

interface Api {
  request<T>(method: string, params?: unknown): Promise<T>;
}

/** What waits for a yes: a row action, or the draft the /schedule form produced. */
interface Pending {
  label: string;
  confirm: string;
  command: string;
  /** The draft came from the Add schedule form: a yes also closes the form. */
  fromForm: boolean;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The project's schedules, read from the `/schedules` view and acted on with the commands its rows
 * carry; "Add schedule" renders the `/schedule` view's form. Every call is `_keryx/command`, so the
 * desktop, the shell and the TUI share one set of rules.
 */
export function SchedulesTab({ sessionId, api }: { sessionId: string; api: Api }) {
  const [view, setView] = useState<CommandView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState<CommandView | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const send = useCallback(
    async (line: string): Promise<CommandResult> => {
      const parsed = parseCommandLine(line);
      if (!parsed) throw new Error(`Not a command: ${line}`);
      return api.request<CommandResult>(COMMAND_METHOD, { sessionId, name: parsed.name, args: parsed.args });
    },
    [api, sessionId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await send("/schedules");
      if (r?._meta?.keryx?.refused === true) setError(r.text ?? "keryx refused /schedules.");
      else {
        setView(r?._meta?.keryx?.view ?? null);
        setError(null);
      }
    } catch (e) {
      setError(msg(e));
    } finally {
      setLoading(false);
    }
  }, [send]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs a command line; true when keryx accepted it. The list is read again either way. */
  const exec = async (line: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setNote(null);
    let ok = false;
    try {
      const r = await send(line);
      if (r?._meta?.keryx?.refused === true) setError(r.text ?? "keryx refused the command.");
      else {
        ok = true;
        setNote((r?.text ?? "").trim() || null);
      }
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
    await load();
    return ok;
  };

  const act = (a: ViewAction) => {
    if (a.confirm) setPending({ label: a.label, confirm: a.confirm, command: a.command, fromForm: false });
    else void exec(a.command);
  };

  const openForm = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await send("/schedule");
      const form = r?._meta?.keryx?.view ?? null;
      if (r?._meta?.keryx?.refused === true || !form?.form) setError(r?.text?.trim() || "keryx did not offer a schedule form.");
      else setAdding(form);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const submitForm = async (line: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await send(line);
      const ask = r?._meta?.keryx?.confirmAction;
      if (r?._meta?.keryx?.refused === true) setError(r.text ?? "keryx refused the schedule.");
      else if (ask && ask.command.startsWith("/")) setPending({ ...ask, fromForm: true });
      else setError((r?.text ?? "").trim() || "keryx did not draft the schedule.");
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const answer = async (yes: boolean) => {
    const p = pending;
    setPending(null);
    if (!yes || !p) return;
    const ok = await exec(p.command);
    if (ok && p.fromForm) setAdding(null);
  };

  if (adding?.form) {
    return (
      <div className="schedules-tab" data-schedules-form>
        <button className="btn btn-sm btn-ghost providers-back" onClick={() => setAdding(null)}>
          <Icon name="chevronRight" size={12} className="flip" /> All schedules
        </button>
        <div className="command-view-title">{adding.title}</div>
        {adding.body ? <pre className="out-pre command-out">{adding.body}</pre> : null}
        <ViewFormPanel form={adding.form} disabled={busy} onSubmit={(line) => void submitForm(line)} />
        {error ? <div className="field-error" role="alert">{error}</div> : null}
        {pending ? <ConfirmDialog pending={pending} onAnswer={(yes) => void answer(yes)} /> : null}
      </div>
    );
  }

  const rows = view?.rows ?? [];
  return (
    <div className="schedules-tab">
      <div className="schedules-bar">
        <button className="btn btn-sm btn-primary" onClick={() => void openForm()} disabled={busy}>
          Add schedule
        </button>
        <button className="icon-btn icon-btn-sm" onClick={() => void load()} disabled={loading || busy} aria-label="Refresh schedules" title="Refresh">
          {loading ? <Spinner size={12} /> : <Icon name="refresh" size={13} />}
        </button>
      </div>
      {error ? <div className="field-error" role="alert">{error}</div> : null}
      {note && !error ? <div className="field-hint" role="status">{note}</div> : null}
      {!loading && rows.length === 0 && !error ? <p className="field-hint activity-empty">No schedules in this project yet.</p> : null}
      <ul className="schedule-list">
        {rows.map((r) => (
          <li key={r.id} className="schedule-row" data-schedule={r.id}>
            <div className="schedule-main">
              <span className="schedule-name truncate">{r.label}</span>
              {r.status ? <span className={`badge ${r.status === "paused" ? "badge-warn" : "badge-ok"}`}>{r.status}</span> : null}
            </div>
            {r.detail ? <div className="schedule-detail">{r.detail}</div> : null}
            <div className="schedule-actions">
              {(r.actions ?? []).map((a) => (
                <button key={a.label + a.command} className="btn btn-sm" disabled={busy} onClick={() => act(a)}>
                  {a.label}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {pending ? <ConfirmDialog pending={pending} onAnswer={(yes) => void answer(yes)} /> : null}
    </div>
  );
}

function ConfirmDialog({ pending, onAnswer }: { pending: Pending; onAnswer: (yes: boolean) => void }) {
  return (
    <Dialog
      title="Confirm"
      icon="alert"
      tone="warn"
      onClose={() => onAnswer(false)}
      footer={
        <>
          <button className="btn" onClick={() => onAnswer(false)}>
            Cancel
          </button>
          <button className="btn btn-primary" data-autofocus onClick={() => onAnswer(true)}>
            {pending.label}
          </button>
        </>
      }
    >
      <pre className="out-pre command-out">{pending.confirm}</pre>
    </Dialog>
  );
}
