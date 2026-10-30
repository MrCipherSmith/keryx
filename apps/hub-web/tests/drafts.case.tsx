import { act,renderHook } from '@testing-library/react';
import { beforeEach,expect,test } from 'vitest';
import { useDraft,useDraftStore } from '../src/state/drafts';
beforeEach(()=>useDraftStore.getState().clearAll());
test('successful stale submission cannot clear a newer in-memory draft',()=>{
 const{result}=renderHook(()=>useDraft('p1:proposal',{text:'initial',baseVersion:1}));
 act(()=>result.current[1]({text:'submitted',baseVersion:1}));const submitted=result.current[0];
 act(()=>result.current[1]({text:'newer unsent work',baseVersion:1}));let cleared=true;act(()=>{cleared=result.current[2](submitted);});
 expect(cleared).toBe(false);expect(result.current[0].text).toBe('newer unsent work');expect(result.current[0].baseVersion).toBe(1);
});
test('matching submitted draft can clear; explicit reset remains unconditional',()=>{
 const{result}=renderHook(()=>useDraft('p1:form',{text:'initial',baseVersion:1}));act(()=>result.current[1]({text:'submitted',baseVersion:1}));const submitted=result.current[0];
 let cleared=false;act(()=>{cleared=result.current[2](submitted);});expect(cleared).toBe(true);expect(useDraftStore.getState().drafts['p1:form']).toBeUndefined();
 act(()=>result.current[1]({text:'another',baseVersion:1}));act(()=>{cleared=result.current[2]();});expect(cleared).toBe(true);expect(useDraftStore.getState().drafts['p1:form']).toBeUndefined();
});
