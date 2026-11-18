import { useCallback, useEffect, useRef, useState } from "react";
import {
  flowsAction,
  flowsGet,
  type AttemptOutcome,
  type FlowAction,
  type FlowCard,
  type FlowDetail,
  type FlowTaskRow,
  type TaskKind,
} from "../platform/commands";
import { absoluteTime, copyText, errMessage, prLabel, relativeTime } from "../lib/format";
import { Icon, type IconName } from "../components/Icon";
import { InlineMarkdown, Markdown } from "../components/Markdown";
import { Dialog, EmptyState, Sheet, Spinner } from "../components/ui";
import { Menu, type MenuItem } from "../components/Menu";
import { useToast } from "../components/Toasts";
import { StatusPill } from "./FlowsBoard";
import { flowRef, nextStepHint, stateActions, terminalCommands, validateArg, type StateActionId } from "./model";

const ACTION_ICON: Record<StateActionId, IconName> = {
  freeze: "snowflake",
  start: "play",
  block: "ban",
  unblock: "circleCheck",
  next: "target",
};

type Tab = "overview" | "criteria" | "tasks" | "journal" | "gates";

interface Props {
  cwd: string;
  card: FlowCard;
  version: number;
  onClose: () => void;
  /** Sessions already linked to this flow, newest first. */
  linked: LinkedSession[];
  onWorkOn: (target: "new" | string) => void;
  onChanged: () => void;
}

/** A session the flow is linked to, as the "Work on this flow" menu lists it. */
export interface LinkedSession {
  id: string;
  title: string;
  updatedAt: string | null;
}

type Form =
  | { kind: "block" }
  | { kind: "freeze" }
  | { kind: "taskAdd" }
  | { kind: "attempt"; task: FlowTaskRow }
  | { kind: "commands" }
  | { kind: "next"; output: string };

