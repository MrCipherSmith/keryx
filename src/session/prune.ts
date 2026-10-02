// Send-time pruning of old tool exchanges (flow 387 T11, T18).
//
// A real session carried ~600K chars of tool results (180 messages) that were
// re-sent on every round, next to the assistant messages that made the calls
// (arguments, replayed reasoning). Before each request, everything outside a
// protected window is shrunk:
//
//  - T11: a tool result becomes a fixed placeholder naming a file with the full text.
//  - T18: an assistant tool-call message whose results are ALL outside the window is
//    collapsed together with them into ONE plain assistant text record, one line per
//    call (`name(digest) → ok|error, full output: <path>`). Old exchanges are not
//    re-sent as structured function calls at all.
//
//  - T19: the encrypted reasoning replay (`reasoning.replay`, echoed to the provider
//    on every later request) is kept only on the newest 3 assistant messages that
//    carry it; older ones lose it, protected window or not. Live-probed against
//    Codex: a structured function_call whose reasoning item was stripped is accepted.
//    It joins the same batch and the same >= 20K saving threshold as the other two,
//    so earlier messages are not rewritten round by round (the prefix cache only
//    breaks once per batch); the newest rounds always keep theirs.
//
// Patterns: opencode `session/compaction.ts` prune (protect the newest 40K tokens,
// only act past a 20K saving), gemini-cli `toolOutputMasking`. Unlike opencode there
// is no protected-turns rule: the context of a real session sat inside one or two
// long operator turns, so protecting whole turns would prune nothing there. The
// operator message is never a tool result, so it is never touched.
//
// Messages are REPLACED, never mutated, so `archive.jsonl`, which holds the original
// message objects, keeps the original text and the original calls. Saving is batched
// (>= 20K tokens, one batch for both kinds) so the provider's prompt-cache prefix is
// not broken every round, and idempotent: a cleared result is never rewritten and a
// collapsed record is plain assistant text (no `toolCalls`), so it is never regrouped.
// A group is collapsed whole or not at all, so no tool result is left without its
// call and no call without its result.
//
// This module takes the session dir from its caller and never resolves a
// config-dir path itself (see the note in `./paths.ts`).

import { estimateMessageTokens } from "../harness/provider/context-guard";
import { extractSpillPath, writeToolOutputFile } from "../harness/tool/output-spill";
import type { NormalizedMessage } from "../harness/provider/types";

/** Newest tool-result tokens that are never pruned. */
export const PRUNE_PROTECT_TOOL_TOKENS = 40_000;
/** Prune only when it saves at least this many estimated tokens. */
export const PRUNE_MIN_SAVING_TOKENS = 20_000;
/** Start of every placeholder; also how an already-cleared result is recognised. */
export const CLEARED_PREFIX = "[Old tool result cleared";
/** First line of a collapsed record's call list (the text before it is the assistant's own). */
export const COLLAPSED_HEADER = "[Earlier tool calls, collapsed — each full output is saved to the file named]";
/** Assistant messages (newest first) that keep their reasoning replay. */
export const REASONING_KEEP_ROUNDS = 3;
/** Most characters of an argument digest. */
const DIGEST_CHARS = 80;
/** Rough path length used to size a record line before its file is known. */
const GUESS_PATH_CHARS = 70;

const PLAIN_PLACEHOLDER = `${CLEARED_PREFIX} to save context]`;

export function clearedPlaceholder(filePath: string | undefined): string {
  return filePath === undefined ? PLAIN_PLACEHOLDER : `${CLEARED_PREFIX} — full text: ${filePath}]`;
}

export function isClearedToolResult(m: NormalizedMessage): boolean {
  return m.role === "tool" && m.content.startsWith(CLEARED_PREFIX);
}

/** The file a cleared-result placeholder names, if any. */
function extractClearedPath(content: string): string | undefined {
  return /^\[Old tool result cleared — full text: (.+)\]$/.exec(content)?.[1];
}

function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Paths a unified diff writes (`+++ b/path`, or `--- a/path` for a deletion). */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    const m = /^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/.exec(line);
    if (m !== null && m[1] !== undefined && m[1] !== "/dev/null") {
      out.push(m[1]);
    }
  }
  return out;
}

