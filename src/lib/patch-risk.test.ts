import { expect, test } from "bun:test";
import { classifyPatchRisk, extractPatchText, MAX_FILES_BEFORE_ESCALATION, parsePatchTargets } from "./patch-risk";

function modifyHunk(path: string): string {
  return [`--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-old", "+new", ""].join("\n");
}

function createHunk(path: string): string {
  return ["--- /dev/null", `+++ b/${path}`, "@@ -0,0 +1,1 @@", "+new file", ""].join("\n");
}

function deleteHunk(path: string): string {
  return [`--- a/${path}`, "+++ /dev/null", "@@ -1,1 +0,0 @@", "-gone", ""].join("\n");
}

test("parsePatchTargets: modify, create, delete are each classified correctly", () => {
  expect(parsePatchTargets(modifyHunk("src/a.ts"))).toEqual([{ path: "src/a.ts", action: "modify" }]);
  expect(parsePatchTargets(createHunk("src/b.ts"))).toEqual([{ path: "src/b.ts", action: "create" }]);
  expect(parsePatchTargets(deleteHunk("src/c.ts"))).toEqual([{ path: "src/c.ts", action: "delete" }]);
});

test("parsePatchTargets: a multi-file patch yields one target per file, in order", () => {
  const patch = modifyHunk("src/a.ts") + createHunk("src/b.ts") + deleteHunk("src/c.ts");
  expect(parsePatchTargets(patch)).toEqual([
    { path: "src/a.ts", action: "modify" },
    { path: "src/b.ts", action: "create" },
    { path: "src/c.ts", action: "delete" },
  ]);
});

test("parsePatchTargets: malformed or non-diff input yields no targets, never throws", () => {
  expect(parsePatchTargets("")).toEqual([]);
  expect(parsePatchTargets("not a diff at all\njust some text")).toEqual([]);
  expect(parsePatchTargets("+++ b/orphan.ts (no preceding --- line)")).toEqual([]);
});

test("parsePatchTargets: a trailing tab-separated timestamp is stripped", () => {
  const patch = ["--- a/src/a.ts\t2026-01-01 00:00:00", "+++ b/src/a.ts\t2026-01-02 00:00:00", "@@ -1 +1 @@", "-x", "+y", ""].join("\n");
  expect(parsePatchTargets(patch)).toEqual([{ path: "src/a.ts", action: "modify" }]);
});

test("classifyPatchRisk: an ordinary 1-3 file modify is neither destructive nor a credential touch", () => {
  const patch = modifyHunk("src/a.ts") + modifyHunk("src/b.ts");
  const result = classifyPatchRisk(patch);
  expect(result.destructive).toBe(false);
  expect(result.credentials).toBe(false);
  expect(result.reasons).toEqual([]);
});

test("classifyPatchRisk: deleting any file escalates to destructive, with a named reason", () => {
  const result = classifyPatchRisk(modifyHunk("src/a.ts") + deleteHunk("src/old.ts"));
  expect(result.destructive).toBe(true);
  expect(result.credentials).toBe(false);
  expect(result.reasons.some((r) => r.includes("deletes") && r.includes("src/old.ts"))).toBe(true);
});

test("classifyPatchRisk: touching .git/ directly escalates to destructive", () => {
  const result = classifyPatchRisk(modifyHunk(".git/config"));
  expect(result.destructive).toBe(true);
  expect(result.reasons.some((r) => r.includes(".git"))).toBe(true);
});

test(`classifyPatchRisk: more than ${MAX_FILES_BEFORE_ESCALATION} files in one call escalates to destructive`, () => {
  const many = Array.from({ length: MAX_FILES_BEFORE_ESCALATION + 1 }, (_unused, i) => modifyHunk(`src/f${i}.ts`)).join("");
  const result = classifyPatchRisk(many);
  expect(result.destructive).toBe(true);
  expect(result.reasons.some((r) => r.includes("files in one call"))).toBe(true);
});

test(`classifyPatchRisk: exactly ${MAX_FILES_BEFORE_ESCALATION} files does NOT escalate on file count alone`, () => {
  const exact = Array.from({ length: MAX_FILES_BEFORE_ESCALATION }, (_unused, i) => modifyHunk(`src/f${i}.ts`)).join("");
  const result = classifyPatchRisk(exact);
  expect(result.destructive).toBe(false);
});

test("classifyPatchRisk: a target path touching the agent's own credential files is a hard floor", () => {
  const result = classifyPatchRisk(modifyHunk(".local/share/keryx/permissions.json"));
  expect(result.credentials).toBe(true);
  expect(result.reasons.some((r) => r.includes("credential"))).toBe(true);
});

test("classifyPatchRisk: credentials and destructive are independent — a benign single-file credential touch is not also 'destructive'", () => {
  const result = classifyPatchRisk(modifyHunk(".local/share/keryx/permissions.json"));
  expect(result.credentials).toBe(true);
  expect(result.destructive).toBe(false);
});

test("extractPatchText: pulls 'patch' out of the tool's JSON input", () => {
  const patch = modifyHunk("src/a.ts");
  expect(extractPatchText(JSON.stringify({ patch }))).toBe(patch);
});

test("extractPatchText: falls back to the raw string when input is not JSON with a 'patch' field", () => {
  const raw = "not json at all";
  expect(extractPatchText(raw)).toBe(raw);
  expect(extractPatchText(JSON.stringify({ other: "field" }))).toBe(JSON.stringify({ other: "field" }));
});

test("classifyPatchRisk: empty/non-diff input is not destructive and touches no credentials", () => {
  const result = classifyPatchRisk("");
  expect(result).toEqual({ destructive: false, credentials: false, reasons: [] });
});
