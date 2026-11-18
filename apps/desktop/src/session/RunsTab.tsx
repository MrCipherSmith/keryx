import { useCallback, useEffect, useRef, useState } from "react";
import { COMMAND_METHOD, parseCommandLine } from "../acp/commands";
import type { CommandResult, CommandView, ViewRow } from "../acp/types";
import { Icon } from "../components/Icon";
import { Spinner } from "../components/ui";

interface Api {
  request<T>(method: string, params?: unknown): Promise<T>;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `/schedules runs [<name>]`, and `/schedules run-log <name> <id>` for one row: a command line is all the tab sends. */
const RUNS = "/schedules runs";

/**
 * The recent runs of the project's schedules (of one when `schedule` is set), and one run's report and
 * run log. Both come from `_keryx/command`, like the Schedules tab. Everything shown is what an agent
 * or a command wrote: it is rendered as plain text, never as markup.
 */
export function RunsTab({ sessionId, api, schedule, onSchedule }: { sessionId: string; api: Api; schedule: string | null; onSchedule: (name: string | null) => void }) {
  const [view, setView] = useState<CommandView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** The run open in the detail: the command line that reads it, and its title. */
  const [open, setOpen] = useState<{ command: string; label: string } | null>(null);

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
      const r = await send(schedule ? `${RUNS} ${schedule}` : RUNS);
      if (r?._meta?.keryx?.refused === true) setError(r.text?.trim() || "keryx refused /schedules runs.");
      else {
        setView(r?._meta?.keryx?.view ?? null);
        setError(null);
      }
    } catch (e) {
      setError(msg(e));
    } finally {
      setLoading(false);
    }
  }, [send, schedule]);

  useEffect(() => {
    void load();
  }, [load]);

  if (open) return <RunDetail send={send} command={open.command} label={open.label} onBack={() => setOpen(null)} />;

  const rows = view?.rows ?? [];
  return (
    <div className="runs-tab" data-runs-tab>
      <div className="runs-bar">
        {schedule ? (
          <button className="btn btn-sm btn-ghost" onClick={() => onSchedule(null)} title="Show the runs of every schedule">
            {schedule} · show all
          </button>
        ) : (
          <span className="field-hint">All schedules</span>
        )}
        <button className="icon-btn icon-btn-sm" onClick={() => void load()} disabled={loading} aria-label="Refresh runs" title="Refresh">
          {loading ? <Spinner size={12} /> : <Icon name="refresh" size={13} />}
        </button>
      </div>
      {error ? <div className="field-error" role="alert">{error}</div> : null}
      {!loading && rows.length === 0 && !error ? <p className="field-hint activity-empty">{view?.body?.trim() || "No runs yet."}</p> : null}
      <ul className="runs-list">
        {rows.map((r) => (
          <li key={r.id}>
            <RunRow row={r} onOpen={(command) => setOpen({ command, label: r.label })} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function RunRow({ row, onOpen }: { row: ViewRow; onOpen: (command: string) => void }) {
  const command = row.actions?.[0]?.command;
  const bad = row.status && row.status !== "ok" && row.status !== "success";
  return (
    <button className="activity-row" data-run={row.id} disabled={!command} onClick={() => command && onOpen(command)}>
      <span className="activity-main">
        <span className="activity-label">{row.label}</span>
        {row.detail ? <span className="activity-detail">{row.detail}</span> : null}
      </span>
      {row.status ? <span className={`badge ${bad ? "badge-warn" : "badge-ok"}`}>{row.status}</span> : null}
    </button>
  );
}

function RunDetail({ send, command, label, onBack }: { send: (line: string) => Promise<CommandResult>; command: string; label: string; onBack: () => void }) {
  const [view, setView] = useState<CommandView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await send(command);
      if (r?._meta?.keryx?.refused === true) setError(r.text?.trim() || "keryx refused the command.");
      else {
        setView(r?._meta?.keryx?.view ?? null);
        setError(null);
      }
    } catch (e) {
      setError(msg(e));
    } finally {
      setLoading(false);
    }
  }, [send, command]);

  useEffect(() => {
    void load();
  }, [load]);

  const report = view?.rows?.find((r) => r.id === "report");
  const log = view?.rows?.find((r) => r.id === "log");
  return (
    <div className="runs-tab" data-run-detail>
      <div className="runs-bar">
        <button className="btn btn-sm btn-ghost providers-back" onClick={onBack}>
          <Icon name="chevronRight" size={12} className="flip" /> All runs
        </button>
        <button className="icon-btn icon-btn-sm" onClick={() => void load()} disabled={loading} aria-label="Refresh run" title="Refresh">
          {loading ? <Spinner size={12} /> : <Icon name="refresh" size={13} />}
        </button>
      </div>
      <div className="subagent-title">
        <strong className="truncate">{view?.title ?? label}</strong>
      </div>
      {view?.body ? <div className="run-summary">{view.body}</div> : null}
      {error ? <div className="field-error" role="alert">{error}</div> : null}
      {report ? <RunSection id="report" row={report} /> : null}
      {log ? <RunSection id="log" row={log} tail /> : null}
    </div>
  );
}

/** One text of a run. `missing` shows why there is none; `truncated` says the head was cut. A log opens at its end. */
function RunSection({ id, row, tail }: { id: string; row: ViewRow; tail?: boolean }) {
  const text = row.detail ?? "";
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (tail && el) el.scrollTop = el.scrollHeight;
  }, [tail, text]);
  const missing = row.status === "missing";
  return (
    <section className="run-section" data-run-section={id}>
      <div className="run-section-head">
        <span className="truncate">{row.label}</span>
        {row.status === "truncated" ? <span className="badge badge-warn">last 64 KB only</span> : null}
      </div>
      {missing ? (
        <p className="field-hint">{text}</p>
      ) : (
        <pre ref={ref} className="run-text" tabIndex={0} aria-label={row.label}>
          {text.length > 0 ? text : "(empty)"}
        </pre>
      )}
    </section>
  );
}