function oneLine(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").replace(/ → /g, " -> ").trim();
  return one.length <= max ? one : `${one.slice(0, Math.max(1, max - 1))}…`;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Small deterministic digest of a call's arguments: the path (plus the pattern) for
 * read/search tools, the files touched for `apply_patch`, the first ~80 chars of the
 * command for a shell tool, else the first ~80 chars of the args JSON.
 */
export function argDigest(name: string, rawArgs: string): string {
  const args = parseArgs(rawArgs);
  if (name === "apply_patch" && typeof args.patch === "string") {
    const files = [...new Set(patchPaths(args.patch))];
    if (files.length > 0) {
      return oneLine(files.join(", "), 200);
    }
  }
  const pattern = typeof args.pattern === "string" && args.pattern.length > 0 ? args.pattern : undefined;
  if (typeof args.path === "string" && args.path.length > 0) {
    const p = oneLine(args.path, 200);
    return pattern === undefined ? p : `${p} | pattern=${oneLine(pattern, 40)}`;
  }
  if (pattern !== undefined) {
    return `pattern=${oneLine(pattern, DIGEST_CHARS)}`;
  }
  const command = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : undefined;
  if (command !== undefined) {
    return oneLine(command, DIGEST_CHARS);
  }
  return oneLine(rawArgs, DIGEST_CHARS);
}

function isErrorResult(m: NormalizedMessage): boolean {
  return m.isError === true || /^\S+ failed:/.test(m.content);
}

function recordLine(name: string, digest: string, error: boolean, filePath: string | undefined): string {
  return `${name}(${digest}) → ${error ? "error" : "ok"}${filePath === undefined ? "" : `, full output: ${filePath}`}`;
}

/** The `name(digest)` pairs a collapsed record lists, in order; empty for any other message. */
export function parseCollapsedRecord(m: NormalizedMessage): { name: string; digest: string }[] {
  if (m.role !== "assistant" || m.toolCalls !== undefined || !m.content.includes(COLLAPSED_HEADER)) {
    return [];
  }
  const out: { name: string; digest: string }[] = [];
  for (const line of m.content.slice(m.content.indexOf(COLLAPSED_HEADER)).split("\n").slice(1)) {
    const hit = /^([A-Za-z0-9_.:-]+)\((.*)\) → (?:ok|error)(?:, full output: .*)?$/.exec(line);
    if (hit?.[1] !== undefined && hit[2] !== undefined) {
      out.push({ name: hit[1], digest: hit[2] });
    }
  }
  return out;
}

export interface PrunePlanEntry {
  index: number;
  /** Estimated tokens the placeholder saves. */
  saving: number;
}

/** An assistant tool-call message and its results, all outside the protected window. */
export interface CollapseGroup {
  /** Index of the assistant message. */
  start: number;
  /** Index of its last tool result. */
  end: number;
  /** Estimated tokens the collapsed record saves. */
  saving: number;
}

/** An assistant message carrying opaque reasoning replay items. */
function hasReplay(m: NormalizedMessage): boolean {
  return m.role === "assistant" && (m.reasoning?.replay?.length ?? 0) > 0;
}

/** `m` without its reasoning replay (the visible reasoning text and flags stay). */
function withoutReplay(m: NormalizedMessage): NormalizedMessage {
  const { reasoning, ...rest } = m;
  if (reasoning === undefined) {
    return m;
  }
  const { replay: _replay, ...kept } = reasoning;
  return Object.keys(kept).length > 0 ? { ...rest, reasoning: kept } : rest;
}

export interface PrunePlan {
  /** Results to clear on their own (their group is not collapsed). */
  entries: PrunePlanEntry[];
  /** Whole exchanges to collapse into one text record. */
  groups: CollapseGroup[];
  /** Assistant messages that lose their reasoning replay (all but the newest 3 carrying it). */
  strips: PrunePlanEntry[];
  /** Total estimated saving of `entries` and `groups`. */
  savedTokens: number;
}

/** Estimated size of the record line for `call`, before its file path is known. */
function guessRecordTokens(group: NormalizedMessage, results: readonly NormalizedMessage[]): number {
  let chars = COLLAPSED_HEADER.length + group.content.length + 1;
  for (const call of group.toolCalls ?? []) {
    const result = results.find((r) => r.toolCallId === call.id);
    const path = result === undefined ? undefined : (extractClearedPath(result.content) ?? extractSpillPath(result.content));
    chars += call.name.length + argDigest(call.name, call.arguments).length + 20 + (path ?? "x".repeat(GUESS_PATH_CHARS)).length;
  }
  return Math.ceil(chars / 4);
}

/**
 * Which tool exchanges are outside the protected window, and what shrinking them
 * saves. Pure. Walks newest to oldest: tool-result tokens accumulate and the result
 * that pushes the total past the protected budget, and every older one, is outside.
 * `protectedFrom` is the oldest protected result; an exchange is collapsed only when
 * its last result lies before it. Every other outside result is cleared on its own.
 */
export function planPrune(
  history: readonly NormalizedMessage[],
  opts: { protectTokens?: number; collapseGroups?: boolean } = {},
): PrunePlan {
  const protectTokens = opts.protectTokens ?? PRUNE_PROTECT_TOOL_TOKENS;
  let protectedFrom = history.length;
  let total = 0;
  const outside: number[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m === undefined || m.role !== "tool") {
      continue;
    }
    total += tokens(m.content);
    if (total <= protectTokens) {
      protectedFrom = i;
    } else {
      outside.push(i);
    }
  }

  // The newest REASONING_KEEP_ROUNDS assistant messages carrying replay keep it, and
  // are never collapsed (a collapse would drop it too); every older one is a strip.
  const keepReasoning = new Set<number>();
  const stripCandidates: number[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m !== undefined && hasReplay(m)) {
      if (keepReasoning.size < REASONING_KEEP_ROUNDS) {
        keepReasoning.add(i);
      } else {
        stripCandidates.push(i);
      }
    }
  }

  const groups: CollapseGroup[] = [];
  const grouped = new Set<number>();
  if (opts.collapseGroups !== false) {
    for (let i = 0; i < protectedFrom; i++) {
      const a = history[i];
      if (
        a === undefined ||
        a.role !== "assistant" ||
        a.toolCalls === undefined ||
        a.toolCalls.length === 0 ||
        keepReasoning.has(i)
      ) {
        continue;
      }
      let end = i;
      while (end + 1 < history.length && history[end + 1]?.role === "tool") {
        end += 1;
      }
      const results = history.slice(i + 1, end + 1);
      const ids = new Set(a.toolCalls.map((c) => c.id));
      const answered = new Set(results.map((r) => r.toolCallId ?? ""));
      const complete = results.length > 0 && ids.size === a.toolCalls.length && answered.size === ids.size && [...ids].every((id) => answered.has(id)) && results.length === ids.size;
      if (!complete || end >= protectedFrom) {
        continue;
      }
      let before = estimateMessageTokens(a);
      for (const r of results) {
        before += estimateMessageTokens(r);
      }
      const saving = before - guessRecordTokens(a, results);
      if (saving > 0) {
        groups.push({ start: i, end, saving });
        for (let k = i + 1; k <= end; k++) {
          grouped.add(k);
        }
      }
      i = end;
    }
  }

  const entries: PrunePlanEntry[] = [];
  for (const i of outside) {
    const m = history[i];
    if (m === undefined || grouped.has(i) || isClearedToolResult(m)) {
      continue;
    }
    const saving = tokens(m.content) - tokens(clearedPlaceholder(extractSpillPath(m.content)));
    if (saving > 0) {
      entries.push({ index: i, saving });
    }
  }
  // A group collapses its assistant message anyway, so a strip there would double count.
  const collapsedStarts = new Set(groups.map((g) => g.start));
  const strips: PrunePlanEntry[] = [];
  for (const i of stripCandidates) {
    const m = history[i];
    if (m !== undefined && !collapsedStarts.has(i)) {
      strips.push({ index: i, saving: estimateMessageTokens(m) - estimateMessageTokens(withoutReplay(m)) });
    }
  }
  const savedTokens =
    entries.reduce((a, e) => a + e.saving, 0) +
    groups.reduce((a, g) => a + g.saving, 0) +
    strips.reduce((a, e) => a + e.saving, 0);
  return { entries, groups, strips, savedTokens };
}

