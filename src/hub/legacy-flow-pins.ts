import { criteriaDigest, type Control } from '../remote-control/protocol';
import type { HubState } from './store';

/** One pin comparison for admission refusal and post-run drift reporting. */
export function inspectLegacyFlowPins(state: HubState, association: Extract<Control['FlowAssociation'], {mode:'flow'}>, projectId?: string) {
    const flow=state.flows.find(flow=>flow.id===association.flowId&&(projectId===undefined||flow.projectId===projectId));
    const spec=flow&&state.documents.find(document=>document.id===flow.specDocumentId&&document.projectId===flow.projectId);
    const drift: ('flow-version'|'spec'|'criteria')[]=[];
    if(flow){
        if(flow.version!==association.expectedFlowVersion)drift.push('flow-version');
        if(!spec||spec.contentDigest!==association.specDigest||flow.specContentDigest!==association.specDigest)drift.push('spec');
        if(criteriaDigest(flow.criteria)!==association.criteriaDigest)drift.push('criteria');
    }
    return{flow,spec,drift};
}
