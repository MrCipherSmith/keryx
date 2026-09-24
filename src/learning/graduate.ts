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
import { appendDecision } from "./decisions";
import { assertInsideLearningRoot, graduationDir, learningDataDir, projectLockPath } from "./paths";
import { scanLearnedText } from "./scan";
import { listPatterns, readPattern, writePattern, type StoreEnvOptions } from "./store";
import type { GraduationTarget, LearnedPattern, LearningDomain, LearningScope } from "./types";

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

/** Lowercase word tokens >= 4 chars, minus a small stopword list, starting with a letter (never a bare number). */
function keywordsOf(text: string): ReadonlySet<string> {
  const words = text.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? [];
  return new Set(words.filter((word) => word.length >= 4 && !STOPWORDS.has(word)));
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

function topKeywords(cluster: readonly LearnedPattern[], limit: number): string[] {
  const frequency = new Map<string, number>();
  for (const record of cluster) {
    for (const word of keywordsOf(`${record.trigger} ${record.action}`)) {
      frequency.set(word, (frequency.get(word) ?? 0) + 1);
    }
  }
  return [...frequency.entries()]
    .sort(([wordA, countA], [wordB, countB]) => countB - countA || wordA.localeCompare(wordB))
    .slice(0, limit)
    .map(([word]) => word);
}

/** Kebab-case suggested name from the cluster's top keywords — always matches `^[a-z][a-z0-9-]*$` by construction (`keywordsOf` only yields lowercase `[a-z][a-z0-9]*` tokens). */
function suggestedNameFor(cluster: readonly LearnedPattern[]): string {
  const words = topKeywords(cluster, 3);
  if (words.length > 0) return words.join("-");
  return `learned-${(cluster[0] as LearnedPattern).domain}`;
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

  const accepted = await listPatterns(root, { status: "accepted", ...(opts.domain !== undefined ? { domain: opts.domain } : {}) }, storeOptions);

  const clusters = clusterRecords(accepted);
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

    const domain = (cluster[0] as LearnedPattern).domain;
    const suggestedName = suggestedNameFor(cluster);
    const keywords = topKeywords(cluster, 5);
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
      const updated: LearnedPattern = { ...member, graduation: graduationRef, updatedAt: nowIso };
      // `member` is already stored at `status: "accepted"` — no capability
      // needed (`store.writePattern`'s "already accepted" exception).
      await writePattern(root, updated, storeOptions);
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

async function buildAgentCandidate(root: string, proposal: GraduationProposalFile, storeOptions: StoreEnvOptions): Promise<AgentDefinition> {
  const members: string[] = [];
  for (const id of proposal.members) {
    const record = await readMember(root, id, storeOptions);
    members.push(record !== undefined ? `- ${record.trigger} -> ${record.action} (source: ${id})` : `- (source record "${id}" not found)`);
  }

  const description = proposal.summary.length > 0 && proposal.summary.length <= 1024 ? proposal.summary : proposal.summary.slice(0, 1024);
  const role =
    `Applies guidance graduated from ${proposal.members.length} learned pattern(s) in the "${proposal.domain}" domain. ` +
    "Read-only: report findings and suggested guidance rather than making changes yourself.";

  return {
    name: proposal.suggestedName,
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

  const candidate = await buildAgentCandidate(root, proposal, storeOptions);

  const scan = await scanLearnedText(root, [candidate.description, candidate.role, candidate.body]);
  if (scan.findings.length > 0) {
    throw new LearningGraduateError("learning-text-refused", `agent candidate refused by the security scan: ${scan.findings.join(", ")}`);
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
