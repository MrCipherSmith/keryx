import { expect, test } from "bun:test";
import { extractFlowIntent } from "./extract";

test("product index preserves exception closure separately from clean completion", () => {
  const exceptions = [{ gate: "health", detail: "released regression", reason: "tracked separately",
    operatorWords: "Да", confirmedVia: "terminal", at: "2026-10-20T10:00:00Z" }];
  const intent = extractFlowIntent({
    flowJson: JSON.stringify({ id: "469", status: "done", signatures: [
      { kind: "complete", cleanCompletion: false, exceptions }, { kind: "ac-confirm" },
    ] }), description: null, criteria: null, journal: null,
  }, ".metaproject/flows/469-test");
  expect(intent.status).toBe("closed");
  expect(intent).toMatchObject({ cleanCompletion: false, exceptions });
});

test("old flow records are unknown, not retrospectively clean", () => {
  const intent = extractFlowIntent({ flowJson: '{"status":"done"}',
    description: null, criteria: null, journal: null }, ".metaproject/flows/001-old");
  expect(Object.hasOwn(intent, "cleanCompletion")).toBe(false);
});

test("an explicitly clean signature stays distinguishable", () => {
  expect(extractFlowIntent({ flowJson: '{"status":"done","signatures":[{"kind":"complete","cleanCompletion":true}]}',
    description: null, criteria: null, journal: null }, "flow")).toMatchObject({ cleanCompletion: true });
});
