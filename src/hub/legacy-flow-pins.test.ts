import { expect, test } from 'bun:test';
import { criteriaDigest } from '../remote-control/protocol';
import type { HubState } from './store';
import { inspectLegacyFlowPins } from './legacy-flow-pins';
import { checkAssociation } from './remote-v2/sessions';

test('admission and drift comparison use the owning project specification even when another project reuses its ID', () => {
    const state:HubState={projects:[],documents:[{id:'spec',projectId:'foreign',path:'spec.md',kind:'spec',content:'Foreign',contentDigest:'a'.repeat(64),version:1,sourceRevision:'x',approval:'accepted'},{id:'spec',projectId:'p',path:'spec.md',kind:'spec',content:'Changed',contentDigest:'b'.repeat(64),version:1,sourceRevision:'x',approval:'accepted'}],flows:[{id:'f',projectId:'p',title:'Flow',specDocumentId:'spec',specContentDigest:'a'.repeat(64),criteria:['Works'],status:'in-progress',version:3,subjectRevisionId:null}],proposals:[],evidence:[],revisions:[],deliveries:[],events:[],documentChanges:[],sessions:{},replays:{}};
    const association={mode:'flow' as const,flowId:'f',expectedFlowVersion:3,specDigest:'a'.repeat(64),criteriaDigest:criteriaDigest(['Works'])};
    expect(inspectLegacyFlowPins(state,association,'p').drift).toEqual(['spec']);
    expect(()=>checkAssociation(state,association,'p')).toThrow('Managed Flow association is not current executable work');
    expect(inspectLegacyFlowPins(state,association,'different').flow).toBeUndefined();
});
