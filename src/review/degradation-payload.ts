import { computeAffected } from "../gdgraph/affected";
import type { GraphData } from "../gdgraph/types";
import type { BlastRadius } from "./blast-radius";

/**
 * The consumers a `review-degradation` dispatch is handed (flow 479, AC5).
 *
 * The reviewer's scope is the diff plus every consumer of each shared symbol the diff changed. The consumer
 * list is the code graph's answer (`keryx gdgraph affected`, one hop), never the model's: a reviewer asked to
 * "find the consumers" finds the ones it happens to open, and the sweep that matters is the one over the
 * consumers nobody thought of.
 *
 * Pure over an in-memory graph. It does not decide which exports changed: that is the caller's input, taken
 * from the symbol walk of the blast-radius record ({@link changedExportsOf}), so the two cannot disagree about
 * what "changed" means.
 */

/**
 * Consumers kept in the payload, one budget shared by every changed export (not per export). Above this the rest
 * are listed as dropped, not silently cut.
 */
export const DEFAULT_DEGRADATION_CONSUMER_CAP = 40;

/** Dropped consumers named in the brief; the full count stays in the CAP line and the record. */
export const NOT_TRACED_LISTED = 20;

/** A changed shared module, and the exported names that changed (`*` = every export, or the names are unknown). */
export type ChangedExport = {
  file: string;
  names: string[] | "*";
};

export type DegradationConsumer = {
  file: string;
  /** The changed module, or the barrel re-exporting a changed export, that this file imports. */
  via: string;
  /** How many files import this consumer, so the reader knows which consumers are hubs. */
  fanIn: number;
};

export type DegradationConsumers = {
  /** The consumers kept, closest-to-most-imported first, at most {@link DegradationConsumers.cap}. */
  consumers: DegradationConsumer[];
  /** True when the cap removed at least one consumer. */
  capped: boolean;
  /** The consumers the cap removed, in rank order. They are NOT checked by the reviewer. */
  dropped: DegradationConsumer[];
  cap: number;
  /** Consumers found before the cap. */
  total: number;
  /** Changed shared modules the walk started from. */
  changedExports: ChangedExport[];
  /** Changed modules, and barrels the symbol walk passed through, that the graph has no node for: their consumers are unknown, not none. */
  unresolved: string[];
  /** One sentence for the summary: whether the cap dropped consumers, and how many. */
  summary: string;
};

