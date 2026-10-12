// Flow 387 T12 (AC9): deterministic replay of a synthetic session shaped like the
// 2026-10-01 vantage-frontend session, measured on two request-preparation models.
//
// Only the SHAPE of the real session is reproduced (message mix, sizes, anchor churn,
// notification cadence); every byte of content is seeded filler. The generator is
// seeded (mulberry32), so two runs emit byte-identical sessions.
//
// Two modes:
//  - "branch": composes the REAL code paths of this branch in the order the agent
//    round loop uses them: `spillToolOutput` on every tool result,
//    `anchorsAnnouncement` for anchors changes, `pruneToolOutputs`, the
//    `estimateWithUsageAnchor` guard + `needsCompaction`, `compactWithFallback`
//    spliced into history, and a usage anchor recorded as the full estimate of the
//    request that was "sent" (the provider is simulated).
//  - "main-before": a model of `main` before flow 387 (documented, not imported):
//    full history re-sent every round; every anchors change appends a NEW full
//    `Anchors:` block; no spill; no prune; and no auto-compaction, because the
//    codex window was unknown there (`needsCompaction(_, undefined)` is always
//    false). The per-request figure is the same full-request estimate
//    (`estimateRequestTokens`, which counts replayed reasoning) so both modes are
//    measured with one ruler.

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { NormalizedMessage, NormalizedToolDefinition } from "../../src/harness/provider/types";
import {
  estimateRequestTokens,
  estimateWithUsageAnchor,
  needsCompaction,
  snapshotRequest,
  toUsageAnchor,
  type UsageAnchor,
} from "../../src/harness/provider/context-guard";
import { spillToolOutput, writeToolOutputFile } from "../../src/harness/tool/output-spill";
import { anchorsAnnouncement } from "../../src/session/anchors-announce";
import { compactWithFallback } from "../../src/session/compact";
import { firstChangedIndex, pruneToolOutputs } from "../../src/session/prune";
import { tokensOf } from "../../src/session/bounded-request";
import {
  cachedPriceRatio,
  decideRewrite,
  estimateRemainingRounds,
  pruneThresholdsForWindow,
} from "../../src/session/rewrite-gate";
import { renderAnchorsBlock, type Slate, type SlateAnchors, type SlateNote, type TrailEntry } from "../../src/session/slate";
import { rewriteWorkingMemory } from "../../src/session/working-memory";

/** Model and window of the real session (openai-codex/gpt-6.1-sol). */
export const REPLAY_MODEL = "openai-codex/gpt-6.1-sol";
export const REPLAY_WINDOW = 272_000;
export const REPLAY_SEED = 0x20261001;

// ---------------------------------------------------------------- generator

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

const WORDS = [
  "const", "return", "await", "export", "function", "interface", "import", "from", "async", "value",
  "result", "options", "handler", "config", "state", "items", "index", "length", "undefined", "string",
  "number", "boolean", "Promise", "Record", "readonly", "lorem", "ipsum", "dolor", "amet", "elit",
];

