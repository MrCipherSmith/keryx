import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PublicationAnswer, PublicationRequest, PublicationSettings, PublicationState } from "../../../../src/review/desk-publication-types";
import type { DeskRunKey } from "../../../../src/review/desk-run-types";
import { renderMarkdown } from "../components/Markdown";
import { Dialog, Spinner } from "../components/ui";
import { absoluteTime, errMessage } from "../lib/format";
import { invoke } from "../platform/backend";
import { openExternal } from "../platform/commands";

export function reviewPublish(cwd: string, target: DeskRunKey, request: PublicationRequest) {
  return invoke<PublicationState>("review_publish", { cwd, target, request });
}

const verdicts: ReadonlyArray<{ value: PublicationSettings["verdict"]; label: string }> = [
  { value: "approve", label: "Approve" },
  { value: "suggestions", label: "Approve with suggestions" },
  { value: "changes", label: "Request changes" },
  { value: "comment", label: "Comment only" },
];

const unsupportedCli = "The selected Keryx CLI does not support review publishing. Update it or select Bundled in Settings → Desktop.";

const findingActions = [
  { id: "uphold", label: "Keep finding" },
  { id: "dismiss", label: "Dismiss finding" },
] as const;

function choicesFor(question: PublicationState["questions"][number]): ReadonlyArray<{ id: PublicationAnswer; label: string }> {
  return question.options?.length ? question.options : findingActions;
}

function Preview({ text, label = "Review comment preview" }: { text: string; label?: string }) {
  const html = useMemo(() => {
    const fragment = document.createElement("template");
    fragment.innerHTML = renderMarkdown(text);
    // Keep the preview inert even when the app's Markdown renderer recognizes linked images.
    for (const element of fragment.content.querySelectorAll("script, img, source, video, audio, iframe, object, embed")) element.remove();
    for (const link of fragment.content.querySelectorAll("a")) link.removeAttribute("href");
    return fragment.innerHTML;
  }, [text]);
  return text.trim() ? <div className="md review-publish-markdown" tabIndex={0} aria-label={label}
    dangerouslySetInnerHTML={{ __html: html }} /> : <p>No general comment in this draft.</p>;
}

