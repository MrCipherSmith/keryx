// Settings for `keryx wiki enrich`: run mode, provider and model, group size, groups at a time, scope and
// workers. The dialog only builds the argv (projectCommands.ts); the caller runs it in a terminal tab.

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "../components/ui";
import { PROVIDERS_LIST, type ProviderInfo, type ProvidersListResult } from "../acp/providers";
import { buildEnrichArgs, commandLine, DEFAULT_ENRICH, MAX_CONCURRENCY, previewGroupsArgs, type EnrichSettings } from "./projectCommands";

interface Props {
  /** `_keryx/providers/list` for the provider choices; null when this keryx does not serve it. */
  listProviders: (() => Promise<ProviderInfo[]>) | null;
  onRun: (args: string[], title: string) => void;
  onClose: () => void;
  initial?: EnrichSettings;
}

export const providersLister =
  (request: <T>(method: string, params?: unknown) => Promise<T>) =>
  async (): Promise<ProviderInfo[]> =>
    (await request<ProvidersListResult>(PROVIDERS_LIST, {})).providers ?? [];

function Choice<T extends string>({
  name,
  value,
  current,
  label,
  help,
  disabled,
  onChange,
}: {
  name: string;
  value: T;
  current: T;
  label: string;
  help: string;
  disabled?: boolean;
  onChange: (v: T) => void;
}) {
  const on = current === value;
  return (
    <label className={`choice${on ? " is-on" : ""}${disabled ? " is-disabled" : ""}`}>
      <input type="radio" name={name} checked={on} disabled={disabled} onChange={() => onChange(value)} />
      <span>
        <span className="choice-label">{label}</span>
        <span className="choice-help">{help}</span>
      </span>
    </label>
  );
}

const num = (v: string): number => (v.trim() === "" ? Number.NaN : Number(v));

export function WikiEnrichDialog({ listProviders, onRun, onClose, initial = DEFAULT_ENRICH }: Props) {
  const [s, setS] = useState<EnrichSettings>(initial);
  const set = (patch: Partial<EnrichSettings>) => setS((prev) => ({ ...prev, ...patch }));
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);

  useEffect(() => {
    if (!listProviders) return;
    let live = true;
    listProviders()
      .then((list) => live && setProviders(list.filter((p) => p.connected)))
      .catch(() => live && setProviders([]));
    return () => {
      live = false;
    };
  }, [listProviders]);

  const built = useMemo(() => buildEnrichArgs(s), [s]);
  const waves = s.mode === "waves";

  return (
    <Dialog
      title="Wiki enrich"
      icon="wand"
      width={560}
      onClose={onClose}
      footer={
        <>
          {waves ? (
            <button
              className="btn btn-ghost"
              disabled={!built.ok}
              title="Print the related groups and run nothing (--list)"
              onClick={() => {
                const p = previewGroupsArgs(s);
                if (p.ok) onRun(p.args, "wiki enrich groups");
              }}
            >
              Preview groups
            </button>
          ) : null}
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!built.ok}
            onClick={() => {
              if (!built.ok) return;
              onRun(built.args, "wiki enrich");
              onClose();
            }}
          >
            Run
          </button>
        </>
      }
    >
      <fieldset className="field">
        <legend className="field-label">Run as</legend>
        <div className="choice-list" role="radiogroup" aria-label="Run as">
          <Choice name="mode" value="waves" current={s.mode} onChange={(mode) => set({ mode })} label="Waves of related groups" help="Pages that link to each other or cite the same code go to one worker together (--group related)." />
          <Choice name="mode" value="one" current={s.mode} onChange={(mode) => set({ mode })} label="One job" help="A single worker goes through the whole batch, page by page." />
        </div>
      </fieldset>

      {waves ? (
        <div className="field-row enrich-numbers">
          <label className="field">
            <span className="field-label">Pages per group</span>
            <span className="enrich-range">
              <input type="number" min={1} aria-label="Smallest group" value={Number.isNaN(s.groupMin) ? "" : s.groupMin} onChange={(e) => set({ groupMin: num(e.target.value) })} />
              <span aria-hidden>–</span>
              <input type="number" min={1} aria-label="Largest group" value={Number.isNaN(s.groupMax) ? "" : s.groupMax} onChange={(e) => set({ groupMax: num(e.target.value) })} />
            </span>
          </label>
          <label className="field">
            <span className="field-label">Groups at a time</span>
            <input type="number" min={1} max={MAX_CONCURRENCY} value={Number.isNaN(s.concurrency) ? "" : s.concurrency} onChange={(e) => set({ concurrency: num(e.target.value) })} />
          </label>
        </div>
      ) : null}

      <div className="field-row">
        <label className="field grow">
          <span className="field-label">Provider</span>
          <select value={s.provider} onChange={(e) => set({ provider: e.target.value })}>
            <option value="">Default (from auth.json)</option>
            {(providers ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            {s.provider && providers && !providers.some((p) => p.id === s.provider) ? <option value={s.provider}>{s.provider}</option> : null}
          </select>
        </label>
        <label className="field grow">
          <span className="field-label">Model</span>
          <input className="mono" placeholder="Provider default" value={s.model} onChange={(e) => set({ model: e.target.value })} spellCheck={false} />
        </label>
      </div>

      <fieldset className="field">
        <legend className="field-label">Pages</legend>
        <div className="choice-list" role="radiogroup" aria-label="Pages">
          <Choice name="scope" value="drafts" current={s.scope} onChange={(scope) => set({ scope })} label="Drafts only" help="Pages still Status: draft." />
          <Choice name="scope" value="force" current={s.scope} onChange={(scope) => set({ scope })} label="All pages (--force)" help="Rewrites the prose of accepted pages too." />
        </div>
      </fieldset>

      <fieldset className="field">
        <legend className="field-label">Workers</legend>
        <div className="choice-list" role="radiogroup" aria-label="Workers">
          <Choice name="workers" value="internal" current={s.workers} onChange={(workers) => set({ workers })} label="Internal" help="keryx's own in-process workers, one model call per page." />
          <Choice name="workers" value="external" current={s.workers} onChange={(workers) => set({ workers })} disabled label="External agents" help="Not supported by keryx wiki enrich yet." />
        </div>
      </fieldset>

      <div className="field">
        <span className="field-label">Command</span>
        {built.ok ? (
          <pre className="out-pre is-command" aria-label="Command">{commandLine(built.args)}</pre>
        ) : (
          <span className="field-error" role="alert">
            {built.error}
          </span>
        )}
        <span className="field-hint">Runs in a terminal tab in the side panel; the tab shows progress and the exit code.</span>
      </div>
    </Dialog>
  );
}