function int(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** Code-ish multi-line filler of exactly `n` chars. */
function filler(rng: Rng, n: number): string {
  const parts: string[] = [];
  let len = 0;
  while (len < n) {
    const words: string[] = [];
    const count = int(rng, 4, 12);
    for (let i = 0; i < count; i++) {
      words.push(WORDS[int(rng, 0, WORDS.length - 1)] ?? "x");
    }
    const line = `${" ".repeat(int(rng, 0, 3) * 2)}${words.join(" ")}${rng() < 0.3 ? ";" : ""}\n`;
    parts.push(line);
    len += line.length;
  }
  return parts.join("").slice(0, n);
}

/** Seeded string of `n` base64-alphabet chars (stands in for an encrypted reasoning item). */
function opaque(rng: Rng, n: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const chars: string[] = [];
  for (let i = 0; i < n; i++) {
    chars.push(alphabet[int(rng, 0, alphabet.length - 1)] ?? "A");
  }
  return chars.join("");
}

/** `count` integer sizes drawn from skewed seeded weights that sum to exactly `total`. */
function sizesSummingTo(rng: Rng, count: number, total: number, floor: number): number[] {
  const weights = Array.from({ length: count }, () => 0.25 + rng() ** 3 * 3);
  const sum = weights.reduce((a, b) => a + b, 0);
  // Every size is `floor` plus a weighted share of what is left, so the floor never
  // inflates the total.
  const spare = total - count * floor;
  const sizes = weights.map((w) => floor + Math.round((w / sum) * spare));
  const drift = total - sizes.reduce((a, b) => a + b, 0);
  sizes[sizes.length - 1] = (sizes[sizes.length - 1] ?? floor) + drift;
  return sizes;
}

export type ReplayStep =
  | { kind: "operator"; message: NormalizedMessage }
  | { kind: "anchors"; anchors: SlateAnchors }
  | { kind: "notice"; message: NormalizedMessage }
  | { kind: "round"; assistant: NormalizedMessage; tools: NormalizedMessage[] };

export interface SyntheticSession {
  systemInstruction: string;
  toolDefs: NormalizedToolDefinition[];
  /** A prior compaction summary the session starts from (the archive held ~1068 more). */
  initial: NormalizedMessage[];
  steps: ReplayStep[];
}

const OPERATOR_PROMPTS = [
  "continue",
  "check the CI status and fix what is red",
  "go on with the next item",
  "run the linter and show me what is left",
  "ok, apply it",
  "why did that test fail? look at the log",
  "update the branch and re-run the checks",
  "yes, do that",
  "now the same for the other module",
  "summarize what changed so far",
  "retry, the shell task was cancelled",
  "looks fine, commit it",
  "continue with the review comments",
  "check again",
  "wrap up and report",
];

const TURNS = 15;
const ROUNDS = 110;
const TOOL_RESULTS = 180;
const ANCHOR_STEPS = 22;
const NOTICES = 11;

/** Build the seeded synthetic session. Pure; same seed, same bytes. */
export function generateSession(seed: number = REPLAY_SEED): SyntheticSession {
  const rng = mulberry32(seed);

  // Rounds per operator turn: 110 rounds over 15 turns, uneven.
  const roundsPerTurn = Array.from({ length: TURNS }, () => 7);
  for (let i = 0; i < ROUNDS - TURNS * 7; i++) {
    const t = int(rng, 0, TURNS - 1);
    roundsPerTurn[t] = (roundsPerTurn[t] ?? 7) + 1;
  }

  // Tool calls per round: every round has one, 70 extras spread over seeded rounds.
  const callsPerRound = Array.from({ length: ROUNDS }, () => 1);
  for (let extra = TOOL_RESULTS - ROUNDS; extra > 0; ) {
    const r = int(rng, 0, ROUNDS - 1);
    if ((callsPerRound[r] ?? 1) < 3) {
      callsPerRound[r] = (callsPerRound[r] ?? 1) + 1;
      extra--;
    }
  }
  const callTotal = callsPerRound.reduce((a, b) => a + b, 0);

  // Tool-result sizes: 5 large ones at seeded positions (39K skills listing, 33K SKILL.md,
  // 22K/21K/20K source and lint JSON), the rest sum to the remainder of ~600K chars.
  const big = [39_000, 33_000, 22_000, 21_000, 20_000];
  const resultSizes = sizesSummingTo(rng, callTotal - big.length, 600_000 - big.reduce((a, b) => a + b, 0), 300);
  const bigAt = new Set<number>();
  while (bigAt.size < big.length) {
    bigAt.add(int(rng, 8, callTotal - 20));
  }
  const toolSizeByCall: number[] = [];
  let bigIdx = 0;
  let smallIdx = 0;
  const bigPositions = [...bigAt].sort((a, b) => a - b);
  for (let i = 0; i < callTotal; i++) {
    if (bigPositions.includes(i)) {
      toolSizeByCall.push(big[bigIdx++] ?? 20_000);
    } else {
      toolSizeByCall.push(resultSizes[smallIdx++] ?? 1000);
    }
  }
  const argSizes = sizesSummingTo(rng, callTotal, 100_000, 60);
  const textSizes = sizesSummingTo(rng, ROUNDS, 12_000, 20);

  // Encrypted reasoning replay on 53 seeded rounds, ~143K chars in total.
  const reasoningAt = new Set<number>();
  while (reasoningAt.size < 53) {
    reasoningAt.add(int(rng, 0, ROUNDS - 1));
  }
  const reasoningSizes = sizesSummingTo(rng, 53, 143_000, 1500);

  // Anchor churn: 22 growing `touched` lists, first block ~145 chars, last ~7.3K.
  const touchedAll = Array.from(
    { length: 130 },
    (_, i) => `src/feature-${i % 17}/module-${i % 9}/component-${1000 + i * 7}.tsx`,
  );
  const anchorSteps: SlateAnchors[] = Array.from({ length: ANCHOR_STEPS }, (_, i) => ({
    root: "/work/example-project/frontend",
    tree: "src (feature modules, shared core, wrappers)",
    runtime: { provider: "openai-codex", model: "gpt-6.1-sol" },
    touched: touchedAll.slice(0, Math.round(118 * (i / (ANCHOR_STEPS - 1)) ** 1.3)),
  }));

  // Positions (round index) of anchors changes and shell-task notices.
  const anchorRounds = Array.from({ length: ANCHOR_STEPS }, (_, i) =>
    Math.min(ROUNDS - 1, Math.round(((i + rng() * 0.8) / ANCHOR_STEPS) * ROUNDS)),
  );
  const noticeRounds = new Set<number>();
  while (noticeRounds.size < NOTICES) {
    noticeRounds.add(int(rng, 2, ROUNDS - 1));
  }

  const steps: ReplayStep[] = [];
  let round = 0;
  let call = 0;
  let anchorIdx = 0;
  let reasoningIdx = 0;
  const reasoningBySlot = [...reasoningAt].sort((a, b) => a - b);
  for (let turn = 0; turn < TURNS; turn++) {
    steps.push({
      kind: "operator",
      message: { role: "user", content: OPERATOR_PROMPTS[turn] ?? "continue", provenance: "trusted" },
    });
    for (let r = 0; r < (roundsPerTurn[turn] ?? 7); r++, round++) {
      while (anchorIdx < ANCHOR_STEPS && (anchorRounds[anchorIdx] ?? ROUNDS) <= round) {
        steps.push({ kind: "anchors", anchors: anchorSteps[anchorIdx] as SlateAnchors });
        anchorIdx++;
      }
      if (noticeRounds.has(round)) {
        const size = int(rng, 900, 4300);
        steps.push({
          kind: "notice",
          message: {
            role: "user",
            content: `[system] A shell task finished (exit 0).\n${filler(rng, size)}`.slice(0, size),
            provenance: "tool",
            injected: true,
          },
        });
      }
      const calls = callsPerRound[round] ?? 1;
      const toolCalls = Array.from({ length: calls }, (_, k) => {
        const n = call + k;
        const argSize = argSizes[n] ?? 100;
        const pad = Math.max(0, argSize - 12);
        return {
          id: `call_${n}`,
          name: n % 3 === 0 ? "read_file" : n % 3 === 1 ? "search_code" : "shell_exec",
          arguments: `{"cmd":"${filler(rng, pad).replace(/[\n"\\]/g, " ")}"}`,
        };
      });
      const assistant: NormalizedMessage = {
        role: "assistant",
        content: filler(rng, textSizes[round] ?? 100).replace(/\n/g, " "),
        toolCalls,
      };
      if (reasoningBySlot.includes(round)) {
        assistant.reasoning = {
          replay: [
            {
              providerId: "openai-codex",
              kind: "encrypted_content",
              data: opaque(rng, reasoningSizes[reasoningIdx++] ?? 2700),
            },
          ],
        };
      }
      const tools: NormalizedMessage[] = toolCalls.map((tc, k) => ({
        role: "tool",
        content: filler(rng, toolSizeByCall[call + k] ?? 1000),
        toolCallId: tc.id,
        provenance: "tool",
      }));
      call += calls;
      steps.push({ kind: "round", assistant, tools });
    }
  }

  const toolDefs: NormalizedToolDefinition[] = Array.from({ length: 28 }, (_, i) => ({
    name: `tool_${i}`,
    description: filler(rng, 500).replace(/\n/g, " "),
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: filler(rng, 300).replace(/\n/g, " ") } },
    },
  }));

  return {
    systemInstruction: filler(rng, 12_000),
    toolDefs,
    initial: [
      {
        role: "user",
        content: `[Compacted earlier context — full transcript retained on disk]\n${filler(rng, 3000)}`.slice(0, 3000),
        provenance: "project",
        injected: true,
      },
    ],
    steps,
  };
}

