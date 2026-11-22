import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { DEFAULT_REVIEW_PARALLEL, DESK_MAX_PARALLEL, DESK_MAX_POOL_MODELS, DESK_REVIEW_POOLS, type DeskReviewModel, type DeskReviewOptions, type DeskReviewPool } from "../../../../src/review/desk-run-options";
import type { DeskRevision, DeskRunKey } from "../../../../src/review/desk-run-types";
import { Icon } from "../components/Icon";
import { Dialog, Spinner } from "../components/ui";
import { errMessage } from "../lib/format";
import type { FlowCard } from "../platform/commands";
import type { ReviewBoardSnapshot, ReviewCard } from "./types";
import "./ReviewLaunchDialog.css";

export interface ReviewLaunchModel {
  provider: string;
  model: string;
  label: string;
}
export interface ReviewLaunchTargetResult {
  snapshot: ReviewBoardSnapshot;
  selectedNumber?: number;
}
export type ReviewLaunchDialogProps = {
  flows: readonly FlowCard[];
  defaultFlow?: string;
  models: readonly ReviewLaunchModel[];
  onApply: (key: DeskRunKey, revision: DeskRevision, options: DeskReviewOptions) => Promise<void>;
  onClose: () => void;
} & (
  | { initialTarget?: string; loadTargets: (hint?: string, signal?: AbortSignal) => Promise<ReviewLaunchTargetResult>; fixedTarget?: never }
  | { initialTarget?: never; loadTargets?: never; fixedTarget: Omit<DeskRunKey, "number"> & { card: ReviewCard } }
);

const tierLabels = { strong: "Strong", middle: "Middle", light: "Light" };
const maxLimit = Number.MAX_SAFE_INTEGER;
const limits = [
  { key: "maxWaves", label: "Max waves", initial: 0, min: 0, max: maxLimit },
  { key: "maxParallel", label: "Parallel reviewers", initial: DEFAULT_REVIEW_PARALLEL, min: 1, max: DESK_MAX_PARALLEL },
  { key: "maxTokens", label: "Token limit", initial: 0, min: 0, max: maxLimit },
] as const;
type LimitField = typeof limits[number];
const modelKey = (model: DeskReviewModel) => JSON.stringify([model.provider, model.model]);

function limitHelp(value: string, field: LimitField) {
  const trimmed = value.trim();
  const number = trimmed === "" ? field.initial : Number(trimmed);
  const invalid = (trimmed !== "" && !/^\d+$/.test(trimmed)) || number < field.min || number > field.max;
  const range = "1–" + field.max.toLocaleString();
  return {
    number,
    invalid,
    message: invalid ? `Enter ${field.min === 0 ? "0 or " : ""}${range}.`
      : field.min === 0 ? `0 = no cap · ${range}` : `${range} · default ${field.initial}`,
  };
}

export function ModelPicker({ tier, choices, onSelect, onClose }: {
  tier: string; choices: ReviewLaunchModel[]; onSelect: (model: ReviewLaunchModel) => void; onClose: () => void;
}) {
  const id = useId();
  const [provider, setProvider] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const providerInput = useRef<HTMLSelectElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const providers = [...new Set(choices.map(model => model.provider))];
  const needle = query.trim().toLowerCase();
  const filtered = choices.filter(model => model.provider === provider &&
    (model.label.toLowerCase().includes(needle) || model.model.toLowerCase().includes(needle)));
  const optionId = (index: number) => `${id}-model-${index}`;

  useEffect(() => { providerInput.current?.focus(); }, []);
  useEffect(() => { if (provider) searchInput.current?.focus(); }, [provider]);
  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = 0;
    picker.current?.scrollIntoView?.({ block: "nearest" });
  }, [provider]);

  function move(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && filtered[active]) {
      event.preventDefault();
      onSelect(filtered[active]!);
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && filtered.length) {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? Math.min(active + 1, filtered.length - 1) : Math.max(active - 1, 0);
      setActive(next);
      list.current?.children.item(next)?.scrollIntoView({ block: "nearest" });
    }
  }

  return <div ref={picker} className="review-model-picker" onKeyDown={event => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }}>
    <div className="review-model-picker-fields">
      <label>Provider
        <select ref={providerInput} className="select-compact" aria-label={`${tier} provider`} value={provider}
          onChange={event => { setProvider(event.currentTarget.value); setQuery(""); setActive(-1); }}>
          <option value="">Choose a provider</option>
          {providers.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      <label>Model
        <input ref={searchInput} className="text-input" type="search" role="combobox" aria-label={`Search ${tier} models`} disabled={!provider}
          value={query} placeholder="Search by name" autoComplete="off" aria-autocomplete="list" aria-expanded={!!provider}
          aria-controls={id} aria-activedescendant={filtered[active] ? optionId(active) : undefined}
          onChange={event => { setQuery(event.currentTarget.value); setActive(-1); }} onKeyDown={move} />
      </label>
    </div>
    <ul ref={list} className="review-model-results" role="listbox" aria-label={`${tier} models from ${provider}`} id={id} hidden={!provider || !filtered.length}>
      {filtered.map((model, index) => <li key={modelKey(model)} id={optionId(index)} role="option" aria-selected={index === active}
        onMouseDown={event => event.preventDefault()} onClick={() => onSelect(model)}>
        <span>{model.label || model.model}</span>
      </li>)}
    </ul>
    {provider && !filtered.length && <p className="field-hint" role="status">No matching models.</p>}
  </div>;
}

