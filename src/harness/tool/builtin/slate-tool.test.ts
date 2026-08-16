// RED tests for SLATE-3a: `slate_read` / `slate_write_seed` (flow 161, AC5).
//
// Mirrors `workspace-context-tool.test.ts`'s style: real temp-dir fixtures
// (matching `slate-lifecycle.test.ts`'s pattern), no mocking of `slate.ts`/
// `slate-lifecycle.ts` internals.
//
// `src/harness/tool/builtin/slate-tool.ts` does NOT exist yet; until T9
// (task-implementer) builds it, EVERY test below fails identically at
// import time — that is the expected RED, not a per-test bug.
//
// PINNED API (T9 implements exactly this surface — see flow 161's T8 dispatch
// report for the full rationale):
//
//   export function slateReadTool(
//     cwd: string,
//     getSessionDir: () => string | undefined,
//   ): InteractiveTool;
//   // name "slate_read", input schema {} (no required fields,
//   // additionalProperties: false), risk "read". invoke() calls
//   // getSessionDir(); undefined -> { isError: true }. Otherwise reads the
//   // slate (readSlate), derives `course` via courseFromSlate(cwd, slate),
//   // and returns { output: JSON.stringify({ course, seeds, workspaceId }),
//   // isError: false }.
//
//   export function slateWriteSeedTool(
//     getSessionDir: () => string | undefined,
//     idSeq: () => string,
//     clock: () => string,
//   ): InteractiveTool;
//   // name "slate_write_seed", input { text: string (required), kind?: one
//   // of the 6 SlateSeedKind values }, risk "read" (a draft hypothesis, not
//   // accepted knowledge — see the T8 report for the risk-classification
//   // rationale). invoke() validates text is a non-empty string (trim),
//   // validates kind if given, calls getSessionDir() (undefined ->
//   // isError), then appendSeed(dir, { id: idSeq(), text: text.trim(),
//   // ts: clock(), ...(kind ? { kind } : {}) }) WRAPPED IN TRY/CATCH —
//   // appendSeed's thrown "no open slate" error must degrade to
//   // { isError: true }, never propagate. On success returns
//   // { output: JSON.stringify({ appended: seed }), isError: false }.

import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { slateReadTool, slateWriteSeedTool } from "./slate-tool";
import { readSlate, writeSlate, type SlateSeedKind } from "../../../session/slate";
import { openSlate } from "../../../session/slate-lifecycle";
import { validateAgainstSchemaObject } from "../../../contracts/validator";

async function tempSessionDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "keryx-slate-tool-dir-"));
}

async function tempCwd(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "keryx-slate-tool-cwd-"));
}

function fixedIdSeq(prefix = "seed"): () => string {
  let counter = 0;
  return () => `${prefix}-${counter++}`;
}

function fixedClock(iso = "2026-08-16T00:00:00.000Z"): () => string {
  return () => iso;
}

// --- slate_read ---------------------------------------------------------

test("slate_read: no active session (getSessionDir returns undefined) is a clear tool error, not a crash", async () => {
  const cwd = await tempCwd();
  const tool = slateReadTool(cwd, () => undefined);

  const result = await tool.invoke({});

  expect(result.isError).toBe(true);
  expect(result.output.toLowerCase()).toContain("no active session");
});

test("slate_read: definition shape mirrors workspace-context-tool.ts — name, empty input schema, risk read", () => {
  const cwd = "/irrelevant";
  const tool = slateReadTool(cwd, () => undefined);

  expect(tool.definition.name).toBe("slate_read");
  expect(tool.definition.risk).toBe("read");
  expect(tool.definition.inputSchema).toMatchObject({
    type: "object",
    additionalProperties: false,
  });
  // No required fields — `slate_read` takes no arguments.
  const schema = tool.definition.inputSchema as { required?: string[] };
  expect(schema.required ?? []).toEqual([]);
});

test("slate_read: against a real open slate with a flowRef and seeds, returns course/seeds/workspaceId as JSON", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  await openSlate({ dir, cwd, mintAttemptId: () => "attempt-0" });
  await writeSlate(dir, (prev) => ({
    ...(prev ?? { anchors: { root: cwd, touched: [] }, course: {}, seeds: [] }),
    workspaceId: "workspace-abc",
    course: { flowRef: "999-does-not-exist" },
    seeds: [{ id: "seed-a", text: "an accepted-looking observation", ts: "2026-08-16T00:00:00.000Z" }],
  }));

  const tool = slateReadTool(cwd, () => dir);
  const result = await tool.invoke({});

  expect(result.isError).toBe(false);
  const parsed = JSON.parse(result.output) as {
    course: { state: string };
    seeds: { id: string; text: string; ts: string }[];
    workspaceId?: string;
  };
  // flowRef "999-does-not-exist" resolves to nothing on disk — courseFromSlate
  // fails closed to "unbound" (its own documented contract), which is still a
  // real, well-formed CourseProjection reaching the model through slate_read.
  expect(parsed.course.state).toBe("unbound");
  expect(parsed.seeds).toEqual([{ id: "seed-a", text: "an accepted-looking observation", ts: "2026-08-16T00:00:00.000Z" }]);
  expect(parsed.workspaceId).toBe("workspace-abc");
});

