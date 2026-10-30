import { canonicalDigest } from '../../remote-control/protocol';
import type { SessionInspectionAuthority, SessionOwnedControlAuthority, SessionSelectionAuthorityResult } from '../../session/host-types';
const ownedControls = new Set(['tasks.kill', 'demote', 'approvals.allow-once', 'approvals.deny', 'interrupt', 'questions.answer']);
/** Exists only while the exact fresh-granted command application is awaited. */
export class MachineCommandScope {
    private active = true;
    constructor(private readonly binding: {
        operationId: string;
        actorId: string;
        requestDigest: string;
        payloadDigest: string;
    }, private readonly readCurrent: (action: SessionInspectionAuthority) => Promise<boolean>) { }
    close(): void { this.active = false; }
    private matches(action: SessionInspectionAuthority): boolean { return this.active && action.operationId === this.binding.operationId && action.actorId === this.binding.actorId && canonicalDigest(action.command) === this.binding.requestDigest; }
    async inspection(action: SessionInspectionAuthority): Promise<boolean> { if (!this.matches(action) || ownedControls.has(action.command.commandName))
        return false; return this.readCurrent(action); }
    async owned(action: SessionOwnedControlAuthority): Promise<boolean> { if (!this.matches(action) || !ownedControls.has(action.command.commandName) || action.payloadDigest !== this.binding.payloadDigest)
        return false; return this.readCurrent(action); }
}
/** A classifier and final admission share the original work grant; current read proof cannot renew it. */
export class MachineSelectionScope {
    private active = true;
    constructor(private readonly binding: {
        operationId: string;
        actorId: string;
        payloadDigest: string;
        requestDigest: string;
        sessionId: string;
        sessionVersion: number;
        runId: string;
        turnId: string;
    }, private readonly valid: () => boolean, private readonly readCurrent: (action: import('../../session/host-types').SessionSelectionAuthority) => Promise<boolean | SessionSelectionAuthorityResult>) { }
    close(): void { this.active = false; }
    private matches(action: import('../../session/host-types').SessionSelectionAuthority): boolean { return this.active && this.valid() && action.operationId === this.binding.operationId && action.actorId === this.binding.actorId && action.payloadDigest === this.binding.payloadDigest && canonicalDigest(action.request) === this.binding.requestDigest && action.session.sessionId === this.binding.sessionId && action.session.version === this.binding.sessionVersion && action.runId === this.binding.runId && action.turnId === this.binding.turnId; }
    async check(action: import('../../session/host-types').SessionSelectionAuthority): Promise<SessionSelectionAuthorityResult> {
        if (!this.active) return {status:'unknown'};
        if (!this.valid()) return {status:'expired-work'};
        if (!this.matches(action)) return {status:'stale-subject'};
        const current = await this.readCurrent(action).catch(() => undefined);
        if (!this.valid()) return {status:'expired-work'};
        if (!this.matches(action)) return {status:'stale-subject'};
        return current === true ? {status:'valid'} : current === false || current === undefined ? {status:'unknown'} : current;
    }
}
