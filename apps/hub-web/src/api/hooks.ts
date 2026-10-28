import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { useHub } from '../app/hub-context';
import { getJson,postJson } from './client';
export function useHubQuery<T>(key:readonly unknown[],path:string,enabled=true){const{scopeKey}=useHub();return useQuery({queryKey:[scopeKey,...key],queryFn:({signal})=>getJson<T>(path,signal),enabled});}
export function useOperation<TBody,TResult>(path:string,invalidate:readonly (readonly unknown[])[]=[]){const{scopeKey}=useHub();const client=useQueryClient();return useMutation({mutationFn:(body:TBody)=>postJson<TResult>(path,body),retry:false,onSuccess:async()=>{await Promise.all(invalidate.map(key=>client.invalidateQueries({queryKey:[scopeKey,...key]})));}});}
