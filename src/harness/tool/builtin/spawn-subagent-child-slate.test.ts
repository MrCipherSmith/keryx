// RED tests for flow 163 (Slate Phase 4), Track A — SLATE-6 subagent
// ephemeral slate (frozen AC1/AC2/AC3). See
// `.metaproject/flows/163-2026-08-16-slate-phase-4-ephemeral-subagent-slate-a/
// {description.md,plan.md,acceptance-criteria.md}` for the frozen scope this
// pins.
//
// NOT YET IMPLEMENTED (this whole file is expected RED until task-implementer
// lands Track A): `spawn-subagent-tool.ts`'s `invoke()` today builds only a
// hardcoded child system string (no Anchors block), never touches
// `slate.json` at all, and `SpawnSubagentToolDeps` has no `slateSession`
// field. Every test below that opens a parent slate and expects
// `slate.childDispatches` to gain an entry will fail until that lands
// (either at compile time, if `slateSession` is not yet a recognized field,
// or at assertion time, if the field is accepted but ignored).
//
// DEVIATION FROM plan.md (documented per the tests-creator dispatch brief):
// none for the deps/type surface — `SpawnSubagentToolDeps.slateSession?:
// SlateSessionRef` is exactly what plan.md's Track A step 4 suggests, and
// `SlateChildDispatch`/`Slate` are the real, already-shipped types from
// `src/session/slate.ts` (Phase 2). The one thing this file does NOT
// prescribe is the exact ephemeral-tempdir naming scheme or the exact
// dispatchId minting call — plan.md leaves both to implementer discretion
// ("e.g. `keryx-subagent-slate-<dispatchId>`", "reuse an id already computed
// in invoke()"), so the tests below discover the dispatchId from
// `Object.keys(slate.childDispatches)` rather than predicting it, and prove
// tempdir cleanup by diffing `os.tmpdir()`'s listing before/after rather than
// asserting a specific directory name.
//
// AC2/AC3 RIGOR (per the launch brief): "unreachable after dispatch returns"
// is proven by ACTIVELY trying several other paths to reach the child's Seed
// text (the parent's own `slate.seeds`, a fresh `readSlate` on the parent
// dir, a raw string search over the parent's persisted `slate.json`, and the
// OS tempdir listing) and confirming every one of them comes up empty except
// the one sanctioned path (`childDispatches[dispatchId].seeds`) — not merely
// asserting that path looks right in isolation.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSpawnSubagentTool, ENV_SUBAGENT_TIMEOUT_MS } from "./spawn-subagent-tool";
import type { SpawnSubagentToolDeps } from "./spawn-subagent-tool";
import { openSlate } from "../../../session/slate-lifecycle";
import { readSlate } from "../../../session/slate";
import type { NormalizedEvent, ProviderDescription, ProviderPort, NormalizedRequest } from "../../provider/types";

const DESCRIPTION: ProviderDescription = {
  capabilities: {
    streaming: true,
    toolCalls: true,
    parallelToolCalls: false,
    structuredOutput: false,
    reasoningMetadata: false,
    promptCaching: false,
    vision: false,
    tokenCounting: false,
    modelListing: false,
  },
  descriptor: { providerId: "scripted" },
};

/** A child provider that calls `slate_write_seed` once with a marker, then finishes with plain text. */
function seedWritingProvider(marker: string, captured: NormalizedRequest[]): ProviderPort {
  let call = 0;
  return {
    describe: () => DESCRIPTION,
    stream: (request, opts) => {
      captured.push(request);
      const round = call;
      call += 1;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        if (round === 0) {
          yield {
            kind: "tool_call_start",
            sequence: 0,
            attemptId: opts.attemptId,
            toolCallId: "c1",
            toolName: "slate_write_seed",
          };
          yield {
            kind: "tool_call_end",
            sequence: 1,
            attemptId: opts.attemptId,
            toolCallId: "c1",
            input: JSON.stringify({ text: marker, kind: "follow-up" }),
          };
          yield { kind: "model_end", sequence: 2, attemptId: opts.attemptId };
        } else {
          yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: "child finished the task" };
          yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
        }
      })();
    },
  };
}