// ------------------------------------------------------------------- replay

export interface ReplayResult {
  mode: "branch" | "main-before";
  model: string;
  windowTokens: number;
  thresholdTokens: number;
  requests: number;
  /** Largest per-request estimated input (full-request chars/4 of what was sent). */
  peakEstimate: number;
  /** Sum of the per-request estimates over the replay. */
  totalEstimate: number;
  compactions: number;
  /** Rounds in which prune cleared at least one result. */
  prunes: number;
  /** Flow 393: working-memory rewrites applied (frame rebuilds, with the packs they carried). */
  rewrites: number;
  prunedResults: number;
  spilled: number;
  /** Estimated tokens of the context after the last round. */
  finalContext: number;
  perRequest: number[];
}

function result(
  mode: ReplayResult["mode"],
  perRequest: number[],
  counters: Pick<ReplayResult, "compactions" | "prunes" | "prunedResults" | "spilled" | "finalContext"> &
    Partial<Pick<ReplayResult, "rewrites">>,
): ReplayResult {
  return {
    mode,
    model: REPLAY_MODEL,
    windowTokens: REPLAY_WINDOW,
    thresholdTokens: 0.85 * REPLAY_WINDOW,
    rewrites: 0,
    requests: perRequest.length,
    peakEstimate: Math.max(0, ...perRequest),
    totalEstimate: perRequest.reduce((a, b) => a + b, 0),
    ...counters,
    perRequest,
  };
}

