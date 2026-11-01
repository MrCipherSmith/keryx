import { randomUUID } from 'node:crypto';
import type { HubDocument, HubFlow, Principal } from '../contracts';
import { fail } from '../domain';
import type { HubState, HubStore } from '../store';
import { workDigest } from './domain';
import type { WorkCommand } from './model';
import { flowExecutionUnsettled } from '../remote-v2/flow-settledness';
export type LegacyPreview = {
    receiptId: string;
    contentDigest: string;
    legacyFlowId: string;
    sourceVersion: number;
    sourceDigest: string;
    status: 'eligible';
    source: {
        flowId: string;
        title: string;
        specification: {
            documentId: string;
            version: number;
            contentDigest: string;
        };
        criteria: string[];
        status: 'initializing' | 'ready';
    };
};
type ConvertPayload = Extract<WorkCommand, {
    command: 'legacy.convert';
}>['payload'];
export function createLegacyConversion(store: HubStore, legacy: HubState, now: () => string) {
    function human(actor: Principal, projectId: string) {
        if (actor.kind !== 'human' || !['operator', 'reviewer'].includes(actor.role) || actor.readOnly)
            fail(403, 'human-required', 'Authorized human conversion required');
        if (actor.projectIds && !actor.projectIds.includes(projectId))
            fail(404, 'not-found', 'Project not found');
    }
    function eligible(projectId: string, legacyFlowId: string, sourceVersion: number): {
        flow: HubFlow;
        document: HubDocument;
    } {
        const flow = legacy.flows.find(f => f.projectId === projectId && f.id === legacyFlowId);
        if (!flow)
            fail(404, 'not-found', 'Legacy Flow not found');
        if (store.work.conversion(projectId, legacyFlowId))
            fail(409, 'flow-converted', 'Legacy Flow already converted');
        if (flow.version !== sourceVersion)
            fail(409, 'version-conflict', 'Legacy source version changed');
        const idleState = ['initializing', 'ready'].includes(flow.status);
        const noDelivery = !flow.subjectRevisionId && !flow.acceptedBy && !flow.receipt;
        const noEvidence = !legacy.evidence.some(e => e.projectId === projectId && e.flowId === flow.id);
        if (!idleState || !noDelivery || !noEvidence)
            fail(409, 'legacy-not-idle', 'Only unfinished idle initializing or ready work can convert');
        const document = legacy.documents.find(d => d.projectId === projectId && d.id === flow.specDocumentId && d.contentDigest === flow.specContentDigest);
        if (!document)
            fail(409, 'requirements-drift', 'Exact legacy specification unavailable');
        const unsettled = flowExecutionUnsettled(store.remote, projectId, flow.id);
        if (unsettled) fail(409, 'execution-unsettled', unsettled);
        return { flow, document };
    }
    function sourceDigest(flow: HubFlow, document: HubDocument) {
        return workDigest({ flow, document: { id: document.id, version: document.version, contentDigest: document.contentDigest } });
    }
    function preview(actor: Principal, projectId: string, input: {
        legacyFlowId: string;
        sourceVersion: number;
    }): LegacyPreview {
        human(actor, projectId);
        const { flow, document } = eligible(projectId, input.legacyFlowId, input.sourceVersion);
        const source: LegacyPreview['source'] = {
            flowId: flow.id, title: flow.title, specification: { documentId: document.id, version: document.version, contentDigest: document.contentDigest }, criteria: [...flow.criteria], status: flow.status as 'initializing' | 'ready'
        };
        const preview: LegacyPreview = {
            receiptId: randomUUID(), legacyFlowId: flow.id, sourceVersion: flow.version, sourceDigest: sourceDigest(flow, document), status: 'eligible', source, contentDigest: ''
        };
        preview.contentDigest = workDigest({ ...preview, createdAt: now() });
        store.work.saveLegacyPreview(projectId, actor.id, preview);
        return preview;
    }
    function convert(actor: Principal, projectId: string, input: ConvertPayload) {
        human(actor, projectId);
        const { flow, document } = eligible(projectId, input.legacyFlowId, input.sourceVersion), preview = store.work.legacyPreview(projectId, actor.id, input.dryRunReceiptId);
        if (!preview)
            fail(404, 'not-found', 'Conversion preview not found');
        if (preview.legacyFlowId !== flow.id || preview.sourceVersion !== flow.version || preview.contentDigest !== input.dryRunDigest || preview.sourceDigest !== sourceDigest(flow, document))
            fail(409, 'requirements-drift', 'Legacy source or preview changed; preview again');
        return { flow: structuredClone(flow), document: structuredClone(document) };
    }
    return { preview, convert, converted(legacyFlowId: string, managedFlowId: string) {
            const flow = legacy.flows.find(f => f.id === legacyFlowId);
            if (!flow)
                fail(404, 'not-found', 'Legacy Flow not found');
            store.work.markConverted(flow.projectId, legacyFlowId, managedFlowId);
        } };
}
