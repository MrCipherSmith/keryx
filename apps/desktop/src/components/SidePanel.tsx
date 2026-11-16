import type { ConfigOption, ConfigSelectGroup, ConfigSelectOption } from "../acp/types";
import { modelOption } from "../session/useAcpSession";
import type { SessionState } from "../session/reducer";

interface Props {
  state: SessionState;
  onNew: () => void;
  onLoad: (id: string) => void;
  onMode: (id: string) => void;
  onModel: (configId: string, value: string) => void;
}

function isGroup(o: ConfigSelectOption | ConfigSelectGroup): o is ConfigSelectGroup {
  return "group" in o && Array.isArray((o as ConfigSelectGroup).options);
}

function ModelSelect({ option, onChange }: { option: ConfigOption; onChange: (v: string) => void }) {
  return (
    <select value={option.currentValue} onChange={(e) => onChange(e.target.value)} aria-label="Model">
      {option.options.map((o) =>
        isGroup(o) ? (
          <optgroup key={o.group} label={o.name}>
            {o.options.map((x) => (
              <option key={x.value} value={x.value}>{x.name}</option>
            ))}
          </optgroup>
        ) : (
          <option key={o.value} value={o.value}>{o.name}</option>
        ),
      )}
    </select>
  );
}

const PLAN_MARK = { pending: "○", in_progress: "◐", completed: "●" } as const;

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

export function SidePanel({ state, onNew, onLoad, onMode, onModel }: Props) {
  const model = modelOption(state.configOptions);
  const { modes, plan, usage, sessions, sessionId } = state;
  return (
    <aside className="side">
      <section>
        <div className="side-head">
          <h3>Sessions</h3>
          <button className="btn btn-small" onClick={onNew} disabled={state.busy}>New</button>
        </div>
        <ul className="sessions">
          {sessions.length === 0 ? <li className="muted">No saved sessions</li> : null}
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <button
                className={`session-row${s.sessionId === sessionId ? " current" : ""}`}
                onClick={() => onLoad(s.sessionId)}
                disabled={state.busy}
                title={s.sessionId}
              >
                <span className="session-title">{s.title?.trim() || "Untitled session"}</span>
                {s.updatedAt ? <span className="session-when">{new Date(s.updatedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {modes && modes.availableModes.length > 0 ? (
        <section>
          <h3>Permission mode</h3>
          <div className="seg" role="radiogroup" aria-label="Permission mode">
            {modes.availableModes.map((m) => (
              <button
                key={m.id}
                role="radio"
                aria-checked={m.id === modes.currentModeId}
                className={m.id === modes.currentModeId ? "on" : ""}
                title={m.description ?? undefined}
                onClick={() => m.id !== modes.currentModeId && onMode(m.id)}
              >
                {m.name}
              </button>
            ))}
          </div>
          {(() => {
            const d = modes.availableModes.find((m) => m.id === modes.currentModeId)?.description;
            return d ? <p className="hint">{d}</p> : null;
          })()}
        </section>
      ) : null}

      {model ? (
        <section>
          <h3>Model</h3>
          <ModelSelect option={model} onChange={(v) => onModel(model.id, v)} />
        </section>
      ) : null}

      {plan.length > 0 ? (
        <section>
          <h3>Plan</h3>
          <ul className="plan">
            {plan.map((p, i) => (
              <li key={i} className={`plan-${p.status}`}>
                <span className="plan-mark">{PLAN_MARK[p.status] ?? "○"}</span>
                <span>{p.content}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {usage ? (
        <section>
          <h3>Usage</h3>
          <div className="usage-bar" aria-hidden>
            <div style={{ width: `${usage.size > 0 ? Math.min(100, (usage.used / usage.size) * 100) : 0}%` }} />
          </div>
          <p className="hint">
            {formatTokens(usage.used)} / {formatTokens(usage.size)} tokens
            {usage.cost ? ` · ${usage.cost.amount.toFixed(4)} ${usage.cost.currency}` : ""}
          </p>
        </section>
      ) : null}
    </aside>
  );
}
