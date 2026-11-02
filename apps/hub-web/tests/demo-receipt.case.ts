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
