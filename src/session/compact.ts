// Deterministic conversation compaction (no LLM required).
//
// Replaces an early prefix of the model context with a single structured summary
// message, keeping the last N user turns intact. Full history stays in the
// session archive on disk — compact only shrinks what the model sees next.

import type { NormalizedMessage } from "../harness/provider/types";

export interface CompactOptions {
  /** How many trailing user turns (with following assistant/tool msgs) to keep. */
  keepLastUserTurns?: number;
  /** Optional focus hint embedded in the summary. */
  focus?: string;
  /** Max chars per prior user prompt in the summary. */
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

/**
 * Find start index of the Nth-from-last user message (0 if fewer users).
 * Pure.
 */
export function indexOfKeepFrom(history: readonly NormalizedMessage[], keepLastUserTurns: number): number {
  if (keepLastUserTurns <= 0) {
    return history.length;
  }
  let seen = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === "user") {
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

/**
 * Compact model context. Pure and deterministic (no network / no model).
 * Returns a new array; does not mutate `history`.
 */
export function compactMessages(
  history: readonly NormalizedMessage[],
  opts: CompactOptions = {},
): CompactResult {
  const keepLast = opts.keepLastUserTurns ?? 3;
  const maxPrompt = opts.maxPromptChars ?? 160;
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
  const userPrompts = prefix
    .filter((m) => m.role === "user")
    .map((m) => clip(m.content, maxPrompt));
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
    "[Compacted earlier context — full transcript retained on disk]",
    focus.length > 0 ? `Focus: ${clip(focus, 200)}` : "",
    `Removed ${prefix.length} messages (${userPrompts.length} user turns) from the active context.`,
    "",
    "Prior user requests:",
    ...(userPrompts.length > 0
      ? userPrompts.map((p, i) => `${i + 1}. ${p}`)
      : ["(none)"]),
  ];
  if (tools.length > 0) {
    lines.push("", `Tool results seen earlier (sample): ${tools.join("; ")}`);
  }
  if (lastAssistant !== undefined && lastAssistant.content.trim().length > 0) {
    lines.push("", `Last assistant note before cut: ${clip(lastAssistant.content, 240)}`);
  }
  lines.push(
    "",
    "Continue from the recent turns below. Do not re-ask questions already answered above.",
  );

  const summaryText = lines.filter((l) => l !== undefined).join("\n");
  const summaryMsg: NormalizedMessage = {
    role: "user",
    content: summaryText,
    provenance: "project",
  };

  return {
    context: [summaryMsg, ...suffix],
    removed: prefix.length,
    summaryText,
    noop: false,
  };
}
