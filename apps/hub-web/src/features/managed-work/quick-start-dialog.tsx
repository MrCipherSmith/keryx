import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, Input, Notice, Textarea } from "../../components/ui";
import { QUICK_MODES, questionsFor, type QuickModeId } from "./quick-contract";
import "./quick-start.css";

export type QuickDraft = {
  mode: QuickModeId;
  description: string;
  answers: Record<string, string>;
  skipped: Record<string, boolean>;
  criteria: string;
};
export const emptyQuickDraft: QuickDraft = {
  mode: "task",
  description: "",
  answers: {},
  skipped: {},
  criteria: "",
};
export type QuickPhase =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "rejected"; message: string }
  | { status: "unknown"; message: string };

const TABBABLE =
  "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])";

/** Controls reachable with Tab: an unchecked radio is skipped because its group is entered at the checked one. */
function tabbable(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) => !(el instanceof HTMLInputElement && el.type === "radio" && !el.checked),
  );
}

export function QuickStartDialog({
  draft,
  phase,
  canSubmit,
  onChange,
  onSubmit,
  onRetry,
  onStartOver,
  onClose,
}: {
  draft: QuickDraft;
  phase: QuickPhase;
  canSubmit: boolean;
  onChange: (next: QuickDraft) => void;
  onSubmit: () => void;
  onRetry: () => void;
  onStartOver: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("work");
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const questions = questionsFor(draft.mode);
  const mode = QUICK_MODES.find((candidate) => candidate.id === draft.mode)!;
  const locked = phase.status === "sending" || phase.status === "unknown";

  useEffect(() => {
    const previous = document.activeElement;
    root.current?.querySelector<HTMLInputElement>('input[name="quick-mode"]:checked')?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !root.current) return;
    const controls = tabbable(root.current);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (!root.current.contains(active) || (event.shiftKey && active === first)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const skipAll = () =>
    onChange({
      ...draft,
      skipped: { ...draft.skipped, ...Object.fromEntries(questions.map((q) => [q.id, true])) },
    });

  return (
    <div className="quick-start-backdrop">
      <div
        ref={root}
        className="quick-start-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={phase.status === "sending"}
        onKeyDown={onKeyDown}
      >
        <form
          className="quick-start-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) onSubmit();
          }}
        >
          <h2 id={titleId}>{t("quickStart.title")}</h2>
          <p>{t("quickStart.help")}</p>
          <fieldset className="quick-start-group" disabled={locked}>
            <legend>{t("quickStart.mode")}</legend>
            <div className="quick-start-modes">
              {QUICK_MODES.map((candidate) => (
                <label key={candidate.id} className="quick-start-mode">
                  <input
                    type="radio"
                    name="quick-mode"
                    value={candidate.id}
                    checked={draft.mode === candidate.id}
                    onChange={() => onChange({ ...draft, mode: candidate.id })}
                  />
                  {t("quickStart.modes." + candidate.id)}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="quick-start-group" disabled={locked}>
            <Field label={t("quickStart.description")} hint={t("quickStart.descriptionHint")}>
              <Input
                maxLength={500}
                value={draft.description}
                onChange={(event) => onChange({ ...draft, description: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  if (canSubmit) onSubmit();
                }}
              />
            </Field>
          </fieldset>
          <fieldset className="quick-start-group" disabled={locked}>
            <legend>{t("quickStart.questionsTitle")}</legend>
            <Button variant="ghost" onClick={skipAll}>
              {t("quickStart.skipAll")}
            </Button>
            {questions.map((question) => {
              const label = t("quickStart.questions." + question.id, { defaultValue: question.text });
              const skipped = draft.skipped[question.id] === true;
              return (
                <div key={question.id} className="quick-start-question">
                  <Field label={label}>
                    <Textarea
                      className="quick-start-answer"
                      maxLength={4000}
                      disabled={skipped}
                      value={draft.answers[question.id] ?? ""}
                      onChange={(event) =>
                        onChange({
                          ...draft,
                          answers: { ...draft.answers, [question.id]: event.target.value },
                        })
                      }
                    />
                  </Field>
                  <label className="work-checkbox">
                    <input
                      type="checkbox"
                      aria-label={t("quickStart.skipQuestion", { question: label })}
                      checked={skipped}
                      onChange={(event) =>
                        onChange({
                          ...draft,
                          skipped: { ...draft.skipped, [question.id]: event.target.checked },
                        })
                      }
                    />{" "}
                    {t("quickStart.skip")}
                  </label>
                </div>
              );
            })}
          </fieldset>
          <fieldset className="quick-start-group" disabled={locked}>
            <legend>{t("quickStart.templateCriteria")}</legend>
            <ul className="quick-start-template">
              {mode.criteriaTemplate.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
            <Field label={t("quickStart.criteria")}>
              <Textarea
                maxLength={8000}
                value={draft.criteria}
                onChange={(event) => onChange({ ...draft, criteria: event.target.value })}
              />
            </Field>
          </fieldset>
          {phase.status === "sending" && (
            <p role="status" className="quick-start-status">
              {t("quickStart.sending")}
            </p>
          )}
          {phase.status === "rejected" && <Notice tone="error">{phase.message}</Notice>}
          {phase.status === "unknown" && (
            <Notice tone="error">
              {phase.message}
              <p>{t("quickStart.unknown")}</p>
              <span className="quick-start-recovery">
                <Button variant="secondary" onClick={onRetry}>
                  {t("quickStart.retry")}
                </Button>
                <Button variant="ghost" onClick={onStartOver}>
                  {t("quickStart.startOver")}
                </Button>
              </span>
            </Notice>
          )}
          <div className="quick-start-actions">
            <Button variant="secondary" onClick={onClose}>
              {t("quickStart.cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit || locked}>
              {t("quickStart.submit")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
