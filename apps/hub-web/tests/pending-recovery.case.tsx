import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { HubContext, type HubContextValue } from "../src/app/hub-context";
import { ApiError, resetClient } from "../src/api/client";
import { useDraftStore } from "../src/state/drafts";
import { clearPending, pendingScope, readPending, writePending } from "../src/state/pending";
import { useWorkOperation, validCommand } from "../src/features/managed-work/operation";
import { liveWorkAdapter } from "../src/features/managed-work/adapter";
import type { WorkCommand } from "../src/features/managed-work/types";

const command: Omit<WorkCommand,"operationId"> = {command:"flow.create",expectedVersions:{},payload:{title:"Original Flow",problem:"p",expectedOutcome:"e",scope:"s",outOfScope:"o",ownerId:null,specification:null,criteria:[]}};
const context: HubContextValue={projectId:"p",principal:{id:"human:test",kind:"human",role:"operator"},scopeKey:1,location:{projectId:"p",tab:"flows"},navigate:()=>undefined,refresh:async()=>undefined};
const scope=pendingScope("work","human:test","p","live");
beforeEach(()=>{useDraftStore.getState().clearAll();resetClient();});
function hook(adapter=liveWorkAdapter("p"), ctx=context){return renderHook(()=>useWorkOperation(adapter,()=>undefined),{wrapper:({children})=><HubContext.Provider value={ctx}>{children}</HubContext.Provider>});}
test("lost response survives reload; lookup404 retains original and explicit retry uses exact original UUID/body",async()=>{
 const adapter=liveWorkAdapter("p");const send=vi.spyOn(adapter,"command").mockRejectedValueOnce(new TypeError("lost response")).mockResolvedValue({operationId:"result",status:"committed",receiptId:"r"});
 const lookup=vi.spyOn(adapter,"operation").mockRejectedValue(new ApiError(404,"not-found","not found"));
 const first=hook(adapter);await act(()=>first.result.current.run(command));expect(first.result.current.operation.status).toBe("unknown");
 const original=structuredClone(send.mock.calls[0][0]);expect(readPending(scope,validCommand)).toEqual(original);
 first.unmount();useDraftStore.getState().clearAll();resetClient();const recovered=hook(adapter,{...context,scopeKey:923});
 expect(recovered.result.current.operation.status).toBe("unknown");expect(send).toHaveBeenCalledTimes(1);expect(lookup).not.toHaveBeenCalled();
 await act(()=>recovered.result.current.run());expect(recovered.result.current.operation.command).toEqual(original);
 await act(()=>recovered.result.current.retry());expect(send).toHaveBeenCalledTimes(2);expect(send.mock.calls[1][0]).toEqual(original);expect(readPending(scope,validCommand)).toBeNull();
});
test("a persisted sending human decision is restored unknown, never automatically sent",()=>{
 const original={operationId:"human-decision",command:"requirements.approve",expectedVersions:{flow:1},payload:{targetType:"flow-revision",revisionId:"fr",revisionDigest:"a".repeat(64),flowRevisionId:"fr",reason:"I reviewed the pinned requirements"}};
 expect(validCommand(original)).toBe(true);writePending(scope,original,validCommand);
 const adapter=liveWorkAdapter("p"),send=vi.spyOn(adapter,"command"),lookup=vi.spyOn(adapter,"operation");
 const view=hook(adapter);expect(view.result.current.operation.status).toBe("unknown");expect(send).not.toHaveBeenCalled();expect(lookup).not.toHaveBeenCalled();
});
test("recovery is isolated by principal and project; logout removes only private pending envelopes",()=>{
 const original={...command,operationId:"original"};writePending(scope,original,validCommand);sessionStorage.setItem("ordinary-setting","keep");
 expect(readPending(pendingScope("work","other","p","live"),validCommand)).toBeNull();expect(readPending(pendingScope("work","human:test","q","live"),validCommand)).toBeNull();
 expect(hook(liveWorkAdapter("p"),{...context,principal:{...context.principal,id:"other"}}).result.current.operation.status).toBe("idle");
 clearPending();expect(readPending(scope,validCommand)).toBeNull();expect(sessionStorage.getItem("ordinary-setting")).toBe("keep");
});
test("malformed and oversized entries fail closed; storage denial sends no mutation",async()=>{
 const adapter=liveWorkAdapter("p"),send=vi.spyOn(adapter,"command");sessionStorage.setItem("keryx.pending.v1:"+scope,JSON.stringify({version:1,scope,value:{...command,operationId:"bad",Authorization:"not-allowed"}}));
 const bad=hook(adapter);expect(bad.result.current.blocked).toBe(true);await act(()=>bad.result.current.run(command));expect(send).not.toHaveBeenCalled();bad.unmount();sessionStorage.clear();useDraftStore.getState().clearAll();
 const denied=hook(adapter);vi.spyOn(Storage.prototype,"setItem").mockImplementationOnce(()=>{throw new DOMException("quota","QuotaExceededError");});await act(()=>denied.result.current.run(command));expect(send).not.toHaveBeenCalled();expect(denied.result.current.operation.code).toBe("pending-storage");
 sessionStorage.setItem("keryx.pending.v1:"+scope,"x".repeat(128*1024+1));expect(()=>readPending(scope,validCommand)).toThrow();
});
test("closed bounded persistence rejects replacement IDs and count exhaustion without losing the original",()=>{
 const original={...command,operationId:"one"};writePending(scope,original,validCommand);
 expect(()=>writePending(scope,{...command,operationId:"two"},validCommand)).toThrow();expect(readPending(scope,validCommand)).toEqual(original);
 for(let n=1;n<8;n++)writePending(pendingScope("work","human:test","p"+n,"live"),{...command,operationId:"op"+n},validCommand);
 expect(()=>writePending(pendingScope("work","human:test","ninth","live"),{...command,operationId:"nine"},validCommand)).toThrow();
});

test("a later retry403 cannot erase an unknown original commit or allocate a replacement operation",async()=>{
 const adapter=liveWorkAdapter("p");const send=vi.spyOn(adapter,"command").mockRejectedValueOnce(new TypeError("committed; response lost")).mockRejectedValue(new ApiError(403,"read-only","Current authority refused before lookup"));
 const view=hook(adapter);await act(()=>view.result.current.run(command));const original=structuredClone(send.mock.calls[0][0]);
 await act(()=>view.result.current.retry());expect(view.result.current.operation.status).toBe("unknown");expect(readPending(scope,validCommand)).toEqual(original);
 await act(()=>view.result.current.run({...command,payload:{...command.payload,title:"Replacement"}}));expect(send).toHaveBeenCalledTimes(2);
 await act(()=>view.result.current.retry());expect(send.mock.calls[2][0]).toEqual(original);expect(readPending(scope,validCommand)).toEqual(original);
});
