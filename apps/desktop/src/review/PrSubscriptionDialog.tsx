import { useState } from "react";
import { PR_WATCH_TOPICS, type PrWatchTopic } from "../../../../src/review/watcher-types";
import { Dialog, Spinner } from "../components/ui";
import { absoluteTime } from "../lib/format";
import { useReviewRules, type RulesProps } from "./useReviewRules";

const labels: Record<PrWatchTopic, string> = {
  reviews: "Reviews from other people",
  requests: "Review requests",
  status: "PR status and approval",
  checks: "CI status",
};

export function PrSubscriptionDialog({ number, owned, watching, onSaved, onClose, ...rules }: RulesProps & {
  number: number;
  owned: boolean;
  watching: boolean;
  onSaved: (numbers: number[]) => void;
  onClose: () => void;
}) {
  const { snapshot, request, refresh, error, saving } = useReviewRules(rules, number);
  const saved = snapshot?.subscriptions?.find(item => item.number === number);
  const [draft, setDraft] = useState<PrWatchTopic[] | null>(null);
  const topics = draft ?? saved?.topics ?? PR_WATCH_TOPICS;
  const [draftRebase, setDraftRebase] = useState<boolean | null>(null);
  const rebase = owned && (draftRebase ?? saved?.rebase ?? false);
  const available = Array.isArray(snapshot?.subscriptions);

  async function save(selected: readonly PrWatchTopic[], autoRebase: boolean) {
    if (await request({ kind: "subscription", number, topics: [...selected], rebase: autoRebase })) {
      const other = snapshot!.subscriptions!.filter(item => item.number !== number).map(item => item.number);
      onSaved(selected.length || autoRebase ? [...other, number] : other);
      onClose();
    }
  }

  return <Dialog title={`PR #${number} subscription`} icon="bell" width={500} onClose={saving ? null : onClose} footer={<>
    {saved && <button type="button" className="btn" disabled={saving} onClick={() => void save([], false)}>Unsubscribe</button>}
    <span className="grow" />
    <button type="button" className="btn" disabled={saving} onClick={onClose}>Cancel</button>
    <button type="button" className="btn btn-primary" disabled={!available || (!topics.length && !rebase) || saving} onClick={() => void save(topics, rebase)}>
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
          <p className="field-hint">GitHub updates the PR branch when it can rebase cleanly. Conflicts appear in subscription activity.</p>
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
