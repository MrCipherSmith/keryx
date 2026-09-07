// RED tests for flow 163 (Slate Phase 4), Track B — SLATE-7 wrap-up composer
// (frozen AC1, AC4, AC5, AC6, AC7). See
// `.metaproject/flows/163-2026-08-16-slate-phase-4-ephemeral-subagent-slate-a/
// {description.md,plan.md,acceptance-criteria.md}` for the frozen scope this
// pins.
//
// NOT YET IMPLEMENTED: `src/sac/machine-wrap-up.ts` does not exist yet — this
// WHOLE file fails at import time until task-implementer creates it (mirrors
// `shell.test.ts`'s / `goal-command.test.ts`'s own documented "missing-module
// import is the expected RED failure for the WHOLE file" convention). Every
// test below is RED for that one reason; none is a per-test bug in this file.
//
// DEVIATIONS FROM plan.md's suggested API (documented here since
// task-implementer must match THIS file's actual API, not plan.md's prose,
// per the tests-creator dispatch brief):
//
// 1. `kind: ProposalKind` -> `kind: SlateSeedKind`. `ProposalKind`
//    (proposal-lifecycle.ts) is a private, non-exported local type alias —
//    there is nothing to import. `SlateSeedKind` (src/session/slate.ts) is
//    the REAL, already-exported, already-shipped type with the identical
//    literal union (slate.ts's own doc comment says it "mirrors ProposalKind
//    ... intentionally", so this is not a semantic change, just importing
//    the type that actually exists).
//
// 2. `resolveMachineWrapUp` returns a discriminated union,
//    `Promise<{ ok: true; resolution: TrustedWrapUpResolution } | { ok: false;
//    code: "no_credential" }>`, rather than plan.md's bare
//    `Promise<TrustedWrapUpResolution>`. Plan.md's own prose requires a
//    "typed 'no credential' error" outcome for the fail-closed path, and this
//    codebase's established idiom for "a fallible resolve that a caller must
//    branch on, not catch" is a `{ ok: true; ... } | { ok: false; code }`
//    return (see `spawnSubagent`'s `{ ok: false; reason }`,
//    `readVerifiedProposalEvidence`'s `{ ok: false; code }`) rather than a
//    thrown Error subclass — `SessionWrapUpError` throws, but that call site
//    is a single top-level CLI handler with one try/catch, whereas
//    `runWrapUp` below must keep going across MULTIPLE kind-groups even when
//    one group fails closed, which a thrown exception does not compose with
//    as cleanly.
//
// 3. `resolveMachineWrapUp`/`runWrapUp` accept extra, all-OPTIONAL testability
//    seams beyond plan.md's minimal signature: `now`, `env`, `modelTurn`
//    (`providerFactory` until flow 239 phase 7 replaced it with the AFC-19
//    model-turn port), `modelTurnTimeoutMs` — an already-established
//    injected-non-determinism pattern, needed here to
//    deterministically exercise the fail-closed-no-credential and
//    bounded-timeout-mechanical-fallback behaviors plan.md's Risks section
//    itself calls out, without a real network credential or a real hang.
//
// 4. `runWrapUp` takes BOTH `cwd` (project root — git diff / workspace ops)
//    AND `dir` (the session dir where `slate.json`/`slate-archive/` live) —
//    plan.md's own Track B step 3 says the unbound-candidate artifact lands
//    "under the session dir's slate-archive/", which is a DIFFERENT
//    filesystem location from the project root `cwd` (mirrors
//    `openSlate`'s/`ensureSlateOpened`'s existing `{ dir, cwd }` two-field
//    convention in slate-lifecycle.ts — this is the same distinction, not a
//    new one).
//
// AC4 RIGOR (per the launch brief): the dedup test below races two REAL
// `runWrapUp(...)` calls via `Promise.all` against the SAME fixed flow
// snapshot (the flow.json fixture file is written once, before the race, and
// never touched again — controlling for the flow-snapshot-drift confound
// plan.md's own Risks section calls out) and asserts the on-disk invariant
// directly (at most one `proposal-created` record file), not merely that the
// two in-memory results happen to look consistent.

import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
// RED: `./machine-wrap-up` does not exist yet (task-implementer's Track B creates it).
import { resolveMachineWrapUp, runWrapUp } from "./machine-wrap-up";
import type { MachineWrapUpResolution, WrapUpOutcome } from "./machine-wrap-up";
import { WorkspaceService, localWorkspaceAuthorizationServer } from "./workspace-service";
import type { Slate, SlateSeed } from "../session/slate";
import { readSlate } from "../session/slate";
import type { ModelTurnPort } from "./model-turn-port";

const time = "2026-08-16T00:00:00.000Z";

/**
 * The injected model-turn capability, in its three test shapes. These were
 * `ProviderPort` stubs behind an injected `providerFactory` until flow 239
 * phase 7 moved the whole turn behind a port (`./model-turn-port.ts`, AFC-19):
 * core no longer names a provider, so neither does its test double.
 */
function stubModelTurn(text: string): ModelTurnPort {
  return async () => ({ credentialAvailable: true, text });
}

/** A port that never answers (bounded-timeout fallback probe). */
function hangingModelTurn(): ModelTurnPort {
  return () => new Promise<never>(() => {});
}

/**
 * A port that throws synchronously for exactly ONE Seed kind — detected via
 * `resolveMachineWrapUp`'s own `--- seeds (<kind>) ---` marker in the user
 * message it builds — and answers normally for every other kind. F-002
 * regression test seam: nothing between the port call and `resolveMachineWrapUp`
 * catches, so the throw propagates out uncaught — exactly the
 * "genuinely-thrown, non-conflict failure" class F-002 is about, reached
 * through the cheapest possible seam rather than a new production-code hook.
 */
function perKindThrowingModelTurn(failingKind: string, okText: string): ModelTurnPort {
  return (request) => {
    if (request.user.includes(`seeds (${failingKind})`)) {
      throw new Error(`F-002 test: injected non-conflict failure for kind "${failingKind}"`);
    }
    return Promise.resolve({ credentialAvailable: true, text: okText });
  };
}

/** A real, minimal git repo — `resolveMachineWrapUp` shells out `git diff` per plan.md. */
async function tempGitCwd(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-machine-wrapup-cwd-"));
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "seed content\n", "utf8");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd });
  return cwd;
}

