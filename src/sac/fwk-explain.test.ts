import { expect, test } from "bun:test";
import { formatFwkExplain } from "./fwk-explain";
import type { FwkResult } from "./fwk-service";

function receipt(id: string): FwkResult["receipt"] {
  return {
    schemaVersion: "1.0",
    id,
    workspaceId: "workspace-a",
    actor: "user:local",
    action: "overview",
    decision: "allowed",
    recordedAt: "2026-08-14T20:00:00.000Z",
    cost: { toolCalls: 1, elapsedMs: 0 },
    contextAssembly: { traceRef: "./ids/trace", configurationRevision: "v1", selected: ["./ids/knowhow-0"], omittedOptional: [] },
    policy: { ref: "./security/policy/local", revision: "local-offline-v1" },
    integrity: { recordHash: "a".repeat(64), previousRecordHash: "GENESIS" },
  };
}

test("explain labels Facts, Work, and Know-how owners without mixing layers", () => {
  const result: FwkResult = {
    partial: false,
    omittedOptional: [],
    manifest: {
      facts: [{ statement: "Evidence reference ./notes.md", evidence: [{ uri: "./notes.md", revision: "abc" }], freshness: "fresh" }],
      work: { state: "bound", flowRef: { uri: "./.metaproject/flows/153/flow.json", snapshot: "in-progress", revision: "2026-08-14T20:00:00.000Z" }, completed: ["T1"], next: ["T2"], blocked: [] },
      knowHow: [{ kind: "wiki", uri: "./.metaproject/wiki/architecture/project-map.md", revision: "def", status: "fresh" }],
      freshness: "fresh",
    },
    receipt: receipt("receipt-demo"),
  };
  const text = formatFwkExplain(result);
  expect(text).toContain("Facts (1)");
  expect(text).toContain("Work (bound)");
  expect(text).toContain("Know-how (1: wiki=1 memory=0 skill=0)");
  expect(text).toContain("wiki ./");
  expect(text).toContain("SAC does not write flow.json");
  expect(text).toContain("graph nodes/edges (navigation only)");
});

test("explain reports overflow without a fake successful manifest", () => {
  const text = formatFwkExplain({ code: "context_overflow", requiredId: "work" });
  expect(text).toContain("context_overflow");
  expect(text).not.toContain("Know-how");
});
