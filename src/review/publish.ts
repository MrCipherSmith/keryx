// The only keryx path to GitHub for a review: it runs the readiness checklist, shows the body, and posts nothing a
// failing checklist has not been allowed to post as a "Partial review".

import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { isPrBound } from "./complete-head-gate";
import { readRunProfile } from "./run-profile";
import { renderRoundBlock, ROUND_BLOCK_VERSION, type RoundBlock, type RoundBlockFinding } from "./pr-comments";
import { findingStatus, quoteSha256, readRoundNumber } from "./round-record";
import { recordFinishedRound } from "./round-registry";
import { computeVerdict, premiseRecords, type VerdictFinding } from "./verdict";
import { evaluateCloseGates } from "./close-gates";
import { failingItems, type ReadinessOptions, type ReadinessReport } from "./readiness";
import { cardPressFields, type CardPress, type ConfirmedVia, type ManagedReviewManifest } from "./types";

export const REVIEW_EVENTS = ["COMMENT", "REQUEST_CHANGES", "APPROVE"] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

export type PostResult = { ok: boolean; detail: string };

export type PublishOptions = {
  event?: ReviewEvent | undefined;
  partial?: boolean | undefined;
  readiness?: ReadinessOptions | undefined;
  /** Posts the review to the pull request. */
  post: (ref: string, event: ReviewEvent, body: string) => Promise<PostResult>;
  /** Shows the body to the operator and answers whether to post it. */
  confirm: (body: string, ref: string, event: ReviewEvent) => Promise<boolean>;
  now?: (() => Date) | undefined;
  /** Set when the operator's yes came from a card instead of the terminal prompt; recorded in published.json. */
  confirmedVia?: ConfirmedVia | undefined;
} & CardPress;

export type PublishResult = { readiness: ReadinessReport; body: string; event: ReviewEvent; partial: boolean; posted: boolean; registryWarning?: string | undefined };

export function reviewEvent(value: string | undefined): ReviewEvent {
  const wanted = (value ?? "COMMENT").trim().toUpperCase();
  const found = REVIEW_EVENTS.find((event) => event === wanted);
  if (found === undefined) throw new Error(`--event must be one of ${REVIEW_EVENTS.join(", ")}, got "${value}".`);
  return found;
}

/** What the posted page says about itself when the checklist did not pass: each failing item and what it leaves uncovered. */
export function partialPublishHeader(readiness: ReadinessReport): string[] {
  const failing = failingItems(readiness);
  return [
    `**Partial review.** This review did not pass its readiness checklist (${failing.length} item(s) failing); what follows does not cover the whole change.`,
    ...failing.map((item) => `- ${item.id}: ${item.evidence}`),
    "",
  ];
}

/** Security review M1: an unattended round says so at the top of what it posts, before anything else is read. */
function runModeHeader(packageDir: string): string {
  const profile = readRunProfile(packageDir);
  if (profile?.mode !== "unattended") return "";
  return `**Unattended review** (${profile.declaredVia}): nobody was at the keyboard; a mutation pass may be recorded as Not run.\n\n`;
}

/**
 * Flow 488. A decision the agent recorded from its host's own question (`confirmedVia: "host-question"`) is reported
 * provenance: keryx cannot tell the operator's answer from the agent's claim of one. A body that carries such a decision
 * says so, and names which decisions, so a reader of the pull request does not take it for a card press or a TTY.
 */
async function hostQuestionNotice(packageDir: string, manifest: ManagedReviewManifest): Promise<string> {
  const named: string[] = [];
  for (const waiver of manifest.readiness_waivers ?? []) if (waiver.confirmedVia === "host-question") named.push(`readiness waiver of ${waiver.item}`);
  if (manifest.head_override?.confirmedVia === "host-question") named.push(`head change ${manifest.head_override.from.slice(0, 7)} to ${manifest.head_override.to.slice(0, 7)}`);
  const research = await readJsonFileOr<{ dispatch?: { coverageWaiver?: { confirmedVia?: string } }; coverageWaiver?: { confirmedVia?: string } } | undefined>(path.join(packageDir, "research.json"), undefined);
  if ((research?.dispatch?.coverageWaiver ?? research?.coverageWaiver)?.confirmedVia === "host-question") named.push("coverage waiver");
  const premise = await premiseRecords(packageDir).catch(() => undefined);
  const premiseCount = (premise?.decisions ?? []).filter((decision) => decision.confirmedVia === "host-question").length;
  if (premiseCount > 0) named.push(`${premiseCount} premise decision(s)`);
  if (named.length === 0) return "";
  return `**Decisions recorded from the agent's host question:** ${named.join("; ")}. keryx did not verify the operator's answer to these; they are reported provenance, not a card press or a terminal confirmation.\n\n`;
}