/** A child provider that never yields and never returns (M4b-style hang, reused from spawn-subagent-lifecycle.test.ts's pattern). */
function hangingProvider(): ProviderPort {
  return {
    describe: () => DESCRIPTION,
    stream: () =>
      (async function* (): AsyncGenerator<NormalizedEvent> {
        await new Promise(() => {});
      })(),
  };
}

/** A plain, fast, no-tool-call child provider that captures the request it received. */
function plainProvider(text: string, captured: NormalizedRequest[]): ProviderPort {
  return {
    describe: () => DESCRIPTION,
    stream: (request, opts) => {
      captured.push(request);
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text };
        yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
      })();
    },
  };
}

async function tempParentDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "keryx-spawn-child-slate-parent-"));
}

function toolDeps(
  overrides: Partial<SpawnSubagentToolDeps> & { makeProvider: SpawnSubagentToolDeps["makeProvider"] },
): SpawnSubagentToolDeps {
  let seq = 0;
  return {
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "anthropic", modelId: "claude-sonnet-5" }),
    getDetectedProviders: () => [{ name: "anthropic" }],
    idSeq: () => `id-${seq++}`,
    clock: () => "2026-08-16T00:00:00.000Z",
    ...overrides,
  };
}

// --- AC1: spawn-subagent-tool.ts never itself calls flow complete / workspace
// propose / workspace review, even after this task wires the child's
// ephemeral slate tool in. Cheap, permanent insurance per plan.md Track A
// step 6 — a source-text audit, not a behavioral test, matching this repo's
// existing convention for this exact class of invariant (see
// shell.test.ts's / tui-shell.test.ts's own source-text audits). This test
// passes today (the calls genuinely do not exist yet) and stays a permanent
// guard once Track A lands its child-tool wiring — it is not expected to be
// RED, unlike the rest of this file.

test("AC1: spawn-subagent-tool.ts source never calls flow complete / workspace propose / workspace review", () => {
  const source = readFileSync(path.join(import.meta.dir, "spawn-subagent-tool.ts"), "utf8");
  expect(source).not.toMatch(/flow\s+complete/);
  expect(source).not.toMatch(/workspace\s+propose/);
  expect(source).not.toMatch(/workspace\s+review/);
  expect(source).not.toContain("ProposalLifecycleService");
  expect(source).not.toContain("wrapUpAuthority");
  expect(source).not.toContain(".review(");
});

// --- SLATE-6: fresh child Anchors assembled + injected into child history --

test("SLATE-6: the child's history carries a rendered Anchors block (renderAnchorsBlock output), assembled fresh at dispatch time", async () => {
  const captured: NormalizedRequest[] = [];
  const tool = createSpawnSubagentTool(toolDeps({ makeProvider: () => plainProvider("ok", captured), cwd: process.cwd() }));
  const result = await tool.invoke({ task: "look around the repo", mode: "read_only" });
  expect(result.isError).toBe(false);
  expect(captured.length).toBeGreaterThan(0);

  const firstRequest = captured[0]!;
  // `renderAnchorsBlock` (src/session/slate.ts) always starts its output with
  // the literal line "Anchors:" followed by a "root: <path>" line — this is
  // the cheapest unambiguous fingerprint that a real Anchors block (not just
  // the existing hardcoded system string) reached the child, without this
  // test having to duplicate `renderAnchorsBlock`'s own rendering logic.
  const hasAnchorsMessage = firstRequest.messages.some(
    (message) => typeof message.content === "string" && message.content.includes("Anchors:") && message.content.includes("root:"),
  );
  expect(hasAnchorsMessage).toBe(true);
});

// --- SLATE-6/AC2: the child gets a real (ephemeral) slate to write Seeds
// into, and on return it is folded into parent.slate.childDispatches[id] —
// never merged into the parent's own seeds/anchors/course. --------------

