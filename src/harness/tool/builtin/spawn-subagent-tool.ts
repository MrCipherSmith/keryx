// Interactive `spawn_subagent` tool — wires MAE `spawnSubagent` into the shell agent.
//
// The model proposes a bounded child task. The host:
//   1) fail-closed spawn via RemainingBudgetLedger + spawnSubagent
//   2) runs a read-only (or general read-mostly) agent turn
//   3) returns a quarantined summary to the parent
//
// Risk: `delegate` (agent driver requires approval when an approver is present).

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InteractiveTool, InteractiveToolResult } from "./interactive-tools";
import { builtinReadOnlyTools } from "./interactive-tools";
import { makeKeryxRunner, builtinMetaprojectTools } from "./metaproject-tools";
import { slateWriteSeedTool } from "./slate-tool";
import { createMetaprojectAdapter } from "../metaproject-adapter";
import { RemainingBudgetLedger } from "../../child/ledger";
import { spawnSubagent, foldChildSummary, DEFAULT_MAX_CHILDREN } from "../../child/orchestrate";
import type { SubagentContext } from "../../child/orchestrate";
import type { PolicyProfile } from "../../policy/types";
import { shellChildReadOnlyProfile, shellParentProfile } from "../../policy/profiles";
import type { Provenance } from "../../session/types";
import { runAgentTurn, type AgentDeps, type AgentIO } from "../../../commands/agent";
import type { ProviderPort } from "../../provider/types";
import {
  readSlate,
  renderAnchorsBlock,
  slateLockPath,
  writeSlate,
  type Slate,
  type SlateChildDispatch,
} from "../../../session/slate";
import { openSlate, type SlateSessionRef } from "../../../session/slate-lifecycle";
import { emitSubagentFleet } from "../../../tui/subagent-bridge";
import { withFileLock } from "../../../lib/fs";

export type SubagentMode = "read_only" | "general";

/**
 * Hard cap on a child summary before it enters the parent's history.
 *
 * A child's text is `trustLevel: "derived"` and lands verbatim in the parent's
 * next prompt. Uncapped, a child (or a provider echoing attacker-controlled
 * text) can flood the parent's context: the flow-115 stress run returned
 * 1.5 MB this way. `quarantineChildSummary` flags instruction-shaped text but
 * deliberately never shortens it, so the bound has to be applied here.
 */
const MAX_CHILD_SUMMARY_CHARS = 16_000;

/**
 * Env override for the child wall-clock deadline, in ms. The effective deadline
 * is the SMALLER of this and the granted reservation, so an operator can tighten
 * it but never widen it past what MAE reserved. `0` disables it.
 */
export const ENV_SUBAGENT_TIMEOUT_MS = "KERYX_SUBAGENT_TIMEOUT_MS";

/** Resolve the child deadline: `min(reservation, env override)`; `0` = disabled. */
export function resolveSubagentTimeoutMs(
  reservationMs: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[ENV_SUBAGENT_TIMEOUT_MS];
  if (raw === undefined || raw.trim().length === 0) {
    return reservationMs;
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 0) {
    return reservationMs;
  }
  if (n === 0) {
    return 0;
  }
  return Math.min(n, reservationMs);
}

/** Bound a child summary, marking the cut so the parent can see it happened. */
function boundSummary(text: string): string {
  if (text.length <= MAX_CHILD_SUMMARY_CHARS) {
    return text;
  }
  const dropped = text.length - MAX_CHILD_SUMMARY_CHARS;
  return `${text.slice(0, MAX_CHILD_SUMMARY_CHARS)}\n…(truncated: ${dropped} more characters from the subagent)`;
}

