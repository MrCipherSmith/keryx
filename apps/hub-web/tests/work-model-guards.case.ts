import { expect, test } from "vitest";
import { demoWorkAdapter } from "../src/features/managed-work/demo";
import { amendmentDraft } from "../src/features/managed-work/amendment-model";
import { attentionTarget, resolveAttentionTarget } from "../src/features/managed-work/attention-target";
import { recordOf, recordsOf } from "../src/features/managed-work/model";

test("amendment draft ignores another Intent's revision even when referenced as current", async () => {
  const records = (await demoWorkAdapter("p").snapshot()).records;
  const flow = recordOf(records, "flow", "flow-demo")!;
  const intent = recordOf(records, "intent", "i1")!;
  const foreign = recordOf(records, "intent-revision", "iri2")!;
  intent.currentRevisionId = foreign.id;
  const draft = amendmentDraft(records, flow);
  expect(draft.replacements).toEqual([]);
  expect(draft.affected).toEqual([]);
  expect(draft.complete).toBe(false);
});

test("Flow amendment requires replacements for approved Intents but not an unapproved unaffected Intent", async () => {
  const records = (await demoWorkAdapter("p").snapshot()).records;
  const flow = recordOf(records, "flow", "flow-demo")!;
  const oldFlow = recordOf(records, "flow-revision", flow.currentRevisionId)!;
  flow.currentRevisionId = "fr2";
  records.push({ ...oldFlow, id: "fr2", revision: 2, contentDigest: "b".repeat(64) });
  for (const intent of recordsOf(records, "intent")) {
    const old = recordOf(records, "intent-revision", intent.currentRevisionId)!;
    intent.currentRevisionId = `${old.id}-new`;
    records.push({ ...old, id: intent.currentRevisionId, revision: 2, flowRevisionId: "fr2", contentDigest: "c".repeat(64) });
  }
  const template = recordOf(records, "intent", "i2")!;
  records.push({ ...template, id: "unapproved", title: "Draft", state: "draft", required: false, currentRevisionId: "unapproved-revision", approvedRevisionId: null });
  const draft = amendmentDraft(records, flow);
  expect(draft.affected).toEqual(["i1", "i2"]);
  expect(draft.replacements.map(({ targetId }) => targetId)).toEqual(["flow-demo", "i1", "i2"]);
  expect(draft.expectedVersions).toEqual({ "flow-demo": 1, i1: 1, i2: 1 });
  expect(draft.complete).toBe(true);
});

test("Evidence selects its referenced Attempt even with another cached first", async () => {
  const adapter = demoWorkAdapter("p");
  const records = (await adapter.snapshot()).records;
  const evidence = recordOf(records, "evidence", "ev-agent")!;
  const other = recordOf(records, "attempt", "a-manual")!;
  const target = recordOf(records, "attempt", "a-agent")!;
  expect(attentionTarget(evidence, [other, target])).toEqual({ flowId: "flow-demo", intentId: "i1", attemptId: "a-agent" });
  expect(await resolveAttentionTarget(evidence, [other], adapter)).toEqual({ flowId: "flow-demo", intentId: "i1", attemptId: "a-agent" });
});

test("Evidence rejects a wrong-kind parent returned by the real demo adapter", async () => {
  const adapter = demoWorkAdapter("p");
  const records = (await adapter.snapshot()).records;
  const evidence = { ...recordOf(records, "evidence", "ev-agent")!, attemptId: "flow-demo" };
  expect((await adapter.record(evidence.attemptId)).record.kind).toBe("flow");
  await expect(resolveAttentionTarget(evidence, [], adapter)).rejects.toMatchObject({ code: "invalid-response", status: 502 });
});