/** The most a posted body may hold. GitHub refuses a review body over 65536 characters; this leaves room for headers. */
export const PUBLISHED_BODY_LIMIT = 60_000;

const ID_CHAR = "[A-Za-z0-9_-]";

/** Whether the report names this id as a whole id: `F-1` is not named by `F-12` or `XF-1`. */
export function mentionsFindingId(report: string, id: string): boolean {
  if (id === "") return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!${ID_CHAR})${escaped}(?!${ID_CHAR})`).test(report);
}

function minorsLeftOut(count: number): string {
  return `- … ${count} more minor finding(s) — see verdict-interim.md / \`keryx review verdict\``;
}

/**
 * Owner decision (2026-10-16): minor findings are listed one by one in what is posted, not only counted. Each open minor
 * the report does not already name by id is appended under "Minor findings to address" (id, file:line, problem).
 * The section fits in `budget` characters: the list is cut where it would not, and the rest is counted on one line.
 */
export function minorSection(minors: readonly VerdictFinding[], report: string, budget: number = PUBLISHED_BODY_LIMIT): string {
  const missing = minors.filter((finding) => !mentionsFindingId(report, finding.id));
  if (missing.length === 0) return "";
  const lines = missing.map((finding) => `- ${finding.id}${finding.location === undefined ? "" : ` \`${finding.location}\``} (${finding.reviewer}): ${finding.problem}`);
  const render = (kept: readonly string[]): string => {
    const rest = lines.length - kept.length;
    return `\n## Minor findings to address\n\n${[...kept, ...(rest > 0 ? [minorsLeftOut(rest)] : [])].join("\n")}\n`;
  };
  const full = render(lines);
  if (full.length <= budget) return full;
  // render(kept) is the heading, each kept line plus "\n", the count line plus "\n", and the leading "\n".
  const fixed = render([]).length - minorsLeftOut(lines.length).length;
  let used = 0;
  let kept = 0;
  while (kept < lines.length && fixed + used + lines[kept]!.length + 1 + minorsLeftOut(lines.length - kept - 1).length <= budget) {
    used += lines[kept]!.length + 1;
    kept += 1;
  }
  const cut = render(lines.slice(0, kept));
  return cut.length <= budget ? cut : "";
}

/** Every package with a run profile names its run mode at the foot of the posted body. */
function runModeFooter(packageDir: string): string {
  const profile = readRunProfile(packageDir);
  return profile === undefined ? "" : `\n_run mode: ${profile.mode} (${profile.declaredVia})_\n`;
}

/** The most the round block may add to a posted body; findings past it are counted in `truncated`. */
export const ROUND_BLOCK_LIMIT = 4_000;

/**
 * Flow 458 AC2: the hidden machine-readable round block for a posted body. It holds only what the body already says —
 * a finding is listed only when the body names its id, its file only when the body prints it, its line only when the
 * body prints `file:line`, a symbol only when the body names it, and a quote only as its sha256 — so the block tells a
 * reader of the pull request nothing the review did not.
 */
export function buildRoundBlock(input: { body: string; round: number; reviewId: string; reviewedHead: string | null; findings: readonly unknown[] }): RoundBlock {
  const listed: RoundBlockFinding[] = [];
  for (const entry of input.findings) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== "string" || !mentionsFindingId(input.body, raw.id)) continue;
    const file = typeof raw.file === "string" && raw.file !== "" && input.body.includes(raw.file) ? raw.file : undefined;
    const line = file !== undefined && typeof raw.line === "number" && (input.body.includes(`${file}:${raw.line}`) || input.body.includes(`${file}#L${raw.line}`)) ? raw.line : undefined;
    const quote = typeof raw.quote === "string" && raw.quote.trim() !== "" ? raw.quote : undefined;
    const symbol = quote === undefined && typeof raw.symbol === "string" && raw.symbol !== "" && input.body.includes(raw.symbol) ? raw.symbol : undefined;
    const severity = typeof raw.severity === "string" && ["blocker", "major", "minor", "info"].includes(raw.severity) ? (raw.severity as RoundBlockFinding["severity"]) : "info";
    listed.push({
      id: raw.id,
      ...(file === undefined ? {} : { file }),
      ...(line === undefined ? {} : { line }),
      ...(quote === undefined ? {} : { quoteSha256: quoteSha256(quote) }),
      ...(symbol === undefined ? {} : { symbol }),
      severity,
      status: findingStatus(raw),
    });
  }
  const base = { v: ROUND_BLOCK_VERSION, round: input.round, reviewId: input.reviewId, reviewedHead: input.reviewedHead } as const;
  let kept = listed;
  while (kept.length > 0 && renderRoundBlock({ ...base, findings: kept, truncated: listed.length - kept.length }).length > ROUND_BLOCK_LIMIT) kept = kept.slice(0, -1);
  return { ...base, findings: kept, ...(kept.length < listed.length ? { truncated: listed.length - kept.length } : {}) };
}