export interface PruneOptions {
  /** Live session dir; without one a placeholder or record line carries no path. */
  sessionDir: string | undefined;
  protectTokens?: number;
  /** Overrides {@link PRUNE_MIN_SAVING_TOKENS} (the overflow retry takes any saving). */
  minSavingTokens?: number;
  /** Set false to only clear results and keep every exchange structured (default true). */
  collapseGroups?: boolean;
  /** Called once, just before `history` is changed (hosts flush their archive here). */
  beforeApply?: () => void;
}

export interface PruneResult {
  /** Tool results replaced or folded into a record. */
  pruned: number;
  /** Exchanges collapsed; `history` is shorter by the results and calls they replaced. */
  collapsed: number;
  /** Assistant messages whose reasoning replay was dropped (length unchanged). */
  reasoningStripped: number;
  /** Estimated tokens saved. */
  savedTokens: number;
}

/** Where the full text of `m` lives: its cleared/spill path, else a file written now. */
async function fullTextPath(
  m: NormalizedMessage,
  sessionDir: string | undefined,
  fallbackId: string,
): Promise<string | undefined> {
  const known = extractClearedPath(m.content) ?? extractSpillPath(m.content);
  if (known !== undefined || sessionDir === undefined || isClearedToolResult(m)) {
    return known;
  }
  return writeToolOutputFile(sessionDir, m.toolCallId ?? fallbackId, m.content);
}