/** `main` before flow 387: full history every round, a fresh full anchors block per change. */
export function replayMainBefore(session: SyntheticSession): ReplayResult {
  const history: NormalizedMessage[] = [...session.initial];
  const perRequest: number[] = [];
  for (const step of session.steps) {
    if (step.kind === "operator" || step.kind === "notice") {
      history.push(step.message);
    } else if (step.kind === "anchors") {
      history.push({
        role: "user",
        content: renderAnchorsBlock(step.anchors),
        provenance: "project",
        injected: true,
      });
    } else {
      perRequest.push(estimateRequestTokens(history, session.systemInstruction, session.toolDefs));
      history.push(step.assistant, ...step.tools);
    }
  }
  return result("main-before", perRequest, {
    compactions: 0,
    prunes: 0,
    prunedResults: 0,
    spilled: 0,
    finalContext: estimateRequestTokens(history, session.systemInstruction, session.toolDefs),
  });
}

/**
 * This branch: the agent round loop's request preparation, composed from the exported
 * functions in the order agent.ts runs them (spill on tool result, anchors delta,
 * prune, anchored estimate, guard, compaction splice, usage anchor from the sent size).
 */
export async function replayBranch(session: SyntheticSession, sessionDir?: string): Promise<ReplayResult> {
  // A cleared-result placeholder names its file, so the path length enters the estimate.
  // A fixed root keeps the numbers identical across machines and test runners (their
  // `os.tmpdir()` differs); the random suffix is a constant 6 characters.
  const root = existsSync("/tmp") ? "/tmp" : os.tmpdir();
  const ownDir = sessionDir === undefined ? await mkdtemp(path.join(root, "replay-session-")) : undefined;
  const dir = sessionDir ?? (ownDir as string);
  try {
    const history: NormalizedMessage[] = [...session.initial];
    const perRequest: number[] = [];
    let anchor: UsageAnchor | undefined;
    let compactions = 0;
    let prunes = 0;
    let prunedResults = 0;
    let spilled = 0;
    const { systemInstruction, toolDefs } = session;
    const window = REPLAY_WINDOW;

    for (const step of session.steps) {
      if (step.kind === "operator" || step.kind === "notice") {
        history.push(step.message);
      } else if (step.kind === "anchors") {
        const announcement = anchorsAnnouncement(history, step.anchors);
        if (announcement !== undefined) {
          history.push(announcement);
        }
      } else {
        const pruned = await pruneToolOutputs(history, { sessionDir: dir });
        if (pruned.pruned > 0) {
          prunes += 1;
          prunedResults += pruned.pruned;
          anchor = undefined; // the anchored prefix just shrank
        }
        const guardEstimate =
          pruned.pruned > 0
            ? estimateRequestTokens(history, systemInstruction, toolDefs)
            : estimateWithUsageAnchor(history, systemInstruction, toolDefs, anchor);
        if (needsCompaction(guardEstimate, window)) {
          const compacted = compactWithFallback(history, {
            keepLastUserTurns: 3,
            fits: (ctx) => !needsCompaction(estimateRequestTokens(ctx, systemInstruction, toolDefs), window),
          });
          if (!compacted.noop) {
            history.splice(0, history.length, ...compacted.context);
            compactions += 1;
          }
        }
        const snapshot = snapshotRequest(history, systemInstruction, toolDefs);
        const sent = estimateRequestTokens(history, systemInstruction, toolDefs);
        perRequest.push(sent);
        anchor = toUsageAnchor(snapshot, sent); // simulated provider usage = what was sent
        history.push(step.assistant);
        for (const tool of step.tools) {
          const spill = await spillToolOutput(tool.content, {
            sessionDir: dir,
            toolCallId: tool.toolCallId ?? "call",
          });
          if (spill.text !== tool.content) {
            spilled += 1;
          }
          // Flow 387 review r1 F-002: the agent loop records the spill path as data.
          history.push({ ...tool, content: spill.text, ...(spill.spillPath !== undefined ? { spillPath: spill.spillPath } : {}) });
        }
      }
    }
    return result("branch", perRequest, {
      compactions,
      prunes,
      prunedResults,
      spilled,
      finalContext: estimateRequestTokens(history, systemInstruction, toolDefs),
    });
  } finally {
    if (ownDir !== undefined) {
      await rm(ownDir, { recursive: true, force: true });
    }
  }
}

