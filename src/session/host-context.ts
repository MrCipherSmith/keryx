/** A context reset cuts the active archive, while the executed native archive remains append-only. */
export interface NativeContextReset { cursor: number; archiveCount: number; activeCount: number }
export function activeArchiveIndices(archiveCount:number,cursor:number,resets:readonly NativeContextReset[]):number[]{
 if(!Number.isSafeInteger(archiveCount)||archiveCount<0||!Number.isSafeInteger(cursor)||cursor<0)throw new Error('invalid-context-window');
 let indices=Array.from({length:archiveCount},(_,index)=>index);let priorCursor=0,priorArchive=0;
 for(const reset of resets){
  if(!Number.isSafeInteger(reset.cursor)||reset.cursor<=priorCursor||!Number.isSafeInteger(reset.archiveCount)||reset.archiveCount<priorArchive||!Number.isSafeInteger(reset.activeCount)||reset.activeCount<0)throw new Error('invalid-context-window');
  priorCursor=reset.cursor;priorArchive=reset.archiveCount;if(reset.cursor>cursor)continue;
  if(reset.archiveCount>archiveCount)throw new Error('invalid-context-window');const before=indices.filter(index=>index<reset.archiveCount);if(reset.activeCount>before.length)throw new Error('invalid-context-window');
  indices=[...before.slice(0,reset.activeCount),...Array.from({length:archiveCount-reset.archiveCount},(_,index)=>reset.archiveCount+index)];
 }
 return indices;
}