export function FlowDetailSheet({ cwd, card, version, onClose, linked, onWorkOn, onChanged }: Props) {
  const workBtn = useRef<HTMLButtonElement>(null);
  const [workMenu, setWorkMenu] = useState(false);
  const [detail, setDetail] = useState<FlowDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setDetail(await flowsGet(cwd, card.dir));
      setError(null);
    } catch (e) {
      setError(errMessage(e));
    }
  }, [cwd, card.dir]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const run = useCallback(
    async (action: FlowAction, label: string): Promise<boolean> => {
      setBusy(action.type);
      try {
        const r = await flowsAction(cwd, card.dir, action);
        if (r.ok) {
          if (action.type === "next") {
            setForm({ kind: "next", output: r.stdout.trim() || "(no output)" });
          } else {
            const first = r.stdout.trim().split("\n")[0];
            toast({ level: "ok", title: label, body: first || undefined });
          }
        } else {
          toast({
            level: "error",
            title: `${label} failed${r.exitCode !== null ? ` (exit ${r.exitCode})` : ""}`,
            detail: [r.stderr.trim(), r.stdout.trim()].filter(Boolean).join("\n\n") || "No output.",
          });
        }
        onChanged();
        void load();
        return r.ok;
      } catch (e) {
        toast({ level: "error", title: `${label} failed`, detail: errMessage(e) });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [cwd, card.dir, toast, onChanged, load],
  );

  const c = detail?.card ?? card;
  const criteriaCount = detail?.criteria.length ?? 0;
  const actions = stateActions(c, criteriaCount);
  const step = detail ? nextStepHint(c, criteriaCount) : null;
  const onAction = (id: StateActionId) => {
    if (id === "freeze") setForm({ kind: "freeze" });
    else if (id === "start") void run({ type: "start" }, "Flow started");
    else if (id === "block") setForm({ kind: "block" });
    else if (id === "unblock") void run({ type: "unblock" }, "Flow unblocked");
    else void run({ type: "next" }, "Next task");
  };

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "overview", label: "Overview" },
    { id: "criteria", label: "Criteria", count: detail?.criteria.length },
    { id: "tasks", label: "Tasks", count: detail?.tasks.length },
    { id: "journal", label: "Journal", count: detail?.journal.length },
    { id: "gates", label: "Gates", count: detail ? detail.signatures.length + detail.completionAttempts.length : undefined },
  ];

  return (
    <Sheet label={`Flow #${c.id}`} onClose={onClose} width={820}>
      <header className="sheet-head">
        <div className="sheet-head-row">
          <span className="flow-id flow-id-lg">#{c.id}</span>
          <StatusPill card={c} />
          {c.completionExceptions ? <span className="badge badge-warn">Exceptions</span> : null}
          <span className="grow" />
          <button className="icon-btn" onClick={onClose} aria-label="Close details" title="Close (Esc)">
            <Icon name="x" size={16} />
          </button>
        </div>
        <h2 className="sheet-title">{c.title}</h2>
        <dl className="meta-row">
          {c.baseBranch ? (
            <div>
              <dt>
                <Icon name="branch" size={13} />
                <span className="sr-only">Base branch</span>
              </dt>
              <dd className="mono">{c.baseBranch}</dd>
            </div>
          ) : null}
          {c.prUrl ? (
            <div>
              <dt>
                <Icon name="pr" size={13} />
                <span className="sr-only">Pull request</span>
              </dt>
              <dd>
                <button className="link-btn" onClick={() => void copyText(c.prUrl ?? "").then(() => toast({ level: "info", title: "PR link copied" }))} title={`${c.prUrl} (click to copy)`}>
                  {prLabel(c.prUrl)}
                </button>
              </dd>
            </div>
          ) : null}
          {c.owner ? (
            <div>
              <dt>
                <Icon name="user" size={13} />
                <span className="sr-only">Owner</span>
              </dt>
              <dd>{c.owner}</dd>
            </div>
          ) : null}
          {c.updatedAt ? (
            <div>
              <dt>
                <Icon name="clock" size={13} />
                <span className="sr-only">Updated</span>
              </dt>
              <dd title={absoluteTime(c.updatedAt)}>{relativeTime(c.updatedAt)}</dd>
            </div>
          ) : null}
        </dl>
        <div className="sheet-actions">
          <button
            ref={workBtn}
            className="btn btn-primary"
            onClick={() => (linked.length === 0 ? onWorkOn("new") : setWorkMenu((m) => !m))}
            aria-haspopup={linked.length > 0 ? "menu" : undefined}
            aria-expanded={linked.length > 0 ? workMenu : undefined}
            title={linked.length === 0 ? "Start a new session for this flow" : "Continue in a linked session or start a new one"}
          >
            <Icon name="chat" size={14} /> Work on this flow
            {linked.length > 0 ? <Icon name="chevronDown" size={12} /> : null}
          </button>
          {workMenu ? (
            <Menu
              anchor={workBtn.current}
              label="Work on this flow"
              width={300}
              onClose={() => setWorkMenu(false)}
              items={[
                { kind: "header", id: "h-linked", label: "Continue in a linked session" },
                ...linked.slice(0, 5).map<MenuItem>((sx) => ({
                  id: `s-${sx.id}`,
                  label: <span className="truncate">{sx.title}</span>,
                  description: sx.updatedAt ? relativeTime(sx.updatedAt) : undefined,
                  icon: "chat",
                  onSelect: () => onWorkOn(sx.id),
                })),
                { kind: "separator", id: "sep" },
                { id: "new", label: "Start in a new session", icon: "plus", onSelect: () => onWorkOn("new") },
              ]}
            />
          ) : null}
          <span className="grow" />
          <button className="btn btn-ghost" onClick={() => setForm({ kind: "commands" })} title="Commands that run in a terminal">
            <Icon name="terminal" size={14} /> Terminal commands
          </button>
        </div>
        <div className="flow-state-bar" role="group" aria-label="Flow state">
          {actions.map((a) => (
            // A disabled button gets no hover events in WebKit, so the tooltip sits on a wrapper.
            <span key={a.id} className="flow-state-item" title={a.hint}>
              <button
                className="btn btn-sm"
                disabled={!a.enabled || busy !== null || !detail}
                aria-describedby={a.enabled ? undefined : `hint-${a.id}`}
                onClick={() => onAction(a.id)}
              >
                {busy === a.id ? <Spinner /> : <Icon name={ACTION_ICON[a.id]} size={13} />} {a.label}
              </button>
              {a.enabled ? null : (
                <span id={`hint-${a.id}`} className="sr-only">
                  {a.hint}
                </span>
              )}
            </span>
          ))}
        </div>
        {step ? <p className="flow-next-step">{step}</p> : null}
      </header>

      <nav className="tabs" role="tablist" aria-label="Flow sections">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            className="tab"
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.count !== undefined ? <span className="tab-count">{t.count}</span> : null}
          </button>
        ))}
      </nav>

      <div className="sheet-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {error ? (
          <div className="inline-banner tone-danger">
            <Icon name="alert" size={14} />
            <span>{error}</span>
          </div>
        ) : null}
        {c.error ? (
          <div className="inline-banner tone-danger">
            <Icon name="alert" size={14} />
            <span>
              <code>flow.json</code> could not be read: {c.error}
            </span>
          </div>
        ) : null}
        {!detail && !error ? (
          <div className="loading-row">
            <Spinner /> Loading flow…
          </div>
        ) : detail ? (
          tab === "overview" ? (
            <Overview d={detail} />
          ) : tab === "criteria" ? (
            <Criteria d={detail} />
          ) : tab === "tasks" ? (
            <Tasks
              d={detail}
              busy={busy}
              onAdd={() => setForm({ kind: "taskAdd" })}
              onDone={(t) => void run({ type: "taskDone", taskId: t.id }, `${t.id} marked done`)}
              onAttempt={(t) => setForm({ kind: "attempt", task: t })}
            />
          ) : tab === "journal" ? (
            <Journal d={detail} />
          ) : (
            <Gates d={detail} />
          )
        ) : null}
      </div>

      {form?.kind === "block" ? (
        <TextFormDialog
          title={`Block flow #${c.id}`}
          icon="ban"
          label="Reason"
          multiline
          submit="Block flow"
          tone="danger"
          hint="The flow keeps its lane and shows a Blocked badge until it is unblocked."
          onCancel={() => setForm(null)}
          onSubmit={async (reason) => (await run({ type: "block", reason }, "Flow blocked")) && setForm(null)}
        />
      ) : null}
      {form?.kind === "freeze" ? (
        <Dialog
          title="Freeze acceptance criteria?"
          icon="snowflake"
          tone="warn"
          onClose={() => setForm(null)}
          footer={
            <>
              <button className="btn" onClick={() => setForm(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                data-autofocus
                disabled={busy !== null}
                onClick={() => void run({ type: "freeze" }, "Criteria frozen").then((ok) => ok && setForm(null))}
              >
                {busy === "freeze" ? <Spinner /> : null} Freeze criteria
              </button>
            </>
          }
        >
          {flowRef(c) ? (
            <p>
              <code>keryx flow freeze {flowRef(c)}</code> seals <code>acceptance-criteria.md</code> with a checksum. After this, the criteria
              change only through <code>keryx flow ac update</code> in a terminal.
            </p>
          ) : (
            <p>
              Freezing seals this flow's <code>acceptance-criteria.md</code> with a checksum. After this, the criteria change only through a
              criteria update in a terminal.
            </p>
          )}
        </Dialog>
      ) : null}
      {form?.kind === "taskAdd" ? (
        <TaskAddDialog
          flowId={c.id}
          busy={busy === "taskAdd"}
          onCancel={() => setForm(null)}
          onSubmit={async (title, kind) => (await run({ type: "taskAdd", title, kind }, "Task added")) && setForm(null)}
        />
      ) : null}
      {form?.kind === "attempt" ? (
        <AttemptDialog
          task={form.task}
          busy={busy === "taskAttempt"}
          onCancel={() => setForm(null)}
          onSubmit={async (outcome, detailText) =>
            (await run({ type: "taskAttempt", taskId: form.task.id, outcome, detail: detailText }, `Attempt recorded on ${form.task.id}`)) &&
            setForm(null)
          }
        />
      ) : null}
      {form?.kind === "commands" ? <CommandsDialog card={c} onClose={() => setForm(null)} /> : null}
      {form?.kind === "next" ? (
        <Dialog
          title="Next task"
          icon="target"
          onClose={() => setForm(null)}
          footer={
            <button className="btn btn-primary" data-autofocus onClick={() => setForm(null)}>
              Done
            </button>
          }
        >
          <NextTaskResult output={form.output} />
        </Dialog>
      ) : null}
    </Sheet>
  );
}

