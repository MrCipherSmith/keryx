import { useEffect, useMemo, useRef, useState } from "react";
import { ROUTING_TIER_IDS, type RoutingTier, type TierSettingsSnapshot } from "../../../../src/harness/routing/model-class";
import { COMMAND_METHOD } from "../acp/commands";
import type { CommandResult } from "../acp/types";
import { Dialog, Spinner } from "../components/ui";
import { errMessage } from "../lib/format";
import { ModelTier, type ReviewLaunchModel } from "../review/ReviewLaunchDialog";

type Pools = Record<RoutingTier, Pick<ReviewLaunchModel, "provider" | "model">[]>;
type Props = {
  sessionId: string;
  models: readonly ReviewLaunchModel[];
  rpc: <T>(method: string, params?: unknown) => Promise<T>;
  onClose: () => void;
};
const tierLabel = { strong: "Strong", middle: "Middle", light: "Light" };
const emptyPools = (): Pools => ({ strong: [], middle: [], light: [] });
const modelChoices = (entries: TierSettingsSnapshot["tiers"][number]["user"]) =>
  entries.map(({ providerId: provider, modelId: model }) => ({ provider, model }));

async function routingRequest(rpc: Props["rpc"], sessionId: string, args: string): Promise<string> {
  const result = await rpc<CommandResult>(COMMAND_METHOD, { name: "routing", sessionId, args });
  if (result._meta?.keryx?.refused) {
    throw new Error(result.text);
  }
  if (typeof result.text !== "string") throw new Error("Keryx did not return routing settings.");
  return result.text;
}

export function RoutingDialog({ sessionId, models, rpc, onClose }: Props) {
  const [settings, setSettings] = useState<TierSettingsSnapshot>();
  const [pools, setPools] = useState<Pools>(emptyPools);
  const [open, setOpen] = useState<RoutingTier>();
  const [error, setError] = useState("");
  const [replaceOverrides, setReplaceOverrides] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const savingRef = useRef(false);
  const active = useRef(false);
  const available = useMemo(() => new Map(models.map(model => [JSON.stringify([model.provider, model.model]), model])), [models]);
  useEffect(() => {
    let cancelled = false;
    active.current = true;
    setSettings(undefined);
    setOpen(undefined);
    setReplaceOverrides(false);
    setError("");
    void routingRequest(rpc, sessionId, "tiers").then(text => {
      let snapshot: TierSettingsSnapshot;
      try {
        snapshot = JSON.parse(text);
        if (typeof snapshot.revision !== "string" || !Array.isArray(Reflect.get(snapshot, "tiers"))) throw new Error();
      } catch {
        throw new Error("Keryx returned invalid routing settings.");
      }
      if (cancelled) return;
      const next = emptyPools();
      for (const row of snapshot.tiers) next[row.tier] = modelChoices(row.user);
      setPools(next);
      setSettings(snapshot);
    }).catch(reason => { if (!cancelled) setError(errMessage(reason)); });
    return () => { cancelled = true; active.current = false; };
  }, [rpc, sessionId, reload]);

  async function save() {
    if (!settings || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      await routingRequest(rpc, sessionId, `tiers ${settings.revision} ${JSON.stringify({ modelPools: pools, replaceOverrides })}`);
      if (active.current) onClose();
    } catch (reason) {
      if (active.current) setError(errMessage(reason));
    } finally {
      savingRef.current = false;
      if (active.current) setSaving(false);
    }
  }

  return <div className="review-launch-overlay">
    <Dialog title="Model routing" width={680} onClose={saving ? null : onClose} footer={<>
      <button className="btn" type="button" disabled={saving} onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" type="button" disabled={!settings || saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save routing"}
      </button>
    </>}>
      <div className="review-launch-body">
        {settings ? <>
          <p className="field-hint">These are your defaults across projects. Add models in preference order. Empty tiers use the session model.</p>
          {settings.personalOverrides && <label className="review-launch-adaptive">
            <input type="checkbox" checked={replaceOverrides} disabled={saving}
              onChange={event => setReplaceOverrides(event.currentTarget.checked)} />
            Replace previous personal routing overrides with these tiers
          </label>}
          {settings.projectOverrides && <p className="field-hint">This project has approved routing settings. Project overrides take precedence.</p>}
          {settings.notices.map(notice => <p className="field-hint" key={notice}>{notice}</p>)}
          {settings.projectTrustRequired && <p className="field-hint">Use <code>/routing status</code> to inspect project routing and approve changes.</p>}
          {!available.size && <p className="field-hint">Connect a provider in Keryx to add models.</p>}
          {ROUTING_TIER_IDS.map(tier => {
            const project = settings.tiers.find(row => row.tier === tier)?.project;
            return <ModelTier key={tier} label={project ? `${tierLabel[tier]} · Project` : tierLabel[tier]}
              picked={project ? modelChoices(project) : pools[tier]} models={available} readOnly={Boolean(project) || saving} emptyLabel="Use session model"
              open={open === tier && !saving} setOpen={expanded => setOpen(expanded ? tier : undefined)}
              onChange={selected => setPools(previous => ({ ...previous, [tier]: selected }))} />;
          })}
        </> : !error && <div role="status"><Spinner /> Loading routing settings…</div>}
        {error && <div role="alert">
          <p>{error}</p>
          {(!settings || error.includes("revision conflict")) &&
            <button className="btn btn-sm" type="button" onClick={() => setReload(value => value + 1)}>Reload saved settings</button>}
        </div>}
      </div>
    </Dialog>
  </div>;
}
