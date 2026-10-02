// `product open`: the intents closed in code that nobody has looked back at.
// Reads the index only. A count and a list — nothing here refuses, blocks or
// actions anything, and an entry leaves the list only by being observed.

import { effectiveOutcomeAuthor, originDetailLines, readOriginKind, readOrigin } from "../flow/service";
import { g1aByOrigin, g1aLines } from "./by-origin";
import { NO_INSTRUMENT, hasInstrument } from "./extract";
import { checkStaleness, readIntentIndex } from "./store";
import type { IntentIndex, OpenEntry, OpenReport } from "./types";

export function buildOpenReport(index: IntentIndex): OpenReport {
  const entries: OpenEntry[] = index.intents
    .filter((intent) => intent.status === "closed" && !intent.outcome.observed)
    .map((intent) => ({
      id: intent.id,
      title: intent.title,
      path: intent.path,
      closedAt: intent.closedAt,
      outcome: hasInstrument(intent.outcome.criterion) ? intent.outcome.criterion : (intent.outcome.criterion ?? NO_INSTRUMENT),
      hasCriterion: hasInstrument(intent.outcome.criterion),
      outcomeAuthor: effectiveOutcomeAuthor({ outcomeAuthor: intent.outcomeAuthor, origin: intent.origin }),
      origin: readOriginKind(intent.origin),
      ...originFields(intent.origin),
    }))
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? "") || Number.parseInt(b.id, 10) - Number.parseInt(a.id, 10) || (a.path < b.path ? -1 : 1));
  const { counts } = index;
  return {
    closed: counts.closed,
    neverChecked: entries.length,
    noCriterion: counts.noCriterion,
    notObserved: counts.notObserved,
    observed: counts.observed,
    helped: counts.helped,
    noEffect: counts.noEffect,
    harmed: counts.harmed,
    inconclusive: counts.inconclusive,
    failures: index.failures.length,
    entries,
    g1a: g1aByOrigin(index),
  };
}

function originFields(raw: unknown): { originQuote?: string; originSource?: string } {
  const origin = readOrigin(raw);
  return {
    ...(origin?.quote === undefined ? {} : { originQuote: origin.quote }),
    ...(origin?.source === undefined ? {} : { originSource: origin.source }),
  };
}

/** Header lines shared by the CLI and the TUI, so the two never state different numbers. */
export function openHeaderLines(report: OpenReport): string[] {
  return [
    `intents closed in code, never checked for effect: ${report.neverChecked} of ${report.closed}`,
    `  no outcome criterion stated: ${report.noCriterion}`,
    `  criterion stated, never observed: ${report.notObserved}`,
    `  observed: ${report.observed} (${verdictSplit(report)})`,
    ...(report.failures > 0 ? [`  index parse failures: ${report.failures} (\`keryx product index\` lists them)`] : []),
  ];
}

function verdictSplit(counts: Pick<OpenReport, "helped" | "noEffect" | "harmed" | "inconclusive">): string {
  return `helped ${counts.helped}, no effect ${counts.noEffect}, harmed ${counts.harmed}, inconclusive ${counts.inconclusive}`;
}

export function openEntryLines(entry: OpenEntry): string[] {
  const label = `flow ${entry.id}`;
  const pad = " ".repeat(label.length + 2);
  return [
    `${label}  ${entry.title}`,
    `${pad}outcome: ${entry.outcome}`,
    `${pad}outcome author: ${entry.outcomeAuthor}`,
    ...originDetailLines(entry.origin === "unknown" ? undefined : { kind: entry.origin, quote: entry.originQuote, source: entry.originSource }, pad),
    `${pad}closed ${entry.closedAt === null ? "at an unrecorded time" : entry.closedAt.slice(0, 10)}`,
  ];
}

export function renderOpen(report: OpenReport): string {
  const rows = report.entries.flatMap((entry) => ["", ...openEntryLines(entry).map((line) => `  ${line}`)]);
  const g1a = g1aLines(report.g1a);
  return [...openHeaderLines(report), ...rows, ...(g1a.length > 0 ? ["", ...g1a] : [])].join("\n");
}

export type OpenLoad =
  | { readonly ok: true; readonly report: OpenReport }
  | { readonly ok: false; readonly message: string };

const REBUILD = "Run `keryx product index`.";

/** Read the index, refuse to answer from a missing or stale one, and say which command rebuilds it. */
export async function loadOpenReport(cwd: string): Promise<OpenLoad> {
  try {
    const read = await readIntentIndex(cwd);
    if (read.state === "absent") return { ok: false, message: `No product index yet. ${REBUILD}` };
    if (read.state === "malformed") return { ok: false, message: `The product index is unreadable (${read.reason}). ${REBUILD}` };
    const staleness = await checkStaleness(cwd, read.index);
    if (staleness.stale) return { ok: false, message: `The product index is out of date (${staleness.reason}). ${REBUILD}` };
    return { ok: true, report: buildOpenReport(read.index) };
  } catch {
    // Whatever went wrong reading it, the answer is the same: the index cannot be used, rebuild it.
    return { ok: false, message: `The product index could not be used. ${REBUILD}` };
  }
}

export function renderIndexSummary(index: IntentIndex, file: string): string {
  const { counts } = index;
  return [
    `Indexed ${counts.intents} intents (${counts.flows} flows, ${counts.docpacks} requirements packages).`,
    `  entries with no extractable intent statement: ${index.unusable}`,
    `  parse failures: ${index.failures.length}`,
    ...index.failures.map((failure) => `    ${failure}`),
    `  closed in code: ${counts.closed} (observed ${counts.observed}: ${verdictSplit(counts)}; criterion stated ${counts.notObserved}, none stated ${counts.noCriterion})`,
    `Written: ${file}`,
  ].join("\n");
}