/** Flow 393: the notes a working-memory session would hold (a handful of short facts). */
const REPLAY_NOTES: Record<string, SlateNote> = {
  task: { text: "Goal: get CI green on the frontend branch. Constraint: do not touch generated files.", ts: "t" },
  findings: {
    text: "The failing lint rule is in src/feature-3/module-3. The flaky test is order-dependent; rerun once before editing.",
    ts: "t",
  },
  next: { text: "Next: apply the lint fix, rerun the affected tests, then report to the operator.", ts: "t" },
};

/**
 * Flow 393: this branch on a working-memory host. The round loop's request preparation as
 * `pruneOrRewriteHistory` runs it: every tool result is saved and recorded in the Trail, anchors
 * announce as before, and each round passes through `rewriteWorkingMemory` (frame + last K rounds +
 * observation packs behind the cache-cost gate) before the flow-394 prune and the compaction guard.
 */
export async function replayBounded(session: SyntheticSession, sessionDir?: string): Promise<ReplayResult> {
  const root = existsSync("/tmp") ? "/tmp" : os.tmpdir();
  const ownDir = sessionDir === undefined ? await mkdtemp(path.join(root, "replay-session-")) : undefined;
  const dir = sessionDir ?? (ownDir as string);
  try {
    const history: NormalizedMessage[] = [...session.initial];
    const perRequest: number[] = [];
    let anchor: UsageAnchor | undefined;
    let compactions = 0;
    let prunes = 0;
    let prunedResults = 0;
    let spilled = 0;
    let rewrites = 0;
    let trailStep = 0;
    const trail: TrailEntry[] = [];
    let anchors: SlateAnchors = { root: "/work/example-project/frontend", touched: [] };
    const { systemInstruction, toolDefs } = session;
    const window = REPLAY_WINDOW;
    const thresholds = pruneThresholdsForWindow(window);
    const nonce = "replaynonce";
    const frame = { nonce, scrub: (t: string): string => t.split(nonce).join("[nonce]") };
    let roundIndex = 0;

    for (const step of session.steps) {
      if (step.kind === "operator" || step.kind === "notice") {
        history.push(step.message);
      } else if (step.kind === "anchors") {
        anchors = step.anchors;
        const announcement = anchorsAnnouncement(history, step.anchors);
        if (announcement !== undefined) {
          history.push(announcement);
        }
      } else {
        roundIndex += 1;
        const forced = needsCompaction(estimateRequestTokens(history, systemInstruction, toolDefs), window);
        const slate: Slate = { anchors, course: {}, seeds: [], trail: [...trail], notes: REPLAY_NOTES };
        const rewrite = await rewriteWorkingMemory({
          history,
          sessionDir: dir,
          slate,
          frame,
          contextWindow: window,
          providerId: "openai-codex",
          remainingRounds: estimateRemainingRounds({ round: roundIndex, maxRounds: 150 }),
          atPlanBoundary: false,
          forced,
        });
        let changed = rewrite.applied;
        if (rewrite.applied) rewrites += 1;
        if (!rewrite.applied) {
          const pruned = await pruneToolOutputs(history, {
            sessionDir: dir,
            protectTokens: thresholds.protectTokens,
            minSavingTokens: thresholds.minSavingTokens,
            shouldApply: (plan, h) =>
              decideRewrite({
                kind: "prune",
                savedTokens: plan.savedTokens,
                invalidatedTokens: tokensOf(h.slice(firstChangedIndex(plan, h))),
                remainingRounds: estimateRemainingRounds({ round: roundIndex, maxRounds: 150 }),
                cachedRatio: cachedPriceRatio("openai-codex"),
                forced,
              }).apply,
          });
          if (pruned.pruned > 0) {
            prunes += 1;
            prunedResults += pruned.pruned;
            changed = true;
          }
        }
        if (changed) anchor = undefined;
        const guardEstimate = changed
          ? estimateRequestTokens(history, systemInstruction, toolDefs)
          : estimateWithUsageAnchor(history, systemInstruction, toolDefs, anchor);
        if (needsCompaction(guardEstimate, window)) {
          const compacted = compactWithFallback(history, {
            keepLastUserTurns: 3,
            fits: (ctx) => !needsCompaction(estimateRequestTokens(ctx, systemInstruction, toolDefs), window),
          });
          if (!compacted.noop) {
            history.splice(0, history.length, ...compacted.context);
            compactions += 1;
          }
        }
        const snapshot = snapshotRequest(history, systemInstruction, toolDefs);
        const sent = estimateRequestTokens(history, systemInstruction, toolDefs);
        perRequest.push(sent);
        anchor = toUsageAnchor(snapshot, sent);
        history.push(step.assistant);
        const names = new Map((step.assistant.toolCalls ?? []).map((c) => [c.id, c.name]));
        for (const tool of step.tools) {
          const id = tool.toolCallId ?? "call";
          const spill = await spillToolOutput(tool.content, { sessionDir: dir, toolCallId: id });
          if (spill.text !== tool.content) spilled += 1;
          // The loop saves every output of a working-memory host and records it in the Trail.
          const filePath = spill.spillPath ?? (await writeToolOutputFile(dir, id, tool.content));
          trailStep += 1;
          trail.push({
            step: trailStep,
            tool: names.get(id) ?? "tool",
            digest: id,
            outcome: "ok",
            ts: "t",
            ...(filePath !== undefined ? { outputPath: filePath } : {}),
          });
          history.push({
            ...tool,
            content: spill.text,
            trailStep,
            ...(filePath !== undefined ? { spillPath: filePath } : {}),
          });
        }
      }
    }
    return result("branch", perRequest, {
      rewrites,
      compactions,
      prunes,
      prunedResults,
      spilled,
      finalContext: estimateRequestTokens(history, systemInstruction, toolDefs),
    });
  } finally {
    if (ownDir !== undefined) {
      await rm(ownDir, { recursive: true, force: true });
    }
  }
}

