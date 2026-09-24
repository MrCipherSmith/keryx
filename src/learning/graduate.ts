// `keryx learn graduate` / `keryx learn graduate apply` (W3 spec "Graduation
// to skills/agents/rules"; plan module table; flow 312 T10).
//
//  - `runGraduate` clusters `status: "accepted"` records (project or user
//    scope) by `domain` plus trigger-keyword overlap (Jaccard >= 0.5, >= 2
//    shared keywords, single-linkage, deterministic ordering by id) and
//    writes a proposal artifact under
//    `.metaproject/data/learning/graduation/<proposal-id>.json` (+ a `.md`
//    summary), setting `graduation` on every source record — never a
//    `SKILL.md`, agent definition, or rule file itself.
//  - `applyGraduation` applies one proposal: for an `agent` target, writes
//    `.metaproject/agents/<name>.md` (`origin.kind: "learned"`, `sourceRef`
//    the source pattern id), validated via `validateAgentDefinition`; for a
//    `skill` or `rule` target, it refuses (`graduate-apply-agent-only`) and
//    surfaces the proposal's own `nextSteps` — W1 (skill) or a human (rule)
//    owns that write, not this function.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { validateAgentDefinition, type AgentDefinition } from "../agents";
import { isPathInside, pathExists, withFileLock, writeFileAtomic } from "../lib/fs";
import { loadReviewLearningConfigSafe, type ReviewLearningConfig } from "../review/review-learning";
import { appendDecision } from "./decisions";
import { assertInsideLearningRoot, graduationDir, learningDataDir, projectLockPath } from "./paths";
import { gateReviewerText, loginKeywordSet, mayCarryReviewerText, stripReviewerCommentTriggerPrefix } from "./reviewer-id";
import { scanLearnedText } from "./scan";
import { listPatterns, readPattern, updatePattern, type StoreEnvOptions } from "./store";
import type { GraduationTarget, LearnedPattern, LearningDomain, LearningScope } from "./types";

export class LearningGraduateConfigError extends Error {}

/**
 * `config.authors` + `config.reviewerProfiles`, deduped. Duplicated from
 * `extract.ts` rather than shared: a two-line pure lookup, not worth a
 * cross-file dependency between these two feature modules.
 *
 * R3-F3: goes through the guarded loader — a malformed
 * `review-learning.config.json` throws `LearningGraduateConfigError` here
 * (caught by `applyGraduation` and re-thrown as `LearningGraduateError`
 * with the named reason `review-learning-config-invalid`) rather than
 * letting `loadReviewLearningConfig`'s own un-reasoned error escape.
 * Simplest consistent rule: graduate apply needs the login gate to be
 * trustworthy before it can write an agent candidate, so a config it
 * cannot read at all is refused, full stop.
 */
async function configuredReviewLogins(root: string): Promise<string[]> {
  const result = await loadReviewLearningConfigSafe(root);
  if (!result.ok) {
    throw new LearningGraduateConfigError(result.error);
  }
  const config: ReviewLearningConfig | null = result.config;
  if (config === null) return [];
  return [...new Set([...config.authors, ...(config.reviewerProfiles ?? [])])];
}

export class LearningGraduateError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "LearningGraduateError";
  }
}

