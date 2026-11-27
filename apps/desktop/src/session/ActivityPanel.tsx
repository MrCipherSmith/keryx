import { ExternalBadge } from "./ExternalBadge";
import { useEffect, useRef, useState } from "react";
import { TASKS_KILL, TASKS_OUTPUT, isRunning, supportsTasks, type TaskInfo, type TaskOutputResult } from "../acp/providers";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { Dialog, Spinner } from "../components/ui";
import { partitionSubagents, runningSubagents, statusLabel, type Subagent } from "./activity";
import { SchedulesTab } from "./SchedulesTab";
import { RunsTab } from "./RunsTab";
import { focusDelegateRun, isDelegateRunOpen, onDelegateChange } from "./delegateBus";
import { COMMAND_METHOD } from "../acp/commands";
import { openStreamTab } from "../panels/streamTabs";
import { taskOutputSource } from "./taskStream";
import type { ProjectGitHubAccount } from "../platform/githubAccounts";
import { ProjectGitHubAccountButton } from "../project/GitHubSettings";

export type ActivityTab = "subagents" | "tasks" | "schedules" | "runs";

export interface ActivityApi {
  request<T>(method: string, params?: unknown): Promise<T>;
  extensions: readonly string[];
}

interface Props {
  sessionId: string;
  subagents: readonly Subagent[];
  tasks: readonly TaskInfo[];
  api: ActivityApi;
  tab: ActivityTab;
  onTab: (t: ActivityTab) => void;
  /** The subagent shown in the Subagents tab (the transcript's "Show subagent" link sets it). */
  subagentId: string | null;
  onSubagent: (id: string | null) => void;
  /** Re-list the session's tasks. */
  onRefreshTasks: () => void;
  githubAccount?: ProjectGitHubAccount;
  onProjectSettings?: () => void;
  /** Output poll interval while a shown task runs. */
  pollMs?: number;
}

/** The Activity tab of the side panel: the session's subagents, background tasks, schedules and their runs. */
export function ActivityPanel({ sessionId, subagents, tasks, api, tab, onTab, subagentId, onSubagent, onRefreshTasks, githubAccount, onProjectSettings, pollMs = 1000 }: Props) {
  const runningTasks = tasks.filter(isRunning).length;
  const runningAgents = runningSubagents(subagents);
  const hasTasks = supportsTasks(api.extensions);
  const hasSchedules = api.extensions.includes(COMMAND_METHOD);
  /** The schedule the Runs tab is limited to (null: every schedule). */
  const [runsFor, setRunsFor] = useState<string | null>(null);
  return (
    <aside className="activity-panel" aria-label="Activity">
      <div className="activity-head">
        <div className="tabs activity-tabs" role="tablist">
          <button className="tab" role="tab" aria-selected={tab === "subagents"} onClick={() => onTab("subagents")}>
            Subagents
            {runningAgents > 0 ? <span className="tab-count" title="Running">{runningAgents}</span> : null}
          </button>
          {hasTasks ? (
            <button className="tab" role="tab" aria-selected={tab === "tasks"} onClick={() => onTab("tasks")}>
              Tasks
              {runningTasks > 0 ? <span className="tab-count" title="Running">{runningTasks}</span> : null}
            </button>
          ) : null}
          {hasSchedules ? (
            <button className="tab" role="tab" aria-selected={tab === "schedules"} onClick={() => onTab("schedules")}>
              Schedules
            </button>
          ) : null}
          {hasSchedules ? (
            <button className="tab" role="tab" aria-selected={tab === "runs"} onClick={() => onTab("runs")}>
              Runs
            </button>
          ) : null}
        </div>
      </div>
      {githubAccount ? (
        <div className="activity-account">
          <ProjectGitHubAccountButton account={githubAccount} onOpen={onProjectSettings} />
        </div>
      ) : null}
      <div className="activity-body">
        {tab === "tasks" && hasTasks ? (
          <TasksTab key={sessionId} sessionId={sessionId} tasks={tasks} api={api} onRefresh={onRefreshTasks} pollMs={pollMs} />
        ) : tab === "schedules" && hasSchedules ? (
          <SchedulesTab
            key={sessionId}
            sessionId={sessionId}
            api={api}
            onShowRuns={(name) => {
              setRunsFor(name);
              onTab("runs");
            }}
          />
        ) : tab === "runs" && hasSchedules ? (
          <RunsTab key={`${sessionId}:${runsFor ?? ""}`} sessionId={sessionId} api={api} schedule={runsFor} onSchedule={setRunsFor} />
        ) : (
          <SubagentsTab key={sessionId} subagents={subagents} selected={subagentId} onSelect={onSubagent} />
        )}
      </div>
    </aside>
  );
}

