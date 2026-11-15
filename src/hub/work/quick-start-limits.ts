import type { ClarifyAnswer } from './clarify';
import { getMode, type QuickModeId } from './quick-modes';

export const SKIPPED_LINE = 'Clarifying form: skipped';
export const SKIPPED_ANSWER = 'Skipped';
// The caps flow.create and intent.create enforce (command.schema.json); checked up front so a long form is refused on the spot, not by a late store failure.
export const MAX_PROBLEM = 10000;
export const MAX_CRITERION = 4000;
export const MAX_CRITERIA = 200;
export const MAX_ANSWERS = 200;

/**
 * The description followed by the clarifying-form record. Every question the form asked is kept: an answered one as
 * Q/A lines, a skipped or blank one as the question and a `Skipped` line, never as an empty answer. When nothing was
 * answered the record opens with one skip line, so a wholly skipped form is still recognisable at a glance.
 */
export function problemText(description: string, answers: readonly ClarifyAnswer[]): string {
    const entries = answers.map(answer => {
        const text = answer.skipped || answer.a === null ? '' : answer.a.trim();
        return text.length === 0 ? ['Q: ' + answer.q, SKIPPED_ANSWER] : ['Q: ' + answer.q, 'A: ' + answer.a];
    });
    const answered = entries.some(lines => lines[1] !== SKIPPED_ANSWER);
    return [description, '', ...(answered ? [] : [SKIPPED_LINE]), ...entries.flat()].join('\n');
}

/** Why a well-formed quick start body is too big for the Hub, or undefined when it fits. The server and the TUI share this check. */
export function quickStartSizeProblem(body: {
    readonly mode: QuickModeId;
    readonly description: string;
    readonly answers: readonly ClarifyAnswer[];
    readonly criteria: readonly string[];
}): string | undefined {
    if (body.answers.length > MAX_ANSWERS) return 'answers holds at most ' + MAX_ANSWERS + ' entries';
    const typed = body.criteria.map(text => text.trim()).filter(text => text.length > 0);
    if (typed.some(text => text.length > MAX_CRITERION)) return 'A criterion is at most ' + MAX_CRITERION + ' characters';
    if (getMode(body.mode).criteriaTemplate.length + typed.length > MAX_CRITERIA) return 'A task holds at most ' + MAX_CRITERIA + ' criteria';
    if (problemText(body.description.trim(), body.answers).length > MAX_PROBLEM)
        return 'The description and answers are at most ' + MAX_PROBLEM + ' characters together';
    return undefined;
}
