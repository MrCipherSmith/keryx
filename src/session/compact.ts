// Deterministic conversation compaction (no LLM required).
//
// Replaces an early prefix of the model context with a single structured summary
// message, keeping the last N OPERATOR turns intact. Full history stays in the
// session archive on disk — compact only shrinks what the model sees next.
//
// Flow 387 T8: a "turn" is something the operator typed. The harness also
// injects `role: "user"` messages (`Anchors:` blocks, task notifications,
// repeated-failure hints, an earlier compaction summary); counting those made
// "keep the last 3 user turns" keep only the trailing injected messages and
// remove almost nothing, and each summary nested the previous one with every
// request clipped to 160 chars. Now only operator turns are counted, injected
// messages in the removed prefix are dropped (never summarised as requests),
// and every earlier operator request survives in the summary.

import type { NormalizedMessage } from "../harness/provider/types";
import { consolidateAnchors, isAnchorsContent, isFullAnchorsContent } from "./anchors-announce";
import { parseCollapsedRecord, patchPaths } from "./prune";

export interface CompactOptions {
  /** How many trailing operator turns (with following assistant/tool/injected msgs) to keep. */
  keepLastUserTurns?: number;
  /** Optional focus hint embedded in the summary. */
  focus?: string;
  /** Max chars per prior operator request in the summary (floor: 500). */
  maxPromptChars?: number;
}

export interface CompactResult {
  /** New model context window. */
  context: NormalizedMessage[];
  /** Messages removed from the model window (still in archive). */
  removed: number;
  /** Human-readable summary text that was injected. */
  summaryText: string;
  /** True when history was already small enough. */
  noop: boolean;
}

/** Never clip an operator request below this many characters. */
const MIN_PROMPT_CHARS = 500;
const SUMMARY_HEADER = "[Compacted earlier context";
const REQUESTS_HEADER = "Prior user requests:";
const FILES_READ_PREFIX = "Files read: ";
const FILES_MODIFIED_PREFIX = "Files modified: ";
const TOOLS_RUN_PREFIX = "Tools run: ";
/** Most paths listed per "Files …" line. */
const MAX_LISTED_FILES = 40;
/** Banners of harness-injected notifications that predate the `injected` marker. */
const LEGACY_INJECTED_PREFIXES: readonly string[] = [
  "[system] A shell task finished",
  "[system] Messages from other keryx agents",
];

/** Tools whose `path` argument is a file the model looked at. */
const READ_TOOLS: ReadonlySet<string> = new Set(["read_file", "list_dir", "search_code"]);

/**
 * Whether `m` is a turn the operator authored. Pure.
 *
 * New sessions carry `injected: true` on harness-injected user messages and a
 * `"tool"`/`"harness"` provenance on notifications and hints. A session saved
 * before the marker existed has anchors blocks and summaries with plain
 * `"project"` provenance, so those are recognised by their content too.
 */
export function isOperatorMessage(m: NormalizedMessage): boolean {
  if (m.role !== "user" || m.injected === true) {
    return false;
  }
  if (m.provenance === "tool" || m.provenance === "harness" || m.provenance === "model") {
    return false;
  }
  return !isLegacyInjectedContent(m.content);
}

function isLegacyInjectedContent(content: string): boolean {
  return (
    isAnchorsContent(content) ||
    content.startsWith(SUMMARY_HEADER) ||
    LEGACY_INJECTED_PREFIXES.some((p) => content.startsWith(p))
  );
}

/**
 * Find start index of the Nth-from-last OPERATOR message (0 if fewer operator
 * turns). Harness-injected `role: "user"` messages are never counted. Pure.
 */
export function indexOfKeepFrom(history: readonly NormalizedMessage[], keepLastUserTurns: number): number {
  if (keepLastUserTurns <= 0) {
    return history.length;
  }
  let seen = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m !== undefined && isOperatorMessage(m)) {
      seen += 1;
      if (seen >= keepLastUserTurns) {
        return i;
      }
    }
  }
  return 0;
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= max) {
    return one;
  }
  return `${one.slice(0, Math.max(1, max - 1))}…`;
}