export async function publishReview(packageDir: string, options: PublishOptions): Promise<PublishResult> {
  const manifest = await readJsonFileOr<ManagedReviewManifest | undefined>(path.join(packageDir, "manifest.json"), undefined);
  if (manifest === undefined) throw new Error(`Managed review package has no readable manifest.json: ${packageDir}`);
  if (!isPrBound(manifest.target)) {
    throw new Error(`Review ${manifest.reviewId} is not bound to a pull request (target ${manifest.target.kind} ${manifest.target.ref}); there is nothing to publish to.`);
  }
  const event = options.event ?? "COMMENT";
  const reportText = await readFile(path.join(packageDir, "report.md"), "utf8").catch(() => "");
  if (reportText.trim() === "") throw new Error(`Review ${manifest.reviewId} has no report.md body to publish.`);
  // The same gate evaluation `review complete` runs: round-record tamper, evidence level, readiness. `--partial` relaxes readiness only.
  const { readiness } = await evaluateCloseGates(packageDir, { manifest, report: reportText, readiness: options.readiness, action: "publish", relaxReadiness: options.partial === true });
  const failing = failingItems(readiness);
  const partial = failing.length > 0;
  if (partial && event === "APPROVE") {
    throw new Error(`A partial review cannot approve: ${failing.length} readiness item(s) are failing (${failing.map((item) => item.id).join(", ")}). Use --event COMMENT or REQUEST_CHANGES, or repair the items.`);
  }
  const report = reportText.trim();
  const head = `${partial ? `${partialPublishHeader(readiness).join("\n")}\n` : ""}${runModeHeader(packageDir)}${await hostQuestionNotice(packageDir, manifest)}${report}\n`;
  const foot = runModeFooter(packageDir);
  const minors = minorSection((await computeVerdict(packageDir)).minors, report, PUBLISHED_BODY_LIMIT - head.length - foot.length - ROUND_BLOCK_LIMIT);
  const visible = `${head}${minors}${foot}`;
  const reviewedHead = manifest.target.head ?? null;
  const findings = await readJsonFileOr<unknown>(path.join(packageDir, "findings.json"), []);
  const roundBlock = buildRoundBlock({ body: visible, round: readRoundNumber(packageDir) ?? 1, reviewId: manifest.reviewId, reviewedHead, findings: Array.isArray(findings) ? findings : [] });
  const body = `${visible}\n${renderRoundBlock(roundBlock)}\n`;
  if (!(await options.confirm(body, manifest.target.ref, event))) return { readiness, body, event, partial, posted: false };
  const result = await options.post(manifest.target.ref, event, body);
  if (!result.ok) throw new Error(`GitHub refused the review: ${result.detail}`);
  await writeFileAtomic(
    path.join(packageDir, "published.json"),
    `${JSON.stringify({ pr: manifest.target.ref, reviewId: manifest.reviewId, head: reviewedHead, round: roundBlock.round, event, partial, failing: failing.map((item) => item.id), time: (options.now?.() ?? new Date()).toISOString(), ...(options.confirmedVia === undefined ? {} : { confirmedVia: options.confirmedVia }), ...cardPressFields(options) }, null, 2)}\n`,
  );
  // Flow 458: keryx's own record that it finished (and posted) this round, outside the repository (./round-registry.ts).
  const registered = recordFinishedRound(packageDir, "publish");
  return { readiness, body, event, partial, posted: true, ...(registered.error === undefined ? {} : { registryWarning: `round not recorded in the local round registry: ${registered.error}` }) };
}