export function ModelTier({ label, picked, models, open, setOpen, onChange, readOnly = false, emptyLabel, maxModels = DESK_MAX_POOL_MODELS }: {
  label: string; picked: DeskReviewModel[]; models: ReadonlyMap<string, ReviewLaunchModel>;
  readOnly?: boolean;
  emptyLabel?: string;
  maxModels?: number;
  open: boolean; setOpen: (open: boolean) => void; onChange: (models: DeskReviewModel[]) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const selected = new Set(picked.map(modelKey));
  const choices = [...models.values()].filter(model => !selected.has(modelKey(model)));
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  return <section className="review-launch-tier" aria-label={label + " models"}>
    <header className="review-launch-tier-head">
      <strong>{label}</strong>
      {!readOnly && <button ref={trigger} className="btn btn-sm" type="button" aria-label={`Add model to ${label} tier`}
        aria-expanded={open} aria-controls={id} disabled={!choices.length || picked.length >= maxModels}
        onClick={() => open ? close() : setOpen(true)}><Icon name="plus" size={13} /> Add model</button>}
    </header>
    <div id={id} hidden={!open}>{open && <ModelPicker tier={label} choices={choices} onClose={close}
      onSelect={({ provider, model }) => { close(); onChange([...picked, { provider, model }]); }} />}</div>
    {picked.length > 0 ? <ul className="review-launch-pool">{picked.map(option => {
      const key = modelKey(option);
      const title = models.get(key)?.label || option.model;
      return <li key={key}>
        <span className="review-pool-model" title={option.model}>{title}</span>
        <span className="review-pool-provider" title={option.provider}>{option.provider}</span>
        {!readOnly && <button className="icon-btn icon-btn-sm" type="button" aria-label={`Remove ${option.provider} ${title} from ${label}`}
          onClick={() => onChange(picked.filter(model => modelKey(model) !== key))}><Icon name="x" size={13} /></button>}
      </li>;
    })}</ul> : emptyLabel && <p className="field-hint">{emptyLabel}</p>}
  </section>;
}

function ModelPools({ models, pools, onChange }: {
  models: readonly ReviewLaunchModel[];
  pools: DeskReviewOptions["modelPools"];
  onChange: (next: DeskReviewOptions["modelPools"]) => void;
}) {
  const available = useMemo(() => new Map(models.map(model => [modelKey(model), model])), [models]);
  const [open, setOpen] = useState<DeskReviewPool>();
  return <fieldset className="review-launch-models">
    <legend>Reviewer models</legend>
    <p className="field-hint">Empty tiers use the project’s review routing.</p>
    {DESK_REVIEW_POOLS.map(tier => <ModelTier key={tier} label={tierLabels[tier]} picked={pools[tier]} models={available}
      open={open === tier} setOpen={expanded => setOpen(expanded ? tier : undefined)}
      onChange={selected => onChange({ ...pools, [tier]: selected })} />)}
  </fieldset>;
}

export function ReviewLaunchDialog({ flows, defaultFlow, initialTarget, loadTargets, fixedTarget, models, onApply, onClose }: ReviewLaunchDialogProps) {
  const [hint, setHint] = useState(initialTarget ?? "");
  const [lookup, setLookup] = useState<{ hint: string } | null>(() => ({ hint: initialTarget ?? "" }));
  const [target, setTarget] = useState<ReviewLaunchTargetResult | null>(null);
  const [number, setNumber] = useState("");
  const [readError, setReadError] = useState("");
  const [applyError, setApplyError] = useState("");
  const [mode, setMode] = useState<DeskReviewOptions["mode"]>("auto");
  const [orchestrator, setOrchestrator] = useState(true);
  const [adaptive, setAdaptive] = useState(true);
  const [autoPublish, setAutoPublish] = useState(false);
  const [draftLimits, setDraftLimits] = useState({ maxWaves: "0", maxParallel: String(DEFAULT_REVIEW_PARALLEL), maxTokens: "0" });
  const [chosenFlow, setChosenFlow] = useState<string>();
  const [pools, setPools] = useState<DeskReviewOptions["modelPools"]>({ strong: [], middle: [], light: [] });
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const live = useRef(false);
  const id = useId();
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    setTarget(null);
    setReadError("");
    setApplyError("");
    setNumber("");
    if (!lookup || !loadTargets) return;
    const controller = new AbortController();
    void loadTargets(lookup.hint.trim() || undefined, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      const open = result.snapshot.cards.filter(card => card.state === "open");
      const selected = result.selectedNumber === undefined && !lookup.hint.trim() && open.length === 1
        ? open[0] : open.find(card => card.number === result.selectedNumber);
      setTarget(result);
      setNumber(selected ? String(selected.number) : "");
    }).catch(cause => { if (!controller.signal.aborted) setReadError(errMessage(cause)); });
    return () => controller.abort();
  }, [lookup, loadTargets]);
  const snapshot = target?.snapshot;
  const subject = fixedTarget ?? snapshot;
  const cards = useMemo(() => snapshot?.cards.filter(card => card.state === "open") ?? [], [snapshot]);
  const card = fixedTarget?.card ?? cards.find(candidate => String(candidate.number) === number);
  const eligibleFlows = flows.filter(flow => flow.idValid);
  const linked = card && eligibleFlows.find(flow => flow.prUrl?.replace(/\/$/, "").toLowerCase() === card.url.replace(/\/$/, "").toLowerCase());
  const flow = chosenFlow ?? defaultFlow ?? linked?.id ?? "";
  const flowValid = !flow || eligibleFlows.some(candidate => candidate.id === flow);
  const modelKeys = useMemo(() => new Set(models.map(modelKey)), [models]);
  const modelsValid = !orchestrator || DESK_REVIEW_POOLS.every(tier => pools[tier].every(model => modelKeys.has(modelKey(model))));
  const limitFields = limits.filter(field => orchestrator || field.key === "maxTokens")
    .map(field => ({ ...field, ...limitHelp(draftLimits[field.key], field) }));
  const valid = flowValid && modelsValid && !limitFields.some(field => field.invalid);
  async function apply() {
    if (applyingRef.current || !card || !subject || !valid || card.state !== "open" || !card.headSha || !card.baseSha) return;
    applyingRef.current = true;
    setApplying(true);
    setApplyError("");
    try {
      await onApply({ repo: subject.repo, repositoryId: subject.repositoryId, viewer: subject.viewer, number: card.number },
        { baseSha: card.baseSha, headSha: card.headSha }, {
          mode, ...(orchestrator ? { adaptive, modelPools: pools } : {
            orchestrator: false, adaptive: false, modelPools: { strong: [], middle: [], light: [] },
          }), ...(flow && { flowId: flow }), ...(orchestrator && autoPublish && { autoPublish: true }),
          ...Object.fromEntries(limitFields.filter(field => field.number > 0).map(field => [field.key, field.number])),
        });
      if (live.current) onClose();
    } catch (cause) {
      if (live.current) {
        applyingRef.current = false;
        setApplying(false);
        setApplyError(errMessage(cause));
      }
    }
  }
  function findTarget() {
    setTarget(null);
    setNumber("");
    setReadError("");
    setApplyError("");
    setLookup({ hint });
  }
  return <div className="review-launch-overlay"><Dialog title="Run review" icon="pr" width={680} onClose={applying ? null : onClose} footer={<>
    <button type="button" className="btn btn-sm" disabled={applying} onClick={onClose}>Cancel</button>
    <button type="button" className="btn btn-sm btn-primary" disabled={applying || !valid || card?.state !== "open" || !card?.baseSha || !card?.headSha}
      onClick={() => void apply()}>{applying ? "Starting review…" : "Apply"}</button>
  </>}>
    <fieldset className="review-launch-body" disabled={applying}>
      <section className="review-launch-section">
        {fixedTarget ? <p className="field-hint">{fixedTarget.repo} #{fixedTarget.card.number} · {fixedTarget.card.title}</p> : <>
        <label htmlFor={id + "-target"}>Find pull request</label>
        <form className="review-launch-find" onSubmit={e => { e.preventDefault(); findTarget(); }}>
          <input id={id + "-target"} className="text-input" value={hint} data-autofocus placeholder="GitHub pull request URL or #number"
            onChange={e => {
              setHint(e.currentTarget.value); setLookup(null); setTarget(null); setNumber(""); setReadError(""); setApplyError("");
            }} />
          <button type="submit" className="icon-btn review-launch-find-button" aria-label="Find pull request" title="Find pull request"><Icon name="search" size={16} /></button>
        </form>
        {lookup && !snapshot && !readError && <Spinner label="Finding pull requests" />}
        {readError && <p className="inline-banner tone-warn" role="alert">{readError}</p>}
        {snapshot && <>
          <label htmlFor={id + "-pr"}>{snapshot.repo} · {snapshot.viewer}</label>
          {cards.length ? <select className="select-compact" aria-label="Pull request" id={id + "-pr"} value={number}
            onChange={e => { setNumber(e.currentTarget.value); setApplyError(""); }}>
            <option value="">Choose a pull request</option>
            {cards.map(c => <option key={c.number} value={c.number}>#{c.number} · {c.title}</option>)}
          </select> : <p className="field-hint">No open pull requests found.</p>}
        </>}
        </>}
        {card?.changeStats && <div className="review-launch-stats">
          <span>{card.changeStats.files.toLocaleString()} {card.changeStats.files === 1 ? "file changed" : "files changed"}</span>
          <span className="review-added" aria-label={`${card.changeStats.additions.toLocaleString()} additions`}>+{card.changeStats.additions.toLocaleString()}</span>
          <span className="review-deleted" aria-label={`${card.changeStats.deletions.toLocaleString()} deletions`}>−{card.changeStats.deletions.toLocaleString()}</span>
        </div>}
        <label>Associated Flow
          <select className="select-compact" value={flow} onChange={e => setChosenFlow(e.currentTarget.value)}>
            <option value="">Standalone review</option>
            {!flowValid && <option value={flow} disabled>Unavailable Flow #{flow}</option>}
            {eligibleFlows.map(f => <option key={f.dir} value={f.id}>#{f.id} · {f.title}</option>)}
          </select>
        </label>
      </section>
      <section className="review-launch-section">
        <div className="review-launch-mode">
          <span id={id + "-mode"}>Review mode</span>
          <div className="segmented" role="group" aria-labelledby={id + "-mode"}>
            {(["auto", "manual"] as const).map(value => <button type="button" key={value} aria-pressed={mode === value}
              onClick={() => setMode(value)}>{value === "auto" ? "Auto" : "Manual"}</button>)}
          </div>
        </div>
        <label className="review-launch-adaptive"><input type="checkbox" checked={orchestrator}
          aria-describedby={id + "-workflow"} onChange={e => setOrchestrator(e.currentTarget.checked)} /> Review orchestrator</label>
        <small className="field-hint" id={id + "-workflow"}>Turn off to run one reviewer without reviewer waves.</small>
        {orchestrator && <label className="review-launch-adaptive"><input type="checkbox" checked={adaptive}
          onChange={e => setAdaptive(e.currentTarget.checked)} /> Adaptive model selection</label>}
        <div className="review-launch-limits">{limitFields.map(({ key, label, initial, invalid, message }) =>
          <label key={key}>{label}
            <input className="text-input" type="text" inputMode="numeric" value={draftLimits[key]} placeholder={String(initial)}
              aria-invalid={invalid} aria-describedby={id + key}
              onChange={event => { const value = event.currentTarget.value; setDraftLimits(old => ({ ...old, [key]: value })); }} />
            <small id={id + key} className={invalid ? "review-launch-invalid" : undefined}>{message}</small>
          </label>)}</div>
      </section>
      {orchestrator && <ModelPools models={models} pools={pools} onChange={setPools} />}
      <section className="review-launch-section">
        <label className="review-launch-adaptive"><input type="checkbox" checked={orchestrator && autoPublish} disabled={!orchestrator}
          aria-describedby={id + "-publication"} onChange={e => setAutoPublish(e.currentTarget.checked)} /> Publish to GitHub automatically</label>
        <small className="field-hint" id={id + "-publication"}>
          {orchestrator ? "Posts an English review comment after full coverage, using the Keryx template plus any project overlay. If the overlay requires approval, you’ll be asked to confirm the finished draft."
            : "Automatic posting requires full coverage from the review orchestrator."}
        </small>
      </section>
      {!modelsValid && <p role="alert" className="inline-banner tone-warn">A selected model is no longer available. Remove it to continue.</p>}
      {card && (!card.baseSha || !card.headSha) && <p role="alert" className="inline-banner tone-warn">The PR revision is unavailable. Find the pull request again.</p>}
      {applyError && <p className="inline-banner tone-warn" role="alert">{applyError}</p>}
    </fieldset>
  </Dialog></div>;
}