/**
 * Shrink old tool exchanges in `history` (in place, same array) when that saves
 * enough. A result already spilled by `spillLargeToolOutput` keeps its spill file; any
 * other is written to `<sessionDir>/tool-output/` first so a placeholder or record
 * line can always name a readable path. A failed write degrades to no path (the
 * archive still has the original).
 */
export async function pruneToolOutputs(history: NormalizedMessage[], opts: PruneOptions): Promise<PruneResult> {
  const plan = planPrune(history, {
    ...(opts.protectTokens !== undefined ? { protectTokens: opts.protectTokens } : {}),
    ...(opts.collapseGroups !== undefined ? { collapseGroups: opts.collapseGroups } : {}),
  });
  if (
    plan.entries.length + plan.groups.length + plan.strips.length === 0 ||
    plan.savedTokens < (opts.minSavingTokens ?? PRUNE_MIN_SAVING_TOKENS)
  ) {
    return { pruned: 0, collapsed: 0, reasoningStripped: 0, savedTokens: 0 };
  }
  opts.beforeApply?.();
  let pruned = 0;
  let savedTokens = 0;
  for (const entry of plan.entries) {
    const m = history[entry.index];
    if (m === undefined || m.role !== "tool" || isClearedToolResult(m)) {
      continue;
    }
    const filePath = await fullTextPath(m, opts.sessionDir, `pruned-${entry.index}`);
    history[entry.index] = { ...m, content: clearedPlaceholder(filePath) };
    pruned += 1;
    savedTokens += tokens(m.content) - tokens(clearedPlaceholder(filePath));
  }
  let reasoningStripped = 0;
  for (const strip of plan.strips) {
    const m = history[strip.index];
    if (m !== undefined && hasReplay(m)) {
      history[strip.index] = withoutReplay(m);
      reasoningStripped += 1;
      savedTokens += strip.saving;
    }
  }
  // Back to front: a splice only shifts indices after it.
  let collapsed = 0;
  for (const group of [...plan.groups].reverse()) {
    const assistant = history[group.start];
    if (assistant === undefined || assistant.toolCalls === undefined) {
      continue;
    }
    const results = history.slice(group.start + 1, group.end + 1);
    const lines: string[] = [];
    for (const call of assistant.toolCalls) {
      const result = results.find((r) => r.toolCallId === call.id);
      const filePath =
        result === undefined ? undefined : await fullTextPath(result, opts.sessionDir, `collapsed-${call.id}`);
      lines.push(recordLine(call.name, argDigest(call.name, call.arguments), result !== undefined && isErrorResult(result), filePath));
    }
    const text = assistant.content.trim();
    const record: NormalizedMessage = {
      role: "assistant",
      content: [...(text.length > 0 ? [text] : []), COLLAPSED_HEADER, ...lines].join("\n"),
      ...(assistant.provenance !== undefined ? { provenance: assistant.provenance } : {}),
      ...(assistant.ts !== undefined ? { ts: assistant.ts } : {}),
    };
    savedTokens += [assistant, ...results].reduce((a, m) => a + estimateMessageTokens(m), 0) - estimateMessageTokens(record);
    history.splice(group.start, group.end - group.start + 1, record);
    pruned += results.length;
    collapsed += 1;
  }
  return { pruned, collapsed, reasoningStripped, savedTokens };
}