test("AC2: a child's Seed lands only in parent.slate.childDispatches[dispatchId], never in the parent's own seeds/anchors/course", async () => {
  const parentDir = await tempParentDir();
  const parentCwd = process.cwd();
  const parentBefore = await openSlate({ dir: parentDir, cwd: parentCwd, mintAttemptId: () => "parent-open-1" });

  const marker = "CHILD-SEED-MARKER-AC2-9f3a";
  const captured: NormalizedRequest[] = [];
  const tool = createSpawnSubagentTool(
    toolDeps({
      makeProvider: () => seedWritingProvider(marker, captured),
      cwd: parentCwd,
      slateSession: { dir: parentDir, cwd: parentCwd, opened: true },
    }),
  );

  const result = await tool.invoke({ task: "record a follow-up seed", mode: "general" });
  expect(result.isError).toBe(false);

  const parentAfter = await readSlate(parentDir);
  expect(parentAfter).toBeDefined();
  if (!parentAfter) return;

  // The parent's OWN seeds/anchors/course must be byte-for-byte identical to
  // what `openSlate` produced before the dispatch ran — a naive integration
  // that appended the child's Seed to `prev.seeds` instead of
  // `prev.childDispatches` would fail exactly this assertion.
  expect(parentAfter.seeds).toEqual(parentBefore.seeds);
  expect(parentAfter.anchors).toEqual(parentBefore.anchors);
  expect(parentAfter.course).toEqual(parentBefore.course);

  const dispatchIds = Object.keys(parentAfter.childDispatches ?? {});
  expect(dispatchIds).toHaveLength(1);
  const dispatch = parentAfter.childDispatches![dispatchIds[0]!]!;
  expect(dispatch.status).toBe("completed");
  expect(dispatch.seeds.some((seed) => seed.text.includes(marker))).toBe(true);
  // The dispatch snapshot carries its OWN anchors/course — not the parent's —
  // proving the child had a genuinely separate slate, not a shared one.
  expect(dispatch.anchors).toBeDefined();
  expect(dispatch.course).toBeDefined();
});

test("AC3: after the dispatch returns, the child's Seed is unreachable through every other path — parent slate_read-shaped state, a fresh disk read, and the OS tempdir", async () => {
  const parentDir = await tempParentDir();
  const parentCwd = process.cwd();
  await openSlate({ dir: parentDir, cwd: parentCwd, mintAttemptId: () => "parent-open-1" });

  const marker = "CHILD-SEED-MARKER-AC3-7bd1";
  const captured: NormalizedRequest[] = [];
  const tmpEntriesBefore = new Set(await readdir(tmpdir()));

  const tool = createSpawnSubagentTool(
    toolDeps({
      makeProvider: () => seedWritingProvider(marker, captured),
      cwd: parentCwd,
      slateSession: { dir: parentDir, cwd: parentCwd, opened: true },
    }),
  );
  const result = await tool.invoke({ task: "record a follow-up seed", mode: "general" });
  expect(result.isError).toBe(false);

  // Path 1: the parent's own top-level seeds array (what slate_read would see
  // for the PARENT's session) must not contain the marker.
  const parentSlate = await readSlate(parentDir);
  expect(parentSlate).toBeDefined();
  if (!parentSlate) return;
  expect(parentSlate.seeds.some((seed) => seed.text.includes(marker))).toBe(false);

  // Path 2: a raw read of the persisted slate.json — the marker must appear
  // EXACTLY where childDispatches puts it, not floating anywhere else in the
  // file (e.g. accidentally duplicated into a top-level field by a bug).
  const raw = await readFile(path.join(parentDir, "slate.json"), "utf8");
  const occurrences = raw.split(marker).length - 1;
  expect(occurrences).toBe(1);
  const parsed = JSON.parse(raw) as { childDispatches?: Record<string, { seeds: { text: string }[] }> };
  const dispatchIds = Object.keys(parsed.childDispatches ?? {});
  expect(dispatchIds).toHaveLength(1);
  expect(parsed.childDispatches![dispatchIds[0]!]!.seeds.some((seed) => seed.text.includes(marker))).toBe(true);

  // Path 3: the ephemeral child session dir must be gone — "destroyed
  // immediately after handoff" per the spec (plan.md Track A step 3). Proven
  // by diffing the OS tempdir's listing before/after rather than predicting
  // an exact directory name (implementer discretion per plan.md).
  const tmpEntriesAfter = new Set(await readdir(tmpdir()));
  const newEntries = [...tmpEntriesAfter].filter((entry) => !tmpEntriesBefore.has(entry));
  const leakedSlateDirs = newEntries.filter((entry) => entry.toLowerCase().includes("subagent") || entry.toLowerCase().includes("slate"));
  expect(leakedSlateDirs).toEqual([]);
});