export interface RunGraduateOptions {
  domain?: LearningDomain;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface ApplyGraduationOptions {
  /** Same "no bypass flag" rule `promote.ts` and `accept.ts` enforce. */
  isTerminal: boolean;
  /** Typed confirmation (e.g. "type the proposal id to confirm"), read by the CLI layer. */
  confirm: () => Promise<boolean>;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface GraduationProposalFile {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly target: GraduationTarget;
  readonly members: readonly string[];
  readonly domain: LearningDomain;
  readonly suggestedName: string;
  readonly summary: string;
  readonly nextSteps: readonly string[];
}

export interface GraduateRefusal {
  readonly memberIds: readonly string[];
  readonly categories: readonly string[];
}

export interface GraduateReport {
  /** Proposals newly written by this run (an already-existing proposal id is skipped, not re-listed here). */
  readonly proposals: readonly GraduationProposalFile[];
  /** Proposal ids that already existed on disk — untouched (idempotent). */
  readonly alreadyProposed: readonly string[];
  /** Clusters refused by the security scan before any write — never persisted. */
  readonly refused: readonly GraduateRefusal[];
}

const GIT_SPAWN_TIMEOUT_MS = 2000;

/** Duplicated from `accept.ts`/`promote.ts` — see `promote.ts`'s header for why this is duplicated rather than shared. */
function tryGitUserEmail(root: string): string | undefined {
  try {
    const result = spawnSync("git", ["-C", root, "config", "user.email"], { timeout: GIT_SPAWN_TIMEOUT_MS, encoding: "utf8" });
    if (result.status === 0 && typeof result.stdout === "string") {
      const email = result.stdout.trim();
      return email.length > 0 ? email : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function resolveActor(root: string, env: NodeJS.ProcessEnv): string {
  const fromEnv = env.KERYX_ACTOR?.trim();
  if (fromEnv) return fromEnv;
  return tryGitUserEmail(root) ?? "unknown";
}

function storeOptionsOf(opts: { env?: NodeJS.ProcessEnv; homeDir?: string }): StoreEnvOptions {
  return {
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
  };
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

const STOPWORDS: ReadonlySet<string> = new Set([
  "that",
  "this",
  "with",
  "from",
  "into",
  "have",
  "should",
  "would",
  "could",
  "when",
  "then",
  "after",
  "before",
  "their",
  "there",
  "where",
  "which",
  "while",
  "about",
  "because",
  "without",
  "being",
  "been",
  "were",
  "these",
  "those",
  "every",
  "always",
  "never",
  "often",
  "instead",
  "rather",
  "still",
  "also",
  "only",
  "just",
  "some",
  "does",
  "each",
]);

/** Lowercase word tokens >= 4 chars, minus a small stopword list, starting with a letter (never a bare number) — and, when `logins` is given, minus every token equal (case-insensitive) to a configured login or a hyphen/underscore-split piece of one (R6-F1). Token-equality only: never a substring test, so this cannot re-open the fixed-wording false-refusal `containsConfiguredLogin`'s own substring fallback used to cause (R4-F1/R5-F1/R5-F2). */
function keywordsOf(text: string, logins: readonly string[] = []): ReadonlySet<string> {
  const words = text.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? [];
  const forbidden = loginKeywordSet(logins);
  return new Set(words.filter((word) => word.length >= 4 && !STOPWORDS.has(word) && !forbidden.has(word)));
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): { score: number; shared: number } {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  const unionSize = new Set([...a, ...b]).size;
  return { score: unionSize === 0 ? 0 : shared / unionSize, shared };
}

/**
 * Single-linkage clustering within one `domain`: two records union when their
 * trigger-keyword Jaccard is `>= 0.5` AND they share `>= 2` keywords.
 * Deterministic: records are sorted by `id` first, union-find roots are
 * always the lexicographically smaller id, and clusters are returned sorted
 * by their (smallest) member id.
 */
function clusterRecords(records: readonly LearnedPattern[]): LearnedPattern[][] {
  const sorted = [...records].sort((a, b) => a.id.localeCompare(b.id));
  const keywordsById = new Map(sorted.map((record) => [record.id, keywordsOf(record.trigger)]));
  const parent = new Map(sorted.map((record) => [record.id, record.id]));

  function find(x: string): string {
    let current = x;
    while (parent.get(current) !== current) current = parent.get(current) as string;
    return current;
  }
  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    const [keep, drop] = rootA < rootB ? [rootA, rootB] : [rootB, rootA];
    parent.set(drop, keep);
  }

  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i] as LearnedPattern;
      const b = sorted[j] as LearnedPattern;
      if (a.domain !== b.domain) continue;
      const { score, shared } = jaccard(keywordsById.get(a.id) as ReadonlySet<string>, keywordsById.get(b.id) as ReadonlySet<string>);
      if (score >= 0.5 && shared >= 2) union(a.id, b.id);
    }
  }

  const groups = new Map<string, LearnedPattern[]>();
  for (const record of sorted) {
    const root = find(record.id);
    const list = groups.get(root) ?? [];
    list.push(record);
    groups.set(root, list);
  }
  return [...groups.values()].sort((a, b) => (a[0] as LearnedPattern).id.localeCompare((b[0] as LearnedPattern).id));
}

/**
 * R1-F2: `clusterRecords` keys strictly by `id`, but `listPatterns({ status:
 * "accepted" })` returns BOTH scopes — the same pattern accepted at project
 * scope AND (after `promote`, then a second human accept) at user scope is
 * one conceptual pattern with two on-disk copies, not two independent
 * accepted patterns. Left alone, that pair forms its own 2-member cluster
 * (`[id, id]`) and can trigger a graduation proposal off a SINGLE accepted
 * pattern — exactly the "at least N independently accepted patterns" rule
 * graduation exists to enforce. Deduping by id before clustering (preferring
 * the project-scope copy, so `readMember`'s own project-then-user lookup
 * order and the proposal's members line up with which copy is "the" member)
 * makes every cluster member a distinct id, as the clustering/cluster-size
 * rule already assumes.
 */
function dedupeByIdPreferProject(records: readonly LearnedPattern[]): LearnedPattern[] {
  const byId = new Map<string, LearnedPattern>();
  for (const record of records) {
    const existing = byId.get(record.id);
    if (existing === undefined || (existing.scope !== "project" && record.scope === "project")) {
      byId.set(record.id, record);
    }
  }
  return [...byId.values()];
}

function averageConfidence(cluster: readonly LearnedPattern[]): number {
  return cluster.reduce((sum, record) => sum + record.confidence, 0) / cluster.length;
}

/** The graduation rule (W3 spec "Graduation to skills/agents/rules"). `undefined` when no rule applies — the cluster is not graduated. */
function classify(cluster: readonly LearnedPattern[]): GraduationTarget | undefined {
  if (cluster.length >= 3 && averageConfidence(cluster) >= 0.75) return "agent";
  const domain = (cluster[0] as LearnedPattern).domain;
  if (domain !== "review-conventions" && cluster.length >= 2) return "skill";
  if (cluster.length === 1 && domain === "workflow" && (cluster[0] as LearnedPattern).confidence >= 0.7) return "rule";
  return undefined;
}

/** The `provenance`/`trigger`/`action` shape `keywordSourceFor`/`topKeywords`/`suggestedNameFor` need — every `LearnedPattern` satisfies this, and so does `applyGraduation`'s lighter-weight `MemberAttributionEntry` (built from member records read at apply time, without the rest of `LearnedPattern`). */
interface KeywordEntry {
  readonly provenance: { readonly extractor: string; readonly extractorKind?: string | undefined };
  readonly trigger: string;
  readonly action: string;
}

/**
 * An entry's `trigger`, with `reviewer-comment`'s fixed
 * `REVIEWER_COMMENT_TRIGGER_PREFIX` wording stripped first (R5-F1/R5-F2):
 * that prefix's own constant words ("preparing", "change", "review",
 * "project") are not the member's actual content, and letting them into
 * `topKeywords`/`suggestedNameFor` produced graduation proposal names and
 * summaries built out of Keryx's own template prose rather than what any
 * comment said — the same fixed-wording contamination `containsConfiguredLogin`'s
 * removed substring fallback used to false-refuse on (see `reviewer-id.ts`).
 */
function keywordSourceFor(entry: KeywordEntry): string {
  const trigger = entry.provenance.extractor === "reviewer-comment" ? stripReviewerCommentTriggerPrefix(entry.trigger) : entry.trigger;
  return `${trigger} ${entry.action}`;
}

/**
 * `logins` (R6-F1): forwarded to `keywordsOf` so a configured login (or a
 * hyphen/underscore piece of one) can never surface as a top keyword — and
 * therefore never in `suggestedNameFor`'s name or `runGraduate`'s summary.
 *
 * R9-F1/R9-F2 (review round 9, PR #691): `logins` is applied PER ENTRY, only
 * when `mayCarryReviewerText(entry.provenance)` holds — the same scoping
 * `gateReviewerText`'s member-text gate already applies. An entry whose
 * signal never reads review text (reverted-edit, repeated-correction, a
 * plain `code-style`/`code-bot` cluster, ...) keeps its keywords unfiltered:
 * an ordinary word that happens to equal a configured login (`code`, `edit`,
 * `review`) is that entry's genuine content, not an attribution leak, and
 * filtering it out regardless of provenance both mis-named clean
 * graduations AND (when it emptied the whole keyword set) fell back to
 * `learned-<domain>` — the same fixed fallback name `applyGraduation` used
 * to then wrongly refuse for containing no login at all.
 */
function topKeywords(entries: readonly KeywordEntry[], limit: number, logins: readonly string[] = []): string[] {
  const frequency = new Map<string, number>();
  for (const entry of entries) {
    const loginsForEntry = mayCarryReviewerText(entry.provenance) ? logins : [];
    for (const word of keywordsOf(keywordSourceFor(entry), loginsForEntry)) {
      frequency.set(word, (frequency.get(word) ?? 0) + 1);
    }
  }
  return [...frequency.entries()]
    .sort(([wordA, countA], [wordB, countB]) => countB - countA || wordA.localeCompare(wordB))
    .slice(0, limit)
    .map(([word]) => word);
}

/** Kebab-case suggested name from the entries' top keywords — always matches `^[a-z][a-z0-9-]*$` by construction (`keywordsOf` only yields lowercase `[a-z][a-z0-9]*` tokens). `domain` feeds only the fallback name (no shared keywords survive filtering — a singleton cluster, or every keyword happened to be login-equal for a `mayCarryReviewerText` entry). `logins`: see `topKeywords`. */
function suggestedNameFor(entries: readonly KeywordEntry[], domain: LearningDomain, logins: readonly string[] = []): string {
  const words = topKeywords(entries, 3, logins);
  if (words.length > 0) return words.join("-");
  return `learned-${domain}`;
}

function proposalIdFor(target: GraduationTarget, memberIds: readonly string[]): string {
  const sortedIds = [...memberIds].sort();
  const hash = createHash("sha256").update(sortedIds.join(",")).digest("hex").slice(0, 12);
  return `grad-${target}-${hash}`;
}

function nextStepsFor(target: GraduationTarget, proposalId: string, suggestedName: string, query: string): string[] {
  if (target === "skill") {
    return [
      `keryx skills scout "${query}" --record <pack-dir> --skill-name ${suggestedName} --origin learned --source-ref ${proposalId}`,
    ];
  }
  if (target === "rule") {
    return [
      `Manually author or update a rule under .metaproject/rules/ covering "${query}"; ` +
        "keryx learn graduate never writes a rule file itself.",
    ];
  }
  return [`keryx learn graduate apply ${proposalId}`];
}

function proposalPathFor(root: string, proposalId: string): string {
  return path.join(graduationDir(root), `${proposalId}.json`);
}

function proposalSummaryPathFor(root: string, proposalId: string): string {
  return path.join(graduationDir(root), `${proposalId}.md`);
}

/** Project-relative path stored on each source record's `graduation.proposalPath` (W3 spec: "the source records' `graduation` field with the proposal path"). */
function projectRelativeProposalPath(proposalId: string): string {
  return path.join(".metaproject", "data", "learning", "graduation", `${proposalId}.json`);
}

function renderSummaryMarkdown(proposal: GraduationProposalFile): string {
  const lines = [
    `# Graduation proposal ${proposal.proposalId}`,
    "",
    `- target: ${proposal.target}`,
    `- domain: ${proposal.domain}`,
    `- suggested name: ${proposal.suggestedName}`,
    `- members: ${proposal.members.join(", ")}`,
    "",
    "## Summary",
    "",
    proposal.summary,
    "",
    "## Next steps",
    "",
    ...proposal.nextSteps.map((step) => `- \`${step}\``),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Clusters `status: "accepted"` records (project + user scope) and writes one
 * graduation proposal per qualifying cluster. Never writes a `SKILL.md`,
 * agent definition, or rule file itself — see module header. Idempotent: a
 * cluster whose deterministic proposal id already exists on disk is skipped
 * (`report.alreadyProposed`), not rewritten. A cluster whose member text
 * fails the security scan is skipped and reported (`report.refused`) rather
 * than written or having `graduation` set on its members.
 */
export async function runGraduate(root: string, opts: RunGraduateOptions = {}): Promise<GraduateReport> {
  const storeOptions = storeOptionsOf(opts);
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();

  // R6-F2: loaded through the SAFE loader (never throws) — unlike
  // `applyGraduation`'s `configuredReviewLogins`, a malformed
  // `review-learning.config.json` here degrades to "no configured logins"
  // rather than aborting the whole clustering/proposal pass, the same
  // degrade-not-abort choice `extract.ts`'s `runExtract` makes for every
  // other domain's login gate.
  const configResult = await loadReviewLearningConfigSafe(root);
  const configuredLogins = configResult.ok
    ? configResult.config === null
      ? []
      : [...new Set([...configResult.config.authors, ...(configResult.config.reviewerProfiles ?? [])])]
    : [];

  const accepted = await listPatterns(root, { status: "accepted", ...(opts.domain !== undefined ? { domain: opts.domain } : {}) }, storeOptions);

  const clusters = clusterRecords(dedupeByIdPreferProject(accepted));
  const proposals: GraduationProposalFile[] = [];
  const alreadyProposed: string[] = [];
  const refused: GraduateRefusal[] = [];

  for (const cluster of clusters) {
    const target = classify(cluster);
    if (target === undefined) continue;

    const memberIds = cluster.map((record) => record.id);
    const proposalId = proposalIdFor(target, memberIds);
    const jsonPath = proposalPathFor(root, proposalId);
    assertInsideLearningRoot(jsonPath, [learningDataDir(root)]);

    if (await pathExists(jsonPath)) {
      alreadyProposed.push(proposalId);
      continue;
    }

    const scan = await scanLearnedText(
      root,
      cluster.flatMap((record) => [record.trigger, record.action]),
    );
    if (scan.findings.length > 0) {
      refused.push({ memberIds, categories: scan.findings });
      continue;
    }

    // R6-F2/R7-F3/R8-F3: refuse, before any proposal file is written, a
    // cluster with a member gated by `gateReviewerText` — the same
    // login-may-have-been-configured-after-records-were-stored risk
    // `applyGraduation`'s member-text gate already covers at apply time, now
    // also covered at proposal time so the login never even reaches a
    // `grad-*.json`/`.md` proposal artifact. `gateReviewerText` itself scopes
    // by `mayCarryReviewerText` (R6-F4/R7-F3): every other signal's
    // trigger/action never read review text, so it cannot carry an
    // attribution fragment.
    if (
      configuredLogins.length > 0 &&
      cluster.some((record) => gateReviewerText({ provenance: record.provenance, trigger: record.trigger, action: record.action }, configuredLogins).refused)
    ) {
      refused.push({ memberIds, categories: ["attribution"] });
      continue;
    }

    const domain = (cluster[0] as LearnedPattern).domain;
    const suggestedName = suggestedNameFor(cluster, domain, configuredLogins);
    const keywords = topKeywords(cluster, 5, configuredLogins);
    const query = keywords.length > 0 ? keywords.join(" ") : domain;
    const summary = `${cluster.length} accepted "${domain}" pattern(s) sharing: ${keywords.join(", ") || "(no shared keywords — singleton cluster)"}.`;
    const nextSteps = nextStepsFor(target, proposalId, suggestedName, query);

    const proposal: GraduationProposalFile = {
      schemaVersion: 1,
      proposalId,
      target,
      members: memberIds,
      domain,
      suggestedName,
      summary,
      nextSteps,
    };

    const lockPath = projectLockPath(root);
    await withFileLock(lockPath, async () => {
      await writeFileAtomic(jsonPath, `${JSON.stringify(proposal, null, 2)}\n`);
      const summaryPath = proposalSummaryPathFor(root, proposalId);
      assertInsideLearningRoot(summaryPath, [learningDataDir(root)]);
      await writeFileAtomic(summaryPath, renderSummaryMarkdown(proposal));
    });

    const graduationRef = { target, proposalPath: projectRelativeProposalPath(proposalId) };
    for (const member of cluster) {
      // R1-F1/R1-F7: through the choke point, under the member's own scope
      // lock. `member` is already stored at `status: "accepted"` — no
      // capability needed (`writeRecordUnlocked`'s "already accepted"
      // exception; `updatePattern`'s accepted-text-immutable check does not
      // apply either, since only `graduation`/`updatedAt` change here).
      await updatePattern(root, member.id, member.scope, (current) => ({ ...current, graduation: graduationRef, updatedAt: nowIso }), storeOptions);
    }

    proposals.push(proposal);
  }

  return { proposals, alreadyProposed, refused };
}

// ---------------------------------------------------------------------------
// applyGraduation
// ---------------------------------------------------------------------------

const PROPOSAL_ID_PATTERN = /^grad-(skill|agent|rule)-[0-9a-f]{12}$/;

/** Minimal read-only tool vocabulary for a graduated agent candidate (W2 vocabulary, `../agents/tools.ts`). */
const GRADUATED_AGENT_TOOLS: readonly string[] = ["read_file", "list_dir", "search_code"];

async function readProposal(root: string, proposalId: string): Promise<GraduationProposalFile> {
  if (!PROPOSAL_ID_PATTERN.test(proposalId)) {
    throw new LearningGraduateError("invalid-proposal-id", `"${proposalId}" is not a well-formed graduation proposal id`);
  }
  const jsonPath = proposalPathFor(root, proposalId);
  assertInsideLearningRoot(jsonPath, [learningDataDir(root)]);
  if (!(await pathExists(jsonPath))) {
    throw new LearningGraduateError("graduate-proposal-not-found", `no graduation proposal "${proposalId}"`);
  }
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(jsonPath, "utf8");
  return JSON.parse(raw) as GraduationProposalFile;
}

/** Reads a member pattern record, checking project scope then user scope — same lookup order `learn.ts`'s `findById` uses. */
async function readMember(root: string, id: string, storeOptions: StoreEnvOptions): Promise<LearnedPattern | undefined> {
  const project = await readPattern(root, id, "project", storeOptions);
  if (project !== undefined) return project;
  return readPattern(root, id, "user", storeOptions);
}

function renderAgentMarkdown(definition: AgentDefinition): string {
  const lines: string[] = [
    `name: ${definition.name}`,
    `description: ${definition.description}`,
    `role: ${definition.role}`,
    `tools: [${definition.tools.join(", ")}]`,
    `model_tier: ${definition.model_tier}`,
    `policy_profile: ${definition.policy_profile}`,
  ];
  if (definition.skills.length > 0) lines.push(`skills: [${definition.skills.join(", ")}]`);
  if (definition.stacks.length > 0) lines.push(`stacks: [${definition.stacks.join(", ")}]`);
  lines.push(`output_contract: ${definition.output_contract}`);
  lines.push(`isolation: ${definition.isolation}`);
  if (definition.origin !== undefined) {
    lines.push("origin:");
    lines.push(`  kind: ${definition.origin.kind}`);
    if (definition.origin.sourceRef !== undefined) lines.push(`  sourceRef: ${definition.origin.sourceRef}`);
  }
  return `---\n${lines.join("\n")}\n---\n\n${definition.body}\n`;
}

/** One member's `trigger`/`action` plus the `provenance` `gateReviewerText` needs to decide whether that text is even inspected. */
interface MemberAttributionEntry {
  readonly provenance: { readonly extractor: string; readonly extractorKind?: string | undefined };
  readonly trigger: string;
  readonly action: string;
}

interface AgentCandidateBuild {
  readonly definition: AgentDefinition;
  /**
   * One entry per member record found (R7-F2/R7-F3/R8-F3): `gateReviewerText`
   * itself decides, via `mayCarryReviewerText(entry.provenance)`, whether a
   * given member's `trigger`/`action` is inspected at all — a member whose
   * signal never reads review text (reverted-edit, repeated-correction, etc.)
   * is passed through unchanged and `gateReviewerText` is a no-op for it,
   * rather than being pre-filtered out here (R7-F2, the residual `R6-F4` left
   * open in `applyGraduation`'s old member-text gate).
   */
  readonly memberEntries: readonly MemberAttributionEntry[];
}

/**
 * R9-F1/R9-F2 (review round 9, PR #691): the candidate's `name`/`description`
 * are RECOMPUTED here from `memberEntries` and `configuredLogins` — the
 * logins configured NOW, at apply time — rather than trusted from
 * `proposal.suggestedName`/`proposal.summary`, which were filtered against
 * whichever logins were configured when `runGraduate` ran. A login
 * configured afterward (before this apply) would otherwise leave a stale,
 * unfiltered token sitting in those persisted strings with no way to catch
 * it short of re-checking already-derived text (which is what the removed
 * `extraTokens` re-check did, and which could not tell a stale login token
 * apart from an ordinary keyword or the fixed `learned-<domain>` fallback
 * that only coincidentally shared a substring with a login — R9-F1/R9-F2).
 * Recomputing with the exact same `topKeywords`/`suggestedNameFor` rule
 * `runGraduate` uses (scoped to `mayCarryReviewerText` per member) keeps
 * proposal-time and apply-time in agreement by construction, with nothing
 * stale left to re-check. When the recomputed name differs from
 * `proposal.suggestedName` (the login-derived token that changed it was
 * configured after `runGraduate` ran), the agent is written under the
 * recomputed name, not the stale one.
 */
async function buildAgentCandidate(
  root: string,
  proposal: GraduationProposalFile,
  storeOptions: StoreEnvOptions,
  configuredLogins: readonly string[],
): Promise<AgentCandidateBuild> {
  const members: string[] = [];
  const memberEntries: MemberAttributionEntry[] = [];
  for (const id of proposal.members) {
    const record = await readMember(root, id, storeOptions);
    if (record !== undefined) {
      members.push(`- ${record.trigger} -> ${record.action} (source: ${id})`);
      memberEntries.push({ provenance: record.provenance, trigger: record.trigger, action: record.action });
    } else {
      members.push(`- (source record "${id}" not found)`);
    }
  }

  const recomputedKeywords = topKeywords(memberEntries, 5, configuredLogins);
  const recomputedName = suggestedNameFor(memberEntries, proposal.domain, configuredLogins);
  const summary = `${proposal.members.length} accepted "${proposal.domain}" pattern(s) sharing: ${recomputedKeywords.join(", ") || "(no shared keywords — singleton cluster)"}.`;

  const description = summary.length > 0 && summary.length <= 1024 ? summary : summary.slice(0, 1024);
  const role =
    `Applies guidance graduated from ${proposal.members.length} learned pattern(s) in the "${proposal.domain}" domain. ` +
    "Read-only: report findings and suggested guidance rather than making changes yourself.";

  return {
    definition: {
      name: recomputedName,
      description,
      role,
      tools: GRADUATED_AGENT_TOOLS,
      model_tier: "light",
      policy_profile: "read-only",
      skills: [],
      stacks: [],
      output_contract: "subagent-result",
      isolation: "none",
      origin: { kind: "learned", sourceRef: proposal.members[0] as string },
      body: `## Guidance graduated from learned patterns\n\n${members.join("\n")}\n`,
    },
    memberEntries,
  };
}

/**
 * Applies one graduation proposal. Refuses (all as `LearningGraduateError`):
 *  - `graduate-apply-requires-terminal` — checked FIRST.
 *  - `invalid-proposal-id` / `graduate-proposal-not-found`.
 *  - `graduate-apply-agent-only` — `proposal.target !== "agent"`; the message
 *    carries the proposal's own `nextSteps` (skill/rule targets are applied
 *    by W1 or a human, never here).
 *  - `learning-text-refused` — the security scan found something in the
 *    assembled agent candidate.
 *  - `agent-definition-invalid` — the built candidate fails
 *    `validateAgentDefinition` (defense in depth; should not happen for a
 *    well-formed proposal).
 *  - `agent-candidate-exists` — `.metaproject/agents/<name>.md` already exists.
 *  - `graduate-apply-cancelled` — `confirm()` resolved `false`. Writes nothing.
 */
export async function applyGraduation(root: string, proposalId: string, opts: ApplyGraduationOptions): Promise<{ path: string }> {
  if (!opts.isTerminal) {
    throw new LearningGraduateError(
      "graduate-apply-requires-terminal",
      "keryx learn graduate apply needs an interactive terminal; there is no bypass flag or environment variable.",
    );
  }

  const env = opts.env ?? process.env;
  const storeOptions = storeOptionsOf(opts);
  const proposal = await readProposal(root, proposalId);

  if (proposal.target !== "agent") {
    throw new LearningGraduateError(
      "graduate-apply-agent-only",
      `proposal "${proposalId}" targets "${proposal.target}", not "agent"; graduate apply only writes agent candidates. ` +
        `Next step: ${proposal.nextSteps.join(" ")}`,
    );
  }

  // R3-F3: a malformed config surfaces as `LearningGraduateConfigError` from
  // `configuredReviewLogins` — converted here into the named
  // `review-learning-config-invalid` reason rather than an un-reasoned
  // throw escaping `applyGraduation`. Loaded BEFORE `buildAgentCandidate`
  // (R9-F1/R9-F2): the candidate's name/summary are recomputed from these
  // CURRENT logins, not trusted from the proposal's own stored values — see
  // `buildAgentCandidate`'s doc comment.
  let configuredLogins: string[];
  try {
    configuredLogins = await configuredReviewLogins(root);
  } catch (error) {
    if (error instanceof LearningGraduateConfigError) {
      throw new LearningGraduateError(
        "review-learning-config-invalid",
        `proposal "${proposalId}" cannot be applied: .metaproject/review-learning.config.json is invalid: ${error.message}`,
      );
    }
    throw error;
  }

  const { definition: candidate, memberEntries } = await buildAgentCandidate(root, proposal, storeOptions, configuredLogins);

  const scan = await scanLearnedText(root, [candidate.description, candidate.role, candidate.body]);
  if (scan.findings.length > 0) {
    throw new LearningGraduateError("learning-text-refused", `agent candidate refused by the security scan: ${scan.findings.join(", ")}`);
  }

  // R2-F6/R8-F3: the same case-insensitive configured-login refusal
  // `generalizeLesson`/extract's upsert apply, run here too via
  // `gateReviewerText` — an attribution fragment that somehow survived into a
  // stored member record (or arrived via a differently configured login list
  // at graduation time) is still refused before it reaches
  // `.metaproject/agents/<name>.md`.
  //
  // R4-F1/R5-F1/R5-F2/R7-F2/R7-F3: this login gate checks ONLY
  // `memberEntries` — `gateReviewerText` itself decides, per member, whether
  // `mayCarryReviewerText(entry.provenance)` holds before inspecting that
  // member's `trigger`/`action`. It never checks `candidate.description` or
  // `candidate.name` directly here: both are now RECOMPUTED by
  // `buildAgentCandidate` from `memberEntries` and `configuredLogins` using
  // the same per-member `mayCarryReviewerText`-scoped filtering
  // `runGraduate` applies at proposal time (R9-F1/R9-F2) — so a login is
  // already kept out of them by construction, and there is nothing stale
  // left to re-check (the removed `extraTokens` re-check this comment used
  // to point to, R8-F1, inspected STORED tokens instead and could not tell
  // a stale leaked login apart from an ordinary keyword or the fixed
  // `learned-<domain>` fallback that only coincidentally shared a
  // substring with a login).
  if (
    configuredLogins.length > 0 &&
    memberEntries.some((entry) => gateReviewerText({ provenance: entry.provenance, trigger: entry.trigger, action: entry.action }, configuredLogins).refused)
  ) {
    throw new LearningGraduateError(
      "learning-text-refused",
      `agent candidate for proposal "${proposalId}" refused: contains a configured reviewer login`,
    );
  }

  const validation = validateAgentDefinition(candidate);
  if (!validation.ok) {
    throw new LearningGraduateError(
      "agent-definition-invalid",
      `built agent candidate for "${candidate.name}" failed schema validation: ${validation.errors.map((error) => `${error.field}: ${error.message}`).join("; ")}`,
    );
  }

  const agentsDir = path.join(root, ".metaproject", "agents");
  const targetPath = path.join(agentsDir, `${candidate.name}.md`);
  if (!isPathInside(agentsDir, targetPath)) {
    throw new LearningGraduateError("learning-path-outside-root", `refusing to write outside ${agentsDir}: ${targetPath}`);
  }
  if (await pathExists(targetPath)) {
    throw new LearningGraduateError("agent-candidate-exists", `${targetPath} already exists`);
  }

  const confirmed = await opts.confirm();
  if (!confirmed) {
    throw new LearningGraduateError("graduate-apply-cancelled", "graduate apply cancelled: confirmation did not match. Nothing was written.");
  }

  const lockPath = path.join(agentsDir, "agents.lock");
  await withFileLock(lockPath, async () => {
    await writeFileAtomic(targetPath, renderAgentMarkdown(candidate));
  });

  const now = opts.now ?? new Date();
  const actor = resolveActor(root, env);
  await appendDecision(
    root,
    { action: "graduate-apply", id: proposalId, actor, tty: true, at: now.toISOString() },
    { ...storeOptions, scope: "project" as LearningScope },
  );

  return { path: targetPath };
}
