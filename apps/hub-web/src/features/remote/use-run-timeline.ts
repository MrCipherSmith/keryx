import { useEffect,useRef,useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useHub } from '../../app/hub-context';
import { remoteGet,remoteProject } from '../../api/remote';
import type { RunRecord } from '../../../../../src/remote-control/protocol';
import { appendRunPage,emptyTimeline,type RunEventPage } from './run-timeline';
export function useRunTimeline(run:RunRecord){const hub=useHub();const cursor=useRef(0);const[timeline,setTimeline]=useState(emptyTimeline);const query=useQuery({queryKey:[hub.scopeKey,run.projectId,'remote','run-events',run.runId],queryFn:async({signal})=>{const requestedAfter=cursor.current;const page=await remoteGet<RunEventPage>(remoteProject(run.projectId)+'/runs/'+encodeURIComponent(run.runId)+'/events?after='+requestedAfter,signal);return{...page,requestedAfter};},retry:false});
 useEffect(()=>{if(!query.data)return;setTimeline(previous=>{const next=appendRunPage(previous,query.data);cursor.current=next.cursor;return next;});},[query.data]);
 useEffect(()=>{if(!query.isFetching&&!query.error&&!timeline.conflict&&!timeline.overflow&&timeline.cursor<run.lastLocalSeq&&(!query.data||query.data.cursor>query.data.requestedAfter))void query.refetch();},[timeline.cursor,timeline.conflict,timeline.overflow,run.lastLocalSeq,query.isFetching,query.error,query.refetch,query.data]);
 return{timeline,query};
}