export interface SpawnSubagentToolDeps {
  cwd: string;
  /** Parent provider/model (inherited by child unless MAE resolves otherwise). */
  getParentModel: () => { providerId: string; modelId: string; baseUrl?: string };
  /** Build a ProviderPort for a resolved provider/model. */
  makeProvider: (providerId: string, modelId: string, baseUrl?: string) => ProviderPort;
  /** Credentialed providers the child may use (detection allowlist). */
  getDetectedProviders: () => readonly { name: string }[];
  idSeq?: () => string;
  clock?: () => string;
  /** Parent run/session ids for MAE linkage (defaults generated once). */
  parentRunId?: string;
  parentSessionId?: string;
  /**
   * SLATE-6 (flow 163 Track A) — a LIVE getter, not a static snapshot
   * (fix-round Finding 1, code review of PR #306): the PARENT's own open
   * slate, when this run has one, read AT FOLD TIME (inside
   * `foldChildSlateAndCleanup`'s async closure below), never captured once
   * up front. This matters because BOTH real production call sites —
   * `commands/shell.ts`'s TUI `makeAgentDeps` closure (around line 1590) and
   * its readline REPL call site (around line 1785) — construct THIS tool
   * BEFORE the session's slate is actually opened/resolved: a plain
   * `slateSession?: SlateSessionRef` field snapshotted at
   * `createSpawnSubagentTool()` construction time can never observe a slate
   * that opens later, so with that shape a dispatched subagent's
   * Anchors/Seeds were silently never folded anywhere in any real `keryx
   * shell` session — the whole point of SLATE-6 never actually fired in
   * production. This mirrors the exact reason this codebase already uses a
   * live "box read by reference" pattern for `getSessionDir` at those same
   * two call sites: `shell.ts`'s readline path declares `const
   * slateSessionBox: { current: SlateSessionRef | undefined } = { current:
   * undefined }` and passes a getter that reads `slateSessionBox.current` by
   * reference, then hands `slateSessionBox` itself to `runAgentRepl` so it
   * can mutate `.current` once the session's real slate ref is known (see
   * that file's own SLATE-3a comment). `getSlateSession` here is the same
   * idiom applied to this tool's deps. Optional — every existing call site
   * (tests, and any production surface that predates Slate Phase 4) that
   * omits this keeps working unchanged: the child still gets its own
   * ephemeral slate to write Seeds into (see `invoke()` below), but nothing
   * is folded anywhere afterward, since there is no parent `childDispatches`
   * map to fold into.
   */
  getSlateSession?: () => SlateSessionRef | undefined;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// The two profiles that used to be built here moved to
// `src/harness/policy/profiles.ts` when `keryx serve` needed a profile it could
// COMPARE against — and the source-level guard written for that comparison found
// these two, which the R4c launch prompt had recorded as not existing. Their
// fingerprint inputs are preserved verbatim there; nothing about either posture
// changed. They stay out of the operator-selectable name set, because
// `network: allow` with `delegate: allow` is not something a `serve.json` should
// be able to select by typing a name.
const parentShellPolicy = shellParentProfile;
const childReadOnlyPolicy = shellChildReadOnlyProfile;

/**
 * Create the `spawn_subagent` tool bound to a live shell host.
 * One ledger is shared across all spawns for this tool instance (one shell run).
 */
export function createSpawnSubagentTool(deps: SpawnSubagentToolDeps): InteractiveTool {
  const idSeq = deps.idSeq ?? (() => randomUUID());
  const clock = deps.clock ?? (() => new Date().toISOString());
  const parentRunId = deps.parentRunId ?? idSeq();
  const parentSessionId = deps.parentSessionId ?? idSeq();
  const ledger = new RemainingBudgetLedger(
    { maxRuntimeMs: 15 * 60_000, maxToolCalls: 48 },
    { maxChildren: DEFAULT_MAX_CHILDREN },
  );
  const parentProvenance: Provenance = {
    provenanceId: idSeq(),
    trustLevel: "trusted",
    sourceKind: "keryx-shell",
  };
  let childSeq = 0; // only for human labels when the model omits one

  return {
    definition: {
      name: "spawn_subagent",
      description:
        "Spawn a bounded subagent to work on a focused subtask in parallel-safe isolation " +
        "(MAE multi-agent). Use for independent investigations, reviews, or research while " +
        "you continue the main plan. Input: { task: string, mode?: 'read_only'|'general', " +
        "label?: string, max_tool_calls?: number }. Default mode is read_only (no shell). " +
        "Returns the child's summary. Prefer one clear task per spawn; do not spawn for " +
        "trivial questions (answer yourself).",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string" },
          mode: { type: "string", enum: ["read_only", "general"] },
          label: { type: "string" },
          max_tool_calls: { type: "number" },
        },
        required: ["task"],
        additionalProperties: false,
      },
      risk: "delegate",
    },
    invoke: async (input): Promise<InteractiveToolResult> => {
      const task = typeof input.task === "string" ? input.task.trim() : "";
      if (task.length === 0) {
        return { output: "spawn_subagent requires a non-empty 'task'", isError: true };
      }
      const mode: SubagentMode = input.mode === "general" ? "general" : "read_only";
      const maxToolCalls =
        typeof input.max_tool_calls === "number" && input.max_tool_calls > 0
          ? Math.min(16, Math.floor(input.max_tool_calls))
          : 6;
      const labelRaw = typeof input.label === "string" ? input.label.trim() : "";
      childSeq += 1;
      const workerId = `sub:${idSeq()}`;
      const label =
        labelRaw.length > 0
          ? labelRaw.length > 18
            ? `${labelRaw.slice(0, 15)}…`
            : labelRaw
          : `sub-${childSeq}`;

      const parent = deps.getParentModel();
      const detected = deps.getDetectedProviders();
      const ctx: SubagentContext = {
        parentRunId,
        parentSessionId,
        parentProvenance,
        contextManifestHash: sha256(`${parentRunId}:${parentSessionId}`),
        canonicalContractVersion: "1.0.0",
        parentModel: { providerId: parent.providerId, modelId: parent.modelId },
        parentPolicy: parentShellPolicy(),
        ledger,
        detected: detected.length > 0 ? detected : [{ name: parent.providerId }],
        config: { maxTreeDepth: 2, maxChildren: DEFAULT_MAX_CHILDREN },
      };

      const attemptId = idSeq();
      const branchId = idSeq();
      const reservationId = idSeq();
      const artifactHash = sha256(task);
      const spawned = spawnSubagent(
        {
          attempt: { attemptId, number: childSeq },
          branchId,
          budgetRequest: {
            reservationId,
            maxRuntimeMs: 5 * 60_000,
            maxToolCalls,
          },
          policyRequest: childReadOnlyPolicy(),
          durableResultArtifact: {
            artifactId: idSeq(),
            kind: "final-report",
            hash: artifactHash,
          },
        },
        ctx,
        { idSeq, clock },
      );

      if (!spawned.ok) {
        emitSubagentFleet({
          id: workerId,
          kind: "upsert",
          label,
          status: "failed",
          detail: "denied",
          task,
        });
        return {
          output: `spawn_subagent denied by MAE: ${spawned.reason}`,
          isError: true,
        };
      }

      const runModel = spawned.runModel ?? {
        provider: parent.providerId,
        model: parent.modelId,
      };
      emitSubagentFleet({
        kind: "upsert",
        id: workerId,
        label,
        status: "running",
        detail: mode === "read_only" ? "read-only" : "general",
        model: `${runModel.provider}/${runModel.model}`,
        task,
      });

      const cwd = deps.cwd;
      const tools =
        mode === "read_only"
          ? [
              ...builtinReadOnlyTools(cwd),
              ...builtinMetaprojectTools(cwd, makeKeryxRunner(cwd), createMetaprojectAdapter(cwd)),
            ]
          : [
              // v1 general: still no shell_exec (parent owns mutations)
              ...builtinReadOnlyTools(cwd),
              ...builtinMetaprojectTools(cwd, makeKeryxRunner(cwd), createMetaprojectAdapter(cwd)),
            ];

      // SLATE-6 (flow 163 Track A): give the child a real, throwaway slate to
      // write Seeds into during its turn. Minted under the OS temp dir, NEVER
      // under `sessionDir()`/the project's real session store (plan.md's
      // Risks section: a stray `slate.json` there could later be mistaken by
      // `listSessions()`/a future catch-up UI for a genuine session). This
      // happens UNCONDITIONALLY — regardless of whether `deps.getSlateSession`
      // (the PARENT's own slate getter) is even configured — because the child's
      // own ability to call `slate_write_seed` during its turn does not
      // depend on whether anyone will fold the result anywhere afterward;
      // only the fold step (`foldChildSlateAndCleanup` below) is
      // conditional on a parent slate actually existing.
      //
      // `dispatchId` is the ephemeral dir's own OS-random basename — NOT
      // `idSeq()` — because `idSeq()` alone is not guaranteed unique across
      // two SEPARATE `createSpawnSubagentTool(...)` instances that each seed
      // their own `idSeq` counter from zero (a real shape this file's own
      // test suite exercises: `spawn-subagent-child-slate.test.ts`'s "two
      // spawns... fold into two distinct childDispatches keys" test builds
      // TWO independent tool instances, each with its own zero-based `idSeq`
      // counter, and dispatches one child from each). Minting `dispatchId`
      // from `idSeq()` there would produce the identical string for both
      // dispatches — same number of prior `idSeq()` calls on each instance —
      // and the second `writeSlate` would silently clobber the first
      // dispatch's `childDispatches[dispatchId]` entry, exactly the failure
      // mode AC2/AC3's "structurally separate, never overwritten" invariant
      // forbids. `mkdtemp`'s own OS-level random suffix has no such
      // cross-instance collision risk.
      //
      // `ephemeralDir` (once `mkdtemp` succeeds) is tracked separately from
      // `openedChildSlate` so a failure INSIDE `openSlate` (after the temp
      // dir already exists on disk) still gets cleaned up by
      // `foldChildSlateAndCleanup`'s `finally` below, even though Anchors
      // injection / tool registration / folding are all skipped for this one
      // dispatch (degrade gracefully — mirrors `agent.ts`'s own open-trigger
      // catch: "slate open/close check failed (ignored)" — a setup failure
      // here must not fail the whole spawn).
      let ephemeralDir: string | undefined;
      let openedChildSlate: Slate | undefined;
      let dispatchId = "";
      /**
       * F-001 fix (flow 163 fix round, logic reviewer MAJOR finding):
       * flipped to `true` as the very first statement inside
       * `foldChildSlateAndCleanup`, BEFORE that function's own
       * `rm(ephemeralDir, ...)` runs. The abandoned child turn on a timeout
       * (`void turn.catch(() => {})` below) is never actually cancelled —
       * `runAgentTurn` has no cancellation seam — so if that orphaned turn
       * is mid-way through a `slate_write_seed` tool call when the deadline
       * fires, its `appendSeed`/`writeSlate` call would otherwise still
       * resolve `ephemeralDir` via the dir-getter closure below and could
       * resurrect the just-deleted directory: `slate.ts`'s own `writeSlate`
       * does an unconditional `await mkdir(dir, { recursive: true })` with
       * no existence check, silently RECREATING `ephemeralDir` and writing
       * a fresh `slate.json` into it after `foldChildSlateAndCleanup`
       * already `rm -rf`'d it — a permanent leak, since nothing ever
       * revisits `ephemeralDir` again once this `invoke()` call returns.
       * Gating the dir-getter closure on `closing` (see
       * `tools.push(slateWriteSeedTool(...))` below) makes a late-arriving
       * write see `getSessionDir() -> undefined` instead, which
       * `slateWriteSeedTool`'s own `invoke` already degrades gracefully to
       * `{ output: "slate_write_seed: no active session in this run",
       * isError: true }` (slate-tool.ts) — no directory touched, no throw,
       * no directory recreation. Pinned by
       * spawn-subagent-child-slate.test.ts's "in-flight slate_write_seed
       * races the timeout" test.
       */
      let closing = false;
      try {
        ephemeralDir = await mkdtemp(path.join(tmpdir(), "keryx-subagent-slate-"));
        dispatchId = path.basename(ephemeralDir);
        openedChildSlate = await openSlate({
          dir: ephemeralDir,
          cwd,
          // Never actually invoked in practice: `ephemeralDir` is always a
          // brand-new, just-`mkdtemp`'d directory, so `openSlateAtomic`
          // never finds a prior unclosed slate to archive there (its own
          // documented contract — `slate-lifecycle.ts`'s
          // `OpenSlateOptions.mintAttemptId` doc comment: "called ONLY when
          // a prior unclosed slate is actually found"). Wired anyway so a
          // theoretical future dispatchId collision degrades to an archive
          // rather than a silent overwrite.
          mintAttemptId: () => idSeq(),
          runtime: { provider: runModel.provider, model: runModel.model },
        });
        // `openSlate` already performs its own fresh `computeAnchors({ cwd,
        // runtime })` call internally (`slate-lifecycle.ts`) — reusing ITS
        // result here (rather than a second, separate top-level
        // `computeAnchors` call before this) is one canonical "assembled
        // fresh at this exact dispatch" Anchors computation, not two
        // independent live-git reads that could theoretically observe
        // different repo state a few milliseconds apart.
        // F-001 fix: gate the dir-getter on `closing` (declared above) so a
        // write that is still in flight when `foldChildSlateAndCleanup`
        // begins tearing the ephemeral dir down degrades to "no active
        // session" instead of recreating `ephemeralDir` after deletion.
        tools.push(slateWriteSeedTool(() => (closing ? undefined : ephemeralDir), idSeq, clock));
      } catch {
        openedChildSlate = undefined;
      }

      let provider: ProviderPort;
      try {
        provider = deps.makeProvider(runModel.provider, runModel.model, parent.baseUrl);
      } catch (cause) {
        // Cheap, safe widening of ephemeral-dir cleanup (architecture
        // reviewer's info-level finding, fixed while already in this file):
        // a synchronous throw here — after `mkdtemp`/`openSlate` already
        // succeeded above but before the main try/finally-guarded turn ever
        // starts — used to leak `ephemeralDir` forever, since
        // `foldChildSlateAndCleanup` (which owns cleanup) is never reached
        // on this path. Only the temp-dir removal is duplicated here, never
        // the fold itself (there is no child turn output to fold yet, and
        // no parent-slate write should be attempted for a dispatch
        // that never even reached the provider) — this is deliberately NOT
        // routed through `foldChildSlateAndCleanup` to keep this a small,
        // additive fix rather than a restructuring of that function's
        // contract.
        if (ephemeralDir !== undefined) {
          await rm(ephemeralDir, { recursive: true, force: true }).catch(() => {
            // Best-effort; the original `cause` below is what must surface.
          });
        }
        throw cause;
      }
      const childDeps: AgentDeps = {
        provider,
        providerId: runModel.provider,
        modelId: runModel.model,
        tools,
        systemInstruction:
          "You are a keryx subagent. Complete ONLY the assigned task. " +
          "Be concise. Use tools when needed. Do not spawn further subagents. " +
          "End with a short factual summary the parent can use.",
        idSeq: () => idSeq(),
        maxToolCalls: spawned.reservation.maxToolCalls ?? maxToolCalls,
      };

      let assistant = "";
      let childToolCalls = 0;
      let closed = false;
      const childAbort = new AbortController();
      const io: AgentIO = {
        write: (s) => {
          assistant += s;
        },
        onAssistantText: (text) => {
          assistant = text;
          if (closed) {
            return;
          }
          emitSubagentFleet({ kind: "log", id: workerId, entry: { kind: "text", text } });
        },
        onReasoning: (text) => {
          if (closed) {
            return;
          }
          emitSubagentFleet({ kind: "log", id: workerId, entry: { kind: "reasoning", text } });
        },
        onToolCall: (name) => {
          childToolCalls += 1;
          if (closed) {
            return;
          }
          emitSubagentFleet({
            kind: "upsert",
            id: workerId,
            label,
            status: "running",
            detail: name.length > 14 ? `${name.slice(0, 12)}…` : name,
            model: `${runModel.provider}/${runModel.model}`,
            task,
          });
          emitSubagentFleet({ kind: "log", id: workerId, entry: { kind: "tool", text: name } });
        },
        onToolResult: (name, result) => {
          if (closed) {
            return;
          }
          const preview = result.output.trim().slice(0, 400);
          emitSubagentFleet({
            kind: "log",
            id: workerId,
            entry: { kind: "result", text: `${name}${result.isError ? " (error)" : ""} ${preview}` },
          });
        },
        onSystem: (text) => {
          if (closed) {
            return;
          }
          emitSubagentFleet({ kind: "log", id: workerId, entry: { kind: "system", text } });
        },
        // SECURITY-CRITICAL INVARIANT — do not relax without an ADR.
        // `mode` is chosen by the MODEL and `read_only` is auto-approved with no
        // prompt, so a child's privilege level is effectively self-selected.
        // That is only sound because a child can never execute shell: the tool
        // list omits shell_exec, the child policy sets shell/write/delegate to
        // deny, and this approver refuses unconditionally. Removing any one of
        // the three turns a model-chosen field into a privilege escalation.
        // Pinned by spawn-subagent-isolation.test.ts.
        requestApproval: async () => false,
      };

      // Wall-clock deadline. Until now `maxRuntimeMs` was ledger ACCOUNTING
      // only: nothing enforced it, so a child whose provider never answered
      // blocked the parent turn forever (stress finding M4b). The turn is
      // abandoned at the deadline — `runAgentTurn` has no cancellation seam, so
      // the orphaned promise may still settle later; its result is ignored.
      const deadlineMs = resolveSubagentTimeoutMs(spawned.reservation.maxRuntimeMs);
      const startedAt = performance.now();
      /** Give the reservation back so a finished child stops holding the budget. */
      const releaseBudget = (): void => {
        ledger.release(spawned.reservation.reservationId, {
          maxRuntimeMs: Math.round(performance.now() - startedAt),
          maxToolCalls: childToolCalls,
        });
      };

      /**
       * SLATE-6/AC2/AC3: read the child's ephemeral slate back, fold it into
       * `deps.getSlateSession()`'s (the parent's) `childDispatches[dispatchId]` as
       * a tagged, structurally separate entry, then delete the ephemeral dir
       * — called on ALL THREE exit paths below (success/timeout/error) so a
       * hung or failed child still leaves an "incomplete" snapshot of
       * whatever Seeds it managed to write before hanging/failing, instead of
       * silently discarding them (plan.md Track A step 3).
       *
       * try/finally, per plan.md's Risks section: cleanup of `ephemeralDir`
       * must run even when the read-back/fold throws mid-way, so a read
       * failure never leaks the temp dir. The fold itself is ALSO wrapped in
       * its own try/catch (not just try/finally) — a fold failure must
       * degrade silently (mirrors `agent.ts`'s own "slate open/close check
       * failed (ignored)" convention) rather than propagate up and replace
       * the caller's already-computed, more specific result (e.g. the
       * "timed out" message) with a generic failure.
       *
       * AC2's structural invariant — this write touches ONLY
       * `childDispatches`, NEVER `prev.seeds`/`.anchors`/`.course` — holds by
       * construction below: `prev` is spread verbatim, and only
       * `childDispatches` is ever replaced on top of that spread. There is
       * deliberately no fallback that fabricates a `prev` when none exists
       * (F-003 fix, see the `writeSlate` callback below) — a missing parent
       * slate at fold time is a caller bug, not a shape to paper over.
       *
       * Finding 2 (fix round, code review of PR #306 — "narrower F-001 race
       * window"): flipping `closing` (below) only stops a NEW
       * `slate_write_seed` call from starting once this function has been
       * entered — it does nothing for a write whose `invoke()` already read
       * the dir-getter (observed `closing === false`) moments earlier and is
       * now mid-flight through `writeSlate`'s own `await mkdir(dir, ...)` →
       * `withFileLock(slateLockPath(dir), ...)` → read → `writeFileAtomic`
       * chain. Without further synchronization, this function's own final
       * `rm(dirToClean, ...)` could complete WHILE that write is still
       * between its `mkdir` and its lock acquire; `writeSlate`'s
       * unconditional recursive `mkdir` would then silently RECREATE
       * `dirToClean` once it finally gets its turn — the same "permanent
       * leak" the original F-001 fix targeted, just reached through a
       * different interleaving than the one the existing F-001 regression
       * test drives (that test gates the write so it only starts AFTER
       * cleanup has already fully finished; this one is about a write that
       * starts BEFORE cleanup begins and is still in flight when cleanup
       * runs). The fix below acquires the SAME `slateLockPath(dirToClean)`
       * mutex `writeSlate`/`appendSeed` already take for every
       * read-modify-write against this dir, and does the final read-back
       * AND the `rm` INSIDE that one lock hold — reusing the exact
       * synchronization primitive this file's own writes already go
       * through, not a bespoke new one. This fully serializes cleanup
       * against any write that is already holding the lock or is about to
       * request it: that write's own `mkdir(lockPath)` (a plain,
       * non-`recursive` call — see `withFileLock`, `src/lib/fs.ts`) throws
       * ENOENT once `dirToClean` is gone rather than silently recreating
       * anything, since only the ONE unconditional recursive `mkdir` issued
       * before the lock request can resurrect the dir — and holding this
       * lock while we clean up gives that call a real chance to have
       * already landed (or to fail outright) before we ever touch the
       * filesystem. Doing the read-back inside the same hold is a
       * deliberate bonus, not just a side effect of convenience: it means a
       * Seed a write manages to commit right before losing the lock race is
       * captured in `dispatch.seeds` instead of silently dropped by an
       * earlier, unlocked read.
       */
      const foldChildSlateAndCleanup = async (status: "completed" | "incomplete"): Promise<void> => {
        // F-001 fix: flip BEFORE any lock acquisition/rm below (and before
        // the fold itself) so an in-flight `slate_write_seed` call that
        // hasn't yet read the dir-getter sees `getSessionDir() -> undefined`
        // rather than a directory that is about to be (or already was)
        // removed. See the Finding 2 paragraph above for the narrower
        // window this alone does not close, and the lock hold below that
        // does.
        closing = true;
        if (ephemeralDir === undefined) {
          // `mkdtemp` itself never succeeded — there is nothing to fold or
          // clean up (the child never got an ephemeral slate at all).
          return;
        }
        const dirToClean = ephemeralDir;
        try {
          await withFileLock(slateLockPath(dirToClean), async () => {
            try {
              // Read the parent's slate ref LIVE, at fold time — Finding 1: a
              // plain `deps.slateSession` field captured once at the top of
              // `invoke()` (or, worse, at `createSpawnSubagentTool()`
              // construction time) can never observe a slate that the caller
              // opens AFTER this tool instance was built, which is exactly what
              // both real production call sites do. Calling the getter here,
              // inside the fold closure that only runs once the dispatch is
              // actually settling, is what makes this reflect reality.
              const slateSession = deps.getSlateSession?.();
              if (openedChildSlate !== undefined && slateSession !== undefined) {
                try {
                  const childSlate = await readSlate(dirToClean);
                  const dispatch: SlateChildDispatch = {
                    anchors: childSlate?.anchors ?? openedChildSlate.anchors,
                    course: childSlate?.course ?? openedChildSlate.course,
                    seeds: childSlate?.seeds ?? [],
                    status,
                  };
                  const parentDir = slateSession.dir;
                  await writeSlate(parentDir, (prev) => {
                    // F-003 fix (flow 163 fix round, logic reviewer MAJOR
                    // finding): the previous "defensive fallback" here
                    // literally synthesized the PARENT's OWN `.anchors` field
                    // from the CHILD's freshly-computed Anchors when
                    // `deps.slateSession.dir` had no live `slate.json` yet — a
                    // real AC2 violation if ever hit ("A subagent's
                    // Seeds/Anchors/Course never appear in the parent's own
                    // slate.anchors/.course/.seeds fields"). `prev === undefined`
                    // here can only mean a caller wired a `slateSession` ref
                    // WITHOUT ever calling `openSlate` on it first — a
                    // caller-contract violation, not a runtime condition to
                    // paper over with plausible-but-wrong data. This matches
                    // this codebase's own convention for exactly this class of
                    // bug: `appendSeed` (slate.ts) throws `"appendSeed: no open
                    // slate in <dir>"` rather than fabricating a placeholder
                    // slate. Safe to throw here: this callback runs inside the
                    // inner try/catch above, which already documents itself as
                    // "best-effort fold; never mask the dispatch outcome" — a
                    // thrown error degrades silently, exactly like every other
                    // fold failure, and the caller's already-computed
                    // success/timeout/error result is never touched.
                    if (prev === undefined) {
                      throw new Error(`foldChildSlateAndCleanup: no open parent slate in ${parentDir}`);
                    }
                    return {
                      ...prev,
                      childDispatches: { ...(prev.childDispatches ?? {}), [dispatchId]: dispatch },
                    };
                  });
                } catch (foldCause) {
                  // Best-effort fold; never mask the dispatch outcome the caller
                  // already computed (success text / timeout message / error
                  // message) with a fold-specific failure. Finding 3 (fix round,
                  // error-handling IRON LAW 1 — a bare `catch {}` is forbidden):
                  // still log the failure so it is at least observable, via this
                  // file's own established `emitSubagentFleet({ kind: "log",
                  // ... })` diagnostics channel (same one every other
                  // `invoke()` branch already uses for the parent-facing Workers
                  // panel/inspector) rather than a fresh `console.error` seam.
                  const foldMsg = foldCause instanceof Error ? foldCause.message : String(foldCause);
                  emitSubagentFleet({
                    kind: "log",
                    id: workerId,
                    entry: { kind: "system", text: `slate fold failed (ignored): ${foldMsg}` },
                  });
                }
              }
            } finally {
              // Still inside the lock hold: per the Finding 2 rationale
              // above, no writer can be mid-write past this point without
              // having already lost the `mkdir(lockPath)` race to us.
              // `withFileLock`'s own release check (`ownsLock`/`owner.json`
              // in `src/lib/fs.ts`) degrades to a silent no-op once this
              // `rm` has already deleted the whole tree — including the
              // lock dir itself — which is the intended outcome here, not a
              // bug to work around.
              await rm(dirToClean, { recursive: true, force: true }).catch(() => {
                // Best-effort cleanup; a failed rm must not mask the
                // dispatch result either.
              });
            }
          });
        } catch (lockCause) {
          // `withFileLock` itself can throw — most plausibly its own 5s
          // default timeout waiting for a writer that is unexpectedly slow
          // to release the lock, or an unrelated fs error acquiring it.
          // Finding 3 (no bare `catch {}`): log it, then fall back to a
          // direct, unlocked `rm` so a stuck/failed lock attempt never
          // leaks `dirToClean` forever — this reopens the ORIGINAL (wider)
          // F-001 window only in this already-abnormal fallback path, never
          // on the common path above.
          const lockMsg = lockCause instanceof Error ? lockCause.message : String(lockCause);
          emitSubagentFleet({
            kind: "log",
            id: workerId,
            entry: { kind: "system", text: `slate cleanup lock failed (ignored): ${lockMsg}` },
          });
          await rm(dirToClean, { recursive: true, force: true }).catch(() => {
            // Best-effort cleanup; a failed rm must not mask the dispatch
            // result either.
          });
        }
      };

      try {
        const history: import("../../provider/types").NormalizedMessage[] = [];
        // SLATE-6: inject the child's fresh Anchors as a SEPARATE `history`
        // message — never baked into the hardcoded `systemInstruction`
        // string above — exactly mirroring how `runAgentTurnCore`'s own
        // fresh-open trigger does it for the PARENT (`commands/agent.ts`:
        // `history.push({ role: "user", content: renderAnchorsBlock(...),
        // provenance: "project" })`). Pushed BEFORE `runAgentTurn` is called,
        // so it lands as the first entry in `history` — `runAgentTurnCore`
        // itself pushes `userLine` next (also `role: "user"`), so the
        // child's very first request to its provider carries both, in that
        // order.
        if (openedChildSlate !== undefined) {
          history.push({ role: "user", content: renderAnchorsBlock(openedChildSlate.anchors), provenance: "project" });
        }
        const userLine =
          `## Subagent task (${mode})\n` +
          `${task}\n\n` +
          `Return a concise summary of findings and any recommended next steps for the parent agent.`;
        const turn = runAgentTurn(io, childDeps, history, userLine, { signal: childAbort.signal });
        if (deadlineMs > 0) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const expired = new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), deadlineMs);
          });
          let outcome: "done" | "timeout";
          try {
            outcome = await Promise.race([turn.then(() => "done" as const), expired]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
          if (outcome === "timeout") {
            closed = true;
            childAbort.abort();
            void turn.catch(() => {
              // abandoned turn; do not surface after the parent already timed out
            });
            releaseBudget();
            emitSubagentFleet({ kind: "upsert", id: workerId, label, status: "failed", detail: "timeout", task });
            await foldChildSlateAndCleanup("incomplete");
            const partial = assistant.trim();
            return {
              output:
                `subagent ${label} (${workerId}) timed out after ${deadlineMs}ms and was abandoned ` +
                `(tighten or disable with ${ENV_SUBAGENT_TIMEOUT_MS})` +
                (partial.length > 0 ? `\n--- partial output ---\n${boundSummary(partial)}` : ""),
              isError: true,
            };
          }
        } else {
          await turn;
        }
        closed = true;
        releaseBudget();
        const raw =
          assistant.trim().length > 0
            ? assistant.trim()
            : history
                .filter((m) => m.role === "assistant")
                .map((m) => m.content)
                .join("\n")
                .trim() || "(subagent produced no text)";
        const folded = foldChildSummary(raw);
        emitSubagentFleet({
          kind: "upsert",
          id: workerId,
          label,
          status: "done",
          detail: "done",
          model: `${runModel.provider}/${runModel.model}`,
          task,
        });
        await foldChildSlateAndCleanup("completed");
        return {
          output:
            `subagent ${label} (${workerId}) ${mode} via ${runModel.provider}/${runModel.model}\n` +
            `MAE reservation: tools≤${spawned.reservation.maxToolCalls ?? maxToolCalls} ` +
            `runtime≤${spawned.reservation.maxRuntimeMs}ms children=${ledger.childCount}\n` +
            `--- summary ---\n${boundSummary(folded.text)}`,
          isError: false,
        };
      } catch (cause) {
        closed = true;
        childAbort.abort();
        releaseBudget(); // a failed child must not hold the parent's budget either
        const msg = cause instanceof Error ? cause.message : String(cause);
        emitSubagentFleet({
          kind: "upsert",
          id: workerId,
          label,
          status: "failed",
          detail: "error",
          task,
        });
        await foldChildSlateAndCleanup("incomplete");
        return { output: `subagent ${label} failed: ${msg}`, isError: true };
      }
    },
  };
}