test("AC3: on a child timeout, the fold still happens with status 'incomplete' and the ephemeral dir is still cleaned up (try/finally, not merely the happy path)", async () => {
  const prev = process.env[ENV_SUBAGENT_TIMEOUT_MS];
  process.env[ENV_SUBAGENT_TIMEOUT_MS] = "150";
  try {
    const parentDir = await tempParentDir();
    const parentCwd = process.cwd();
    await openSlate({ dir: parentDir, cwd: parentCwd, mintAttemptId: () => "parent-open-1" });
    const tmpEntriesBefore = new Set(await readdir(tmpdir()));

    const tool = createSpawnSubagentTool(
      toolDeps({
        makeProvider: () => hangingProvider(),
        cwd: parentCwd,
        slateSession: { dir: parentDir, cwd: parentCwd, opened: true },
      }),
    );
    const result = await tool.invoke({ task: "hang forever", mode: "general" });
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/timed out/i);

    const parentSlate = await readSlate(parentDir);
    expect(parentSlate).toBeDefined();
    if (!parentSlate) return;
    const dispatchIds = Object.keys(parentSlate.childDispatches ?? {});
    expect(dispatchIds).toHaveLength(1);
    expect(parentSlate.childDispatches![dispatchIds[0]!]!.status).toBe("incomplete");

    const tmpEntriesAfter = new Set(await readdir(tmpdir()));
    const newEntries = [...tmpEntriesAfter].filter((entry) => !tmpEntriesBefore.has(entry));
    const leakedSlateDirs = newEntries.filter((entry) => entry.toLowerCase().includes("subagent") || entry.toLowerCase().includes("slate"));
    expect(leakedSlateDirs).toEqual([]);
  } finally {
    if (prev === undefined) delete process.env[ENV_SUBAGENT_TIMEOUT_MS];
    else process.env[ENV_SUBAGENT_TIMEOUT_MS] = prev;
  }
});

test("two spawns against the same parent slateSession fold into two distinct childDispatches keys, neither overwriting the other", async () => {
  const parentDir = await tempParentDir();
  const parentCwd = process.cwd();
  await openSlate({ dir: parentDir, cwd: parentCwd, mintAttemptId: () => "parent-open-1" });

  const markerA = "CHILD-SEED-MARKER-A-111";
  const markerB = "CHILD-SEED-MARKER-B-222";
  const capturedA: NormalizedRequest[] = [];
  const capturedB: NormalizedRequest[] = [];

  const tool = createSpawnSubagentTool(
    toolDeps({
      makeProvider: () => seedWritingProvider(markerA, capturedA),
      cwd: parentCwd,
      slateSession: { dir: parentDir, cwd: parentCwd, opened: true },
    }),
  );
  await tool.invoke({ task: "first dispatch", mode: "general", label: "first" });

  // Reuse the SAME tool instance (one shell run, one ledger) for the second
  // spawn — mirrors how a real turn would issue two `spawn_subagent` calls in
  // sequence — but the second call's provider factory returns a DIFFERENT
  // scripted provider so its marker is distinguishable.
  const tool2 = createSpawnSubagentTool(
    toolDeps({
      makeProvider: () => seedWritingProvider(markerB, capturedB),
      cwd: parentCwd,
      slateSession: { dir: parentDir, cwd: parentCwd, opened: true },
    }),
  );
  await tool2.invoke({ task: "second dispatch", mode: "general", label: "second" });

  const parentSlate = await readSlate(parentDir);
  expect(parentSlate).toBeDefined();
  if (!parentSlate) return;
  const dispatchIds = Object.keys(parentSlate.childDispatches ?? {});
  expect(dispatchIds).toHaveLength(2);
  const allSeedText = dispatchIds.flatMap((id) => parentSlate.childDispatches![id]!.seeds.map((seed) => seed.text)).join("\n");
  expect(allSeedText).toContain(markerA);
  expect(allSeedText).toContain(markerB);
});

