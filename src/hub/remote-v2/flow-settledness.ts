import type { ApprovalProjection, Control } from '../../remote-control/protocol';
import type { RemoteRepository } from './storage';
import type { ApprovalRow, QueueRow, RunRow, StoredCommand } from './model';
import type { CommandConfirmationRow } from './config';

const settledQueueStates = { queued: false, suspended: false, admitted: false, applied: true, rejected: true, removed: true } satisfies Record<Control['QueueItem']['state'], boolean>;
const settledApprovalStates = { waiting: false, recorded: false, delivered: false, applied: true, 'not-applied': true, expired: true } satisfies Record<ApprovalProjection['status'], boolean>;
const terminalRunStates = { dispatching: false, received: false, starting: false, running: false, 'waiting-approval': false, paused: false, cancelling: false, unknown: false, succeeded: true, failed: true, cancelled: true, rejected: true, lost: true } satisfies Record<RunRow['state'], boolean>;
function requestAssociation(value: QueueRow['request'] | Control['SessionFork'] | Control['StartTurnRequest'] | undefined) { return value && 'association' in value ? value.association : undefined; }
function associated(value: Control['FlowAssociation'] | undefined, flowId: string) { return value?.mode === 'flow' && value.flowId === flowId; }
function settledRun(run: RunRow) {
    if (!terminalRunStates[run.state] || !run.terminalAt) return false;
    return !['succeeded', 'failed', 'cancelled'].includes(run.state) || !!run.result;
}

/** Native v2 owns its state vocabulary; callers receive only a settledness reason. */
export function flowExecutionUnsettled(repo: RemoteRepository, projectId: string, flowId: string): string | null {
    const runs = repo.all<RunRow>('remote_run', { projectId }).filter(run => associated(run.association, flowId));
    if (runs.some(run => !settledRun(run))) return 'Legacy run or result is unsettled';
    const runIds = new Set(runs.map(run => run.runId));
    const runsByCommand = new Map(runs.map(run => [run.commandId, run]));
    const queue = repo.all<QueueRow>('remote_queue', { projectId });
    for (const row of queue) {
        if (!associated(row.association, flowId) && !associated(requestAssociation(row.request), flowId)) continue;
        if (settledQueueStates[row.item.state]) continue;
        const run = row.admissionCommandId && runsByCommand.get(row.admissionCommandId);
        if (row.item.state === 'admitted' && run && settledRun(run)) continue;
        return 'Legacy execution queue is unsettled';
    }
    if (repo.all<ApprovalRow>('remote_approval_projection', { projectId }).some(row => runIds.has(row.runId) && !settledApprovalStates[row.status])) return 'Legacy approval is unsettled';
    if (repo.all<CommandConfirmationRow>('remote_confirmation', { projectId }).some(row => !row.consumed && associated(requestAssociation(row.original), flowId))) return 'Legacy command confirmation is unsettled';
    const settledCommands = new Set(['applied', 'not-applied', 'rejected', 'expired-unconfirmed']);
    for (const command of repo.all<StoredCommand>('remote_command', { projectId })) {
        if (settledCommands.has(command.status)) continue;
        const envelope = command.envelope;
        const payload = envelope.body;
        const association = 'association' in payload ? payload.association : 'request' in payload ? requestAssociation(payload.request) : undefined;
        if ('runId' in envelope && runIds.has(envelope.runId) || associated(association, flowId)) return 'Legacy command is unsettled';
    }
    return null;
}
