import {fireEvent,screen,waitFor} from "@testing-library/react";
import {beforeEach,expect,test,vi} from "vitest";
import {renderHub} from "./hub-render";
import type {HubContextValue} from "../src/app/hub-context";
import {resetClient} from "../src/api/client";
import {useDraftStore} from "../src/state/drafts";
import i18n from "../src/i18n";
import {ContributionPanel} from "../src/features/managed-work/contribute";
import {demoWorkAdapter} from "../src/features/managed-work/demo";
import {liveWorkAdapter} from "../src/features/managed-work/adapter";
import {recordOf,recordsOf} from "../src/features/managed-work/model";
import type {WorkRecord} from "../src/features/managed-work/types";
const context:HubContextValue={projectId:"p",scopeKey:78,principal:{id:"human:test",kind:"human",role:"operator"},location:{projectId:"p",tab:"work"},navigate:()=>undefined,refresh:async()=>undefined};
const adapter=liveWorkAdapter("p");let records:WorkRecord[];let posted:Record<string,unknown>[];
beforeEach(async()=>{resetClient();useDraftStore.getState().clearAll();await i18n.changeLanguage("en");records=(await demoWorkAdapter("p").snapshot()).records;const attempt=recordOf(records,"attempt","a-agent")!;attempt.state="running";attempt.submissionId=null;records=records.filter(record=>!(record.kind==="submission"&&record.attemptId===attempt.id));posted=[];vi.spyOn(globalThis,"fetch").mockImplementation(async(_input,init)=>{if(init?.method==="POST"){const command=JSON.parse(String(init.body));posted.push(command);return Response.json({operationId:command.operationId,status:"committed",receiptId:"choice-receipt",entities:[],eventCursor:"next"});}return Response.json({records:[],nextCursor:null,eventCursor:"next"});});});
function open(kind:string,draft:Record<string,string>,button:string){const flow=recordOf(records,"flow","flow-demo")!;const intent=recordOf(records,"intent","i1")!;const attempt=recordOf(records,"attempt","a-agent")!;useDraftStore.getState().put([78,"p","live",flow.id,intent.id,attempt.id,kind].join(":"),draft);renderHub(<ContributionPanel adapter={adapter} records={records} flow={flow} intent={intent} attempt={attempt} can={()=>true} onDone={()=>undefined}/>,context);fireEvent.click(screen.getByRole("button",{name:button}));}

test.each(["subject","criterion"])("live Evidence submits the visible current option when the saved %s no longer exists",async(stale)=>{
 const subject=recordOf(records,"subject","subject-agent")!;const revision=recordOf(records,"intent-revision","iri1")!;
 open("evidence",{subject:subject.id,criterion:revision.criteria[0]!.criterionId,[stale]:"removed-choice",method:"bun test",report:"Observed exact candidate",result:"pass"},"Record evidence");
 expect(screen.getByRole("combobox",{name:"Exact result"})).toHaveValue(subject.id);
 expect(screen.getByRole("combobox",{name:"Criterion"})).toHaveValue(revision.criteria[0]!.criterionId);
 fireEvent.click(screen.getByRole("button",{name:"Confirm"}));await waitFor(()=>expect(posted).toHaveLength(1));
 expect(posted[0]).toMatchObject({command:"evidence.record",payload:{subjectId:subject.id,criterionIds:[revision.criteria[0]!.criterionId]}});
});

test("live Attempt creation uses the context currently displayed after a saved context disappears",async()=>{
 const selected=recordsOf(records,"context").find(record=>record.intentRevisionId==="iri1"&&record.flowRevisionId==="fr1")!;
 open("attempt",{context:"removed-context",method:"human",summary:"Independent manual approach"},"New attempt");
 expect(screen.getByRole("combobox",{name:"Context snapshot"})).toHaveValue(selected.id);
 fireEvent.click(screen.getByRole("button",{name:"Confirm"}));await waitFor(()=>expect(posted).toHaveLength(1));
 expect(posted[0]).toMatchObject({command:"attempt.create",payload:{contextSnapshotId:selected.id}});
});

test("live Intent creation maps to the displayed Flow criterion after the saved criterion disappears",async()=>{
 const revision=recordOf(records,"flow-revision","fr1")!;
 open("intent",{criterion:"removed-flow-criterion",title:"Fresh deliverable",deliverable:"Deliver exact behavior",approach:"Small change",outOfScope:"Unrelated work",criteria:"Current criterion"},"Create draft deliverable");
 fireEvent.click(screen.getByRole("button",{name:"Confirm"}));await waitFor(()=>expect(posted).toHaveLength(1));
 expect(posted[0]).toMatchObject({command:"intent.create",payload:{flowCriterionIds:[revision.criteria[0]!.criterionId]}});
});
