// Flow 389 (AC5): what the digest says.
//
// Pure: data in, a structured digest and its text out. No clock, no I/O. A digest names:
//   - what CHANGED since the previous run (new, updated, closed or merged),
//   - what is STUCK (open for a week without an update, a CI failure that is
//     still there after the last digest),
//   - what needs the operator's DECISION (a review requested from them, an
//     approved PR waiting to be merged),
//   - every "PR merged, flow closed, effect not checked" CHAIN the product index
//     lists, and
//   - what could not be READ (a gh call or the board failed).
//
// The first run is a baseline: it lists no changes (there is nothing to compare
// with) but still lists the standing sections. A run with no change has an empty
// `changes` and `quiet: true`; the standing sections still appear, because a
// review waiting for the operator is not news but is still theirs to act on.

import type { OpenEntry } from "../product/service";
import type { DigestDiff, DigestItem, DigestSnapshot } from "./digest-snapshot";

/** Days an open PR or issue may sit without an update before the digest calls it stuck. */
export const DIGEST_STUCK_DAYS = 7;

export interface DigestLine {
  /** Identity for de-duplication: the URL when there is one, else the item key. */
  readonly ref: string;
  readonly text: string;
  readonly url?: string;
}

export interface DigestFailure {
  /** `pr:<repo>`, `issue:<repo>`, `review:<repo>`, `ci:<repo>`, `board`, `model`. */
  readonly source: string;
  readonly detail: string;
}

export interface DigestContent {
  /** No previous snapshot: nothing is reported as changed. */
  readonly baseline: boolean;
  /** Nothing changed since the last run (never true for a baseline). */
  readonly quiet: boolean;
  /** How many changes the diff found, before a line already listed under "decision" or "stuck" is dropped. */
  readonly changeCount: number;
  readonly changes: readonly DigestLine[];
  readonly stuck: readonly DigestLine[];
  readonly decisions: readonly DigestLine[];
  readonly chains: readonly DigestLine[];
  readonly failures: readonly DigestFailure[];
}

export interface DigestContentInput {
  readonly items: readonly DigestItem[];
  readonly diff: DigestDiff;
  readonly previous: DigestSnapshot | undefined;
  readonly failures: readonly DigestFailure[];
  /** The board's "closed, effect not checked" entries (`buildOpenReport(index).entries`). */
  readonly chains: readonly OpenEntry[];
  readonly now: Date;
  readonly stuckDays?: number;
}

function label(item: DigestItem): string {
  const where = item.repo !== undefined ? `${item.repo}#${item.id}` : item.id;
  switch (item.kind) {
    case "pr":
      return `PR ${where}`;
    case "issue":
      return `issue ${where}`;
    case "review":
      return `PR ${where}`;
    case "ci":
      return `failed CI run ${where}`;
    case "board":
      return `flow ${item.id}`;
  }
}

function lineOf(item: DigestItem, suffix: string): DigestLine {
  const author = item.author !== undefined && item.author.length > 0 ? ` by ${item.author}` : "";
  return {
    ref: item.url ?? item.key,
    text: `${label(item)} "${item.title}"${author} ${suffix}`.trim(),
    ...(item.url !== undefined ? { url: item.url } : {}),
  };
}

function goneLabel(key: string): string {
  return key.startsWith("issue:") ? `issue ${key.slice("issue:".length)}` : `PR ${key.slice(key.indexOf(":") + 1)}`;
}

function ageDays(stamp: string, now: Date): number | undefined {
  const t = Date.parse(stamp);
  return Number.isNaN(t) ? undefined : Math.floor((now.getTime() - t) / 86_400_000);
}

function dedupe(lines: readonly DigestLine[], taken: Set<string>): DigestLine[] {
  const out: DigestLine[] = [];
  for (const line of lines) {
    if (taken.has(line.ref)) continue;
    taken.add(line.ref);
    out.push(line);
  }
  return out;
}