function NextTaskResult({ output }: { output: string }) {
  const parsed = parseNext(output);
  const task = parsed?.task;
  const resumed = parsed?.resume?.kind === "unresolved";
  // The ready task is also in keryx's `unresolved` list when it was started and never finished; its badge says so.
  const unresolved = (parsed?.unresolved ?? []).filter((u) => u.task?.id && u.task.id !== task?.id);
  return (
    <>
      {parsed?.kind === "none" ? (
        <p>There is no task to take next: every task is done, or what is left waits on something else.</p>
      ) : task?.id ? (
        <p>
          Next up: <strong className="mono">{task.id}</strong> {task.title}
          {task.kind ? <span className="tag" style={{ marginLeft: 8 }}>{task.kind}</span> : null}
          {resumed ? <span className="badge badge-warn" style={{ marginLeft: 8 }}>started before, never finished</span> : null}
        </p>
      ) : null}
      {unresolved.length > 0 ? (
        <div className="inline-banner tone-warn">
          <Icon name="alert" size={14} />
          <span>
            Also started and left open: {unresolved.map((u) => `${u.task?.id}${u.task?.title ? ` ${u.task.title}` : ""}`).join(", ")}
          </span>
        </div>
      ) : null}
      <details open={!parsed || (parsed.kind !== "none" && !task?.id)}>
        <summary className="dialog-sub">Raw output of keryx flow next</summary>
        <pre className="code-pre">{prettyJson(output)}</pre>
      </details>
    </>
  );
}