/** Requests and file lists carried by an earlier compaction summary. */
function parsePreviousSummary(content: string): { requests: string[]; read: string[]; modified: string[] } {
  const requests: string[] = [];
  const read: string[] = [];
  const modified: string[] = [];
  let inRequests = false;
  for (const line of content.split("\n")) {
    if (line === REQUESTS_HEADER) {
      inRequests = true;
    } else if (inRequests) {
      const m = /^\d+\. (.*)$/.exec(line);
      if (m !== null && m[1] !== undefined && m[1] !== "(none)") {
        requests.push(m[1]);
      } else {
        inRequests = false;
      }
    }
    if (line.startsWith(FILES_READ_PREFIX)) {
      read.push(...splitList(line.slice(FILES_READ_PREFIX.length)));
    } else if (line.startsWith(FILES_MODIFIED_PREFIX)) {
      modified.push(...splitList(line.slice(FILES_MODIFIED_PREFIX.length)));
    }
  }
  return { requests, read, modified };
}

function splitList(text: string): string[] {
  return text
    .split(", ")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Files read / modified by the assistant tool calls in `messages`, in first-seen order. */
function filesFromToolCalls(messages: readonly NormalizedMessage[]): { read: string[]; modified: string[] } {
  const read: string[] = [];
  const modified: string[] = [];
  for (const m of messages) {
    // Flow 387 T18: an old exchange collapsed by `pruneToolOutputs` keeps what it
    // touched in its digest lines.
    for (const call of parseCollapsedRecord(m)) {
      if (call.name === "apply_patch") {
        modified.push(...call.digest.split(", ").filter((f) => f.length > 0));
      } else if (READ_TOOLS.has(call.name)) {
        const file = call.digest.split(" | ")[0] ?? "";
        if (file.length > 0 && !file.startsWith("pattern=") && !file.startsWith("{")) {
          read.push(file);
        }
      }
    }
    for (const call of m.role === "assistant" ? (m.toolCalls ?? []) : []) {
      const args = parseArgs(call.arguments);
      if (call.name === "apply_patch" && typeof args.patch === "string") {
        modified.push(...patchPaths(args.patch));
      } else if (READ_TOOLS.has(call.name) && typeof args.path === "string" && args.path.length > 0) {
        read.push(args.path);
      }
    }
  }
  return { read, modified };
}

function uniqueCapped(items: readonly string[]): string[] {
  return [...new Set(items)].slice(-MAX_LISTED_FILES);
}

/**
 * Compact model context. Pure and deterministic (no network / no model).
 * Returns a new array; does not mutate `history`.
 */
export function compactMessages(
  history: readonly NormalizedMessage[],
  opts: CompactOptions = {},
): CompactResult {
  const keepLast = opts.keepLastUserTurns ?? 3;
  const maxPrompt = Math.max(MIN_PROMPT_CHARS, opts.maxPromptChars ?? MIN_PROMPT_CHARS);
  const focus = opts.focus?.trim() ?? "";

  if (history.length === 0) {
    return { context: [], removed: 0, summaryText: "", noop: true };
  }

  const keepFrom = indexOfKeepFrom(history, keepLast);
  if (keepFrom === 0) {
    return {
      context: [...history],
      removed: 0,
      summaryText: "",
      noop: true,
    };
  }

  const prefix = history.slice(0, keepFrom);
  const suffix = history.slice(keepFrom);

  const summary = buildSummary(prefix, { maxPrompt, focus, inTurn: false });
  const summaryMsg = summary.message;

  // Flow 387 T9: the removed prefix held the session's anchors blocks. Unless
  // the kept window still has a full block, re-emit ONE consolidated full block
  // so the model keeps its bearings and later `touched` changes stay deltas.
  const keptFullBlock = suffix.some((m) => m.role === "user" && isFullAnchorsContent(m.content));
  const anchors = keptFullBlock ? undefined : consolidateAnchors(prefix);

  return {
    context: [summaryMsg, ...(anchors !== undefined ? [anchors] : []), ...suffix],
    removed: prefix.length,
    summaryText: summaryMsg.content,
    noop: false,
  };
}

/** Structured summary of a removed `prefix`. Flow 387 T11: shared by both cut kinds. */
function buildSummary(
  prefix: readonly NormalizedMessage[],
  opts: { maxPrompt: number; focus: string; inTurn: boolean },
): { message: NormalizedMessage } {
  const { maxPrompt, focus, inTurn } = opts;
  // An earlier summary contributes its structured lists, never its whole text.
  const previous = prefix
    .filter((m) => m.role === "user" && m.content.startsWith(SUMMARY_HEADER))
    .map((m) => parsePreviousSummary(m.content));
  const operatorRequests = prefix.filter(isOperatorMessage).map((m) => clip(m.content, maxPrompt));
  const requests = [...previous.flatMap((p) => p.requests), ...operatorRequests];

  const files = filesFromToolCalls(prefix);
  const filesRead = uniqueCapped([...previous.flatMap((p) => p.read), ...files.read]);
  const filesModified = uniqueCapped([...previous.flatMap((p) => p.modified), ...files.modified]);

  const tools = [
    ...new Set(
      prefix
        .filter((m) => m.role === "tool")
        .map((m) => {
          // tool content is freeform; try to keep short
          const line = m.content.split("\n")[0] ?? "";
          return clip(line, 40);
        })
        .filter((t) => t.length > 0),
    ),
  ].slice(0, 24);
  const lastAssistant = [...prefix].reverse().find((m) => m.role === "assistant");

  const lines: string[] = [
    `${SUMMARY_HEADER} — full transcript retained on disk]`,
    focus.length > 0 ? `Focus: ${clip(focus, 200)}` : "",
    `Removed ${prefix.length} messages (${operatorRequests.length} operator turns) from the active context.`,
    "",
    REQUESTS_HEADER,
    ...(requests.length > 0 ? requests.map((p, i) => `${i + 1}. ${p}`) : ["(none)"]),
  ];
  if (filesRead.length > 0) {
    lines.push("", `${FILES_READ_PREFIX}${filesRead.join(", ")}`);
  }
  if (filesModified.length > 0) {
    lines.push(`${FILES_MODIFIED_PREFIX}${filesModified.join(", ")}`);
  }
  if (inTurn) {
    const counts = toolCallCounts(prefix);
    if (counts.length > 0) {
      lines.push(`${TOOLS_RUN_PREFIX}${counts.join(", ")}`);
    }
  }
  if (tools.length > 0) {
    lines.push("", `Tool results seen earlier (sample): ${tools.join("; ")}`);
  }
  if (lastAssistant !== undefined && lastAssistant.content.trim().length > 0) {
    lines.push("", `Last assistant note before cut: ${clip(lastAssistant.content, 240)}`);
  }
  lines.push(
    "",
    inTurn
      ? "The current request is kept below; the tool calls and results that came before the recent ones were removed from the active context (the files they touched are listed above). Continue the task; re-read a file only if you need its exact text."
      : "Continue from the recent turns below. Do not re-ask questions already answered above.",
  );

  return {
    message: {
      role: "user",
      content: lines.join("\n"),
      provenance: "project",
      injected: true,
    },
  };
}

/** `name ×N` per tool the assistant called in `messages`, most-called first. */
function toolCallCounts(messages: readonly NormalizedMessage[]): string[] {
  const counts = new Map<string, number>();
  for (const m of messages) {
    for (const call of parseCollapsedRecord(m)) {
      counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
    }
    for (const call of m.role === "assistant" ? (m.toolCalls ?? []) : []) {
      counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ×${n}`);
}

/** Chars/4 estimate of one message (content + tool-call arguments), as the context guard counts it. */
function messageTokens(m: NormalizedMessage): number {
  let chars = m.content.length;
  for (const call of m.toolCalls ?? []) {
    chars += call.arguments.length;
  }
  return Math.ceil(chars / 4);
}

/** Verbatim tail kept by an in-turn cut (codex / pi / opencode all keep ~20K tokens). */
export const IN_TURN_TAIL_TOKENS = 20_000;

/**
 * Flow 387 T11: cut INSIDE the current operator turn. `compactMessages` keeps whole
 * operator turns, so a session whose context sits in one or two long turns (the
 * operator typed "continue", the model then ran 150 tool calls) removed nothing.
 *
 * Keeps, in order: a summary of everything removed, the anchors block, the operator
 * message that started the current turn, and a verbatim tail of about `tailTokens`.
 * The cut never lands between an assistant `tool_calls` message and its results, so
 * no tool result is orphaned. Pure; noop when the turn has nothing to cut.
 */
export function compactInTurn(
  history: readonly NormalizedMessage[],
  opts: { tailTokens?: number; focus?: string; maxPromptChars?: number } = {},
): CompactResult {
  const noop: CompactResult = { context: [...history], removed: 0, summaryText: "", noop: true };
  const tailTokens = opts.tailTokens ?? IN_TURN_TAIL_TOKENS;
  let turnStart = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m !== undefined && isOperatorMessage(m)) {
      turnStart = i;
      break;
    }
  }
  if (turnStart < 0) {
    return noop;
  }
  // Walk back until the tail's estimate passes the budget; `cut` is the first kept index.
  let cut = history.length;
  let tokens = 0;
  while (cut > turnStart + 1) {
    const m = history[cut - 1];
    const t = m === undefined ? 0 : messageTokens(m);
    if (tokens + t > tailTokens && cut < history.length) {
      break;
    }
    tokens += t;
    cut -= 1;
  }
  // A tool result needs the assistant message that called it. Prefer dropping the
  // split group (cut moves forward, tail shrinks); when that would leave nothing,
  // keep the whole group instead (cut moves back to its assistant message).
  const startsOnResult = (i: number): boolean => history[i]?.role === "tool";
  let forward = cut;
  while (forward < history.length && startsOnResult(forward)) {
    forward += 1;
  }
  if (forward < history.length) {
    cut = forward;
  } else {
    while (cut > turnStart + 1 && startsOnResult(cut)) {
      cut -= 1;
    }
  }
  if (cut <= turnStart + 1) {
    return noop;
  }

  const turnMessage = history[turnStart] as NormalizedMessage;
  const removed = [...history.slice(0, turnStart), ...history.slice(turnStart + 1, cut)];
  const tail = history.slice(cut);
  const summary = buildSummary(removed, {
    maxPrompt: Math.max(MIN_PROMPT_CHARS, opts.maxPromptChars ?? MIN_PROMPT_CHARS),
    focus: opts.focus?.trim() ?? "",
    inTurn: true,
  }).message;
  const keptFullBlock = tail.some((m) => m.role === "user" && isFullAnchorsContent(m.content));
  const anchors = keptFullBlock ? undefined : consolidateAnchors(removed);
  return {
    context: [summary, ...(anchors !== undefined ? [anchors] : []), turnMessage, ...tail],
    removed: removed.length,
    summaryText: summary.content,
    noop: false,
  };
}

export interface FallbackCompactOptions extends CompactOptions {
  /** True when the request built from `context` is under the compaction threshold. */
  fits?: (context: readonly NormalizedMessage[]) => boolean;
  /** Verbatim tail kept by the in-turn cut (default {@link IN_TURN_TAIL_TOKENS}). */
  tailTokens?: number;
}

/**
 * Flow 387 T11: compaction for the automatic guard and the overflow retry. Tries
 * `keepLastUserTurns` (default 3) operator turns, then fewer down to 1 while the
 * cut removes nothing or the result still does not fit; if even one turn is too
 * big, cuts inside that turn ({@link compactInTurn}). Manual `/compact` keeps
 * calling `compactMessages` directly. Pure; returns the last cut that shrank
 * anything, or a noop.
 */
export function compactWithFallback(
  history: readonly NormalizedMessage[],
  opts: FallbackCompactOptions = {},
): CompactResult {
  const { fits, tailTokens, ...base } = opts;
  let best: CompactResult | undefined;
  for (let keep = base.keepLastUserTurns ?? 3; keep >= 1; keep--) {
    const r = compactMessages(history, { ...base, keepLastUserTurns: keep });
    if (r.noop) {
      continue;
    }
    best = r;
    if (fits === undefined || fits(r.context)) {
      return r;
    }
  }
  const source = best?.context ?? history;
  const inTurn = compactInTurn(source, {
    ...(tailTokens !== undefined ? { tailTokens } : {}),
    ...(base.focus !== undefined ? { focus: base.focus } : {}),
    ...(base.maxPromptChars !== undefined ? { maxPromptChars: base.maxPromptChars } : {}),
  });
  if (inTurn.noop) {
    return best ?? { context: [...history], removed: 0, summaryText: "", noop: true };
  }
  return { ...inTurn, removed: inTurn.removed + (best?.removed ?? 0) };
}