export function buildDegradationConsumers(input: {
  graph: GraphData;
  changedExports: readonly ChangedExport[];
  /** Every changed file; a consumer that is itself in the diff is the diff's business and is not repeated. */
  changedFiles?: readonly string[] | undefined;
  /**
   * Pure re-export files the symbol walk passed through ({@link barrelsOf}). Their importers consume the changed
   * export without importing the changed module, so they are traced too, `via` the barrel.
   */
  barrels?: readonly string[] | undefined;
  cap?: number | undefined;
}): DegradationConsumers {
  const cap = input.cap === undefined || !Number.isFinite(input.cap) ? DEFAULT_DEGRADATION_CONSUMER_CAP : Math.max(0, Math.trunc(input.cap));
  const inDiff = new Set([...(input.changedFiles ?? []), ...input.changedExports.map((entry) => entry.file)]);
  const nodePaths = new Set(input.graph.nodes.map((node) => node.path));
  const best = new Map<string, DegradationConsumer>();
  const unresolved: string[] = [];

  const barrels = new Set(input.barrels ?? []);
  const targets = [...new Set([...input.changedExports.map((entry) => entry.file), ...barrels])];

  for (const target of targets) {
    if (!nodePaths.has(target)) {
      unresolved.push(target);
      continue;
    }
    // An exact node path always resolves, so the ambiguous-suffix refusal of `resolveGraphTarget` cannot fire here.
    const result = computeAffected(input.graph, target, { depth: 1, ranked: true });
    for (const dependent of result.ranked) {
      // A barrel is a pass-through: its own importers are the consumers, the barrel itself carries no behaviour.
      if (inDiff.has(dependent.path) || barrels.has(dependent.path) || best.has(dependent.path)) {
        continue;
      }
      best.set(dependent.path, { file: dependent.path, via: target, fanIn: dependent.fanIn });
    }
  }

  const ranked = [...best.values()].sort((a, b) => (a.fanIn !== b.fanIn ? b.fanIn - a.fanIn : a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const consumers = ranked.slice(0, cap);
  const dropped = ranked.slice(cap);
  const capped = dropped.length > 0;
  return {
    consumers,
    capped,
    dropped,
    cap,
    total: ranked.length,
    changedExports: input.changedExports.map((entry) => ({ file: entry.file, names: entry.names })),
    unresolved: [...new Set(unresolved)].sort(),
    summary: capped
      ? `the cap of ${cap} dropped ${dropped.length} of ${ranked.length} consumers; the first ${NOT_TRACED_LISTED} dropped ones are listed, the rest are counted, and none were traced`
      : `the cap of ${cap} dropped no consumer (${ranked.length} found)`,
  };
}

/**
 * The changed shared exports of a blast-radius record: the seeds of its symbol walk that name at least one
 * changed export. A seed with no exported name changed is a file-private edit and is not shared. In `file`
 * mode there are no names, so every changed graph node counts, with `*`.
 */
export function changedExportsOf(radius: Pick<BlastRadius, "reach" | "changedFiles" | "unresolved">): ChangedExport[] {
  const seeds = radius.reach?.seeds;
  if (radius.reach?.mode === "symbol" && seeds !== undefined) {
    return seeds
      .filter((seed) => seed.names === "*" || seed.names.length > 0)
      .map((seed): ChangedExport => ({ file: seed.file, names: seed.names === "*" ? "*" : [...seed.names].sort() }))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  }
  const unresolved = new Set(radius.unresolved.map((entry) => entry.file));
  return radius.changedFiles.filter((file) => !unresolved.has(file)).map((file) => ({ file, names: "*" as const }));
}

/** The barrels the symbol walk passed a changed export through; empty in `file` mode. */
export function barrelsOf(radius: Pick<BlastRadius, "reach">): string[] {
  return radius.reach?.mode === "symbol" ? [...new Set(radius.reach.barrels)].sort() : [];
}

/**
 * The payload section of a `review-degradation` dispatch, generated from the record so it cannot drift from
 * the set it describes.
 */
export function renderDegradationPayloadBrief(payload: DegradationConsumers): string {
  const lines: string[] = [];
  lines.push("SCOPE: degradation");
  lines.push("");
  lines.push("QUESTION: after this change, is the code worse than on the base branch: in behaviour, in defaults, in speed or in");
  lines.push("structure, and can that be shown? Scope is the diff plus the consumers below. The consumer list is the code");
  lines.push("graph's, not yours: trace those, and say so when you traced fewer.");
  lines.push("");
  lines.push(`CHANGED SHARED EXPORTS (${payload.changedExports.length}):`);
  for (const entry of payload.changedExports) {
    lines.push(`  - ${safe(entry.file)}  ${entry.names === "*" ? "(every export)" : entry.names.map(safe).join(", ")}`);
  }
  lines.push("");
  lines.push(
    `CONSUMERS (${payload.consumers.length} of ${payload.total}; the files that import the module holding each changed export, or a barrel re-exporting it; most imported first, cap ${payload.cap}):`,
  );
  for (const consumer of payload.consumers) {
    lines.push(`  - ${safe(consumer.file)}  imports ${safe(consumer.via)}  [fan-in ${consumer.fanIn}]`);
  }
  lines.push("");
  lines.push(`CAP: ${payload.summary}. The cap is one budget shared by all changed exports, not one per export.`);
  if (payload.dropped.length > 0) {
    const listed = payload.dropped.slice(0, NOT_TRACED_LISTED).map((consumer) => safe(consumer.file));
    const more = payload.dropped.length - listed.length;
    lines.push(`NOT TRACED (${payload.dropped.length}): ${listed.join(", ")}${more > 0 ? `, and ${more} more` : ""}`);
  }
  if (payload.unresolved.length > 0) {
    lines.push(
      `NOT ANSWERABLE (${payload.unresolved.length}): ${payload.unresolved.map(safe).join(", ")} absent from the code graph. Their consumers are unknown, not none.`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * A path or name is graph data, not prose: a control character in it must not forge a brief line or drive a terminal.
 * It escapes (a reversible \uXXXX) where `safeText` in lib/live-render.ts flattens to a space, so the reviewer sees the real
 * name; the character class must stay in step with that file's CONTROL_RE.
 */
function safe(text: string): string {
  return text.replace(CONTROL_CHARACTERS, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// Built from a string so the line and paragraph separators stay escapes in the source.
// eslint-disable-next-line no-control-regex -- matching control characters is the point of this check
const CONTROL_CHARACTERS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]", "g");
