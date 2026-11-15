import { describe, expect, test } from 'bun:test';
// The review depths the review engine accepts (`review required --depth`): the only existing source of review depth.
import { DEPTH_REQUESTS } from '../../review/coverage';
// Flow 492 T6: the module does not exist yet (T7). These tests are RED until it does.
import { QUICK_MODES, getMode } from './quick-modes';

type ModeLike = { id: string; reviewDepth: string };
const MODE_IDS = ['quick', 'bug', 'task', 'epic', 'refactor'] as const;

describe('QUICK_MODES (AC2)', () => {
    test('defines exactly the five modes, in a stable set', () => {
        expect(QUICK_MODES.map((mode: ModeLike) => mode.id).sort()).toEqual([...MODE_IDS].sort());
    });

    test('mode ids are unique', () => {
        const ids = QUICK_MODES.map((mode: ModeLike) => mode.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    for (const id of MODE_IDS) {
        describe('mode ' + id, () => {
            test('is present in the table', () => {
                expect(QUICK_MODES.some((mode: ModeLike) => mode.id === id)).toBe(true);
            });

            test('default review depth is an existing review depth', () => {
                const mode = getMode(id);
                expect(DEPTH_REQUESTS as readonly string[]).toContain(mode.reviewDepth);
            });

            test('criteria template is a non-empty list of non-blank strings', () => {
                const { criteriaTemplate } = getMode(id);
                expect(Array.isArray(criteriaTemplate)).toBe(true);
                expect(criteriaTemplate.length).toBeGreaterThan(0);
                for (const line of criteriaTemplate) {
                    expect(typeof line).toBe('string');
                    expect(line.trim().length).toBeGreaterThan(0);
                }
            });
        });
    }

    test('every mode in the table has a review depth that names an existing profile', () => {
        for (const mode of QUICK_MODES) expect(DEPTH_REQUESTS as readonly string[]).toContain(mode.reviewDepth);
    });
});

describe('getMode', () => {
    test('returns the table entry for a known id', () => {
        for (const id of MODE_IDS) {
            const mode = getMode(id);
            expect(mode.id).toBe(id);
            expect(QUICK_MODES).toContain(mode);
        }
    });

    test('throws for an unknown id', () => {
        expect(() => getMode('nonsense')).toThrow();
        expect(() => getMode('')).toThrow();
    });
});
