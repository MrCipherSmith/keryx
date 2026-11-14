import { fail } from '../domain';
import type { Principal } from '../contracts';
import type { HubStore } from '../store';
import type { ClarifyAnswer } from './clarify';
import { authorize, workCommand, workDigest, workOperationKey, type WorkContext } from './domain';
import type { Criterion, FlowRevision, IntentRevision, WorkCommand, WorkFlow, WorkIntent, WorkReceipt, WorkRecord } from './model';
import { getMode, QUICK_MODES, type QuickModeId } from './quick-modes';

export interface QuickStartRequest {
    /** Idempotency key: the same id with the same body replays the stored receipt. */
    readonly operationId: string;
    readonly mode: QuickModeId;
    readonly description: string;
    readonly answers: readonly ClarifyAnswer[];
    readonly criteria: readonly string[];
}

export interface QuickStartDeps {
    readonly store: HubStore;
    /** Epoch milliseconds; read once per composed command and nowhere else. */
    readonly now: () => number;
}

/** The `result` of a quick start receipt. */
export interface QuickStartResult {
    readonly flowId: string;
    readonly intentId: string;
}

const SKIPPED_LINE = 'Clarifying form: skipped';
const MAX_TITLE = 120;

/** Validates an untrusted body (everything but the operation id, which travels in the Idempotency-Key header). */
export function parseQuickStartBody(body: Record<string, unknown>): Omit<QuickStartRequest, 'operationId'> {
    const invalid = (message: string): never => fail(400, 'invalid-body', message);
    if (Object.keys(body).some(key => !['mode', 'description', 'answers', 'criteria'].includes(key))) invalid('Unexpected quick start field');
    const { mode, description, answers, criteria } = body;
    if (typeof mode !== 'string' || !QUICK_MODES.some(candidate => candidate.id === mode)) invalid('Unknown quick start mode');
    if (typeof description !== 'string') invalid('description must be a string');
    if (!Array.isArray(answers) || !answers.every(isAnswer)) invalid('answers must be a list of { q, a, skipped }');
    if (!Array.isArray(criteria) || !criteria.every(item => typeof item === 'string')) invalid('criteria must be a list of strings');
    return { mode: mode as QuickModeId, description: description as string, answers: answers as ClarifyAnswer[], criteria: criteria as string[] };
}

function isAnswer(value: unknown): value is ClarifyAnswer {
    if (!value || typeof value !== 'object') return false;
    const { q, a, skipped } = value as Record<string, unknown>;
    return typeof q === 'string' && (typeof a === 'string' || a === null) && typeof skipped === 'boolean';
}

/**
 * The description followed by the clarifying-form record. Every question the form asked is kept: an answered one as
 * Q/A lines, a skipped or blank one as the question and a `Skipped` line, never as an empty answer. When nothing was
 * answered the record opens with one skip line, so a wholly skipped form is still recognisable at a glance.
 */
function problemText(description: string, answers: readonly ClarifyAnswer[]): string {
    const entries = answers.map(answer => {
        const text = answer.skipped || answer.a === null ? '' : answer.a.trim();
        return text.length === 0 ? ['Q: ' + answer.q, 'Skipped'] : ['Q: ' + answer.q, 'A: ' + answer.a];
    });
    const answered = entries.some(lines => lines[1] !== 'Skipped');
    return [description, '', ...(answered ? [] : [SKIPPED_LINE]), ...entries.flat()].join('\n');
}

function titleOf(description: string): string {
    const first = description.split('\n')[0]!.trim();
    return first.length > MAX_TITLE ? first.slice(0, MAX_TITLE - 1).trimEnd() + '…' : first;
}

/**
 * Creates a Flow, one required Intent and starts it as the signed-in human, in one store transaction.
 * The three existing commands (flow.create, intent.create, flow.approve-and-start) run through `workCommand`
 * over one in-memory state, and only the composite receipt keyed by the operation id is kept.
 */