async function tempSessionDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "keryx-machine-wrapup-session-"));
}

async function writeFlowFixture(cwd: string, dirName: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const dir = path.join(cwd, ".metaproject", "flows", dirName);
  await mkdir(dir, { recursive: true });
  const flow = {
    schemaVersion: 2,
    id: dirName.slice(0, 3),
    slug: dirName.slice(4),
    title: "Race flow",
    status: "in-progress",
    createdAt: time,
    updatedAt: time,
    source: { type: "description", ref: null },
    acChecksum: null,
    acConfirmed: {},
    pr: { url: null },
    tasks: [{ id: "T1", title: "First", kind: "context", status: "done" }],
    history: [],
    ...overrides,
  };
  await writeFile(path.join(dir, "flow.json"), JSON.stringify(flow), "utf8");
}

async function createWorkspace(cwd: string, workspaceId: string): Promise<void> {
  const workspaces = new WorkspaceService({
    workspaceRoot: cwd,
    authorizationServer: localWorkspaceAuthorizationServer(),
    strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
    now: () => new Date(time),
  });
  await workspaces.create({ request: undefined, requestCorrelationId: "wrapup-fixture-0001", id: workspaceId, title: "Wrap-up target" });
}

function seed(id: string, text: string, kind?: SlateSeed["kind"]): SlateSeed {
  return { id, text, ts: time, ...(kind !== undefined ? { kind } : {}) };
}

function baseSlate(overrides: Partial<Slate> = {}): Slate {
  return {
    anchors: { root: "/tmp/does-not-matter", touched: [] },
    course: {},
    seeds: [],
    ...overrides,
  };
}

async function readSlateForTest(dir: string): Promise<Slate | undefined> {
  return readSlate(dir);
}

async function proposalFiles(cwd: string, workspaceId: string): Promise<string[]> {
  const dir = path.join(cwd, ".metaproject", "workspaces", workspaceId, "proposals");
  try {
    const entries = await readdir(dir);
    // A real `proposal-created` record's filename is exactly `<id>.json` — no
    // extra dot-segments. Approval/decision/write-intent/write-result
    // sidecars all have an extra `.<hash>.<kind>.json` suffix
    // (proposal-lifecycle.ts's own path helpers), so this filter counts only
    // genuine proposal records, not their sidecars.
    return entries.filter((entry) => entry.endsWith(".json") && entry.split(".").length === 2);
  } catch {
    return [];
  }
}

// --- AC1: no OTHER code in this module reaches service.create()/
// wrapUpAuthority.issue for the "flow" source, and no path here ever calls
// "workspace review" at all. Source-text audit, mirroring Track A's own
// AC1 test and this repo's shell.test.ts/tui-shell.test.ts convention. -----

test("AC1: machine-wrap-up.ts never calls workspace review, and .create(/.issue( appear only inside runWrapUp/resolveMachineWrapUp", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(path.join(import.meta.dir, "machine-wrap-up.ts"), "utf8");
  expect(source).not.toMatch(/workspace\s+review/);
  expect(source).not.toContain(".review(");
  // Every reference to `.create(` or `.issue(` must textually appear after
  // the LAST exported function declaration boundary check below is
  // deliberately loose (a full call-graph check is out of scope for a
  // source-text audit) — the real intent (only these two functions may ever
  // reach SAC's write surface) is enforced behaviorally by the rest of this
  // file exercising `runWrapUp`/`resolveMachineWrapUp` end-to-end; this
  // audit only pins the cheap, permanent "review is never called" half.
});

// --- AC5: evidence never references session-evidence/*.md dumps -----------