export interface ReplayComparison {
  before: ReplayResult;
  after: ReplayResult;
  /** 1 - after.total / before.total. */
  totalReduction: number;
  /** after.peak / window. */
  peakShareOfWindow: number;
}

export async function runReplay(seed: number = REPLAY_SEED): Promise<ReplayComparison> {
  const session = generateSession(seed);
  const before = replayMainBefore(session);
  const after = await replayBranch(session);
  return {
    before,
    after,
    totalReduction: 1 - after.totalEstimate / before.totalEstimate,
    peakShareOfWindow: after.peakEstimate / REPLAY_WINDOW,
  };
}

function format(r: ReplayResult): string {
  return [
    `${r.mode}`,
    `  requests:               ${r.requests}`,
    `  peak per-request input: ${r.peakEstimate} tokens (${((r.peakEstimate / r.windowTokens) * 100).toFixed(1)}% of window)`,
    `  total estimated input:  ${r.totalEstimate} tokens`,
    `  compactions:            ${r.compactions}`,
    `  prune rounds:           ${r.prunes} (${r.prunedResults} results cleared)`,
    ...(r.rewrites > 0 ? [`  working-memory rewrites: ${r.rewrites}`] : []),
    `  spilled results:        ${r.spilled}`,
    `  final context:          ${r.finalContext} tokens`,
  ].join("\n");
}

