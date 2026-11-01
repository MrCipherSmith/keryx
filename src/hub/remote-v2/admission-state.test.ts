import {expect, test} from 'bun:test';
import type {HubState} from '../store';
import {readOnlyAdmissionState} from './admission-state';

test('admission legacy view preserves lazy projections and rejects nested mutation before changing originals', () => {
    let revisionReads=0;
    const project={id:'p',name:'Project',version:1,lineRevisionId:null,lineVersion:0,contextRevision:0};
    const state:HubState={projects:[project],documents:[],proposals:[],flows:[],evidence:[],deliveries:[],events:[],documentChanges:[],sessions:{},replays:{},get revisions():HubState["revisions"]{revisionReads++;throw new Error('Binary revision hydration must stay lazy');},legacyConversions:new Proxy({}, {get(_target,key){return key==='legacy' ? {projectId:'p',managedFlowId:'managed'} : undefined;}})};
    const view=readOnlyAdmissionState(state);
    expect(view.projects.some(project=>project.id==='p')).toBe(true);
    expect(view.projects.filter(project=>project.id==='p').map(project=>project.name)).toEqual(['Project']);
    expect(view.legacyConversions?.legacy).toEqual({projectId:'p',managedFlowId:'managed'});
    expect(revisionReads).toBe(0);
    expect(()=>{view.projects[0]!.name='Changed';}).toThrow('Admission may not mutate legacy HubState');
    expect(()=>view.projects.push(project)).toThrow('Admission may not mutate legacy HubState');
    expect(()=>{view.projects=[];}).toThrow('Admission may not mutate legacy HubState');
    expect(state.projects).toEqual([project]);expect(project.name).toBe('Project');expect(revisionReads).toBe(0);
});