/** Build the structured digest. */
export function buildDigestContent(input: DigestContentInput): DigestContent {
  const stuckDays = input.stuckDays ?? DIGEST_STUCK_DAYS;
  const { diff, now } = input;

  // Decisions: a review requested from the operator, or an approved non-draft PR waiting to be merged.
  const decisionLines: DigestLine[] = [
    ...input.items.filter((i) => i.kind === "review").map((i) => lineOf(i, "— your review is requested")),
    ...input.items
      .filter((i) => i.kind === "pr" && i.reviewDecision === "APPROVED" && i.draft !== true)
      .map((i) => lineOf(i, "— approved, waiting for you to merge")),
  ];

  // Stuck: open and untouched for a week, or a CI failure that was already there at the last digest.
  const stuckLines: DigestLine[] = [];
  for (const item of input.items) {
    if (item.kind === "pr" || item.kind === "issue") {
      const age = ageDays(item.stamp, now);
      if (age !== undefined && age >= stuckDays) stuckLines.push(lineOf(item, `— no update for ${age} days`));
    } else if (item.kind === "ci" && input.previous?.entries[item.key] !== undefined) {
      stuckLines.push(lineOf(item, "— still failing since the last digest"));
    }
  }

  // Changes: what the diff found. A baseline reports none.
  const changeLines: DigestLine[] = [
    ...diff.added.map((i) => lineOf(i, "— new")),
    ...diff.updated.map((i) => lineOf(i, "— updated")),
    ...diff.gone.map((key): DigestLine => ({ ref: key, text: `${goneLabel(key)} — closed or merged` })),
  ];

  const taken = new Set<string>();
  const decisions = dedupe(decisionLines, taken);
  const stuck = dedupe(stuckLines, taken);
  const changes = dedupe(changeLines, taken);

  const chains: DigestLine[] = input.chains.map((entry) => ({
    ref: `board:${entry.id}`,
    text:
      `flow ${entry.id} "${entry.title}" — PR merged, flow closed${entry.closedAt !== null ? ` ${entry.closedAt.slice(0, 10)}` : ""}, ` +
      `effect not checked (${entry.hasCriterion ? `to check: ${entry.outcome}` : "no outcome criterion stated"})`,
  }));

  const changeCount = diff.added.length + diff.updated.length + diff.gone.length;
  const quiet = !diff.baseline && changeCount === 0;
  return { baseline: diff.baseline, quiet, changeCount, changes, stuck, decisions, chains, failures: input.failures };
}

function section(title: string, lines: readonly DigestLine[], empty: string): string[] {
  return [`${title}`, ...(lines.length === 0 ? [`- ${empty}`] : lines.map((l) => `- ${l.text}${l.url !== undefined ? `\n  ${l.url}` : ""}`)), ""];
}

/** The deterministic digest text. A model summary, when one ran, goes ABOVE it and never replaces it. */
export function renderDigestText(content: DigestContent, header: { readonly name: string; readonly at: string }): string {
  const status = content.baseline
    ? "first run: baseline taken, changes are reported from the next digest on"
    : content.quiet
      ? "nothing changed since the last digest"
      : `${content.changeCount} change(s) since the last digest`;
  const lines: string[] = [`Digest ${header.name} — ${header.at.slice(0, 16).replace("T", " ")} UTC`, status, ""];
  if (content.failures.length > 0) {
    lines.push("Could not read", ...content.failures.map((f) => `- ${f.source}: ${f.detail}`), "");
  }
  if (!content.baseline && !content.quiet) lines.push(...section("What changed", content.changes, "everything that changed is listed below"));
  lines.push(...section("Needs your decision", content.decisions, "nothing waits for you"));
  lines.push(...section("Stuck", content.stuck, "nothing is stuck"));
  lines.push(...section("PR merged, flow closed, effect not checked", content.chains, "none"));
  return lines.join("\n").trimEnd();
}
