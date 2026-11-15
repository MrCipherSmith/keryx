import type { DepthRequest } from '../../review/coverage';

/** The kinds of work a quick start can open. Each one fixes a default review depth and a starting set of criteria. */
export type QuickModeId = 'quick' | 'bug' | 'task' | 'epic' | 'refactor';

export interface QuickMode {
    readonly id: QuickModeId;
    readonly label: string;
    /** Default review depth for work started in this mode; always one of `DEPTH_REQUESTS`. */
    readonly reviewDepth: DepthRequest;
    /** Checkable criterion sentences offered as the starting acceptance criteria. */
    readonly criteriaTemplate: readonly string[];
}

export const QUICK_MODES: readonly QuickMode[] = [
    {
        id: 'quick',
        label: 'Quick',
        reviewDepth: 'light',
        criteriaTemplate: [
            'The requested change is made and nothing else is touched',
            'The affected behaviour works when checked by hand',
        ],
    },
    {
        id: 'bug',
        label: 'Bug',
        reviewDepth: 'light',
        criteriaTemplate: [
            'The reported failure no longer reproduces',
            'A regression test fails without the fix and passes with it',
            'Behaviour outside the reported failure is unchanged',
        ],
    },
    {
        id: 'task',
        label: 'Task',
        reviewDepth: 'auto',
        criteriaTemplate: [
            'The described outcome is observable in the running product',
            'New behaviour is covered by automated tests',
            'Existing tests still pass',
        ],
    },
    {
        id: 'epic',
        label: 'Epic',
        reviewDepth: 'full',
        criteriaTemplate: [
            'Every part of the scope is delivered or explicitly deferred with a reason',
            'Each delivered part has its own checkable acceptance criteria',
            'The parts work together end to end',
            'The documentation reflects the delivered behaviour',
        ],
    },
    {
        id: 'refactor',
        label: 'Refactor',
        reviewDepth: 'full',
        criteriaTemplate: [
            'External behaviour is unchanged, shown by tests that pass before and after',
            'The stated structural goal is met',
            'No new public interfaces are added or removed unless listed in the scope',
        ],
    },
];

/** The table entry for a mode id; an unknown id is a caller bug, so it throws. */
export function getMode(id: string): QuickMode {
    const mode = QUICK_MODES.find((candidate) => candidate.id === id);
    if (mode === undefined) throw new Error('Unknown quick mode: ' + JSON.stringify(id));
    return mode;
}