test("with no slateSession configured, the tool still completes normally and never throws building/folding a child slate", async () => {
  const tool = createSpawnSubagentTool(toolDeps({ makeProvider: () => plainProvider("ok", []) }));
  const result = await tool.invoke({ task: "no parent slate available", mode: "read_only" });
  expect(result.isError).toBe(false);
});

// --- F-001 fix regression test (flow 163 fix round, logic reviewer MAJOR
// finding): a `slate_write_seed` write that only arrives AFTER the
// timeout-driven `foldChildSlateAndCleanup("incomplete")` has already run
// must never resurrect the just-deleted `ephemeralDir`. `runAgentTurn` has
// no cancellation seam — `void turn.catch(() => {})` merely stops the parent
// from AWAITING the abandoned turn, it does not stop the turn's own event
// loop from continuing to run in the background and invoking real tools —
// so a provider that only proceeds to its `slate_write_seed` call AFTER an
// externally-controlled gate is released (well after the parent's own
// `tool.invoke()` call has already returned "timed out") deterministically
// reproduces the exact race the finding describes, without depending on real
// filesystem timing lining up with a wall-clock deadline. ---------------

/** A child provider that stalls (via `gate`) before emitting a single
 * `slate_write_seed` tool call for `marker`, then finishes — used to land a
 * write strictly AFTER the parent's timeout/cleanup has already completed. */
function gatedSeedWritingProvider(marker: string, gate: Promise<void>): ProviderPort {
  return {
    describe: () => DESCRIPTION,
    stream: (_request, opts) =>
      (async function* (): AsyncGenerator<NormalizedEvent> {
        await gate;
        yield {
          kind: "tool_call_start",
          sequence: 0,
          attemptId: opts.attemptId,
          toolCallId: "late-1",
          toolName: "slate_write_seed",
        };
        yield {
          kind: "tool_call_end",
          sequence: 1,
          attemptId: opts.attemptId,
          toolCallId: "late-1",
          input: JSON.stringify({ text: marker, kind: "follow-up" }),
        };
        yield { kind: "model_end", sequence: 2, attemptId: opts.attemptId };
      })(),
  };
}

test("F-001: a slate_write_seed write that arrives after timeout-driven cleanup begins must NOT resurrect the deleted ephemeral dir", async () => {
  const prevEnv = process.env[ENV_SUBAGENT_TIMEOUT_MS];
  process.env[ENV_SUBAGENT_TIMEOUT_MS] = "80";
  try {
    const parentDir = await tempParentDir();
    const parentCwd = process.cwd();
    await openSlate({ dir: parentDir, cwd: parentCwd, mintAttemptId: () => "parent-open-1" });

    const marker = "CHILD-SEED-MARKER-F001-LATE-WRITE";
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const tmpEntriesBefore = new Set(await readdir(tmpdir()));

    const tool = createSpawnSubagentTool(
      toolDeps({
        makeProvider: () => gatedSeedWritingProvider(marker, gate),
        cwd: parentCwd,
        slateSession: { dir: parentDir, cwd: parentCwd, opened: true },
      }),
    );

    // The provider never progresses (it awaits `gate`, which this test has
    // not released yet), so the deadline fires first: the parent's
    // `spawn_subagent` call must already report a timeout, and
    // `foldChildSlateAndCleanup("incomplete")` must already have run — with
    // NO seeds folded, since the child never got a chance to write anything
    // before the deadline hit.
    const result = await tool.invoke({ task: "stall until released, then try to write a seed", mode: "general" });
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/timed out/i);

    const parentAfterTimeout = await readSlate(parentDir);
    expect(parentAfterTimeout).toBeDefined();
    if (!parentAfterTimeout) return;
    const dispatchIdsAfterTimeout = Object.keys(parentAfterTimeout.childDispatches ?? {});
    expect(dispatchIdsAfterTimeout).toHaveLength(1);
    const dispatchId = dispatchIdsAfterTimeout[0]!;
    expect(parentAfterTimeout.childDispatches![dispatchId]!.status).toBe("incomplete");
    expect(parentAfterTimeout.childDispatches![dispatchId]!.seeds).toEqual([]);

    // NOW release the gate: the abandoned turn (never actually cancelled)
    // proceeds to call `slate_write_seed` for real, racing against the
    // cleanup that has ALREADY finished above. Pre-fix, `slateWriteSeedTool`'s
    // dir-getter still resolved to the just-deleted `ephemeralDir`, and
    // `appendSeed`/`writeSlate`'s unconditional `mkdir` silently recreated
    // it (a permanent leak — nothing ever revisits `ephemeralDir` again).
    releaseGate();
    // Give the abandoned turn's event loop a real chance to process the
    // tool call and attempt (and, pre-fix, complete) the write.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // No directory was resurrected under the OS tempdir.
    const tmpEntriesAfter = new Set(await readdir(tmpdir()));
    const newEntries = [...tmpEntriesAfter].filter((entry) => !tmpEntriesBefore.has(entry));
    const leakedSlateDirs = newEntries.filter(
      (entry) => entry.toLowerCase().includes("subagent") || entry.toLowerCase().includes("slate"),
    );
    expect(leakedSlateDirs).toEqual([]);

    // The parent's own dispatch snapshot is unchanged, and the marker text
    // never landed anywhere reachable on disk.
    const parentAfterLateWrite = await readSlate(parentDir);
    expect(parentAfterLateWrite).toBeDefined();
    if (!parentAfterLateWrite) return;
    expect(parentAfterLateWrite.childDispatches![dispatchId]!.seeds).toEqual([]);
    const raw = await readFile(path.join(parentDir, "slate.json"), "utf8");
    expect(raw.includes(marker)).toBe(false);
  } finally {
    if (prevEnv === undefined) delete process.env[ENV_SUBAGENT_TIMEOUT_MS];
    else process.env[ENV_SUBAGENT_TIMEOUT_MS] = prevEnv;
  }
});

