import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PublicationRequest, PublicationSettings, PublicationState } from "../../../../src/review/desk-publication-types";
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

function Preview({ text }: { text: string }) {
  const html = useMemo(() => {
    const fragment = document.createElement("template");
    fragment.innerHTML = renderMarkdown(text);
    // Keep the preview inert even when the app's Markdown renderer recognizes linked images.
    for (const element of fragment.content.querySelectorAll("script, img, source, video, audio, iframe, object, embed")) element.remove();
    for (const link of fragment.content.querySelectorAll("a")) link.removeAttribute("href");
    return fragment.innerHTML;
  }, [text]);
  return text.trim() ? <div className="md review-publish-markdown" tabIndex={0} aria-label="Review comment preview"
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
  const [error, setError] = useState("");
  const requestNumber = useRef(0);
  const activeRequest = useRef(false);
  const verdictName = useId();
  const answerName = useId();

  const send = useCallback(async (request: PublicationRequest) => {
    if (activeRequest.current) return;
    activeRequest.current = true;
    const number = ++requestNumber.current;
    setPending(request.kind);
    setError("");
    try {
      const result = await command(cwd, target, request);
      if (number !== requestNumber.current) return;
      if (result?.version !== 1) throw new Error("This Keryx CLI does not support review publishing. Check the CLI version in Settings.");
      setDraft(result);
      setSettings(result.settings);
      setPreviewStale(false);
    } catch (cause) {
      if (number !== requestNumber.current) return;
      const message = errMessage(cause);
      setError(message);
      if (/^(stale|unavailable):/i.test(message)) setPreviewStale(true);
      if (/^access:/i.test(message)) onAccessLost?.(message);
    } finally {
      if (number === requestNumber.current) {
        activeRequest.current = false;
        setPending(null);
      }
    }
  }, [command, cwd, onAccessLost, target]);

  useEffect(() => {
    void send({ kind: "preview", id });
    return () => {
      requestNumber.current++;
      activeRequest.current = false;
    };
  }, [send, id]);

  function update(options: PublicationSettings) {
    if (activeRequest.current) return;
    setSettings(options);
    setPreviewStale(true);
    void send({ kind: "preview", id, settings: options });
  }

  const busy = pending !== null;
  const posted = Boolean(draft?.publishedUrl);
  const questions = draft?.questions ?? [];
  const question = questions[Math.min(questionIndex, questions.length - 1)];
  const unanswered = questions.filter(({ id }) => {
    const answer = settings?.answers[id];
    return answer !== "uphold" && answer !== "dismiss";
  }).length;
  const canUsePreview = !!draft && !!settings && !busy && !previewStale && !posted;

  return createPortal(<Dialog title="Publish to GitHub" width={780} focusRoot
    onClose={busy && pending !== "preview" ? null : onClose} footer={
      <div className="review-publish-footer">
        <button type="button" className="btn" disabled={busy && pending !== "preview"} onClick={onClose}>Close</button>
        {!posted && <>
          <button type="button" className="btn" disabled={!canUsePreview}
            onClick={() => { if (canUsePreview) void send({ kind: "save", id, settings }); }}>Save locally</button>
          <button type="button" className="btn btn-primary" disabled={!canUsePreview || !draft.canSubmit || unanswered > 0}
            onClick={() => { if (canUsePreview && draft.canSubmit && !unanswered) void send({ kind: "submit", id, settings, digest: draft.digest }); }}>Submit review</button>
        </>}
      </div>
    }>
    <div className="review-publish" aria-busy={busy}>
      <p className="review-detail-meta">{target.repo} #{target.number} · @{target.viewer}</p>
      {error && <div className="inline-banner tone-warn" role="alert">
        <span>{error}</span>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void send({ kind: "preview", id, ...(settings && { settings }) })}>Refresh preview</button>
      </div>}
      {settings && draft && !posted && <>
        <div className="review-publish-settings">
          <fieldset disabled={busy}>
            <legend>Include in the review</legend>
            <label><input type="checkbox" checked={settings.general}
              onChange={e => update({ ...settings, general: e.currentTarget.checked })} /> General comment</label>
            <label><input type="checkbox" checked={settings.inline}
              onChange={e => update({ ...settings, inline: e.currentTarget.checked })} /> Inline comments</label>
            <label><input type="checkbox" checked={settings.keryxTemplate}
              onChange={e => update({ ...settings, keryxTemplate: e.currentTarget.checked })} /> Keryx template</label>
            {draft.overlayAvailable && <label><input type="checkbox" checked={settings.overlay}
              onChange={e => update({ ...settings, overlay: e.currentTarget.checked })} /> Project overlay</label>}
          </fieldset>
          <fieldset disabled={busy}>
            <legend>Review verdict</legend>
            {verdicts.map(({ value, label }) => <label key={value}>
              <input type="radio" name={verdictName} value={value} checked={settings.verdict === value}
                onChange={() => update({ ...settings, verdict: value })} /> {label}
            </label>)}
          </fieldset>
        </div>
        {question && <section className="review-publish-questions" aria-label="Finding questions">
          <div className="review-detail-meta" aria-live="polite">
            <strong>Question {Math.min(questionIndex + 1, questions.length)} of {questions.length}</strong>
            {!!unanswered && <span>{unanswered} unanswered</span>}
          </div>
          <fieldset disabled={busy}>
            <legend>{question.text}</legend>
            {!!question.options?.length && <ul className="review-publish-question-options">
              {question.options.map((option, index) => <li key={index}>{option}</li>)}
            </ul>}
            {(["uphold", "dismiss"] as const).map(answer => <label key={answer}>
              <input type="radio" name={answerName} checked={settings.answers[question.id] === answer}
                onChange={() => update({ ...settings, answers: { ...settings.answers, [question.id]: answer } })} />
              {answer === "uphold" ? "Keep finding" : "Dismiss finding"}
              {answer === question.recommendation && <span className="badge">Recommended</span>}
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
      {draft && <section className="review-publish-preview" aria-label="Draft preview">
        <div className="review-detail-meta"><strong>General comment preview</strong><span>{draft.inlineCount} inline comments</span></div>
        <Preview text={draft.body} />
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
