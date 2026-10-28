import { useCallback } from 'react';
import { create } from 'zustand';
type DraftState={drafts:Record<string,unknown>;put:(key:string,value:unknown)=>void;remove:(key:string)=>void;clearAll:()=>void};
export const useDraftStore=create<DraftState>(set=>({drafts:{},put:(key,value)=>set(s=>({drafts:{...s.drafts,[key]:value}})),remove:key=>set(s=>{const next={...s.drafts};delete next[key];return{drafts:next};}),clearAll:()=>set({drafts:{}})}));
export function useDraft<T>(key:string,initial:T):[T,(next:T|((previous:T)=>T))=>void,(expected?:T)=>boolean]{
 const saved=useDraftStore(s=>s.drafts[key]) as T|undefined;
 // Capture the original version without writing a global store during render.
 const draft=saved===undefined?initial:saved;
 const setDraft=useCallback((next:T|((previous:T)=>T))=>{const current=(useDraftStore.getState().drafts[key] as T|undefined)??initial;useDraftStore.getState().put(key,typeof next==='function'?(next as (v:T)=>T)(current):next);},[key,initial]);
 const clear=useCallback((expected?:T)=>{const current=useDraftStore.getState().drafts[key];if(expected!==undefined&&current!==undefined&&current!==expected)return false;useDraftStore.getState().remove(key);return true;},[key]);return[draft,setDraft,clear];
}