export function quickStart(deps: QuickStartDeps, actor: Principal, projectId: string, request: QuickStartRequest): WorkReceipt {
    if (actor.kind !== 'human' || !['operator', 'reviewer'].includes(actor.role))
        fail(403, 'human-required', 'Only a signed-in human can start work');
    const { store } = deps;
    return store.workTransaction(() => {
        const context: WorkContext = { legacy: store.workLegacyContext(projectId), now: () => new Date(deps.now()).toISOString() };
        authorize(actor, projectId, context, true);
        const description = request.description.trim();
        if (description.length === 0) fail(400, 'invalid-body', 'description is required');
        if (!QUICK_MODES.some(candidate => candidate.id === request.mode)) fail(400, 'invalid-mode', 'Unknown quick start mode');
        const mode = getMode(request.mode);
        const { operationId } = request;
        const requestDigest = workDigest({ command: 'quick-start', ...request });
        const previous = store.work.operation(projectId, actor.id, operationId);
        if (previous) {
            if (previous.requestDigest !== requestDigest) fail(409, 'idempotency-conflict', 'Operation ID already used with another command');
            return previous;
        }
        const criteria: Criterion[] = [...mode.criteriaTemplate, ...request.criteria.map(text => text.trim()).filter(text => text.length > 0)]
            .map((text, index) => ({ criterionId: 'quick-' + (index + 1), text, waivable: false }));
        const state = store.work.commandState(projectId, { command: 'flow.approve-and-start', payload: {}, operationId }, actor.id);
        const key = workOperationKey(projectId, actor.id, operationId);
        const run = (command: WorkCommand): unknown => {
            const { result } = workCommand(state, actor, projectId, command, context);
            // Each command would store its own receipt under the shared operation id; only the composite one is kept.
            delete state.operations[key];
            return result;
        };
        const byId = <T extends WorkRecord>(id: string, kind: T['kind']): T => state.records.find((record): record is T => record.id === id && record.kind === kind)!;
        const envelope = (expectedVersions: Record<string, number>) => ({ operationId, expectedVersions });

        const flow = run({ ...envelope({}), command: 'flow.create', payload: {
            title: titleOf(description), problem: problemText(description, request.answers), expectedOutcome: description,
            scope: 'As described, started in ' + mode.label + ' mode', outOfScope: 'Anything the description does not ask for',
            ownerId: null, specification: null, criteria,
        } }) as WorkFlow;
        const intent = run({ ...envelope({ [flow.id]: flow.version }), command: 'intent.create', payload: {
            flowId: flow.id, title: flow.title, deliverable: description, approach: 'As described', outOfScope: 'Anything the description does not ask for',
            ownerId: null, required: true, criteria, flowCriterionIds: criteria.map(criterion => criterion.criterionId),
            criterionMappings: criteria.map(criterion => ({ intentCriterionId: criterion.criterionId, flowCriterionId: criterion.criterionId })),
        } }) as WorkIntent;
        const current = byId<WorkFlow>(flow.id, 'flow'), flowRevision = byId<FlowRevision>(current.currentRevisionId, 'flow-revision');
        const intentRevision = byId<IntentRevision>(intent.currentRevisionId, 'intent-revision');
        run({ ...envelope({ [flow.id]: current.version, [intent.id]: intent.version }), command: 'flow.approve-and-start', payload: {
            flowId: flow.id, flowRevisionDigest: flowRevision.contentDigest,
            intents: [{ intentId: intent.id, revisionId: intentRevision.id, revisionDigest: intentRevision.contentDigest }],
            reason: 'Started with quick start in ' + mode.label + ' mode',
        } });

        const result: QuickStartResult = { flowId: flow.id, intentId: intent.id };
        const receipt: WorkReceipt = {
            operationId, status: 'committed', receiptId: crypto.randomUUID(), actorId: actor.id, projectId, requestDigest, result,
            eventCursor: state.sequence ?? state.events.filter(event => event.projectId === projectId).at(-1)?.sequence ?? 0,
        };
        state.operations[key] = receipt;
        store.work.save(projectId, state);
        return structuredClone(receipt);
    });
}
