import { useState } from "react";
import { PR_WATCH_TOPICS, type PrRepairModel, type PrRepairSettings, type PrWatchTopic } from "../../../../src/review/watcher-types";
import { ModelPicker, type ReviewLaunchModel } from "./ReviewLaunchDialog";
import { Dialog, Spinner } from "../components/ui";
import { absoluteTime } from "../lib/format";
import { useReviewRules, type RulesProps } from "./useReviewRules";

const labels: Record<PrWatchTopic, string> = {
  reviews: "Reviews from other people",
  requests: "Review requests",
  status: "PR status and approval",
  checks: "CI status",
};

const noRepairs = { conflicts: false, ci: false, reviews: false, draftWhileRepairing: false, readyAfterPush: false };
const sameModel = (a: PrRepairModel, b: PrRepairModel) => a.provider === b.provider && a.model === b.model;

export function PrSubscriptionDialog({ number, owned, watching, models = [], currentModel, onSaved, onClose, ...rules }: RulesProps & {
  number: number;
  owned: boolean;
  watching: boolean;
  models?: readonly ReviewLaunchModel[] | undefined;
  currentModel?: PrRepairModel | undefined;
  onSaved: (numbers: number[]) => void;
  onClose: () => void;
}) {
  const { snapshot, request, refresh, error, saving } = useReviewRules(rules, number);
  const saved = snapshot?.subscriptions?.find(item => item.number === number);
  const [draft, setDraft] = useState<PrWatchTopic[] | null>(null);
  const topics = draft ?? saved?.topics ?? PR_WATCH_TOPICS;
  const [draftRebase, setDraftRebase] = useState<boolean | null>(null);
  const rebase = owned && (draftRebase ?? saved?.rebase ?? false);
  const [draftRepair, setDraftRepair] = useState<Omit<PrRepairSettings, "model"> | null>(null);
  const [pickedModel, setPickedModel] = useState<PrRepairModel>();
  const [pickModel, setPickModel] = useState(false);
  const repair = draftRepair ?? saved?.repair ?? noRepairs;
  const model = pickedModel ?? saved?.repair?.model ?? currentModel;
  const modelAvailable = !!model && models.some(candidate => sameModel(candidate, model));
  const repairEnabled = owned && (repair.conflicts || repair.ci || repair.reviews);
  const available = Array.isArray(snapshot?.subscriptions);

  async function save(selected: readonly PrWatchTopic[], autoRebase: boolean, settings?: PrRepairSettings) {
    if (await request({ kind: "subscription", number, topics: [...selected], rebase: autoRebase, ...(settings && { repair: settings }) })) {
      const other = snapshot!.subscriptions!.filter(item => item.number !== number).map(item => item.number);
      onSaved(selected.length || autoRebase || settings ? [...other, number] : other);
      onClose();
    }
  }

  return <Dialog title={`PR #${number} subscription`} icon="bell" width={500} onClose={saving ? null : onClose} footer={<>
    {saved && <button type="button" className="btn" disabled={saving} onClick={() => void save([], false)}>Unsubscribe</button>}
    <span className="grow" />
    <button type="button" className="btn" disabled={saving} onClick={onClose}>Cancel</button>
    <button type="button" className="btn btn-primary" disabled={!available || (!topics.length && !rebase && !repairEnabled) || (repairEnabled && !modelAvailable) || saving}
      onClick={() => void save(topics, rebase, repairEnabled && modelAvailable ? { ...repair, model: { provider: model!.provider, model: model!.model } } : undefined)}>
      {saved ? "Save" : "Subscribe"}
    </button>
  </>}>
    <div className="review-watcher">
      {error && <p role="alert" className="watcher-notice">{error} <button type="button" className="link-btn" onClick={refresh}>Retry</button></p>}
      {!snapshot && !error ? <Spinner label="Loading subscription" /> : null}
      {snapshot && !available && <p role="alert">The selected Keryx CLI does not support PR subscriptions yet.</p>}
      {available && <>
        {!watching && <p className="watcher-notice">Turn on PR watcher for this repository to collect activity.</p>}
        <fieldset className="field pr-subscription-topics" disabled={saving}>
          <legend className="field-label">Watch for</legend>
          {PR_WATCH_TOPICS.map(topic => <label key={topic}>
            <input type="checkbox" checked={topics.includes(topic)} onChange={event => {
              setDraft(event.currentTarget.checked ? [...topics, topic] : topics.filter(item => item !== topic));
            }} />
            {labels[topic]}
          </label>)}
        </fieldset>
        {owned && <fieldset className="field pr-subscription-topics" disabled={saving}>
          <legend className="field-label">Automatic branch maintenance</legend>
          <label><input type="checkbox" checked={rebase} onChange={event => setDraftRebase(event.currentTarget.checked)} /> Rebase when behind the base branch</label>
          <label><input type="checkbox" checked={repair.conflicts}
            onChange={event => setDraftRepair({ ...repair, conflicts: event.currentTarget.checked })} /> Resolve merge conflicts and push</label>
          <label><input type="checkbox" checked={repair.ci}
            onChange={event => setDraftRepair({ ...repair, ci: event.currentTarget.checked })} /> Fix failed GitHub Actions checks and push</label>
          <label><input type="checkbox" checked={repair.reviews}
            onChange={event => setDraftRepair({ ...repair, reviews: event.currentTarget.checked })} /> Fix review feedback, push, and reply in English</label>
          {repairEnabled && <>
            <label><input type="checkbox" checked={repair.draftWhileRepairing} onChange={event => {
              const checked = event.currentTarget.checked;
              setDraftRepair({ ...repair, draftWhileRepairing: checked, readyAfterPush: checked && repair.readyAfterPush });
            }} /> Convert to draft while repairing</label>
            <label><input type="checkbox" checked={repair.readyAfterPush && repair.draftWhileRepairing}
              disabled={!repair.draftWhileRepairing}
              onChange={event => setDraftRepair({ ...repair, readyAfterPush: event.currentTarget.checked })} />
              Return to Ready for review after a successful push</label>
            <div className="rule-heading">
              <span>{model ? `${model.provider} · ${model.model}` : "Choose a repair model"}</span>
              <button className="btn btn-sm" type="button" aria-expanded={pickModel} disabled={!models.length}
                onClick={() => setPickModel(value => !value)}>Choose model</button>
            </div>
            {pickModel && <ModelPicker tier="Repair" choices={[...models]} onClose={() => setPickModel(false)}
              onSelect={choice => { setPickedModel(choice); setPickModel(false); }} />}
            {!modelAvailable && <p className="watcher-notice">Select an available model to enable repairs.</p>}
            <p className="field-hint">Repairs run in a separate checkout and can push changes to this PR’s source branch.</p>
          </>}
        </fieldset>}
        {saved && <section className="watcher-history">
          <h3>Subscription activity</h3>
          {saved.activity?.length ? <ol>{saved.activity.map((event, index) => <li key={`${event.at}-${index}`}>
            {event.description}<time dateTime={event.at}>{absoluteTime(event.at)}</time>
          </li>)}</ol> : <p>No matching changes recorded yet.</p>}
        </section>}
      </>}
    </div>
  </Dialog>;
}
