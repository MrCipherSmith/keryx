import { memo, useEffect, useState } from "react";
import type { ConfigOption } from "../acp/types";
import { absoluteTime, formatTokens, relativeTime } from "../lib/format";
import { gitInfo, type GitInfo } from "../platform/commands";
import { Icon } from "../components/Icon";
import type { SessionState, TokenPair } from "./reducer";
import { modelOption } from "./useAcpSession";

interface Props {
  state: SessionState;
  cwd: string;
  projectName: string;
}

function optionName(option: ConfigOption | undefined): string | null {
  if (!option) return null;
  for (const o of option.options) {
    if ("group" in o) {
      const hit = o.options.find((x) => x.value === option.currentValue);
      if (hit) return hit.name;
    } else if (o.value === option.currentValue) return o.name;
  }
  return option.currentValue || null;
}

function Pair({ label, pair, title }: { label: string; pair: TokenPair | null; title?: string }) {
  return (
    <div className="info-row" title={title}>
      <span className="info-key">{label}</span>
      <span className="info-val">{pair ? `${formatTokens(pair.inputTokens)} in · ${formatTokens(pair.outputTokens)} out` : "—"}</span>
    </div>
  );
}

/** The git state of `cwd`, read again when the shown session or its busy state changes. */
function useGit(cwd: string, sessionId: string | null, busy: boolean): GitInfo | null | undefined {
  const [git, setGit] = useState<GitInfo | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    // A turn's end is when files and the branch are most likely to have changed.
    if (busy) return;
    gitInfo(cwd)
      .then((g) => live && setGit(g))
      .catch(() => live && setGit(null));
    return () => {
      live = false;
    };
  }, [cwd, sessionId, busy]);
  return git;
}

/** What one session runs in and has used so far: project, branch, model, context and tokens. */
export const SessionInfoPanel = memo(function SessionInfoPanel({ state, cwd, projectName }: Props) {
  const git = useGit(cwd, state.sessionId, state.busy);
  const usage = state.usage;
  const ctx = usage && usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : null;
  const info = state.sessions.find((x) => x.sessionId === state.sessionId);
  const mode = state.modes?.availableModes.find((m) => m.id === state.modes?.currentModeId)?.name ?? state.modes?.currentModeId;
  const done = state.plan.filter((p) => p.status === "completed").length;

  return (
    <aside className="info-panel" aria-label="Session info">
      <div className="info-body">
        <section className="info-section" aria-label="Environment">
          <div className="info-line" title={cwd}>
            <Icon name="folder" size={14} />
            <span className="truncate">
              {projectName} <span className="info-dim">· {cwd.replace(/^\/Users\/[^/]+/, "~")}</span>
            </span>
          </div>
          <div className="info-line">
            <Icon name="branch" size={14} />
            {git === undefined ? (
              <span className="info-dim">Reading git…</span>
            ) : git === null ? (
              <span className="info-dim">Not a git checkout</span>
            ) : (
              <span className="truncate" title={git.upstream ? `Tracks ${git.upstream}` : undefined}>
                {git.branch ?? `detached at ${git.commit ?? "?"}`}
                {git.ahead || git.behind ? (
                  <span className="info-dim">
                    {" "}
                    {git.ahead ? `↑${git.ahead}` : ""}
                    {git.behind ? ` ↓${git.behind}` : ""}
                  </span>
                ) : null}
              </span>
            )}
          </div>
          {git ? (
            <div className="info-line">
              <Icon name="file" size={14} />
              <span>{git.changed === 0 ? "No changes" : `${git.changed} changed file${git.changed === 1 ? "" : "s"}`}</span>
            </div>
          ) : null}
        </section>

        <section className="info-section" aria-label="Agent">
          <div className="info-row">
            <span className="info-key">Model</span>
            <span className="info-val truncate">{optionName(modelOption(state.configOptions)) ?? "—"}</span>
          </div>
          <div className="info-row">
            <span className="info-key">Mode</span>
            <span className="info-val">{mode ?? "—"}</span>
          </div>
          <div className="info-row">
            <span className="info-key">keryx</span>
            <span className="info-val">{state.agentVersion ?? "—"}</span>
          </div>
          <div className="info-row">
            <span className="info-key">State</span>
            <span className="info-val">{!state.sessionId ? "No session" : state.busy ? "Working" : state.held ? "Live" : "Closed"}</span>
          </div>
        </section>

        <section className="info-section" aria-label="Context">
          <div className="info-row">
            <span className="info-key">Context</span>
            <span className="info-val">{ctx !== null ? `${ctx}%` : "—"}</span>
          </div>
          {ctx !== null ? (
            <div className="info-meter" title={`Last model call used ${formatTokens(usage!.used)} of ${formatTokens(usage!.size)} tokens`}>
              <span style={{ width: `${ctx}%` }} className={ctx >= 85 ? "is-high" : undefined} />
            </div>
          ) : null}
        </section>

        <section className="info-section" aria-label="Tokens">
          <Pair label="Session" pair={usage?.session ?? null} title="Every model call in this session" />
          <Pair label="This turn" pair={usage?.turn ?? null} title="The latest turn, so far" />
          <Pair label="Last call" pair={usage?.call ?? null} />
          {usage?.cost ? (
            <div className="info-row">
              <span className="info-key">Cost</span>
              <span className="info-val">
                {usage.cost.amount.toFixed(4)} {usage.cost.currency}
              </span>
            </div>
          ) : null}
        </section>

        {state.plan.length > 0 ? (
          <section className="info-section" aria-label="Plan">
            <div className="info-row">
              <span className="info-key">Plan</span>
              <span className="info-val">
                {done} of {state.plan.length} done
              </span>
            </div>
          </section>
        ) : null}

        {state.sessionId ? (
          <section className="info-section" aria-label="Session">
            <div className="info-row">
              <span className="info-key">Id</span>
              <span className="info-val mono" title={state.sessionId}>
                {state.sessionId.replace(/-/g, "").slice(-8)}
              </span>
            </div>
            {info?.updatedAt ? (
              <div className="info-row" title={absoluteTime(info.updatedAt)}>
                <span className="info-key">Updated</span>
                <span className="info-val">{relativeTime(info.updatedAt)}</span>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </aside>
  );
});