test("slate_read: against a freshly opened slate with no course/seeds yet, returns an empty-but-well-formed shape", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  await openSlate({ dir, cwd, mintAttemptId: () => "attempt-0" });

  const tool = slateReadTool(cwd, () => dir);
  const result = await tool.invoke({});

  expect(result.isError).toBe(false);
  const parsed = JSON.parse(result.output) as { course: { state: string }; seeds: unknown[]; workspaceId?: string };
  expect(parsed.course).toEqual({ state: "unbound" });
  expect(parsed.seeds).toEqual([]);
  expect(parsed.workspaceId).toBeUndefined();
});

test("F-001: slate_read against a session dir with a MALFORMED slate.json resolves with isError: true, never rejects/throws", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  // Write an invalid-JSON slate.json directly (bypassing writeSlate/openSlate,
  // which would never themselves produce malformed content) to simulate the
  // real failure mode `readSlate` does NOT swallow: it only catches `ENOENT`
  // and rethrows everything else (see slate.ts), so `JSON.parse` throwing on
  // this file is exactly the uncaught-throw path F-001 fixes.
  await writeFile(path.join(dir, "slate.json"), "{not valid json", "utf8");

  const tool = slateReadTool(cwd, () => dir);

  // The critical assertion: invoke() RESOLVES (never rejects) — matching
  // agent.ts's executeCall bare `return tool.invoke(input)` with no
  // try/catch around it. A throwing invoke would crash the whole turn loop.
  await expect(tool.invoke({})).resolves.toBeDefined();

  const result = await tool.invoke({});
  expect(result.isError).toBe(true);
  expect(result.output).toContain("slate_read failed");
});

test("slate_read: never leaks the raw session directory path — only course/seeds/workspaceId content reaches the model", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  await openSlate({ dir, cwd, mintAttemptId: () => "attempt-0" });
  await writeSlate(dir, (prev) => ({
    ...(prev ?? { anchors: { root: cwd, touched: [] }, course: {}, seeds: [] }),
    seeds: [{ id: "s1", text: "some seed text", ts: "2026-08-16T00:00:00.000Z" }],
  }));

  const tool = slateReadTool(cwd, () => dir);
  const result = await tool.invoke({});

  expect(result.output).not.toContain(dir);
});

// --- slate_write_seed ----------------------------------------------------

test("slate_write_seed: no active session (getSessionDir returns undefined) is a clear tool error, not a crash", async () => {
  const tool = slateWriteSeedTool(() => undefined, fixedIdSeq(), fixedClock());

  const result = await tool.invoke({ text: "a real observation" });

  expect(result.isError).toBe(true);
});

test("slate_write_seed: definition shape mirrors workspace-context-tool.ts — name, required text, optional kind enum, risk read", () => {
  const tool = slateWriteSeedTool(() => undefined, fixedIdSeq(), fixedClock());

  expect(tool.definition.name).toBe("slate_write_seed");
  expect(tool.definition.risk).toBe("read");
  const schema = tool.definition.inputSchema as {
    required?: string[];
    properties: Record<string, { type?: string; enum?: string[] }>;
  };
  expect(schema.required).toEqual(["text"]);
  expect(schema.properties.text?.type).toBe("string");
  const kindEnum: SlateSeedKind[] = ["decision", "wiki-update", "memory-entry", "follow-up", "contract-change", "risk"];
  expect(schema.properties.kind?.enum?.slice().sort()).toEqual([...kindEnum].sort());
});

test("slate_write_seed: against an OPEN slate with valid text, appends the seed with the INJECTED id/clock (never Date.now/randomUUID) and reports it back", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  await openSlate({ dir, cwd, mintAttemptId: () => "attempt-0" });

  const tool = slateWriteSeedTool(() => dir, fixedIdSeq("seed"), fixedClock("2026-08-16T01:02:03.000Z"));
  const result = await tool.invoke({ text: "  the deploy pipeline needs a rollback step  " });

  expect(result.isError).toBe(false);
  const parsed = JSON.parse(result.output) as { appended: { id: string; text: string; ts: string; kind?: string } };
  expect(parsed.appended.id).toBe("seed-0");
  expect(parsed.appended.ts).toBe("2026-08-16T01:02:03.000Z");
  // Text is trimmed before being persisted.
  expect(parsed.appended.text).toBe("the deploy pipeline needs a rollback step");
  expect(parsed.appended.kind).toBeUndefined();

  const persisted = await readSlate(dir);
  expect(persisted?.seeds).toEqual([
    { id: "seed-0", text: "the deploy pipeline needs a rollback step", ts: "2026-08-16T01:02:03.000Z" },
  ]);
});

