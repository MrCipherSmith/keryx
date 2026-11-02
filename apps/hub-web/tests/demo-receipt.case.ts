import {expect,test} from "vitest";
import {demoWorkAdapter} from "../src/features/managed-work/demo";
import {recordOf} from "../src/features/managed-work/model";

test("demo selection receipts expose only the live command result while canonical state contains side effects",async()=>{
 const adapter=demoWorkAdapter("p");const before=await adapter.snapshot();
 const attempt=recordOf(before.records,"attempt","a-agent")!;const intent=recordOf(before.records,"intent",attempt.intentId)!;const submission=recordOf(before.records,"submission",attempt.submissionId)!;
 const receipt=await adapter.command({operationId:"select-exact",command:"attempt.select",expectedVersions:{"flow-demo":1,[intent.id]:intent.version,[attempt.id]:attempt.version},payload:{intentId:intent.id,attemptId:attempt.id,submissionId:submission.id,submissionDigest:submission.contentDigest,reason:"Reviewed exact candidate"}});
 expect(receipt.entities).toHaveLength(1);expect(receipt.entities?.[0]?.kind).toBe("decision");
 const after=await adapter.snapshot();expect(recordOf(after.records,"intent",intent.id)).toMatchObject({selectedSubmissionId:submission.id,version:intent.version+1});
});

test("demo acceptance updates the Intent and emits the canonical intent change",async()=>{
 const adapter=demoWorkAdapter("p");const before=await adapter.snapshot();
 const attempt=recordOf(before.records,"attempt","a-agent")!;const intent=recordOf(before.records,"intent",attempt.intentId)!;const submission=recordOf(before.records,"submission",attempt.submissionId)!;
 await adapter.command({operationId:"select-for-acceptance",command:"attempt.select",expectedVersions:{[intent.id]:intent.version,[attempt.id]:attempt.version},payload:{intentId:intent.id,attemptId:attempt.id,submissionId:submission.id,submissionDigest:submission.contentDigest,reason:"Choose candidate"}});
 const selected=recordOf((await adapter.snapshot()).records,"intent",intent.id)!;
 const receipt=await adapter.command({operationId:"accept-exact",command:"review.decide",expectedVersions:{[intent.id]:selected.version},payload:{targetType:"intent-review",targetId:intent.id,submissionId:submission.id,submissionDigest:submission.contentDigest,decision:"accept",reason:"Reviewed",waivers:[]}});
 const decision=receipt.entities?.[0];expect(decision).toMatchObject({kind:"decision",targetType:"intent-review",targetId:intent.id,decision:"accept"});
 const accepted=recordOf((await adapter.snapshot()).records,"intent",intent.id)!;
 expect(accepted).toMatchObject({state:"accepted",acceptanceDecisionId:decision!.id,version:selected.version+1});
 const events=await adapter.events("2");
 expect(events.events).toHaveLength(2);
 expect(events.events[0]).toMatchObject({type:"intent-changed",entityType:"intent",entityId:intent.id,entityVersion:accepted.version,operationId:"accept-exact"});
 expect(events.events[1]).toMatchObject({type:"decision-recorded",entityType:"decision",entityId:decision!.id,operationId:"accept-exact"});
});