/** `keryx flow next --json`: a NextTaskDecision (src/flow/machine.ts), read loosely. */
interface NextJson {
  kind?: string;
  task?: { id?: string; title?: string; kind?: string };
  /** On a ready decision: whether the task was already started by someone who never came back. */
  resume?: { kind?: string };
  /** Every not-done task that carries an open attempt. */
  unresolved?: Array<{ task?: { id?: string; title?: string } }>;
}

function parseNext(output: string): NextJson | null {
  try {
    const v: unknown = JSON.parse(output);
    return v && typeof v === "object" ? (v as NextJson) : null;
  } catch {
    return null;
  }
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

// ---- tabs -------------------------------------------------------------------

function Overview({ d }: { d: FlowDetail }) {
  const c = d.card;
  const tasksPct = c.tasksTotal ? Math.round((c.tasksDone / c.tasksTotal) * 100) : 0;
  const acPct = c.acTotal ? Math.round((c.acConfirmed / c.acTotal) * 100) : 0;
  const unfrozen = d.criteria.length > 0 && d.criteria.every((x) => x.kind === null) && c.status === "initializing";
  return (
    <div className="overview">
      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Tasks</div>
          <div className="stat-value">
            {c.tasksDone}
            <span className="stat-of">/{c.tasksTotal}</span>
          </div>
          <div className="progress">
            <div className="progress-fill" style={{ width: `${tasksPct}%` }} />
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Criteria confirmed</div>
          <div className="stat-value">
            {c.acConfirmed}
            <span className="stat-of">/{c.acTotal}</span>
          </div>
          <div className="progress">
            <div className="progress-fill" style={{ width: `${acPct}%` }} />
          </div>
        </div>
      </div>
      {unfrozen ? (
        <div className="inline-banner tone-info">
          <Icon name="snowflake" size={14} />
          <span>Criteria are not frozen yet: use Freeze criteria at the top.</span>
        </div>
      ) : null}
      <DocSection title="Description" text={d.docs.description} />
      <DocSection title="Plan" text={d.docs.plan} />
      <DocSection title="Context" text={d.docs.context} collapsed />
    </div>
  );
}

function DocSection({ title, text, collapsed }: { title: string; text: string | null; collapsed?: boolean }) {
  const [open, setOpen] = useState(!collapsed);
  if (!text || !text.trim()) return null;
  // The first heading usually repeats the section name; drop it.
  const body = text.replace(/^#\s+[^\n]*\n+/, "");
  return (
    <section className="doc-section">
      <button className="section-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        <h3>{title}</h3>
      </button>
      {open ? <Markdown text={body} className="md-doc" /> : null}
    </section>
  );
}

const KIND_LABEL: Record<string, string> = {
  exec: "exec",
  invariant: "invariant",
  judged: "judged",
  none: "none",
  unclassified: "unclassified",
};

function Criteria({ d }: { d: FlowDetail }) {
  if (d.criteria.length === 0) {
    return (
      <EmptyState icon="shield" title="No acceptance criteria">
        <p>
          This flow has no <code>- ACn:</code> lines in <code>acceptance-criteria.md</code>.
        </p>
      </EmptyState>
    );
  }
  return (
    <ol className="criteria">
      {d.criteria.map((ac) => (
        <li key={ac.id} className={`criterion${ac.confirmed ? " is-confirmed" : ""}`}>
          <span className="criterion-mark" aria-label={ac.confirmed ? "Confirmed" : "Not confirmed"}>
            <Icon name={ac.confirmed ? "circleCheck" : "circle"} size={16} />
          </span>
          <div className="criterion-main">
            <div className="criterion-head">
              <span className="mono criterion-id">{ac.id}</span>
              {ac.kind ? <span className={`tag tag-${ac.kind}`}>{KIND_LABEL[ac.kind] ?? ac.kind}</span> : null}
            </div>
            <div className="criterion-text">
              <InlineMarkdown text={ac.text} />
            </div>
            {ac.verify ? (
              <div className="criterion-verify">
                <span className="verify-label">verify</span>
                <code>{ac.verify}</code>
              </div>
            ) : null}
            {ac.confirmed ? (
              <div className="criterion-note">
                Confirmed {relativeTime(ac.confirmed.at)}
                {ac.confirmed.note ? <> — {ac.confirmed.note}</> : null}
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

const TASK_ICON: Record<string, IconName> = {
  todo: "circle",
  "in-progress": "circleDot",
  done: "circleCheck",
};

function Tasks({
  d,
  busy,
  onAdd,
  onDone,
  onAttempt,
}: {
  d: FlowDetail;
  busy: string | null;
  onAdd: () => void;
  onDone: (t: FlowTaskRow) => void;
  onAttempt: (t: FlowTaskRow) => void;
}) {
  const closed = d.card.status === "done";
  return (
    <div className="tasks">
      {!closed ? (
        <div className="tasks-toolbar">
          <button className="btn btn-sm" onClick={onAdd}>
            <Icon name="plus" size={13} /> Add task
          </button>
        </div>
      ) : null}
      {d.tasks.length === 0 ? (
        <EmptyState icon="checklist" title="No tasks yet" />
      ) : (
        <ul className="task-list">
          {d.tasks.map((t) => (
            <li key={t.id} className={`task-row status-${t.status}`}>
              <span className="task-mark">
                <Icon name={TASK_ICON[t.status] ?? "circle"} size={16} />
              </span>
              <div className="task-main">
                <div className="task-title">
                  <span className="mono task-id">{t.id}</span>
                  <span>{t.title}</span>
                </div>
                <div className="task-meta">
                  <span className="tag">{t.kind}</span>
                  {t.disposition && t.disposition !== "completed" ? (
                    <span className={`tag tag-${t.disposition}`} title={t.dispositionReason ?? undefined}>
                      {t.disposition}
                    </span>
                  ) : null}
                  {t.dependsOn.length ? <span>after {t.dependsOn.join(", ")}</span> : null}
                  {t.attempts ? (
                    <span title={t.lastAttempt ? `${t.lastAttempt.outcome} ${absoluteTime(t.lastAttempt.at)}${t.lastAttempt.detail ? `: ${t.lastAttempt.detail}` : ""}` : undefined}>
                      {t.attempts} attempt{t.attempts > 1 ? "s" : ""}
                      {t.lastAttempt ? ` · last ${t.lastAttempt.outcome}` : ""}
                    </span>
                  ) : null}
                </div>
                {t.dispositionReason ? <div className="task-reason">{t.dispositionReason}</div> : null}
              </div>
              {t.status !== "done" && !closed ? (
                <div className="task-actions">
                  <button className="btn btn-sm btn-ghost" onClick={() => onAttempt(t)} disabled={busy !== null}>
                    Attempt…
                  </button>
                  <button className="btn btn-sm" onClick={() => onDone(t)} disabled={busy !== null} title={flowRef(d.card) ? `keryx flow task done ${flowRef(d.card)} ${t.id}` : "Mark this task done"}>
                    {busy === "taskDone" ? <Spinner /> : <Icon name="check" size={13} />} Done
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Journal({ d }: { d: FlowDetail }) {
  const [limit, setLimit] = useState(60);
  if (d.journal.length === 0) return <EmptyState icon="history" title="No journal entries" />;
  let lastDay = "";
  return (
    <div className="journal">
      {d.journal.slice(0, limit).map((j, i) => {
        const day = j.at.slice(0, 10);
        const header = day !== lastDay ? day : null;
        lastDay = day;
        return (
          <div key={`${j.at}-${i}`}>
            {header ? (
              <div className="journal-day">
                {new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
              </div>
            ) : null}
            <div className="journal-entry">
              <time className="journal-time" dateTime={j.at} title={absoluteTime(j.at)}>
                {new Date(j.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              </time>
              <div className="journal-main">
                <span className="journal-event">{j.event}</span>
                {j.detail ? <JournalDetail text={j.detail} /> : null}
              </div>
            </div>
          </div>
        );
      })}
      {d.journal.length > limit ? (
        <button className="lane-more" onClick={() => setLimit((n) => n + 100)}>
          Show older entries ({d.journal.length - limit})
        </button>
      ) : null}
    </div>
  );
}

function JournalDetail({ text }: { text: string }) {
  const long = text.length > 220;
  const [open, setOpen] = useState(false);
  return (
    <div className="journal-detail">
      {long && !open ? `${text.slice(0, 220)}…` : text}
      {long ? (
        <button className="link-btn" onClick={() => setOpen((o) => !o)}>
          {open ? "Less" : "More"}
        </button>
      ) : null}
    </div>
  );
}

interface SignatureView {
  at?: string;
  kind?: string;
  criterion?: string;
  identity?: { value?: string | null };
  exceptions?: unknown[];
  cleanCompletion?: boolean;
}
interface AttemptView {
  at?: string;
  passed?: boolean;
  cleanCompletion?: boolean;
  gates?: Array<{ name?: string; status?: string; detail?: string }>;
  exceptions?: unknown[];
}

function Gates({ d }: { d: FlowDetail }) {
  const sigs = d.signatures as SignatureView[];
  const attempts = (d.completionAttempts as AttemptView[]).slice().reverse();
  if (sigs.length === 0 && attempts.length === 0) {
    return (
      <EmptyState icon="shieldCheck" title="No gate records yet">
        <p>Signatures and completion attempts appear here after criteria are confirmed or completion is tried.</p>
      </EmptyState>
    );
  }
  return (
    <div className="gates">
      {attempts.length > 0 ? (
        <section>
          <h3 className="section-title">Completion attempts</h3>
          {attempts.map((a, i) => (
            <details key={i} className="gate-attempt" open={i === 0}>
              <summary>
                <Icon name={a.passed ? "circleCheck" : "circleX"} size={15} className={a.passed ? "tone-ok" : "tone-danger"} />
                <span>{a.passed ? (a.cleanCompletion === false ? "Passed with exceptions" : "Passed") : "Refused"}</span>
                <span className="grow" />
                <time title={absoluteTime(a.at)}>{relativeTime(a.at)}</time>
              </summary>
              <ul className="gate-list">
                {(a.gates ?? []).map((g, j) => (
                  <li key={j} className={`gate gate-${g.status ?? "unknown"}`}>
                    <span className="gate-status">{g.status}</span>
                    <span className="mono gate-name">{g.name}</span>
                    {g.detail ? <span className="gate-detail">{g.detail}</span> : null}
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </section>
      ) : null}
      {sigs.length > 0 ? (
        <section>
          <h3 className="section-title">Signatures</h3>
          <ul className="sig-list">
            {sigs
              .slice()
              .reverse()
              .map((s, i) => (
                <li key={i}>
                  <Icon name="pencil" size={13} />
                  <span>
                    {s.kind === "complete" ? "Completion" : `Confirmed ${s.criterion ?? ""}`}
                    {s.identity?.value ? <> by {s.identity.value}</> : null}
                    {s.exceptions && s.exceptions.length ? <span className="badge badge-warn">{s.exceptions.length} exception(s)</span> : null}
                  </span>
                  <span className="grow" />
                  <time title={absoluteTime(s.at)}>{relativeTime(s.at)}</time>
                </li>
              ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// ---- forms ------------------------------------------------------------------

function TextFormDialog({
  title,
  icon,
  label,
  hint,
  submit,
  tone,
  multiline,
  onCancel,
  onSubmit,
}: {
  title: string;
  icon: IconName;
  label: string;
  hint?: string;
  submit: string;
  tone?: "danger" | "warn";
  multiline?: boolean;
  onCancel: () => void;
  onSubmit: (value: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const err = validateArg(label, value);
  const submitNow = async () => {
    setTouched(true);
    if (err || sending) return;
    setSending(true);
    await onSubmit(value);
    setSending(false);
  };
  return (
    <Dialog
      title={title}
      icon={icon}
      tone={tone}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className={`btn ${tone === "danger" ? "btn-danger" : "btn-primary"}`} onClick={() => void submitNow()} disabled={sending}>
            {sending ? <Spinner /> : null} {submit}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">{label}</span>
        {multiline ? (
          <textarea
            data-autofocus
            rows={3}
            value={value}
            aria-invalid={touched && !!err}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submitNow();
            }}
          />
        ) : (
          <input data-autofocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void submitNow()} />
        )}
        {touched && err ? <span className="field-error">{err}</span> : hint ? <span className="field-hint">{hint}</span> : null}
      </label>
    </Dialog>
  );
}

const KINDS: TaskKind[] = ["implement", "test", "verify", "review", "docs", "context"];

function TaskAddDialog({
  flowId,
  busy,
  onCancel,
  onSubmit,
}: {
  flowId: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (title: string, kind: TaskKind) => Promise<unknown>;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<TaskKind>("implement");
  const [touched, setTouched] = useState(false);
  const err = validateArg("Title", title);
  const submit = () => {
    setTouched(true);
    if (!err && !busy) void onSubmit(title, kind);
  };
  return (
    <Dialog
      title={`Add a task to #${flowId}`}
      icon="plus"
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? <Spinner /> : null} Add task
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Title</span>
        <input data-autofocus value={title} aria-invalid={touched && !!err} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        {touched && err ? <span className="field-error">{err}</span> : null}
      </label>
      <label className="field">
        <span className="field-label">Kind</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as TaskKind)}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
    </Dialog>
  );
}

const OUTCOMES: Array<{ id: AttemptOutcome; label: string; help: string }> = [
  { id: "started", label: "Started", help: "Work on the task began." },
  { id: "failed", label: "Failed", help: "This attempt did not succeed; the task stays open." },
  { id: "blocked", label: "Blocked", help: "The task cannot proceed until something else changes." },
];

function AttemptDialog({
  task,
  busy,
  onCancel,
  onSubmit,
}: {
  task: FlowTaskRow;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (outcome: AttemptOutcome, detail: string) => Promise<unknown>;
}) {
  const [outcome, setOutcome] = useState<AttemptOutcome>("started");
  const [detail, setDetail] = useState("");
  const [touched, setTouched] = useState(false);
  const err = validateArg("Detail", detail);
  const submit = () => {
    setTouched(true);
    if (!err && !busy) void onSubmit(outcome, detail);
  };
  return (
    <Dialog
      title={`Record an attempt on ${task.id}`}
      icon="history"
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? <Spinner /> : null} Record attempt
          </button>
        </>
      }
    >
      <p className="dialog-sub">{task.title}</p>
      <fieldset className="field">
        <legend className="field-label">Outcome</legend>
        <div className="choice-list">
          {OUTCOMES.map((o, i) => (
            <label key={o.id} className={`choice${outcome === o.id ? " is-on" : ""}`}>
              <input type="radio" name="outcome" checked={outcome === o.id} onChange={() => setOutcome(o.id)} data-autofocus={i === 0 ? true : undefined} />
              <span>
                <span className="choice-label">{o.label}</span>
                <span className="choice-help">{o.help}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span className="field-label">Detail</span>
        <textarea rows={3} value={detail} aria-invalid={touched && !!err} onChange={(e) => setDetail(e.target.value)} />
        {touched && err ? <span className="field-error">{err}</span> : null}
      </label>
    </Dialog>
  );
}

function CommandsDialog({ card, onClose }: { card: FlowCard; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);
  return (
    <Dialog
      title="Run in a terminal"
      icon="terminal"
      onClose={onClose}
      width={520}
      footer={
        <button className="btn btn-primary" data-autofocus onClick={onClose}>
          Done
        </button>
      }
    >
      <p className="dialog-sub">
        These commands have gates and confirmation tokens that belong in a terminal, so the board does not run them. Replace each{" "}
        <code>&lt;placeholder&gt;</code> before running; quote free text.
      </p>
      {terminalCommands(card).length === 0 ? (
        <p className="dialog-sub">This flow's directory name or id is not safe to put in a command, so no command is offered.</p>
      ) : null}
      <ul className="command-list">
        {terminalCommands(card).map((c) => (
          <li key={c.command}>
            <span className="command-label">{c.label}</span>
            <code className="command-code">{c.command}</code>
            <button
              className="icon-btn"
              aria-label={`Copy: ${c.command}`}
              title="Copy"
              onClick={() =>
                void copyText(c.command).then(() => {
                  setCopied(c.command);
                  if (timer.current) window.clearTimeout(timer.current);
                  timer.current = window.setTimeout(() => setCopied(null), 1200);
                })
              }
            >
              <Icon name={copied === c.command ? "check" : "copy"} size={14} />
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
