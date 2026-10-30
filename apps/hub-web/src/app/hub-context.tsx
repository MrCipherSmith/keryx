import { createContext,useContext } from 'react';
import type { Principal } from '../api/types';
import type { HubLocation } from './navigation';
export type HubContextValue={projectId:string|null;principal:Principal;scopeKey:number;location:HubLocation;navigate:(patch:Partial<HubLocation>)=>void;refresh:()=>Promise<void>};
export const HubContext=createContext<HubContextValue|null>(null);
export function useHub(){const context=useContext(HubContext);if(!context)throw new Error('Hub context missing');return context;}
