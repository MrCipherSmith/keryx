// Flow 393 AC13: ObservationPack.
//
// A tool result over 10 KiB stays verbatim for two requests (the model has read it and acted on
// it), then becomes a FIXED-shape pack: byte and line counts, the first and last line, and a
// reference the model can recall the whole text from (`recall_step`, or the saved file). Unlike a
// prune placeholder it keeps enough of the result's shape to tell whether re-reading is needed.
//
// Packs are applied only in the batches the other rewrites use (see `rewrite-gate.ts`): the caller
// plans here, asks the gate, then applies. Messages are REPLACED, never mutated, so `archive.jsonl`
// keeps the original.

import { estimateMessageTokens } from "../harness/provider/context-guard";
import type { NormalizedMessage } from "../harness/provider/types";
import { isInsideToolOutputDir, writeToolOutputFile } from "../harness/tool/output-spill";
import { isClearedToolResult } from "./prune";

/** A result larger than this many bytes is a pack candidate. */
export const PACK_MIN_BYTES = 10 * 1024;
/** Requests a candidate stays verbatim for before it is packed. */
export const PACK_AFTER_REQUESTS = 2;
/** Most characters of the first or last line kept in a pack. */
export const PACK_LINE_CHARS = 160;
export const PACK_HEADER = "[Observation pack";

export function isObservationPack(m: NormalizedMessage): boolean {
  return m.role === "tool" && (m.packed === true || m.content.startsWith(PACK_HEADER));
}

function clipLine(line: string): string {
  const one = line.replace(/\s+/g, " ").trim();
  return one.length <= PACK_LINE_CHARS ? one : `${one.slice(0, PACK_LINE_CHARS - 1)}…`;
}

export interface PackFacts {
  bytes: number;
  lines: number;
  first: string;
  last: string;
}

/** Size and shape of a result's text. Pure. */
export function packFacts(text: string): PackFacts {
  const lines = text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    lines: lines.length,
    first: clipLine(nonEmpty[0] ?? ""),
    last: clipLine(nonEmpty[nonEmpty.length - 1] ?? ""),
  };
}

/**
 * The fixed pack text. `reference` names how to get the full text back: a Trail step (for
 * `recall_step`) wins over a bare file path.
 */
export function renderObservationPack(opts: {
  tool: string;
  facts: PackFacts;
  trailStep?: number;
  filePath?: string;
}): string {
  const { facts } = opts;
  const where = opts.trailStep !== undefined ? ` step ${opts.trailStep},` : "";
  const reference =
    opts.trailStep !== undefined
      ? `recall_step {"step":${opts.trailStep},"start_line":1}`
      : opts.filePath !== undefined
        ? `read_file {"path":${JSON.stringify(opts.filePath)}}`
        : "not saved (history_search can find the original in the archive)";
  return [
    `${PACK_HEADER} —${where} ${opts.tool}, ${facts.bytes} bytes, ${facts.lines} lines; the full text is saved]`,
    `first line: ${facts.first}`,
    `last line: ${facts.last}`,
    `full text: ${reference}`,
  ].join("\n");
}

export interface PackCandidate {
  index: number;
  tool: string;
  /** Estimated tokens the pack saves. */
  saving: number;
}

/**
 * Tool results that are over {@link PACK_MIN_BYTES}, were shown for at least
 * {@link PACK_AFTER_REQUESTS} requests (assistant messages after them), and are not already a
 * pack or a prune placeholder. Pure.
 */
export function planObservationPacks(history: readonly NormalizedMessage[]): PackCandidate[] {
  const out: PackCandidate[] = [];
  // Assistant messages after index i: walk from the end.
  let assistantsAfter = 0;
  const toolByCall = new Map<string, string>();
  for (const m of history) {
    if (m.role === "assistant") {
      for (const c of m.toolCalls ?? []) toolByCall.set(c.id, c.name);
    }
  }
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m === undefined) continue;
    if (m.role === "assistant") {
      assistantsAfter += 1;
      continue;
    }
    if (m.role !== "tool" || assistantsAfter < PACK_AFTER_REQUESTS) continue;
    if (isClearedToolResult(m) || isObservationPack(m)) continue;
    if (Buffer.byteLength(m.content, "utf8") <= PACK_MIN_BYTES) continue;
    const tool = toolByCall.get(m.toolCallId ?? "") ?? "tool";
    const sample = renderObservationPack({ tool, facts: packFacts(m.content), filePath: "x".repeat(70) });
    const saving = estimateMessageTokens(m) - Math.ceil(sample.length / 4);
    if (saving > 0) out.push({ index: i, tool, saving });
  }
  return out.reverse();
}

/**
 * Replace each candidate in `history` (same array, same length) with its pack. The full text is
 * written to `<sessionDir>/tool-output/` first when no file holds it yet, so the pack's reference
 * is always readable. Returns the estimated tokens saved.
 */
export async function applyObservationPacks(
  history: NormalizedMessage[],
  candidates: readonly PackCandidate[],
  sessionDir: string | undefined,
): Promise<{ packed: number; savedTokens: number }> {
  let packed = 0;
  let savedTokens = 0;
  for (const c of candidates) {
    const m = history[c.index];
    if (m === undefined || m.role !== "tool" || isObservationPack(m) || isClearedToolResult(m)) continue;
    let filePath: string | undefined;
    if (m.spillPath !== undefined && sessionDir !== undefined && isInsideToolOutputDir(sessionDir, m.spillPath)) {
      filePath = m.spillPath;
    } else if (sessionDir !== undefined) {
      filePath = await writeToolOutputFile(sessionDir, m.toolCallId ?? `packed-${c.index}`, m.content);
    }
    const content = renderObservationPack({
      tool: c.tool,
      facts: packFacts(m.content),
      ...(m.trailStep !== undefined ? { trailStep: m.trailStep } : {}),
      ...(filePath !== undefined ? { filePath } : {}),
    });
    savedTokens += estimateMessageTokens(m) - Math.ceil(content.length / 4);
    const { spillPath: _old, ...rest } = m;
    history[c.index] = { ...rest, content, packed: true, ...(filePath !== undefined ? { spillPath: filePath } : {}) };
    packed += 1;
  }
  return { packed, savedTokens };
}
