import { getMode, type QuickModeId } from './quick-modes';

/** A clarifying question offered while starting work; ids are stable and are what answers are keyed by. */
export interface ClarifyQuestion {
    readonly id: string;
    readonly text: string;
}

/** One recorded answer: `a` is null exactly when the question was skipped. */
export interface ClarifyAnswer {
    readonly q: string;
    readonly a: string | null;
    readonly skipped: boolean;
}

const QUESTIONS: Readonly<Record<QuickModeId, readonly ClarifyQuestion[]>> = {
    quick: [
        { id: 'what-to-change', text: 'What exactly should change?' },
        { id: 'where', text: 'Where in the project does it live?' },
    ],
    bug: [
        { id: 'steps-to-reproduce', text: 'What are the steps to reproduce the problem?' },
        { id: 'expected-vs-actual', text: 'What did you expect, and what happens instead?' },
        { id: 'affected-area', text: 'Which part of the product is affected?' },
    ],
    task: [
        { id: 'desired-outcome', text: 'What should be possible when this is done?' },
        { id: 'constraints', text: 'Are there constraints or things to avoid?' },
        { id: 'done-check', text: 'How will you check that it works?' },
    ],
    epic: [
        { id: 'goal', text: 'What is the overall goal?' },
        { id: 'scope', text: 'What is in scope, and what is not?' },
        { id: 'parts', text: 'What are the main parts, in the order they should land?' },
        { id: 'success-measure', text: 'How will you know the whole effort succeeded?' },
    ],
    refactor: [
        { id: 'structural-goal', text: 'What should the code look like afterwards?' },
        { id: 'must-not-change', text: 'What must not change?' },
        { id: 'verify-unchanged', text: 'How can we verify that behaviour is unchanged?' },
    ],
};

/** The template questions for a mode; an unknown mode id throws. */
export function questionsFor(modeId: string): readonly ClarifyQuestion[] {
    return QUESTIONS[getMode(modeId).id];
}

/** One entry per template question, in order. Missing, undefined and blank answers are recorded as skipped; unknown keys are dropped. */
export function buildAnswers(modeId: string, input: Readonly<Record<string, string | undefined>>): readonly ClarifyAnswer[] {
    return questionsFor(modeId).map((question) => {
        const raw = Object.hasOwn(input, question.id) ? input[question.id] : undefined;
        if (raw === undefined || raw.trim().length === 0) return { q: question.id, a: null, skipped: true };
        return { q: question.id, a: raw, skipped: false };
    });
}
