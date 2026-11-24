import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PublicationAnswer, PublicationRequest, PublicationSettings, PublicationState } from "../../../../src/review/desk-publication-types";
import type { DeskRunKey } from "../../../../src/review/desk-run-types";
import { Dialog, Spinner } from "../components/ui";
import { absoluteTime, errMessage } from "../lib/format";
import { invoke, isTauri } from "../platform/backend";
import { openExternal } from "../platform/commands";
import { ReviewReportMarkdown } from "./ReviewReportMarkdown";

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
  return text.trim() ? <ReviewReportMarkdown text={text} label={label} className="review-publish-markdown" /> : <p>No general comment in this draft.</p>;
}

const shortSha = (sha: string) => sha.slice(0, 7);

export function ReviewPublishDialog({ cwd, target, id, command = reviewPublish, onAccessLost, onDecision, onUpdateReview, updateDisabled = false, onClose }: {
  cwd: string;
  target: DeskRunKey;
  id: string;
  command?: typeof reviewPublish | undefined;
  onAccessLost?: ((message: string) => void) | undefined;
  onDecision?: (() => void) | undefined;
  /** Starts an update round on the current head it is given; offered only while the head has moved. */
  onUpdateReview?: ((currentHead: string) => void) | undefined;
  /** The update round cannot start now, because another action of the same review is in flight. */
  updateDisabled?: boolean | undefined;
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
  const decision = useRef(onDecision);
  decision.current = onDecision;
  const verdictName = useId();
  const answerName = useId();
  const headMovedNotice = useId();
  const updateReasonId = useId();

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
          if (request.kind === "skip" || request.kind === "submit") decision.current?.();
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
  const writing = pending !== null && pending !== "preview";
  const posted = Boolean(draft?.publishedUrl);
  const questions = draft?.questions ?? [];
  const question = questions[Math.min(questionIndex, questions.length - 1)];
  const unanswered = questions.filter(item => !choicesFor(item).some(choice => choice.id === settings?.answers[item.id])).length;
  const canUsePreview = !!draft && !!settings && !busy && !previewStale && !posted;
  const headMoved = draft?.headMoved;
  // The update round is the primary action while it is offered; publishing as is becomes the alternative.
  const updateOffered = !!headMoved && !!onUpdateReview && !posted;
  // The current head comes from the latest preview: a preview in flight or out of date may name an intermediate head.
  const updateReason = updateDisabled ? "Another action of this review is still running. Update review is available when it finishes."
    : busy ? "The preview is updating." : previewStale ? "Refresh the preview to update this review." : undefined;
  const publishButton = <button type="button" className={updateOffered ? "btn" : "btn btn-primary"}
    disabled={!canUsePreview || !draft.canSubmit || unanswered > 0}
    onClick={() => { if (canUsePreview && draft.canSubmit && !unanswered) void send({ kind: "submit", id, settings, digest: draft.digest }); }}>
    {headMoved ? <>Publish as is for <code>{shortSha(headMoved.reviewedHead)}</code></> : "Submit review"}</button>;

  return createPortal(<Dialog title="Publish to GitHub" width={780} focusRoot
    onClose={writing ? null : onClose} footer={
      <div className="review-publish-footer">
        {/* The two head-moved alternatives stay next to each other, so a wrapping footer keeps them on one row. */}
        {updateOffered && headMoved && onUpdateReview && <>
          <button type="button" className="btn btn-primary" disabled={!!updateReason} title={updateReason}
            aria-describedby={updateReason && !busy ? updateReasonId : undefined}
            onClick={() => { if (!updateReason) onUpdateReview(headMoved.currentHead); }}>Update review to <code>{shortSha(headMoved.currentHead)}</code></button>
          {publishButton}
        </>}
        <button type="button" className="btn" disabled={writing} onClick={onClose}>Close</button>
        {!posted && <>
          {!draft?.skipped && <button type="button" className="btn" disabled={busy || !draft}
            onClick={() => void send({ kind: "skip", id })}>Skip publication</button>}
          <button type="button" className="btn" disabled={!canUsePreview}
            onClick={() => { if (canUsePreview) void send({ kind: "save", id, settings }); }}>Save locally</button>
          {!updateOffered && publishButton}
        </>}
      </div>
    }>
    <div className="review-publish" aria-busy={writing}>
      <p className="review-detail-meta">{target.repo} #{target.number} · @{target.viewer}</p>
      {draft?.skipped && <p className="review-detail-muted" role="status">Publication skipped. This review is saved locally.</p>}
      {error && <div className="inline-banner tone-warn" role="alert">
        <span>{error}</span>
        {!draft && <button type="button" className="btn btn-sm" disabled={busy} onClick={refreshPreview}>Refresh preview</button>}
      </div>}
      {settings && draft && !posted && <>
        {headMoved && <div id={headMovedNotice} className="inline-banner tone-warn review-publish-head-moved" role="status"><span>
          Reviewed commit <code title={headMoved.reviewedHead}>{shortSha(headMoved.reviewedHead)}</code>. The pull request has moved
          to <code title={headMoved.currentHead}>{shortSha(headMoved.currentHead)}</code> since. Publishing as is posts a Comment
          for the reviewed commit only. The verdict is Comment only, and inline comments are off because they cannot be
          placed on an earlier commit.
        </span></div>}
        {/* While the preview updates, its progress line below already says so. */}
        {updateOffered && updateReason && !busy && <p id={updateReasonId} className="review-detail-muted">{updateReason}</p>}
        <div className="review-publish-settings">
          <fieldset disabled={writing} aria-describedby={headMoved ? headMovedNotice : undefined}>
            <legend>Include in the review</legend>
            <label><input type="checkbox" checked={settings.general}
              onChange={e => update({ general: e.currentTarget.checked })} /> General comment</label>
            <label><input type="checkbox" checked={settings.inline} disabled={!!headMoved}
              onChange={e => update({ inline: e.currentTarget.checked })} /> Inline comments</label>
            <small className="review-detail-muted">English · Keryx template{draft.overlayAvailable ? " + project overlay" : ""}</small>
            {draft.overlayRequiresApproval && <small className="review-detail-muted">This project requires confirmation of the finished report.</small>}
            {draft.overlayWarning && <small className="review-detail-muted" role="status">{draft.overlayWarning}</small>}
          </fieldset>
          <fieldset disabled={writing} aria-describedby={headMoved ? headMovedNotice : undefined}>
            <legend>Review verdict</legend>
            <label><input type="radio" name={verdictName} value="recommended" checked={settings.verdictOverride == null} disabled={!!headMoved}
              onChange={() => update({ verdictOverride: null })} />
              <span>Use recommendation{settings.verdictOverride == null && <>
                <br /><small>{verdicts.find(option => option.value === settings.verdict)?.label} recommended</small>
              </>}</span>
            </label>
            {verdicts.map(({ value, label }) => <label key={value}>
              <input type="radio" name={verdictName} value={value} checked={settings.verdictOverride === value} disabled={!!headMoved}
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
        {!!draft.inlineComments?.length && <details className="review-publish-inline" open={inlineOpen}
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
        pending === "preview" ? "Updating preview…" : pending === "save" ? "Saving draft locally…"
          : pending === "skip" ? "Saving your decision…"
          : import.meta.env?.DEV && !isTauri() ? "Confirm publication in the dev server terminal." : "Submitting review…"
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
