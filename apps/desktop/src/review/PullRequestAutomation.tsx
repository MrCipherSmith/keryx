import { useState } from "react";
import type { ReviewPrMode } from "../../../../src/review/review-rule-types";
import { Spinner } from "../components/ui";
import { describeRule, RuleActivity } from "./ReviewRuleInfo";
import { type RulesProps, useReviewRules } from "./useReviewRules";

export function PullRequestAutomation({ number, open, ...props }: RulesProps & { number: number; open: boolean }) {
  const { snapshot, error, saving, request, refresh } = useReviewRules(props, number);
  const [draft, setDraft] = useState<string | null>(null);
  const saved = snapshot?.choice.mode === "auto" ? "auto/" + snapshot.choice.ruleId : snapshot?.choice.mode;
  const selected = draft ?? saved ?? "project";
  const selectedRule = snapshot?.rules.find(rule => "auto/" + rule.id === selected);
  const available = selected === "manual" || selected === "project" || !!selectedRule?.enabled;
  async function apply() {
    if (!available) return;
    const choice: ReviewPrMode = selected === "manual" || selected === "project" ? { mode: selected } : { mode: "auto", ruleId: selected.slice(5) };
    if (await request({ kind: "mode", number, choice })) setDraft(null);
  }
  return <section className="pr-automation" aria-label="Pull request automation">
    <div className="rule-heading"><h3>Review automation</h3><button className="btn btn-sm" disabled={saving} onClick={refresh}>Refresh activity</button></div>
    {error && <p className="inline-banner tone-warn" role="alert">{error}</p>}
    {!snapshot && !error && <Spinner label="Loading automation settings" />}
    {snapshot && <>
      <label>Review mode<select className="select-compact" value={selected} disabled={saving || !open} onChange={e => setDraft(e.target.value)}>
        <option value="project">Use project rules</option>
        <optgroup label="Auto for this PR">
          {snapshot.rules.filter(rule => rule.enabled).map(rule => <option key={rule.id} value={"auto/" + rule.id}>Auto · {rule.name}</option>)}
          {!available && <option value={selected} disabled>Auto · {selectedRule?.name ?? "Deleted rule"} (unavailable)</option>}
          {!snapshot.rules.some(rule => rule.enabled) && available && <option value="no-rules" disabled>No enabled rules</option>}
        </optgroup>
        <option value="manual">Manual only</option>
      </select></label>
      <p className="review-detail-muted">{selected === "manual" ? "Start a review from this card whenever you need one."
        : selected === "project" ? "The watcher applies all matching project rules to this PR."
        : selectedRule?.enabled ? describeRule(selectedRule)
        : "The selected rule is unavailable. Choose another rule to resume automatic reviews."}</p>
      {open && draft !== null && selected !== saved && <div className="rule-actions">
        <button className="btn btn-primary" disabled={saving || !available} onClick={() => void apply()}>Save mode</button>
        <button className="btn" disabled={saving} onClick={() => setDraft(null)}>Cancel</button>
      </div>}
      <RuleActivity events={snapshot.activity.filter(event => event.number === number)} />
    </>}
  </section>;
}