// --- F-003 fix regression test (flow 163 fix round, logic reviewer MAJOR
// finding): when `deps.slateSession` points at a dir with no live
// `slate.json` (i.e. a caller wired a `slateSession` ref without ever
// calling `openSlate` on it — a caller-contract violation), the fold must
// throw internally (caught by the surrounding best-effort try/catch) rather
// than synthesizing a brand-new parent `Slate` out of the CHILD's own
// Anchors. The old fallback made the child's freshly-computed Anchors become
// the new PARENT slate's own top-level `.anchors` field — a literal AC2
// violation ("A subagent's Seeds/Anchors/Course never appear in the parent's
// own slate.anchors/.course/.seeds fields"). ---------------------------

test("F-003: a slateSession dir with no live slate.json never gets a synthesized parent Slate written to it", async () => {
  // Deliberately NOT `openSlate`'d — mirrors the exact caller-contract
  // violation F-003 addresses: a `slateSession` ref pointing at a dir with
  // no `slate.json` on disk at all.
  const parentDir = await tempParentDir();
  const parentCwd = process.cwd();

  const marker = "CHILD-SEED-MARKER-F003-NO-PARENT-SLATE";
  const captured: NormalizedRequest[] = [];
  const tool = createSpawnSubagentTool(
    toolDeps({
      makeProvider: () => seedWritingProvider(marker, captured),
      cwd: parentCwd,
      slateSession: { dir: parentDir, cwd: parentCwd, opened: true },
    }),
  );

  // The dispatch itself must still succeed — a fold failure is best-effort
  // and must never mask the caller's already-computed dispatch outcome
  // (this file's own AC2/AC3 fold try/catch convention, documented at
  // `foldChildSlateAndCleanup`'s own doc comment in spawn-subagent-tool.ts).
  const result = await tool.invoke({ task: "record a follow-up seed", mode: "general" });
  expect(result.isError).toBe(false);

  // No `slate.json` was ever written to `parentDir` at all — the F-003 fix
  // throws INSTEAD of synthesizing a `Slate` from the child's own Anchors,
  // so the parent's own fields (which do not exist yet) are never wrongly
  // populated with data that structurally belongs to the child.
  const parentSlate = await readSlate(parentDir);
  expect(parentSlate).toBeUndefined();
});
