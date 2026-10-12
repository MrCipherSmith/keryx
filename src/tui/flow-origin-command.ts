// Flow 390 (AC8): `/flow origin` — shows where a flow came from, and sets it
// with a reason. A one-shot text surface through `io.onSystem?.()`, not a modal,
// the same shape as `/staledocs`. It goes through the flow service, so the
// evidence rule, the journal line and the lock are the ones `keryx flow origin
// set` uses. Nothing here gates anything.
//
//   /flow origin [<id>]                                   show (no id: a bounded summary, counts by kind and the newest few)
//   /flow origin <id> <kind> --reason "<why>" [--quote "<verbatim>"] [--source "<ref>"]

import { flowServiceDeps } from "../commands/flow";
import { createFlowService, originDetailLines, readOrigin } from "../flow/service";
import type { FlowService } from "../flow/types";

export const FLOW_ORIGIN_COMMAND = "/flow";

export function isFlowOriginCommand(name: string): boolean {
  return name === FLOW_ORIGIN_COMMAND;
}

export const FLOW_ORIGIN_USAGE =
  '/flow origin [<id>]  |  /flow origin <id> <kind> --reason "<why>" [--quote "<verbatim>"] [--source "<ref>"]  (kind: human-request, agent-finding, agent-proposal, unknown)';

/** Split a line into words, keeping a single- or double-quoted run as one word (quotes removed). */
export function splitShellWords(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  for (const char of line) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || current.length > 0) words.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started || current.length > 0) words.push(current);
  return words;
}

interface ParsedOrigin {
  positionals: string[];
  reason?: string | undefined;
  quote?: string | undefined;
  source?: string | undefined;
}

function parseOriginArgs(words: readonly string[]): ParsedOrigin {
  const parsed: ParsedOrigin = { positionals: [] };
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? "";
    if (word === "--reason" || word === "--quote" || word === "--source") {
      const value = words[i + 1];
      i += 1;
      if (word === "--reason") parsed.reason = value;
      else if (word === "--quote") parsed.quote = value;
      else parsed.source = value;
    } else {
      parsed.positionals.push(word);
    }
  }
  return parsed;
}

/** Pure rendering of one flow's origin for the transcript. */
export function renderFlowOrigin(id: string, origin: unknown): string {
  return [`${id}`, ...originDetailLines(readOrigin(origin), "  ")].join("\n");
}

/** How many of the newest flows `/flow origin` lists by name; the rest are only counted. */
export const FLOW_ORIGIN_RECENT_LIMIT = 10;

/**
 * `/flow origin` with no id: how many flows came from each origin, and the newest
 * few by name. Never one block per flow: a project with hundreds of flows would
 * flood the transcript. The quote and source of one flow are `/flow origin <id>`.
 */
async function summarizeOrigins(cwd: string, service: FlowService): Promise<string> {
  const flows = await service.list({ cwd });
  if (flows.length === 0) return "No flows.";
  const newestFirst = [...flows].sort((a, b) => Number(b.id) - Number(a.id) || b.id.localeCompare(a.id));
  const kinds = await Promise.all(
    newestFirst.map(async (summary) => {
      try {
        const flow = await service.get({ cwd, id: summary.id });
        return readOrigin(flow.origin)?.kind ?? "unknown";
      } catch {
        return "unknown";
      }
    }),
  );
  const counts = new Map<string, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const countLine = [...counts.entries()].map(([kind, count]) => `${kind} ${count}`).join(", ");
  const shown = Math.min(FLOW_ORIGIN_RECENT_LIMIT, newestFirst.length);
  const lines = [`origins of ${flows.length} flows: ${countLine}`, `newest ${shown}:`];
  for (let i = 0; i < shown; i += 1) {
    lines.push(`  ${newestFirst[i]?.id ?? "?"}  ${kinds[i] ?? "unknown"}`);
  }
  if (flows.length > shown) lines.push(`  ... ${flows.length - shown} older not listed`);
  lines.push("/flow origin <id> shows the quote and source of one flow.");
  return lines.join("\n");
}

/**
 * The whole job of `/flow origin`: parse, show or set, one string back. A usage
 * error or a missing-evidence note is text, never a throw for an ordinary state.
 */
export async function runFlowOriginForShell(
  cwd: string,
  line: string,
  service: FlowService = createFlowService(flowServiceDeps()),
): Promise<string> {
  const words = splitShellWords(line.trim());
  const [, sub, ...rest] = words;
  if (sub !== "origin") {
    return `Usage: ${FLOW_ORIGIN_USAGE}`;
  }
  const args = parseOriginArgs(rest);
  const [id, kind, ...extra] = args.positionals;
  if (extra.length > 0) {
    return `Usage: ${FLOW_ORIGIN_USAGE}`;
  }
  if (id === undefined) {
    return summarizeOrigins(cwd, service);
  }
  if (kind === undefined) {
    const flow = await service.get({ cwd, id });
    return renderFlowOrigin(flow.id, flow.origin);
  }
  if (args.reason === undefined || args.reason.trim().length === 0) {
    return `/flow origin ${id} ${kind} needs --reason "<why>".\nUsage: ${FLOW_ORIGIN_USAGE}`;
  }
  const result = await service.originSet({
    cwd,
    id,
    kind,
    reason: args.reason,
    quote: args.quote,
    source: args.source,
  });
  if (result.note !== undefined) {
    return `${result.note}\nNothing written; origin stays ${result.previous}.\n${renderFlowOrigin(result.flow.id, result.flow.origin)}`;
  }
  const head = result.changed ? `origin ${result.previous} -> ${result.next}` : `origin already ${result.next}; nothing written`;
  return `${head}\n${renderFlowOrigin(result.flow.id, result.flow.origin)}`;
}