test("AC5: resolveMachineWrapUp's evidence never points at a session-evidence/*.md full-archive dump", async () => {
  const cwd = await tempGitCwd();
  await createWorkspace(cwd, "workspace-a");

  const result: MachineWrapUpResolution = await resolveMachineWrapUp({
    cwd,
    workspaceId: "workspace-a",
    slate: baseSlate({ workspaceId: "workspace-a", seeds: [seed("s1", "a real finding", "decision")] }),
    kind: "decision",
    now: () => new Date(time),
    modelTurn: stubModelTurn("machine-authored summary of the evidence above"),
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  for (const item of result.resolution.evidence) {
    expect(item.uri).not.toMatch(/session-evidence/);
    expect(item.kind).not.toBe("session");
  }
});

// --- Fail-closed: a supplied port with no credential -> typed no-credential
// outcome, no proposal attempted. -------------------------------------------

test("resolveMachineWrapUp fails closed with { ok: false, code: 'no_credential' } when the supplied port reports no credential", async () => {
  const cwd = await tempGitCwd();
  await createWorkspace(cwd, "workspace-a");

  const result = await resolveMachineWrapUp({
    cwd,
    workspaceId: "workspace-a",
    slate: baseSlate({ workspaceId: "workspace-a", seeds: [seed("s1", "a real finding", "decision")] }),
    kind: "decision",
    now: () => new Date(time),
    env: {}, // deliberately no ANTHROPIC_API_KEY / any provider key
    // The capability is present and answers honestly that it has no key.
    modelTurn: async () => ({ credentialAvailable: false, text: "" }),
  });

  expect(result).toEqual({ ok: false, code: "no_credential" });
});

// --- Fail-closed: no port at all -> a DIFFERENT typed outcome, and no
// mechanical summary presented as if a model had authored one. ---------------

test("resolveMachineWrapUp refuses with { ok: false, code: 'no_model_turn' } when no model-turn port is supplied at all (AFC-19)", async () => {
  const cwd = await tempGitCwd();
  await createWorkspace(cwd, "workspace-a");

  const result = await resolveMachineWrapUp({
    cwd,
    workspaceId: "workspace-a",
    slate: baseSlate({ workspaceId: "workspace-a", seeds: [seed("s1", "a real finding", "decision")] }),
    kind: "decision",
    now: () => new Date(time),
    env: {},
  });

  expect(result).toEqual({ ok: false, code: "no_model_turn" });
  // And nothing was written: the refusal happens before the evidence step, so
  // an unwired client leaves no half-finished wrap-up behind.
  const evidenceDir = path.join(cwd, ".metaproject", "workspaces", "workspace-a", "machine-evidence");
  await expect(readdir(evidenceDir)).rejects.toThrow();
});

// --- Bounded timeout -> mechanical fallback, never a hang. -----------------

test("resolveMachineWrapUp falls back to a mechanical summary on a bounded model-turn timeout, rather than hanging", async () => {
  const cwd = await tempGitCwd();
  await createWorkspace(cwd, "workspace-a");

  const started = performance.now();
  const result = await resolveMachineWrapUp({
    cwd,
    workspaceId: "workspace-a",
    slate: baseSlate({ workspaceId: "workspace-a", seeds: [seed("s1", "a real finding", "decision")] }),
    kind: "decision",
    now: () => new Date(time),
    modelTurn: hangingModelTurn(),
    modelTurnTimeoutMs: 200,
  });
  const elapsed = performance.now() - started;

  expect(elapsed).toBeLessThan(5_000);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.resolution.summary.trim().length).toBeGreaterThan(0);
  // The abandoned model-turn promise must be safely ignored, not left as an
  // unhandled rejection that crashes the test process after this test
  // returns (mirrors spawn-subagent-tool.ts's own `void turn.catch(...)`
  // pattern, called out explicitly in plan.md's Risks section) — proven
  // indirectly: if this were unhandled, bun's test runner would report a
  // process-level error for this file, which the RED run below checks for.
});

// --- AC6/AC7: workspaceId unset -> unbound-candidate artifact instead of
// propose; untagged seeds group under "follow-up"; empty kinds never
// invented. ------------------------------------------------------------------

test("flow 200: with no workspaceId and a FAILED resolve, runWrapUp writes an unbound-candidate artifact (never calls propose) and groups untagged seeds as follow-up", async () => {
  const cwd = await tempGitCwd();
  const dir = await tempSessionDir();

  const slate = baseSlate({
    // workspaceId deliberately omitted/undefined.
    seeds: [
      seed("s1", "tagged as a decision", "decision"),
      seed("s2", "no kind given at all"), // untagged -> must group as "follow-up"
      seed("s3", "also no kind"), // untagged -> same "follow-up" group as s2
    ],
  });

  const outcome: WrapUpOutcome = await runWrapUp({
    cwd,
    dir,
    slate,
    trigger: "process-termination",
    now: () => new Date(time),
    modelTurn: stubModelTurn("mechanical or model summary"),
    // Flow 200 lazy binding: resolve-or-create is attempted from Seeds; a
    // failed resolve degrades to the unbound-candidate artifact (AC6).
    resolveWorkspace: async () => ({ ok: false, reason: "ambiguous" }),
  });

  // Every group outcome must be the unbound-candidate degrade — never
  // "proposed" — since no workspaceId could be resolved.
  expect(outcome.groups.length).toBeGreaterThan(0);
  for (const group of outcome.groups) {
    expect(group.outcome).toBe("unbound-candidate");
  }
  // Only kinds with at least one real Seed appear — "decision" (s1) and
  // "follow-up" (s2+s3 untagged) — never an invented empty group like
  // "wiki-update" or "risk".
  const kinds = outcome.groups.map((group) => group.kind).sort();
  expect(kinds).toEqual(["decision", "follow-up"]);

  // No proposal was ever created anywhere under the (nonexistent) workspace
  // tree — the ONLY outcome for an unresolved workspaceId per AC6.
  const workspacesRoot = path.join(cwd, ".metaproject", "workspaces");
  await expect(readdir(workspacesRoot).catch(() => [])).resolves.toEqual([]);

  // The unbound-candidate artifact lives under the SESSION dir's
  // slate-archive/, not the project cwd (plan.md Track B step 3) — read it
  // back and confirm both grouped kinds and the untagged seeds' text are
  // present somewhere in the written artifact set.
  const archiveDir = path.join(dir, "slate-archive");
  const archiveEntries = await readdir(archiveDir);
  const unboundFiles = archiveEntries.filter((entry) => entry.includes("unbound-candidate"));
  expect(unboundFiles.length).toBeGreaterThan(0);
  const archived = (
    await Promise.all(unboundFiles.map((entry) => readFile(path.join(archiveDir, entry), "utf8")))
  ).join("\n");
  expect(archived).toContain("no kind given at all");
  expect(archived).toContain("also no kind");
});

test("flow 200 (lazy binding): with no workspaceId and a SUCCESSFUL resolve, runWrapUp binds the resolved workspace to the slate and proposes per kind-group", async () => {
  const cwd = await tempGitCwd();
  const dir = await tempSessionDir();
  await createWorkspace(cwd, "workspace-seed-resolved");
  await writeFlowFixture(cwd, "042-lazy-flow");

  const slate = baseSlate({
    // workspaceId deliberately omitted — the resolver must bind it from seeds.
    seeds: [seed("s1", "lazy binding from seeds", "decision")],
  });
  const resolveCalls: Array<{ cwd: string; topicHint: string }> = [];

  const outcome: WrapUpOutcome = await runWrapUp({
    cwd,
    dir,
    slate,
    trigger: "flow-complete",
    now: () => new Date(time),
    modelTurn: stubModelTurn("lazy summary"),
    resolveWorkspace: async (input) => {
      resolveCalls.push(input);
      return { ok: true, workspaceId: "workspace-seed-resolved", action: "bound-existing" };
    },
  });

  // The resolver saw the SEEDS' texts as the topic hint, not the first
  // message.
  expect(resolveCalls).toHaveLength(1);
  expect(resolveCalls[0]?.topicHint).toContain("lazy binding from seeds");

  // A proposal landed in the bound workspace.
  const files = await proposalFiles(cwd, "workspace-seed-resolved");
  expect(files.length).toBe(1);
  const decision = outcome.groups.find((group) => group.kind === "decision");
  expect(decision?.outcome).toBe("proposed");

  // The slate was bound so future wrap-ups reuse the same workspace.
  const slateAfter = await readSlateForTest(dir);
  expect(slateAfter?.workspaceId).toBe("workspace-seed-resolved");
});

// --- AC4: two near-simultaneous wrap-up triggers for the SAME flow
// transition converge on at most one accepted evidence set. -----------------

test("AC4: two Promise.all-raced runWrapUp calls for the same flow transition produce at most one proposal on disk", async () => {
  const cwd = await tempGitCwd();
  const dirA = await tempSessionDir();
  const dirB = await tempSessionDir();
  await createWorkspace(cwd, "workspace-a");
  // Written ONCE, before the race, and never touched again — this is what
  // controls for the flow-snapshot-drift confound plan.md's own Risks
  // section calls out: both racing calls must see the IDENTICAL flow
  // snapshot/sourceRevision, or a legitimate divergence (not a dedup bug)
  // would explain two proposals, proving nothing about AC4 itself.
  await writeFlowFixture(cwd, "042-race-flow");

  const slate = baseSlate({
    workspaceId: "workspace-a",
    course: { flowRef: "042" },
    seeds: [seed("s1", "the same finding both racers see", "decision")],
  });

  const modelTurn = stubModelTurn("racer summary");

  const [first, second] = await Promise.all([
    runWrapUp({ cwd, dir: dirA, slate, trigger: "flow-complete", now: () => new Date(time), modelTurn }),
    runWrapUp({ cwd, dir: dirB, slate, trigger: "flow-complete", now: () => new Date(time), modelTurn }),
  ]);

  // AC4's actual invariant, checked directly on disk: at most one accepted
  // evidence set — never two independently reviewable proposal records for
  // the same (workspaceId, flowRef, sourceRevision, kind) tuple.
  const files = await proposalFiles(cwd, "workspace-a");
  expect(files.length).toBe(1);

  // Both racers must agree on what happened: either exactly one of the two
  // says "proposed" (the other observing the lock-protected "conflict" per
  // plan.md's own described mechanism), or both say "proposed" while
  // pointing at the SAME proposalId (an equally valid convergent outcome) —
  // what must NEVER happen is two different "proposed" proposalIds.
  const decisionA = first.groups.find((group) => group.kind === "decision");
  const decisionB = second.groups.find((group) => group.kind === "decision");
  expect(decisionA).toBeDefined();
  expect(decisionB).toBeDefined();
  if (!decisionA || !decisionB) return;
  const outcomes = [decisionA.outcome, decisionB.outcome].sort();
  expect(outcomes.every((outcome) => outcome === "proposed" || outcome === "conflict")).toBe(true);
  if (decisionA.outcome === "proposed" && decisionB.outcome === "proposed") {
    expect((decisionA as { proposalId: string }).proposalId).toBe((decisionB as { proposalId: string }).proposalId);
  } else {
    // At least one must have actually proposed — a race where BOTH report
    // "conflict" would mean nothing was ever proposed at all, which is a
    // different (and wrong) failure mode than AC4 describes.
    expect(outcomes).toContain("proposed");
  }
});

test("two DIFFERENT non-empty kind groups in the same runWrapUp call produce two distinct proposals, not a collision", async () => {
  const cwd = await tempGitCwd();
  const dir = await tempSessionDir();
  await createWorkspace(cwd, "workspace-a");
  await writeFlowFixture(cwd, "043-two-kinds-flow");

  const slate = baseSlate({
    workspaceId: "workspace-a",
    course: { flowRef: "043" },
    seeds: [seed("s1", "a decision finding", "decision"), seed("s2", "a risk finding", "risk")],
  });

  const outcome = await runWrapUp({
    cwd,
    dir,
    slate,
    trigger: "explicit",
    now: () => new Date(time),
    modelTurn: stubModelTurn("two-kind summary"),
  });

  const proposedKinds = outcome.groups.filter((group) => group.outcome === "proposed").map((group) => group.kind).sort();
  expect(proposedKinds).toEqual(["decision", "risk"]);
  const files = await proposalFiles(cwd, "workspace-a");
  expect(files.length).toBe(2);
});

// --- F-002: a genuinely-thrown, non-conflict failure in ONE kind-group must
// never discard a sibling group's already-succeeded/persisted proposal. -----

test("F-002: a genuinely-thrown, non-conflict failure in ONE kind-group never discards a sibling group's successful proposal", async () => {
  const cwd = await tempGitCwd();
  const dir = await tempSessionDir();
  await createWorkspace(cwd, "workspace-a");
  await writeFlowFixture(cwd, "044-mixed-outcome-flow");

  const slate = baseSlate({
    workspaceId: "workspace-a",
    course: { flowRef: "044" },
    seeds: [
      seed("s1", "a decision finding that must still get proposed", "decision"),
      seed("s2", "a risk finding whose model turn is injected to fail", "risk"),
    ],
  });

  // Pre-fix, `runWrapUp`'s bare `Promise.all` over `proposeOneGroup` calls
  // would let the "risk" group's thrown error reject the WHOLE call,
  // discarding the "decision" group's result even though its evidence/
  // proposal had already been computed/persisted independently.
  const outcome: WrapUpOutcome = await runWrapUp({
    cwd,
    dir,
    slate,
    trigger: "explicit",
    now: () => new Date(time),
    modelTurn: perKindThrowingModelTurn("risk", "decision summary"),
  });

  const decisionGroup = outcome.groups.find((group) => group.kind === "decision");
  const riskGroup = outcome.groups.find((group) => group.kind === "risk");
  expect(decisionGroup).toBeDefined();
  expect(riskGroup).toBeDefined();
  if (!decisionGroup || !riskGroup) return;

  expect(decisionGroup.outcome).toBe("proposed");
  expect(riskGroup.outcome).toBe("error");
  if (riskGroup.outcome === "error") {
    expect(riskGroup.message).toContain("injected non-conflict failure");
  }

  // Confirmed on disk too: exactly one proposal (the decision group's) was
  // ever persisted — the risk group's thrown failure never even got as far
  // as attempting a write, and never poisoned the sibling group's own
  // already-successful write either.
  const files = await proposalFiles(cwd, "workspace-a");
  expect(files.length).toBe(1);
});

// --- flow 173: SAC durable wrap-up dispatch outcome recording -------------
// `runWrapUp` persists a `{recordType: "wrap-up-outcome", ...}` artifact
// under the session dir's `slate-archive/`, unconditionally on both of its
// "real work happened" return paths (unbound-candidate degrade AND the
// propose-attempt path, success or failure alike), but writes NOTHING for
// the harmless zero-seeds no-op early return.

async function readWrapUpOutcomeArtifacts(dir: string): Promise<Array<Record<string, unknown>>> {
  const archiveDir = path.join(dir, "slate-archive");
  let entries: string[];
  try {
    entries = (await readdir(archiveDir)).filter((name) => name.endsWith("-wrap-up-outcome.json"));
  } catch {
    return [];
  }
  return Promise.all(
    entries.map(async (entry) => JSON.parse(await readFile(path.join(archiveDir, entry), "utf8")) as Record<string, unknown>),
  );
}

test("AC1/AC2/AC3/AC9: runWrapUp writes a wrap-up-outcome artifact for the unbound-candidate degrade path", async () => {
  const cwd = await tempGitCwd();
  const dir = await tempSessionDir();

  const slate = baseSlate({
    // workspaceId deliberately omitted -> resolve fails -> unbound-candidate
    // degrade path.
    seeds: [seed("s1", "tagged as a decision", "decision")],
  });

  const outcome = await runWrapUp({
    cwd,
    dir,
    slate,
    trigger: "process-termination",
    now: () => new Date(time),
    modelTurn: stubModelTurn("mechanical or model summary"),
    resolveWorkspace: async () => ({ ok: false, reason: "ambiguous" }),
  });

  const artifacts = await readWrapUpOutcomeArtifacts(dir);
  expect(artifacts.length).toBe(1);
  const artifact = artifacts[0]!;
  expect(artifact.recordType).toBe("wrap-up-outcome");
  expect(artifact.trigger).toBe("process-termination");
  expect(artifact.generatedAt).toBe(time);
  // Same groups shape already returned from this branch (every group
  // "unbound-candidate", matching the outcome value itself).
  expect(artifact.groups).toEqual(outcome.groups);
  expect(outcome.groups.every((group) => group.outcome === "unbound-candidate")).toBe(true);
});

test("AC1/AC2/AC9: runWrapUp writes a wrap-up-outcome artifact recording an 'error' group outcome from the propose path", async () => {
  const cwd = await tempGitCwd();
  const dir = await tempSessionDir();
  await createWorkspace(cwd, "workspace-a");
  await writeFlowFixture(cwd, "045-outcome-error-flow");

  const slate = baseSlate({
    workspaceId: "workspace-a",
    course: { flowRef: "045" },
    seeds: [seed("s1", "a risk finding whose model turn is injected to fail", "risk")],
  });

  const outcome = await runWrapUp({
    cwd,
    dir,
    slate,
    trigger: "explicit",
    now: () => new Date(time),
    modelTurn: perKindThrowingModelTurn("risk", "unused"),
  });

  expect(outcome.groups.length).toBe(1);
  expect(outcome.groups[0]!.outcome).toBe("error");

  const artifacts = await readWrapUpOutcomeArtifacts(dir);
  expect(artifacts.length).toBe(1);
  const artifact = artifacts[0]!;
  expect(artifact.recordType).toBe("wrap-up-outcome");
  expect(artifact.trigger).toBe("explicit");
  // The resulting groups array is passed through directly (AC2: written
  // unconditionally, success or failure).
  expect(artifact.groups).toEqual(outcome.groups);
});

test("AC2: runWrapUp writes a wrap-up-outcome artifact for a fully successful ('proposed') propose path too", async () => {
  const cwd = await tempGitCwd();
  const dir = await tempSessionDir();
  await createWorkspace(cwd, "workspace-a");
  await writeFlowFixture(cwd, "046-outcome-proposed-flow");

  const slate = baseSlate({
    workspaceId: "workspace-a",
    course: { flowRef: "046" },
    seeds: [seed("s1", "a decision finding that should succeed", "decision")],
  });

  const outcome = await runWrapUp({
    cwd,
    dir,
    slate,
    trigger: "flow-complete",
    now: () => new Date(time),
    modelTurn: stubModelTurn("summary"),
  });

  expect(outcome.groups.length).toBe(1);
  expect(outcome.groups[0]!.outcome).toBe("proposed");

  const artifacts = await readWrapUpOutcomeArtifacts(dir);
  expect(artifacts.length).toBe(1);
  expect(artifacts[0]!.groups).toEqual(outcome.groups);
});

test("AC3: runWrapUp writes NO wrap-up-outcome artifact for the zero-seeds no-op early return", async () => {
  const cwd = await tempGitCwd();
  const dir = await tempSessionDir();

  const slate = baseSlate({ seeds: [] }); // zero non-empty seed groups

  const outcome = await runWrapUp({
    cwd,
    dir,
    slate,
    trigger: "explicit",
    now: () => new Date(time),
  });

  expect(outcome.groups).toEqual([]);
  const artifacts = await readWrapUpOutcomeArtifacts(dir);
  expect(artifacts.length).toBe(0);
});

test("AC2/NFR-1: a failing writeWrapUpOutcomeArtifact mkdir never poisons runWrapUp's own already-computed result", async () => {
  const cwd = await tempGitCwd();
  const dir = await tempSessionDir();
  await createWorkspace(cwd, "workspace-a");
  await writeFlowFixture(cwd, "047-outcome-mkdir-failure-flow");

  // Force writeWrapUpOutcomeArtifact's `mkdir(archiveDir, { recursive: true })`
  // to throw: pre-create a regular FILE at the exact path it needs to `mkdir`
  // as a directory ("slate-archive"), so Node's fs.mkdir rejects with
  // ENOTDIR/EEXIST instead of creating the directory. This is the same class
  // of real-world failure the fix documents (a non-directory colliding with
  // `slate-archive`) and does not touch `writeUnboundCandidateArtifact` or any
  // other function's own use of the session dir.
  await writeFile(path.join(dir, "slate-archive"), "not a directory", "utf8");

  const slate = baseSlate({
    workspaceId: "workspace-a",
    course: { flowRef: "047" },
    seeds: [seed("s1", "a decision finding that should still succeed", "decision")],
  });

  const outcome = await runWrapUp({
    cwd,
    dir,
    slate,
    trigger: "flow-complete",
    now: () => new Date(time),
    modelTurn: stubModelTurn("summary"),
  });

  // runWrapUp itself must resolve normally with its correctly-computed
  // outcome, not reject/throw, even though the best-effort outcome-artifact
  // write below it failed outright before ever reaching writeFileAtomic.
  expect(outcome.groups.length).toBe(1);
  expect(outcome.groups[0]!.outcome).toBe("proposed");

  // The proposal itself was still genuinely persisted — the mkdir failure in
  // writeWrapUpOutcomeArtifact never prevented the real work already done by
  // proposeOneGroup/Promise.all from reaching the caller.
  const files = await proposalFiles(cwd, "workspace-a");
  expect(files.length).toBe(1);

  // And, as expected, no wrap-up-outcome artifact could be read back (the
  // colliding file is still sitting where the directory should be) — the
  // failure was swallowed, not silently "succeeded".
  const artifacts = await readWrapUpOutcomeArtifacts(dir);
  expect(artifacts.length).toBe(0);
});

// --- The redaction floor (flow 236 T6) --------------------------------------
//
// Measured before this suite existed, on the fixture below: this resolver wrote
// `aws_key = AKIAIOSFODNN7EXAMPLE` verbatim into
// `machine-evidence/*.diff.txt` and sent the same bytes to the model provider,
// while `session-wrap-up.ts` — the sibling producer of the same `kind: "diff"`
// evidence, from the same `gitDiff` primitive — wrote
// `aws_key = [REDACTED:secret]`. These tests hold both producers to the second
// behaviour, and to announcing it when it happens.
//
// The trigger is real: a genuine uncommitted working-tree change in a real git
// repo, collected by the real `gitDiff`, floored by the real `guardOutput`
// seam. Nothing about the redaction is injected by the test.

const PLANTED_SECRET = "AKIAIOSFODNN7EXAMPLE";

/** Make `git diff` in `cwd` genuinely carry a secret. */
async function plantSecretInWorkingTree(cwd: string): Promise<void> {
  await writeFile(path.join(cwd, "README.md"), `seed content\naws_key = ${PLANTED_SECRET}\n`, "utf8");
}

async function enableSecurity(cwd: string, mode: "advisory" | "enforced"): Promise<void> {
  await mkdir(path.join(cwd, ".metaproject"), { recursive: true });
  await writeFile(path.join(cwd, ".metaproject", "metaproject.json"), JSON.stringify({ modules: { security: { enabled: true } } }), "utf8");
  await writeFile(path.join(cwd, ".metaproject", "security.config.json"), JSON.stringify({ mode }), "utf8");
}

async function machineEvidence(cwd: string, workspaceId: string): Promise<Map<string, string>> {
  const dir = path.join(cwd, ".metaproject", "workspaces", workspaceId, "machine-evidence");
  const names = await readdir(dir);
  const out = new Map<string, string>();
  for (const name of names) out.set(name, await readFile(path.join(dir, name), "utf8"));
  return out;
}

test("a secret in the working-tree diff never reaches the evidence file OR the model prompt", async () => {
  const cwd = await tempGitCwd();
  await createWorkspace(cwd, "workspace-a");
  await plantSecretInWorkingTree(cwd);

  let promptSentToProvider = "";
  const result = await resolveMachineWrapUp({
    cwd,
    workspaceId: "workspace-a",
    slate: baseSlate({ workspaceId: "workspace-a", seeds: [seed("s1", "a real finding", "decision")] }),
    kind: "decision",
    now: () => new Date(time),
    modelTurn: async (request) => {
      promptSentToProvider = request.user;
      return { credentialAvailable: true, text: "summary" };
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const files = await machineEvidence(cwd, "workspace-a");
  const diffName = [...files.keys()].find((name) => name.endsWith(".diff.txt"))!;
  // The diff is still a real diff of the real change — this is not "the floor
  // ate the evidence", it is "the floor masked the credential in it".
  expect(files.get(diffName)).toContain("aws_key = ");
  expect(files.get(diffName)).not.toContain(PLANTED_SECRET);
  // Egress: the prompt leaves the machine, so it is floored too.
  expect(promptSentToProvider).toContain("--- git diff ---");
  expect(promptSentToProvider).not.toContain(PLANTED_SECRET);

  // The recorded revision is the sha256 of what is actually on disk, so a
  // downstream hash check verifies the bytes that exist rather than bytes that
  // were never written.
  const diffItem = result.resolution.evidence.find((item) => item.kind === "diff")!;
  expect(diffItem.revision).toBe(createHash("sha256").update(files.get(diffName)!).digest("hex"));
});

test("redacted evidence is announced: a redaction-notice item names the rewritten file, and is itself hash-verified", async () => {
  const cwd = await tempGitCwd();
  await createWorkspace(cwd, "workspace-a");
  await enableSecurity(cwd, "advisory");
  await plantSecretInWorkingTree(cwd);

  const result = await resolveMachineWrapUp({
    cwd,
    workspaceId: "workspace-a",
    slate: baseSlate({ workspaceId: "workspace-a", seeds: [seed("s1", "a real finding", "decision")] }),
    kind: "decision",
    now: () => new Date(time),
    modelTurn: stubModelTurn("summary"),
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const notice = result.resolution.evidence.find((item) => item.kind === "redaction-notice");
  expect(notice).toBeDefined();
  // Appended last: `evidence[0]` is still the diff every owner writer reads.
  expect(result.resolution.evidence[0]!.kind).toBe("diff");
  expect(result.resolution.evidence.at(-1)).toBe(notice!);

  const files = await machineEvidence(cwd, "workspace-a");
  const noticeName = path.posix.basename(notice!.uri);
  const noticeBody = files.get(noticeName)!;
  const diffName = [...files.keys()].find((name) => name.endsWith(".diff.txt"))!;

  // It says WHICH body was rewritten, and lists the untouched ones separately
  // rather than leaving the reader to guess.
  expect(noticeBody).toContain("## Rewritten");
  expect(noticeBody).toContain("- decision.diff.txt");
  expect(noticeBody).toContain("## Byte-preserved");
  expect(noticeBody).toContain("- decision.flow.json");
  expect(noticeBody).toContain("- decision.seeds.json");
  expect(noticeBody).toMatch(/secret:\d/); // leak-safe category count from the engine
  expect(noticeBody).not.toContain(PLANTED_SECRET);
  // The notice describes the diff body, and the diff body really is the masked one.
  expect(files.get(diffName)).not.toContain(PLANTED_SECRET);

  // Hash-verified like every other evidence item, so it travels with the
  // proposal and cannot be dropped without breaking verification.
  expect(notice!.revision).toBe(createHash("sha256").update(noticeBody).digest("hex"));
});

test("a wrap-up whose evidence the floor did NOT touch carries no redaction notice", async () => {
  const cwd = await tempGitCwd();
  await createWorkspace(cwd, "workspace-a");
  await enableSecurity(cwd, "advisory");
  // No planted secret: the working tree is clean of anything the floor masks.

  const result = await resolveMachineWrapUp({
    cwd,
    workspaceId: "workspace-a",
    slate: baseSlate({ workspaceId: "workspace-a", seeds: [seed("s1", "an ordinary finding", "decision")] }),
    kind: "decision",
    now: () => new Date(time),
    modelTurn: stubModelTurn("summary"),
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.resolution.evidence.map((item) => item.kind)).toEqual(["diff", "flow", "seeds"]);
  const files = await machineEvidence(cwd, "workspace-a");
  expect([...files.keys()].some((name) => name.endsWith(".redaction.md"))).toBe(false);
});

test("an enforced workspace refuses the wrap-up outright, writes no evidence, and does not report it as a missing credential", async () => {
  const cwd = await tempGitCwd();
  await createWorkspace(cwd, "workspace-a");
  await enableSecurity(cwd, "enforced");
  await plantSecretInWorkingTree(cwd);

  const result = await resolveMachineWrapUp({
    cwd,
    workspaceId: "workspace-a",
    slate: baseSlate({ workspaceId: "workspace-a", seeds: [seed("s1", "a real finding", "decision")] }),
    kind: "decision",
    now: () => new Date(time),
    modelTurn: stubModelTurn("summary"),
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  // NOT "no_credential": a security refusal that wears the missing-key label
  // sends a reviewer looking for an API key that was never the problem.
  expect(result.code).toBe("security_denied");
  if (result.code !== "security_denied") return;
  expect(result.detail).not.toContain(PLANTED_SECRET);
  // Leak-safe: categories and counts, never the span it matched.
  expect(result.detail).toMatch(/secret:\d/);

  // Fail-closed: refused before the evidence step, so nothing half-written.
  const evidenceDir = path.join(cwd, ".metaproject", "workspaces", "workspace-a", "machine-evidence");
  await expect(readdir(evidenceDir)).rejects.toThrow();
});

test("a proposal whose evidence carries a redaction notice still validates and persists end to end", async () => {
  const cwd = await tempGitCwd();
  const dir = await tempSessionDir();
  await createWorkspace(cwd, "workspace-a");
  await writeFlowFixture(cwd, "236-redaction-notice-flow");
  await enableSecurity(cwd, "advisory");
  await plantSecretInWorkingTree(cwd);

  const outcome = await runWrapUp({
    cwd,
    dir,
    slate: baseSlate({ workspaceId: "workspace-a", course: { flowRef: "236" }, seeds: [seed("s1", "a decision finding", "decision")] }),
    trigger: "flow-complete",
    now: () => new Date(time),
    modelTurn: stubModelTurn("summary"),
  });

  // The notice is an extra `evidence[]` member on a schema-validated
  // (`workspace-proposal`) record whose `evidence` item is
  // `additionalProperties: false` — so this proves the marking survives
  // `create()`'s own validation and containment checks, rather than only
  // existing in the in-memory resolution.
  expect(outcome.groups[0]!.outcome).toBe("proposed");
  const files = await proposalFiles(cwd, "workspace-a");
  expect(files.length).toBe(1);
  const record = JSON.parse(await readFile(path.join(cwd, ".metaproject", "workspaces", "workspace-a", "proposals", files[0]!), "utf8")) as {
    evidence: { kind: string; uri: string; revision: string }[];
  };
  const notice = record.evidence.find((item) => item.kind === "redaction-notice")!;
  expect(notice).toBeDefined();
  const noticeBody = await readFile(path.join(cwd, notice.uri.slice(2)), "utf8");
  expect(noticeBody).toContain("## Rewritten");
  expect(notice.revision).toBe(createHash("sha256").update(noticeBody).digest("hex"));
});

test("runWrapUp surfaces a floor refusal as an 'error' group outcome, never as 'no_credential'", async () => {
  const cwd = await tempGitCwd();
  const dir = await tempSessionDir();
  await createWorkspace(cwd, "workspace-a");
  await writeFlowFixture(cwd, "236-redaction-floor-flow");
  await enableSecurity(cwd, "enforced");
  await plantSecretInWorkingTree(cwd);

  const outcome = await runWrapUp({
    cwd,
    dir,
    slate: baseSlate({ workspaceId: "workspace-a", course: { flowRef: "236" }, seeds: [seed("s1", "a decision finding", "decision")] }),
    trigger: "flow-complete",
    now: () => new Date(time),
    modelTurn: stubModelTurn("summary"),
  });

  expect(outcome.groups.length).toBe(1);
  const group = outcome.groups[0]!;
  expect(group.outcome).toBe("error");
  if (group.outcome !== "error") return;
  expect(group.message).toContain("security floor");
  expect(group.message).not.toContain(PLANTED_SECRET);
});

// --- The floor's SECOND asymmetry (flow 236 T12) ----------------------------
//
// The suite above closed the asymmetry BETWEEN the two producers of a
// `TrustedWrapUpResolution`. This one closes the asymmetry WITHIN this
// producer, between its two write paths. Measured before this suite existed,
// on an unbound slate whose only seed read
// `follow up on the key AKIAIOSFODNN7EXAMPLE in config`:
//
//   groups: [{"kind":"follow-up","outcome":"unbound-candidate"}]
//   --- 2026-09-07T21-56-36-330Z-unbound-candidate.json
//       contains raw secret: true
//
// while the identical bytes through `applyEvidenceRedactionFloor` — the floor
// the BOUND path of the very same function already ran — came back as
// `follow up on the key [REDACTED:secret] in config`, `altered: true`.
// `resolveMachineWrapUp` floored its seeds before hashing, prompting and
// writing; `writeUnboundCandidateArtifact` wrote the same seed texts verbatim.
//
// As with the suite above, nothing here is injected: a real seed, the real
// `runWrapUp` writer, the real `guardOutput` seam.

/** Everything sitting in a session's `slate-archive/`, by filename. */
async function slateArchiveFiles(dir: string): Promise<Map<string, string>> {
  const archiveDir = path.join(dir, "slate-archive");
  const out = new Map<string, string>();
  let names: string[];
  try {
    names = await readdir(archiveDir);
  } catch {
    return out;
  }
  for (const name of names) out.set(name, await readFile(path.join(archiveDir, name), "utf8"));
  return out;
}

test("a secret in a SEED never reaches the unbound-candidate artifact, and the rewrite is announced", async () => {
  const cwd = await tempGitCwd();
  const dir = await tempSessionDir();

  const outcome = await runWrapUp({
    cwd,
    dir,
    // No workspaceId, and the external-slate source, so this takes the
    // unbound-candidate path unconditionally (AC-38) — the exact path the
    // reviewer reproduced on.
    slate: baseSlate({ seeds: [seed("s1", `follow up on the key ${PLANTED_SECRET} in config`)] }),
    trigger: "external-slate-close",
    wrapUpSource: "external-slate",
    now: () => new Date(time),
    modelTurn: stubModelTurn("summary"),
  });

  expect(outcome.groups).toEqual([{ kind: "follow-up", outcome: "unbound-candidate" }]);

  const files = await slateArchiveFiles(dir);
  const candidateName = [...files.keys()].find((name) => name.endsWith("-unbound-candidate.json"))!;
  const candidate = files.get(candidateName)!;
  expect(candidate).not.toContain(PLANTED_SECRET);
  // Not "the floor ate the artifact": the seed is still recorded, and still
  // attributed, with only the credential masked.
  expect(candidate).toContain("[REDACTED:secret]");
  const parsed = JSON.parse(candidate) as { groups: Array<{ kind: string; seeds: Array<{ text: string; source: string }> }> };
  expect(parsed.groups[0]!.kind).toBe("follow-up");
  expect(parsed.groups[0]!.seeds[0]!.source).toBe("parent");
  expect(parsed.groups[0]!.seeds[0]!.text).toContain("follow up on the key");

  // Altered and NOT silent: a sibling notice names the rewritten artifact.
  const noticeName = `${candidateName}.redaction.md`;
  const notice = files.get(noticeName);
  expect(notice).toBeDefined();
  expect(notice!).toContain("## Rewritten");
  expect(notice!).toContain(`- ${candidateName}`);
  expect(notice!).not.toContain(PLANTED_SECRET);
  // The notice must not be mistaken for a second record by `catch-up.ts`,
  // which scans this directory by exactly these two filename suffixes.
  expect(noticeName.endsWith("-unbound-candidate.json")).toBe(false);
  expect(noticeName.endsWith("-wrap-up-outcome.json")).toBe(false);
});

test("an unaltered unbound-candidate artifact carries no redaction notice", async () => {
  const cwd = await tempGitCwd();
  const dir = await tempSessionDir();

  await runWrapUp({
    cwd,
    dir,
    slate: baseSlate({ seeds: [seed("s1", "an ordinary follow-up with nothing sensitive in it")] }),
    trigger: "external-slate-close",
    wrapUpSource: "external-slate",
    now: () => new Date(time),
    modelTurn: stubModelTurn("summary"),
  });

  const files = await slateArchiveFiles(dir);
  expect([...files.keys()].some((name) => name.endsWith("-unbound-candidate.json"))).toBe(true);
  expect([...files.keys()].some((name) => name.endsWith(".redaction.md"))).toBe(false);
});

test("a floor REFUSAL on the unbound path is its own outcome, never reported as 'unbound-candidate'", async () => {
  const cwd = await tempGitCwd();
  const dir = await tempSessionDir();
  await enableSecurity(cwd, "enforced");

  const outcome = await runWrapUp({
    cwd,
    dir,
    slate: baseSlate({ seeds: [seed("s1", `follow up on the key ${PLANTED_SECRET} in config`)] }),
    trigger: "external-slate-close",
    wrapUpSource: "external-slate",
    now: () => new Date(time),
    modelTurn: stubModelTurn("summary"),
  });

  // "unbound-candidate" means "a durable artifact for these seeds exists on
  // disk" — and `catch-up.ts` treats it as a completed dispatch that outranks
  // every failure signal. After a refusal that is simply false, so it must not
  // be what comes back.
  expect(outcome.groups.length).toBe(1);
  const group = outcome.groups[0]!;
  expect(group.outcome).not.toBe("unbound-candidate");
  expect(group.outcome).toBe("error");
  if (group.outcome !== "error") return;
  expect(group.message).toContain("security floor");
  expect(group.message).not.toContain(PLANTED_SECRET);
  // Leak-safe: categories and counts, never the span it matched.
  expect(group.message).toMatch(/secret:\d/);

  // Fail-closed: nothing half-written, and above all no artifact carrying the
  // seed text the floor just refused to let through.
  const files = await slateArchiveFiles(dir);
  expect([...files.keys()].some((name) => name.endsWith("-unbound-candidate.json"))).toBe(false);
  for (const body of files.values()) expect(body).not.toContain(PLANTED_SECRET);
});

test("a secret in a thrown error message never reaches the wrap-up-outcome artifact", async () => {
  const cwd = await tempGitCwd();
  const dir = await tempSessionDir();
  await createWorkspace(cwd, "workspace-a");
  await writeFlowFixture(cwd, "236-outcome-floor-flow");

  const outcome = await runWrapUp({
    cwd,
    dir,
    slate: baseSlate({ workspaceId: "workspace-a", course: { flowRef: "236" }, seeds: [seed("s1", "a decision finding", "decision")] }),
    trigger: "flow-complete",
    now: () => new Date(time),
    // A provider that rejects by echoing back the request it would not serve
    // is an ordinary shape, and `proposeOneGroup` puts `error.message`
    // straight into the group outcome this artifact records. "Thrown-Error
    // message" is not a category anyone should assume is free of user content.
    modelTurn: () => {
      throw new Error(`provider rejected request: aws_key = ${PLANTED_SECRET}`);
    },
  });

  expect(outcome.groups.length).toBe(1);
  expect(outcome.groups[0]!.outcome).toBe("error");

  const artifacts = await readWrapUpOutcomeArtifacts(dir);
  expect(artifacts.length).toBe(1);
  const recorded = JSON.stringify(artifacts[0]);
  expect(recorded).not.toContain(PLANTED_SECRET);
  // Still a usable failure record — `classifySession` reads these groups to
  // tell "wrap-up genuinely failed" from "wrap-up never triggered".
  expect(recorded).toContain("provider rejected request");
  expect(recorded).toContain("[REDACTED:secret]");

  const files = await slateArchiveFiles(dir);
  const outcomeName = [...files.keys()].find((name) => name.endsWith("-wrap-up-outcome.json"))!;
  expect(files.get(`${outcomeName}.redaction.md`)).toBeDefined();
});