// ---- subagents ---------------------------------------------------------------------------------

function StatusDot({ status }: { status: string }) {
  if (status === "running") return <Spinner size={12} />;
  if (status === "idle") return <Icon name="circle" size={12} />;
  if (status === "done" || status === "completed") return <Icon name="circleCheck" size={13} />;
  if (status === "failed" || status === "killed") return <Icon name="circleX" size={13} />;
  return <Icon name="circle" size={12} />;
}

function SubagentsTab({ subagents, selected, onSelect }: { subagents: readonly Subagent[]; selected: string | null; onSelect: (id: string | null) => void }) {
  const current = selected ? subagents.find((s) => s.id === selected) : undefined;
  if (current) {
    return (
      <>
        <button className="btn btn-sm btn-ghost providers-back" onClick={() => onSelect(null)}>
          <Icon name="chevronRight" size={12} className="flip" /> All subagents
        </button>
        <SubagentDetail agent={current} />
      </>
    );
  }
  const { current: recent } = partitionSubagents(subagents);
  if (!recent.length) return <p className="field-hint activity-empty">{subagents.length ? "Earlier subagents are in the session’s archive." : "No subagents in this session yet."}</p>;
  return (
    <ul className="activity-list">
      {recent.map((a) => (
        <li key={a.id}>
          <button className={"activity-row" + (a.runtime === "external" ? " is-external" : "")} onClick={() => onSelect(a.id)} data-subagent={a.id}>
            <span className={`activity-status status-${a.status}`} title={statusLabel(a.status)}>
              <StatusDot status={a.status} />
            </span>
            <span className="activity-main">
              <span className="activity-label truncate">
                {a.label}
              </span>
              {a.detail ? <span className="activity-detail truncate">{a.detail}</span> : null}
            </span>
            {a.model ? <span className="badge badge-neutral truncate activity-model">{a.model}</span> : null}
            {a.runtime === "external" ? <ExternalBadge /> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function SubagentDetail({ agent }: { agent: Subagent }) {
  const task = agent.task?.trim() || agent.entries.find((e) => e.kind === "task")?.text.trim() || "";
  return (
    <div className="subagent-detail" data-subagent-detail={agent.id}>
      <div className="subagent-title">
        <span className={`activity-status status-${agent.status}`}>
          <StatusDot status={agent.status} />
        </span>
        <strong className="truncate">{agent.label}</strong>
        <span className="badge badge-neutral">{statusLabel(agent.status)}</span>
        {agent.runtime === "external" ? <ExternalBadge /> : null}
      </div>
      {agent.model || agent.runtime ? (
        <div className="field-hint">
          {[agent.model, agent.runtime].filter(Boolean).join(" · ")}
        </div>
      ) : null}
      {agent.runtime === "external" ? <OpenTerminal runId={agent.id} /> : null}
      {agent.runtime === "external" && agent.detail ? <div className="field-hint">{agent.detail === "closed" ? "Terminal closed." : agent.detail}</div> : null}
      {task ? (
        <div className="subagent-task">
          <div className="tool-label">Task</div>
          <div className="subagent-task-text">{task}</div>
        </div>
      ) : null}
      <div className="subagent-log">
        {agent.entries
          .filter((e) => e.kind !== "task")
          .map((e, i) => (
            <SubagentEntryView key={i} kind={e.kind} text={e.text} />
          ))}
      </div>
    </div>
  );
}

/** A `/delegate` run's terminal tab, while it is still open: brings it forward in the side panel. */
function OpenTerminal({ runId }: { runId: string }) {
  const [, tick] = useState(0);
  useEffect(() => onDelegateChange(() => tick((n) => n + 1)), []);
  if (!isDelegateRunOpen(runId)) return null;
  return (
    <button className="btn btn-sm" data-open-terminal={runId} onClick={() => void focusDelegateRun(runId)}>
      <Icon name="terminal" size={13} /> Open terminal
    </button>
  );
}

function SubagentEntryView({ kind, text }: { kind: string; text: string }) {
  if (kind === "text") {
    return (
      <div className="subagent-entry entry-text">
        <Markdown text={text} />
      </div>
    );
  }
  if (kind === "reasoning") {
    return (
      <details className="subagent-entry entry-reasoning">
        <summary>Reasoning</summary>
        <div className="entry-reasoning-body">{text}</div>
      </details>
    );
  }
  if (kind === "system") return <div className="subagent-entry entry-system">{text}</div>;
  return (
    <div className={`subagent-entry entry-${kind}`}>
      <div className="tool-label">{kind === "tool" ? "Tool" : kind === "result" ? "Result" : kind}</div>
      <pre className="out-pre">{text}</pre>
    </div>
  );
}

// ---- tasks -----------------------------------------------------------------------------------------

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function elapsedOf(t: TaskInfo, now: number): string {
  if (t.startedAt === null) return "";
  return formatElapsed((t.endedAt ?? now) - t.startedAt);
}

function TasksTab({ sessionId, tasks, api, onRefresh, pollMs }: { sessionId: string; tasks: readonly TaskInfo[]; api: ActivityApi; onRefresh: () => void; pollMs: number }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [kill, setKill] = useState<TaskInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(tasks.some(isRunning));
  const current = selected ? tasks.find((t) => t.id === selected) : undefined;

  const doKill = async (t: TaskInfo) => {
    setKill(null);
    setError(null);
    try {
      await api.request(TASKS_KILL, { sessionId, taskId: t.id });
    } catch (e) {
      setError(`Could not kill ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    onRefresh();
  };

  if (current) {
    return (
      <>
        <button className="btn btn-sm btn-ghost providers-back" onClick={() => setSelected(null)}>
          <Icon name="chevronRight" size={12} className="flip" /> All tasks
        </button>
        <TaskHeader task={current} now={now} />
        <div className="task-actions">
          <button
            className="btn btn-sm"
            data-open-task-terminal={current.id}
            onClick={() =>
              openStreamTab({
                key: `task:${sessionId}:${current.id}`,
                title: current.command.length > 28 ? `${current.command.slice(0, 27)}…` : current.command,
                detail: current.command,
                source: taskOutputSource(api.request, sessionId, current.id, pollMs),
              })
            }
            title="Follow this task's output in a terminal tab of the side panel"
          >
            <Icon name="terminal" size={13} /> Open in terminal
          </button>
          {isRunning(current) ? (
            <button className="btn btn-sm" onClick={() => setKill(current)}>
              Kill
            </button>
          ) : null}
        </div>
        {error ? <div className="field-error" role="alert">{error}</div> : null}
        <TaskOutput key={current.id} sessionId={sessionId} task={current} api={api} pollMs={pollMs} onChanged={onRefresh} />
        {kill ? <KillDialog task={kill} onCancel={() => setKill(null)} onKill={() => void doKill(kill)} /> : null}
      </>
    );
  }
  if (tasks.length === 0) return <p className="field-hint activity-empty">No background tasks in this session.</p>;
  return (
    <>
      <ul className="activity-list">
        {tasks.map((t) => (
          <li key={t.id}>
            <button className="activity-row" onClick={() => setSelected(t.id)} data-task={t.id}>
              <span className={`activity-status status-${t.status}`} title={t.status}>
                <StatusDot status={t.status} />
              </span>
              <span className="activity-main">
                <span className="activity-label mono truncate">{t.command}</span>
                <span className="activity-detail">
                  {[t.status, t.phase, elapsedOf(t, now), t.exitCode !== null ? `exit ${t.exitCode}` : ""].filter(Boolean).join(" · ")}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {error ? <div className="field-error" role="alert">{error}</div> : null}
    </>
  );
}

function TaskHeader({ task, now }: { task: TaskInfo; now: number }) {
  return (
    <div className="subagent-detail" data-task-detail={task.id}>
      <div className="subagent-title">
        <span className={`activity-status status-${task.status}`}>
          <StatusDot status={task.status} />
        </span>
        <strong className="mono truncate">{task.command}</strong>
      </div>
      <div className="field-hint">
        {[task.status, task.phase, elapsedOf(task, now), task.exitCode !== null ? `exit code ${task.exitCode}` : ""].filter(Boolean).join(" · ")}
      </div>
    </div>
  );
}

function KillDialog({ task, onCancel, onKill }: { task: TaskInfo; onCancel: () => void; onKill: () => void }) {
  return (
    <Dialog
      title={`Kill ${task.id}?`}
      icon="alert"
      tone="warn"
      width={400}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onKill}>
            Kill
          </button>
        </>
      }
    >
      <p className="field-hint mono">{task.command}</p>
    </Dialog>
  );
}

type Chunk = { gap: true } | { gap?: false; text: string };
const MAX_OUTPUT_CHARS = 200_000;

/**
 * A task's output, read in pieces with `_keryx/tasks/output {since}`: the first call has no cursor, each
 * reply's `nextCursor` goes into the next. While the task runs it is polled every `pollMs`; polling stops
 * when keryx reports it finished, and when the row is no longer shown (unmount, other task, other session).
 * `missed` means keryx dropped output between two reads: shown as a gap.
 */
function TaskOutput({ sessionId, task, api, pollMs, onChanged }: { sessionId: string; task: TaskInfo; api: ActivityApi; pollMs: number; onChanged: () => void }) {
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const cursor = useRef<string | number | null>(null);
  const running = isRunning(task);
  const taskId = task.id;
  const changed = useRef(onChanged);
  changed.current = onChanged;

  useEffect(() => {
    let cancelled = false;
    let inflight = false;
    let timer = 0;
    const stop = () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
    const tick = async () => {
      if (inflight || cancelled) return;
      inflight = true;
      try {
        const params: Record<string, unknown> = { sessionId, taskId };
        if (cursor.current !== null) params.since = cursor.current;
        const r = await api.request<TaskOutputResult>(TASKS_OUTPUT, params);
        if (cancelled) return;
        if (r?.nextCursor !== undefined && r.nextCursor !== null) cursor.current = r.nextCursor;
        const text = typeof r?.output === "string" ? r.output : "";
        if (r?.missed || text) {
          setChunks((prev) => {
            const next = prev.slice();
            if (r.missed) next.push({ gap: true });
            if (text) {
              const last = next[next.length - 1];
              if (last && !last.gap) next[next.length - 1] = { text: last.text + text };
              else next.push({ text });
            }
            let total = 0;
            for (let i = next.length - 1; i >= 0; i--) {
              const c = next[i]!;
              if (!c.gap) total += c.text.length;
              if (total > MAX_OUTPUT_CHARS) return next.slice(i);
            }
            return next;
          });
        }
        if (r?.status && r.status !== "running") {
          stop();
          changed.current();
        }
      } catch {
        /* the next tick tries again; an exited task simply has nothing more */
      } finally {
        inflight = false;
      }
    };
    void tick();
    if (running) timer = window.setInterval(() => void tick(), pollMs);
    return stop;
  }, [api, sessionId, taskId, running, pollMs]);

  return (
    <div className="task-output" aria-label="Task output">
      {chunks.length === 0 ? <div className="field-hint">{running ? "No output yet." : "No output."}</div> : null}
      {chunks.map((c, i) =>
        c.gap ? (
          <div key={i} className="task-gap" role="note">
            output skipped here
          </div>
        ) : (
          <pre key={i} className="out-pre task-out">
            {c.text}
          </pre>
        ),
      )}
    </div>
  );
}
