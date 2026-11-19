import { useState } from "react";
import type { ReviewRule } from "../../../../src/review/review-rule-types";
import { Icon } from "../components/Icon";
import { Dialog, Spinner } from "../components/ui";
import { describeRule, RuleActivity, runLimits } from "./ReviewRuleInfo";
import { useReviewRules, type RulesProps } from "./useReviewRules";

function newRule(): ReviewRule {
  return { id: crypto.randomUUID(), name: "", enabled: true, event: "review_requested",
    author: "", assignee: "", reviewer: "", requireGreen: true, budgetMinutes: 30, budgetTokens: null };
}

function RuleEditor({ initial, saving, onCancel, onSave }: {
  initial: ReviewRule; saving: boolean; onCancel: () => void; onSave: (rule: ReviewRule) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const set = <K extends keyof ReviewRule>(key: K, value: ReviewRule[K]) => setDraft(old => ({ ...old, [key]: value }));
  const submit = () => onSave({ ...draft, name: draft.name.trim(), author: draft.author.trim(), assignee: draft.assignee.trim(), reviewer: draft.reviewer.trim() });
  return <form className="review-rule-editor" onSubmit={e => { e.preventDefault(); if (draft.name.trim()) submit(); }}>
    <fieldset disabled={saving}>
      <label>Rule name<input className="input" required maxLength={100} value={draft.name} onChange={e => set("name", e.target.value)} /></label>
      <label>Trigger<select className="select-compact" value={draft.event} onChange={e => set("event", e.target.value as ReviewRule["event"])}>
        <option value="review_requested">Review requested or re-requested</option><option value="push">New head commit</option>
      </select></label>
      <div className="rule-field-grid">
        <label>PR author<input className="input" maxLength={180} placeholder="Any author" value={draft.author} onChange={e => set("author", e.target.value)} /></label>
        <label>PR assignee<input className="input" maxLength={180} placeholder="Any assignee" value={draft.assignee} onChange={e => set("assignee", e.target.value)} /></label>
      </div>
      <label>Requested reviewer<input className="input" maxLength={180} placeholder="Any user or team (org/team)" value={draft.reviewer} onChange={e => set("reviewer", e.target.value)} /></label>
      <label className="rule-check"><input type="checkbox" checked={draft.requireGreen} onChange={e => set("requireGreen", e.target.checked)} />Wait for passing CI</label>
      <div className="rule-field-grid">
        <label>Time limit (minutes)<input className="input" type="number" required min={1} max={30} value={draft.budgetMinutes || ""} onChange={e => set("budgetMinutes", Number(e.target.value))} /></label>
        <label>Token limit (optional)<input className="input" type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1}
          placeholder="No token limit" value={draft.budgetTokens ?? ""}
          onChange={e => set("budgetTokens", e.target.value === "" ? null : Number(e.target.value))} /></label>
      </div>
      <p className="rule-preview" aria-label="Rule preview">{describeRule(draft)}</p>
      <label className="rule-check"><input type="checkbox" checked={draft.enabled} onChange={e => set("enabled", e.target.checked)} />Enable this rule</label>
      <div className="rule-actions"><button type="submit" className="btn btn-primary" disabled={!draft.name.trim()}>Save rule</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button></div>
    </fieldset>
  </form>;
}

function RulesDialog({ onClose, ...props }: RulesProps & { onClose: () => void }) {
  const { request, refresh, snapshot, error, saving } = useReviewRules(props);
  const [editor, setEditor] = useState<ReviewRule | null>(null);
  const [confirmDelete, setConfirmDelete] = useState("");
  return <Dialog title="Review rules" icon="checklist" width={580} onClose={onClose} focusRoot
    footer={<button className="btn" onClick={onClose}>Close</button>}>
    <div className="project-review-rules">
      <p><strong>{props.target.repo}</strong> · {props.target.viewer}</p>
      <p className="review-detail-muted">Enabled rules use the PR watcher’s schedule. Turn on the watcher to run reviews in the background.</p>
      {error && <p className="inline-banner tone-warn" role="alert">{error} <button className="btn btn-sm" disabled={saving} onClick={refresh}>Refresh rules</button></p>}
      {!snapshot && !error && <Spinner label="Loading rules" />}
      {snapshot && (editor ? <RuleEditor key={editor.id} initial={editor} saving={saving} onCancel={() => setEditor(null)}
        onSave={async rule => { if (await request({ kind: "save", rule })) setEditor(null); }} /> : <>
        <div className="rule-heading"><h3>Project rules</h3><button className="btn btn-primary btn-sm" onClick={() => setEditor(newRule())}>New rule</button></div>
        {!snapshot.rules.length && <p className="review-detail-muted">No automatic review rules yet.</p>}
        {snapshot.rules.map(rule => <article key={rule.id} className="rule-entry" aria-label={rule.name}>
          <div className="rule-heading"><strong>{rule.name}</strong><span className="badge">{rule.enabled ? "Enabled" : "Disabled"}</span></div>
          <p>{describeRule(rule)}</p>
          <small>{runLimits(rule.budgetMinutes, rule.budgetTokens)}</small>
          {confirmDelete === rule.id ? <div className="rule-actions">
            <span>Delete this rule?</span>
            <button className="btn btn-sm" disabled={saving} onClick={async () => {
              if (await request({ kind: "delete", id: rule.id })) setConfirmDelete("");
            }}>Confirm delete</button><button className="btn btn-sm" disabled={saving} onClick={() => setConfirmDelete("")}>Keep rule</button>
          </div> : <div className="rule-actions">
            <button className="btn btn-sm" disabled={saving} onClick={() => setEditor(rule)}>Edit</button>
            <button className="btn btn-sm" disabled={saving} onClick={() => void request({ kind: "save", rule: { ...rule, enabled: !rule.enabled } })}>{rule.enabled ? "Disable" : "Enable"}</button>
            <button className="link-btn" disabled={saving} onClick={() => setConfirmDelete(rule.id)}>Delete</button>
          </div>}
        </article>)}
        <RuleActivity events={snapshot.activity} showNumber />
      </>)}
    </div>
  </Dialog>;
}

export function ProjectReviewRules(props: RulesProps) {
  const [open, setOpen] = useState(false);
  return <><button className="btn btn-sm" onClick={() => setOpen(true)} aria-haspopup="dialog"><Icon name="checklist" size={14} /> Review rules</button>
    {open && <RulesDialog {...props} onClose={() => setOpen(false)} />}</>;
}