export function ReviewPublishDialog({ cwd, target, id, command = reviewPublish, onAccessLost, onClose }: {
  cwd: string;
  target: DeskRunKey;
  id: string;
  command?: typeof reviewPublish | undefined;
  onAccessLost?: ((message: string) => void) | undefined;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<PublicationState>();
  const [settings, setSettings] = useState<PublicationSettings>();
  const [pending, setPending] = useState<PublicationRequest["kind"] | null>("preview");
  const [previewStale, setPreviewStale] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [inlineOpen, setInlineOpen] = useState(false);
  const [error, setError] = useState("");
  const currentSettings = useRef<PublicationSettings>();
  const requestNumber = useRef(0);
  const activeRequest = useRef<PublicationRequest["kind"] | null>(null);
  const queuedPreview = useRef<Extract<PublicationRequest, { kind: "preview" }>>();
  const verdictName = useId();
  const answerName = useId();

  const send = useCallback(async (initialRequest: PublicationRequest) => {
    if (activeRequest.current) {
      if (activeRequest.current === "preview" && initialRequest.kind === "preview") queuedPreview.current = initialRequest;
      return;
    }
    const number = ++requestNumber.current;
    let request: PublicationRequest | undefined = initialRequest;
    try {
      while (request) {
        activeRequest.current = request.kind;
        setPending(request.kind);
        setError("");
        try {
          const result = await command(cwd, target, request);
          if (number !== requestNumber.current) return;
          if (result?.version !== 1) throw new Error(unsupportedCli);
          if (!queuedPreview.current) {
            currentSettings.current = result.settings;
            setDraft(result);
            setSettings(result.settings);
            setPreviewStale(false);
          }
        } catch (cause) {
          if (number !== requestNumber.current) return;
          const reason = errMessage(cause);
          if (/^access:/i.test(reason)) {
            queuedPreview.current = undefined;
            setPreviewStale(true);
            onAccessLost?.(reason);
          }
          if (!queuedPreview.current) {
            setError(/\bunknown review command:\s*desk-publish\b/i.test(reason) ? unsupportedCli : reason);
            if (/^(stale|unavailable):/i.test(reason)) setPreviewStale(true);
          }
        }
        request = queuedPreview.current;
        queuedPreview.current = undefined;
      }
    } finally {
      if (number === requestNumber.current) {
        activeRequest.current = null;
        setPending(null);
      }
    }
  }, [command, cwd, onAccessLost, target]);

  useEffect(() => {
    currentSettings.current = undefined;
    setDraft(undefined);
    setSettings(undefined);
    setQuestionIndex(0);
    setInlineOpen(false);
    setPreviewStale(true);
    void send({ kind: "preview", id, refresh: true });
    return () => {
      requestNumber.current++;
      activeRequest.current = null;
      queuedPreview.current = undefined;
    };
  }, [send, id]);

  function update(changes: Partial<PublicationSettings>) {
    const current = currentSettings.current;
    if (!current || (activeRequest.current && activeRequest.current !== "preview")) return;
    const options = { ...current, verdictOverride: current.verdictOverride ?? null, ...changes };
    currentSettings.current = options;
    setSettings(options);
    setPreviewStale(true);
    void send({ kind: "preview", id, settings: options });
  }

  function refreshPreview() {
    const latest = currentSettings.current;
    setPreviewStale(true);
    void send({ kind: "preview", id, refresh: true, ...(latest && { settings: latest }) });
  }

  const busy = pending !== null;
  const writing = pending === "save" || pending === "submit";
  const posted = Boolean(draft?.publishedUrl);
  const questions = draft?.questions ?? [];
  const question = questions[Math.min(questionIndex, questions.length - 1)];
  const unanswered = questions.filter(item => !choicesFor(item).some(choice => choice.id === settings?.answers[item.id])).length;
  const canUsePreview = !!draft && !!settings && !busy && !previewStale && !posted;

  return createPortal(<Dialog title="Publish to GitHub" width={780} focusRoot
    onClose={writing ? null : onClose} footer={
      <div className="review-publish-footer">
        <button type="button" className="btn" disabled={writing} onClick={onClose}>Close</button>
        {!posted && <>
          <button type="button" className="btn" disabled={!canUsePreview}
            onClick={() => { if (canUsePreview) void send({ kind: "save", id, settings }); }}>Save locally</button>
          <button type="button" className="btn btn-primary" disabled={!canUsePreview || !draft.canSubmit || unanswered > 0}
            onClick={() => { if (canUsePreview && draft.canSubmit && !unanswered) void send({ kind: "submit", id, settings, digest: draft.digest }); }}>Submit review</button>
        </>}
      </div>
    }>
    <div className="review-publish" aria-busy={writing}>
      <p className="review-detail-meta">{target.repo} #{target.number} · @{target.viewer}</p>
      {error && <div className="inline-banner tone-warn" role="alert">
        <span>{error}</span>
        {!draft && <button type="button" className="btn btn-sm" disabled={busy} onClick={refreshPreview}>Refresh preview</button>}
      </div>}
      {settings && draft && !posted && <>
        <div className="review-publish-settings">
          <fieldset disabled={writing}>
            <legend>Include in the review</legend>
            <label><input type="checkbox" checked={settings.general}
              onChange={e => update({ general: e.currentTarget.checked })} /> General comment</label>
            <label><input type="checkbox" checked={settings.inline}
              onChange={e => update({ inline: e.currentTarget.checked })} /> Inline comments</label>
            <label><input type="checkbox" checked={settings.keryxTemplate}
              onChange={e => update({ keryxTemplate: e.currentTarget.checked })} /> Keryx template</label>
            {draft.overlayAvailable && <label><input type="checkbox" checked={settings.overlay}
              onChange={e => update({ overlay: e.currentTarget.checked })} /> Project overlay</label>}
            {draft.overlayWarning && <small className="review-detail-muted" role="status">{draft.overlayWarning}</small>}
          </fieldset>
          <fieldset disabled={writing}>
            <legend>Review verdict</legend>
            <label><input type="radio" name={verdictName} value="recommended" checked={settings.verdictOverride == null}
              onChange={() => update({ verdictOverride: null })} />
              <span>Use recommendation{settings.verdictOverride == null && <>
                <br /><small>{verdicts.find(option => option.value === settings.verdict)?.label} recommended</small>
              </>}</span>
            </label>
            {verdicts.map(({ value, label }) => <label key={value}>
              <input type="radio" name={verdictName} value={value} checked={settings.verdictOverride === value}
                onChange={() => update({ verdict: value, verdictOverride: value })} /> {label}
            </label>)}
          </fieldset>
        </div>
        {question && <section className="review-publish-questions" aria-label="Finding questions">
          <div className="review-detail-meta" aria-live="polite">
            <strong>Question {Math.min(questionIndex + 1, questions.length)} of {questions.length}</strong>
            {!!unanswered && <span>{unanswered} unanswered</span>}
          </div>
          <fieldset disabled={writing}>
            <legend>{question.text}</legend>
            {!question.recommendation && <small className="review-detail-muted">The report has no recommendation.</small>}
            {choicesFor(question).map(choice => <label key={choice.id}>
              <input type="radio" name={answerName} value={choice.id} checked={settings.answers[question.id] === choice.id}
                onChange={() => update({ answers: { ...currentSettings.current?.answers, [question.id]: choice.id } })} />
              <span className="review-publish-choice">{choice.label}
                {choice.id === question.recommendation && <> <span className="badge">Recommended</span></>}
              </span>
            </label>)}
          </fieldset>
          <div className="review-publish-navigation">
            <button type="button" className="btn btn-sm" disabled={questionIndex === 0}
              onClick={() => setQuestionIndex(index => index - 1)}>Previous question</button>
            <button type="button" className="btn btn-sm" disabled={questionIndex >= questions.length - 1}
              onClick={() => setQuestionIndex(index => index + 1)}>Next question</button>
          </div>
        </section>}
      </>}
      {draft && <section className="review-publish-preview" aria-label="Draft preview" aria-busy={pending === "preview"}>
        <div className="review-detail-meta review-publish-preview-header">
          <strong>General comment preview</strong><span>{draft.inlineCount} inline comments</span>
          {!posted && <button type="button" className="btn btn-sm" disabled={busy} onClick={refreshPreview}>Refresh preview</button>}
        </div>
        <Preview text={draft.body} />
        {!!draft.inlineComments?.length && <details className="review-publish-inline"
          onToggle={event => setInlineOpen(event.currentTarget.open)}>
          <summary>Preview inline comments</summary>
          {inlineOpen && <ol>{draft.inlineComments.map((comment, index) => {
            const location = `${comment.path}:${comment.line}`;
            return <li key={`${location}:${index}`}>
              <code>{location}</code>
              <Preview text={comment.body} label={`Inline comment at ${location}`} />
            </li>;
          })}</ol>}
        </details>}
      </section>}
      {pending !== null && <p className="review-detail-meta"><Spinner />{
        pending === "preview" ? "Updating preview…" : pending === "save" ? "Saving draft locally…" : "Submitting review…"
      }</p>}
      {!busy && !error && !posted && draft?.blockedReason && <p className="review-detail-muted" role="status">{draft.blockedReason}</p>}
      {!posted && !previewStale && draft?.savedAt && <p className="review-detail-muted" role="status">Last saved locally · {absoluteTime(draft.savedAt)}</p>}
      {draft?.publishedUrl && <p className="review-detail-meta" role="status">
        Review published on GitHub.
        {draft.publishedUrl.startsWith(`https://github.com/${target.repo}/pull/${target.number}#pullrequestreview-`) &&
          <button type="button" className="link-btn"
            onClick={() => void openExternal(draft.publishedUrl!).catch(cause => setError(errMessage(cause)))}>Open published review</button>}
      </p>}
    </div>
  </Dialog>, document.body);
}
