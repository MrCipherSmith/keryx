import { describe, expect, test } from 'bun:test';
// Flow 492 T6: the module does not exist yet (T7). These tests are RED until it does.
import { buildAnswers, questionsFor } from './clarify';

type QuestionLike = { id: string; text: string };
type AnswerLike = { q: string; a: string | null; skipped: boolean };
const MODE_IDS = ['quick', 'bug', 'task', 'epic', 'refactor'] as const;

describe('questionsFor (AC3)', () => {
    for (const id of MODE_IDS) {
        test('mode ' + id + ' has a non-empty list of {id, text} questions', () => {
            const questions = questionsFor(id);
            expect(questions.length).toBeGreaterThan(0);
            for (const question of questions) {
                expect(typeof question.id).toBe('string');
                expect(question.id.length).toBeGreaterThan(0);
                expect(typeof question.text).toBe('string');
                expect(question.text.trim().length).toBeGreaterThan(0);
            }
        });

        test('mode ' + id + ' has unique question ids', () => {
            const ids = questionsFor(id).map((question: QuestionLike) => question.id);
            expect(new Set(ids).size).toBe(ids.length);
        });
    }
});

describe('buildAnswers (AC3)', () => {
    for (const id of MODE_IDS) {
        describe('mode ' + id, () => {
            test('all questions skipped: every entry is skipped with a null answer', () => {
                const questions = questionsFor(id);
                const answers = buildAnswers(id, {});
                expect(answers).toHaveLength(questions.length);
                expect(answers.map((entry: AnswerLike) => entry.q)).toEqual(questions.map((question: QuestionLike) => question.id));
                for (const entry of answers) {
                    expect(entry.a).toBeNull();
                    expect(entry.skipped).toBe(true);
                }
            });

            test('undefined and blank answers count as skipped', () => {
                const questions = questionsFor(id);
                const input: Record<string, string | undefined> = {};
                questions.forEach((question: QuestionLike, index: number) => {
                    input[question.id] = index % 2 === 0 ? undefined : '   \n\t';
                });
                const answers = buildAnswers(id, input);
                expect(answers).toHaveLength(questions.length);
                for (const entry of answers) {
                    expect(entry.a).toBeNull();
                    expect(entry.skipped).toBe(true);
                }
            });

            test('an answered question is recorded with its text and skipped false', () => {
                const [first, ...rest] = questionsFor(id);
                if (first === undefined) throw new Error('mode has no questions');
                const answers = buildAnswers(id, { [first.id]: 'The login page, on mobile' });
                expect(answers).toHaveLength(rest.length + 1);
                const entry = answers.find((candidate: AnswerLike) => candidate.q === first.id);
                expect(entry).toEqual({ q: first.id, a: 'The login page, on mobile', skipped: false });
                for (const other of answers.filter((candidate: AnswerLike) => candidate.q !== first.id)) {
                    expect(other.a).toBeNull();
                    expect(other.skipped).toBe(true);
                }
            });

            test('all questions answered: none skipped, one entry per question in order', () => {
                const questions = questionsFor(id);
                const input: Record<string, string> = {};
                for (const question of questions) input[question.id] = 'answer for ' + question.id;
                const answers = buildAnswers(id, input);
                expect(answers).toEqual(questions.map((question: QuestionLike) => ({ q: question.id, a: 'answer for ' + question.id, skipped: false })));
            });
        });
    }

    test('an answer for an unknown question id is not recorded', () => {
        const questions = questionsFor('bug');
        const answers = buildAnswers('bug', { 'no-such-question': 'stray' });
        expect(answers).toHaveLength(questions.length);
        expect(answers.some((entry: AnswerLike) => entry.q === 'no-such-question')).toBe(false);
    });
});