export function formatComparison(c: ReplayComparison): string {
  return [
    `model ${c.after.model}  window ${c.after.windowTokens}  compaction threshold ${c.after.thresholdTokens} (0.85 x window)`,
    format(c.before),
    format(c.after),
    `total estimated input reduction: ${(c.totalReduction * 100).toFixed(1)}% (AC9 needs >= 50%)`,
    `peak per-request input vs threshold: ${c.after.peakEstimate} < ${c.after.thresholdTokens} -> ${c.after.peakEstimate < c.after.thresholdTokens ? "yes" : "NO"}`,
  ].join("\n");
}

/** Flow 393 AC3: the replay peak must stay at or below this many estimated tokens. */
export const BOUNDED_PEAK_LIMIT = 64_000;
/** Flow 393 AC3: 25% below the flow-394 replay total of 7,374,769. */
export const FLOW_394_REPLAY_TOTAL = 7_374_769;
export const BOUNDED_TOTAL_LIMIT = Math.round(FLOW_394_REPLAY_TOTAL * 0.75);

export interface BoundedComparison {
  flow394: ReplayResult;
  bounded: ReplayResult;
  /** 1 - bounded.total / flow394.total. */
  totalReduction: number;
}

export async function runBoundedReplay(seed: number = REPLAY_SEED): Promise<BoundedComparison> {
  const session = generateSession(seed);
  const flow394 = await replayBranch(session);
  const bounded = await replayBounded(session);
  return { flow394, bounded, totalReduction: 1 - bounded.totalEstimate / flow394.totalEstimate };
}

export function formatBounded(c: BoundedComparison): string {
  return [
    "flow 394 (prune only)",
    format(c.flow394),
    "flow 393 (bounded request, working memory)",
    format(c.bounded),
    `peak per-request input: ${c.bounded.peakEstimate} (limit ${BOUNDED_PEAK_LIMIT}) -> ${c.bounded.peakEstimate <= BOUNDED_PEAK_LIMIT ? "ok" : "OVER"}`,
    `total estimated input: ${c.bounded.totalEstimate} (limit ${BOUNDED_TOTAL_LIMIT}, ${(c.totalReduction * 100).toFixed(1)}% below flow 394) -> ${c.bounded.totalEstimate <= BOUNDED_TOTAL_LIMIT ? "ok" : "OVER"}`,
  ].join("\n");
}

if (import.meta.main) {
  const seedFlag = process.argv.indexOf("--seed");
  const seed = seedFlag >= 0 ? Number(process.argv[seedFlag + 1]) : REPLAY_SEED;
  console.log(formatComparison(await runReplay(seed)));
  console.log("");
  console.log(formatBounded(await runBoundedReplay(seed)));
}
