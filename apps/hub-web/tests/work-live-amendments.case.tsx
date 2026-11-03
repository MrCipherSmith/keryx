import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { renderHub } from "./hub-render";
import type { HubContextValue } from "../src/app/hub-context";
import { resetClient } from "../src/api/client";
import { useDraftStore } from "../src/state/drafts";
import i18n from "../src/i18n";
import { demoWorkAdapter } from "../src/features/managed-work/demo";
import { liveWorkAdapter } from "../src/features/managed-work/adapter";
import { AmendmentsPanel } from "../src/features/managed-work/amendments";
import { FlowSummary } from "../src/features/managed-work/work-panels";
import { RevisionEditor } from "../src/features/managed-work/revision-editor";
import { recordOf, recordsOf } from "../src/features/managed-work/model";
import type { WorkRecord, AmendmentManifest } from "../src/features/managed-work/types";

const context:HubContextValue={projectId:"p",scopeKey:77,principal:{id:"human:test",kind:"human",role:"operator"},location:{projectId:"p",tab:"work"},navigate:()=>undefined,refresh:async()=>undefined};
const adapter=liveWorkAdapter("p");
let records:WorkRecord[];
let posted:Record<string,unknown>[];
beforeEach(async()=>{resetClient();useDraftStore.getState().clearAll();await i18n.changeLanguage("en");records=(await demoWorkAdapter("p").snapshot()).records;posted=[];vi.spyOn(globalThis,"fetch").mockImplementation(async(_input,init)=>{if(init?.method==="POST"){const body=JSON.parse(String(init.body));posted.push(body);return Response.json({operationId:body.operationId,receiptId:"reviewed-receipt",status:"committed",entities:[],eventCursor:"next"});}return Response.json({records:[],nextCursor:null,eventCursor:"next"});});});
function show(children:React.ReactNode){return renderHub(children,context,new QueryClient({defaultOptions:{queries:{retry:false}}}));}
function replacements(){const flow=recordOf(records,"flow","flow-demo")!;const source=recordOf(records,"flow-revision",flow.currentRevisionId)!;flow.currentRevisionId="fr2";records.push({...source,id:"fr2",revision:2,contentDigest:"b".repeat(64)});for(const intent of recordsOf(records,"intent")){const revision=recordOf(records,"intent-revision",intent.currentRevisionId)!;intent.currentRevisionId=revision.id+"-new";records.push({...revision,id:intent.currentRevisionId,revision:2,flowRevisionId:"fr2",contentDigest:"c".repeat(64)});}return flow;}

test("live membership amendment includes a newly introduced unapproved Intent and its editable proposal target",async()=>{
 const flow=replacements();const template=recordOf(records,"intent","i2")!;const revision=recordOf(records,"intent-revision",template.currentRevisionId)!;
 records.push({...template,id:"new-intent",title:"New required membership",state:"draft",approvedRevisionId:null,currentRevisionId:"new-intent-revision"},{...revision,id:"new-intent-revision",intentId:"new-intent"});
 recordOf(records,"flow-revision","fr2")!.requiredIntentIds.push("new-intent");
 show(<AmendmentsPanel adapter={adapter} flow={flow} records={records} can={()=>true} onDone={()=>undefined}/>);
 fireEvent.click(screen.getByRole("button",{name:"Propose revised requirements"}));
 expect(screen.getByRole("option",{name:"New required membership"})).toBeInTheDocument();
 fireEvent.click(screen.getByRole("button",{name:"Propose revised requirements"}));
 fireEvent.change(screen.getByRole("textbox",{name:"Reason for the requirements change"}),{target:{value:"Review exact new membership"}});
 fireEvent.click(screen.getByRole("button",{name:"Authorize exact amendment set"}));
 await waitFor(()=>expect(posted).toHaveLength(1));
 expect(posted[0]).toMatchObject({expectedVersions:{"flow-demo":1,i1:1,i2:1,"new-intent":1},payload:{affectedIntentIds:["i1","i2","new-intent"]}});
});

test("live pending amendment resolution supplies versions for every manifest Intent including unapproved and cancelled",async()=>{
 const flow=replacements();const intent=recordOf(records,"intent","i2")!;intent.state="cancelled";intent.approvedRevisionId=null;
 const manifest:AmendmentManifest={id:"manifest",kind:"amendment",projectId:"p",createdBy:"human:test",createdAt:"2026-11-02T00:00:00Z",flowId:flow.id,sourceFlowRevisionId:flow.approvedRevisionId!,affectedIntentIds:["i1","i2"],replacements:recordsOf(records,"intent").map(intent=>({targetType:"intent",targetId:intent.id,revisionId:intent.currentRevisionId,contentDigest:recordOf(records,"intent-revision",intent.currentRevisionId)!.contentDigest})),reason:"Pending exact set",contentDigest:"d".repeat(64)};records.push(manifest);
 show(<AmendmentsPanel adapter={adapter} flow={flow} records={records} can={()=>true} onDone={()=>undefined}/>);
 fireEvent.change(screen.getByRole("textbox",{name:"Decision reason"}),{target:{value:"Withdraw exact pending set"}});
 fireEvent.click(screen.getByRole("button",{name:"Withdraw whole set"}));await waitFor(()=>expect(posted).toHaveLength(1));
 expect(posted[0]).toMatchObject({command:"requirements.resolve-amendment",expectedVersions:{"flow-demo":1,i1:1,i2:1}});
});

test("Flow-only amendment actually crosses the live command boundary with an empty affected set",async()=>{
 const flow=replacements();records=records.filter(record=>record.kind!=="intent");recordOf(records,"flow-revision","fr2")!.requiredIntentIds=[];
 show(<AmendmentsPanel adapter={adapter} flow={flow} records={records} can={()=>true} onDone={()=>undefined}/>);
 fireEvent.change(screen.getByRole("textbox",{name:"Reason for the requirements change"}),{target:{value:"Review Flow scope only"}});
 fireEvent.click(screen.getByRole("button",{name:"Authorize exact amendment set"}));await waitFor(()=>expect(posted).toHaveLength(1));
 expect(posted[0]).toMatchObject({command:"requirements.amend",payload:{affectedIntentIds:[],replacements:[{targetType:"flow",targetId:flow.id,revisionId:"fr2"}]}});
});

test("cancelled required Intents do not disable Flow approval or appear in revision membership choices",()=>{
 const flow=recordOf(records,"flow","flow-demo")!;flow.state="draft";flow.approvedRevisionId=null;recordOf(records,"intent","i1")!.state="draft";recordOf(records,"intent","i1")!.approvedRevisionId=null;const cancelled=recordOf(records,"intent","i2")!;cancelled.state="cancelled";
 recordOf(records,"flow-revision",flow.currentRevisionId)!.requiredIntentIds=["i1"];
 const rendered=show(<FlowSummary adapter={adapter} flow={flow} records={records} can={command=>command==="requirements.approve"} human prepare={()=>undefined}/>);
 expect(screen.getByRole("button",{name:"Approve requirements"})).toBeEnabled();rendered.unmount();
 show(<RevisionEditor adapter={adapter} flow={flow} records={records} onDone={()=>undefined}/>);
 expect(screen.queryByRole("checkbox",{name:cancelled.title})).not.toBeInTheDocument();
});
