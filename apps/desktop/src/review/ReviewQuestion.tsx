import { useState } from "react";
import type { DeskQuestion } from "../../../../src/review/desk-run-types";

export type AnswerReviewQuestion = (runId: string, questionId: string, answer: string) => void;

export function ReviewQuestion({ question, working, onAnswer, initialText = "", legend }: {
  initialText?: string; legend: string; question: DeskQuestion; working: boolean; onAnswer: (answer: string) => void;
}) {
  const [text, setText] = useState(initialText);
  const canReply = !!text.trim() && text.trim() !== initialText.trim();
  return <fieldset className="review-question" disabled={working}>
    <legend>{legend}</legend>
    <p>{question.question}</p>
    {question.options.map(option => <button key={option.id} type="button" className="btn review-answer-option"
      onClick={() => onAnswer(option.id)}>
      <span>{option.label}{option.recommended && " (recommended)"}</span>
      {option.description && <small>{option.description}</small>}
    </button>)}
    {question.allowFreeform && <form onSubmit={e => { e.preventDefault(); if (canReply) onAnswer(text.trim()); }}>
      <label>Your reply<textarea maxLength={2000} value={text} onChange={e => setText(e.target.value)} rows={2} /></label>
      <button type="submit" className="btn btn-primary btn-sm" disabled={!canReply}>Send reply</button>
    </form>}
  </fieldset>;
}