test("slate_write_seed: a valid kind is persisted verbatim on the appended seed", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  await openSlate({ dir, cwd, mintAttemptId: () => "attempt-0" });

  const tool = slateWriteSeedTool(() => dir, fixedIdSeq("seed"), fixedClock());
  const result = await tool.invoke({ text: "consider a wiki update here", kind: "wiki-update" });

  expect(result.isError).toBe(false);
  const persisted = await readSlate(dir);
  expect(persisted?.seeds[0]?.kind).toBe("wiki-update");
});

test("slate_write_seed: against a session dir with NO open slate, degrades to isError WITHOUT the invoke() call itself throwing — appendSeed's thrown error must never propagate", async () => {
  const dir = await tempSessionDir(); // never opened — no slate.json exists
  const tool = slateWriteSeedTool(() => dir, fixedIdSeq(), fixedClock());

  // The critical assertion: invoke() RESOLVES (never rejects), matching
  // agent.ts's executeCall bare `return tool.invoke(input)` with no
  // try/catch around it — a throwing invoke would crash the whole turn loop.
  await expect(tool.invoke({ text: "an observation with nowhere to land" })).resolves.toBeDefined();

  const result = await tool.invoke({ text: "an observation with nowhere to land" });
  expect(result.isError).toBe(true);
  expect(await readSlate(dir)).toBeUndefined();
});

test("slate_write_seed: an unrecognized kind is rejected explicitly (not silently dropped/coerced) and nothing is appended", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  await openSlate({ dir, cwd, mintAttemptId: () => "attempt-0" });

  const tool = slateWriteSeedTool(() => dir, fixedIdSeq(), fixedClock());
  const result = await tool.invoke({ text: "a valid seed text", kind: "not-a-real-kind" });

  expect(result.isError).toBe(true);
  const persisted = await readSlate(dir);
  expect(persisted?.seeds).toEqual([]);
});

test("slate_write_seed: empty/whitespace-only text is rejected and nothing is appended", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  await openSlate({ dir, cwd, mintAttemptId: () => "attempt-0" });

  const tool = slateWriteSeedTool(() => dir, fixedIdSeq(), fixedClock());

  const empty = await tool.invoke({ text: "" });
  expect(empty.isError).toBe(true);

  const whitespace = await tool.invoke({ text: "   \n\t  " });
  expect(whitespace.isError).toBe(true);

  const missing = await tool.invoke({});
  expect(missing.isError).toBe(true);

  const persisted = await readSlate(dir);
  expect(persisted?.seeds).toEqual([]);
});

// --- F-002: bound + redact the slate_write_seed write path --------------

test("F-002: slate_write_seed's inputSchema enforces a maxLength on 'text', rejected at the schema-validation layer BEFORE invoke() ever runs (mirrors executeCall's own pre-invoke validation call)", () => {
  const tool = slateWriteSeedTool(() => undefined, fixedIdSeq(), fixedClock());

  const oversized = validateAgainstSchemaObject(tool.definition.inputSchema, { text: "x".repeat(4001) });
  expect(oversized.valid).toBe(false);
  expect(oversized.errors.some((e) => e.path.includes("text"))).toBe(true);

  // A right-at-the-bound length is still accepted — the cap is inclusive.
  const atBound = validateAgainstSchemaObject(tool.definition.inputSchema, { text: "x".repeat(4000) });
  expect(atBound.valid).toBe(true);
});

test("F-002: slate_write_seed redacts a secret-shaped seed text BEFORE it is persisted to slate.json — a leaked credential never hits disk", async () => {
  const dir = await tempSessionDir();
  const cwd = await tempCwd();
  await openSlate({ dir, cwd, mintAttemptId: () => "attempt-0" });

  // Same GitHub-token-shaped fixture `redact.test.ts` uses for a realistic,
  // detector-recognized secret.
  const token = `ghp_${"A".repeat(36)}`;
  const tool = slateWriteSeedTool(() => dir, fixedIdSeq(), fixedClock());
  const result = await tool.invoke({ text: `remember this token=${token} for later` });

  expect(result.isError).toBe(false);
  expect(result.output).not.toContain(token);
  expect(result.output).toContain("[REDACTED:");

  const persisted = await readSlate(dir);
  const storedText = persisted?.seeds[0]?.text ?? "";
  expect(storedText).not.toContain(token);
  expect(storedText).toContain("[REDACTED:");
});
