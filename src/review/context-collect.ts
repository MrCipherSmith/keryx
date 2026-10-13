import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type CollectedComment, type GitHubPort, callGitHub, collectPrComments } from "./pr-comments";

export const PR_CONTEXT_JSON = "pr-context.json";
export const PR_CONTEXT_MD = "pr-context.md";

export type CheckState = "passing" | "failing" | "pending" | "skipped";

export type CheckSummary = { name: string; state: CheckState };

export type CiStatus = {
  state: "passing" | "failing" | "pending" | "none" | "unknown";
  checks: CheckSummary[];
  failing: string[];
};

export type BackendPin = { kind: "sha" | "version" | "pull" | "branch" | "url"; ref: string; line: string; source: string };

export type PrContextComment = {
  id: string;
  source: string;
  author: string;
  authorIsBot: boolean;
  path: string | null;
  line: number | null;
  url: string;
  submittedAt: string;
  reviewState: string | null;
  /** The whole body. Nothing here is cut: a finding's `problem` is the place for a summary. */
  body: string;
};

export type PrContext = {
  schemaVersion: 1;
  repo: string;
  number: number;
  headSha: string | null;
  collectedAt: string;
  /** Which collection of this pull request this is; a new head starts the next one. */
  round: number;
  /** What the pull request was for when it was first collected. Later rounds keep it. */
  intent: { round: number; title: string; body: string };
  ci: CiStatus;
  backendPins: BackendPin[];
  comments: PrContextComment[];
};

export type PullText = { title: string; body: string; headSha: string | null };

const BACKEND_LINE = /backend|бэкенд|бекенд|бэк\b|\bBE\b/i;
const SHA = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;
const VERSION = /\bv?\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/g;
const PULL = /(?:[\w.-]+\/[\w.-]+)?#\d+\b/g;
const URL_REF = /https?:\/\/github\.com\/[^\s)>\]]+\/(?:pull|commit|tree)\/[\w.%/-]+/g;
const BRANCH = /(?:\bbranch|ветк[аеиу])\s+`?([\w./-]+)`?/gi;

/** Backend pins are the refs a pull request names on a line that talks about the backend. */
export function extractBackendPins(texts: readonly { source: string; text: string }[]): BackendPin[] {
  const pins: BackendPin[] = [];
  const seen = new Set<string>();
  const add = (kind: BackendPin["kind"], ref: string, line: string, source: string) => {
    const key = `${kind}:${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    pins.push({ kind, ref, line: line.trim().slice(0, 300), source });
  };
  for (const { source, text } of texts) {
    for (const line of text.split(/\r?\n/)) {
      if (!BACKEND_LINE.test(line)) continue;
      for (const m of line.matchAll(URL_REF)) add("url", m[0], line, source);
      const withoutUrls = line.replace(URL_REF, " ");
      for (const m of withoutUrls.matchAll(PULL)) add("pull", m[0], line, source);
      for (const m of withoutUrls.matchAll(VERSION)) add("version", m[0], line, source);
      for (const m of withoutUrls.matchAll(SHA)) add("sha", m[0], line, source);
      for (const m of withoutUrls.matchAll(BRANCH)) add("branch", m[1]!, line, source);
    }
  }
  return pins;
}

export function summariseChecks(checks: readonly CheckSummary[] | undefined): CiStatus {
  if (checks === undefined) return { state: "unknown", checks: [], failing: [] };
  const failing = checks.filter((c) => c.state === "failing").map((c) => c.name);
  const state = checks.length === 0 ? "none" : failing.length > 0 ? "failing" : checks.some((c) => c.state === "pending") ? "pending" : "passing";
  return { state, checks: [...checks], failing };
}

export function buildPrContext(input: {
  repo: string;
  number: number;
  pull: PullText;
  comments: readonly CollectedComment[];
  checks?: readonly CheckSummary[] | undefined;
  previous?: PrContext | undefined;
  now?: Date | undefined;
}): PrContext {
  const { previous } = input;
  const round = previous === undefined ? 1 : previous.headSha === input.pull.headSha ? previous.round : previous.round + 1;
  const comments: PrContextComment[] = input.comments.map((c) => ({
    id: c.id, source: c.source, author: c.author, authorIsBot: c.authorIsBot, path: c.path, line: c.line,
    url: c.url, submittedAt: c.submittedAt, reviewState: c.reviewState, body: c.body,
  }));
  const intent = previous?.intent ?? { round: 1, title: input.pull.title, body: input.pull.body };
  const pins = extractBackendPins([
    { source: "pull request body", text: `${input.pull.title}\n${input.pull.body}` },
    ...comments.map((c) => ({ source: c.id, text: c.body })),
  ]);
  return {
    schemaVersion: 1,
    repo: input.repo,
    number: input.number,
    headSha: input.pull.headSha,
    collectedAt: (input.now ?? new Date()).toISOString(),
    round,
    intent,
    ci: summariseChecks(input.checks),
    backendPins: pins,
    comments,
  };
}

export function renderPrContext(ctx: PrContext): string {
  const lines = [
    `# Pull request context: ${ctx.repo}#${ctx.number}`,
    "",
    `Head ${ctx.headSha ?? "not reported"}, collection round ${ctx.round}, collected ${ctx.collectedAt}.`,
    "",
    `## Intent (round ${ctx.intent.round})`,
    "",
    `**${ctx.intent.title}**`,
    "",
    ctx.intent.body.trim() === "" ? "_The pull request has no description._" : ctx.intent.body,
    "",
    `## CI: ${ctx.ci.state}`,
    "",
    ...(ctx.ci.checks.length === 0 ? ["_No checks reported._"] : ctx.ci.checks.map((c) => `- ${c.name}: ${c.state}`)),
    "",
    "## Backend pins",
    "",
    ...(ctx.backendPins.length === 0 ? ["_The pull request names none._"] : ctx.backendPins.map((p) => `- ${p.kind} \`${p.ref}\` (${p.source}): ${p.line}`)),
    "",
    `## Review comments (${ctx.comments.length}, full text)`,
    "",
  ];
  for (const c of ctx.comments) {
    lines.push(`### ${c.id} by ${c.author}${c.path === null ? "" : ` on ${c.path}${c.line === null ? "" : `:${c.line}`}`}`, "", c.body, "");
  }
  return `${lines.join("\n")}\n`;
}

/** Reads an earlier collection in the package, so the round-1 intent survives later rounds. */
export async function readPrContext(packageDir: string): Promise<PrContext | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(packageDir, PR_CONTEXT_JSON), "utf8")) as PrContext;
    return parsed?.schemaVersion === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function pullText(raw: unknown): PullText {
  const o = (raw !== null && typeof raw === "object" ? raw : {}) as { title?: unknown; body?: unknown; head?: { sha?: unknown } };
  return {
    title: typeof o.title === "string" ? o.title : "",
    body: typeof o.body === "string" ? o.body : "",
    headSha: typeof o.head?.sha === "string" ? o.head.sha.toLowerCase() : null,
  };
}

/** Collects the pull request's comments in full, its intent, CI and backend pins, and writes them into the package. */
export async function collectPrContext(input: {
  port: GitHubPort;
  repo: string;
  number: number;
  self: string;
  packageDir: string;
  checks?: readonly CheckSummary[] | undefined;
  now?: Date | undefined;
}): Promise<{ context: PrContext; json: string; md: string }> {
  const [pull, collected, previous] = await Promise.all([
    callGitHub(input.port, { method: "GET", path: `repos/${input.repo}/pulls/${input.number}` }),
    collectPrComments({ port: input.port, repo: input.repo, number: input.number, self: input.self }),
    readPrContext(input.packageDir),
  ]);
  const context = buildPrContext({ repo: input.repo, number: input.number, pull: pullText(pull), comments: collected.comments, checks: input.checks, previous, now: input.now });
  await mkdir(input.packageDir, { recursive: true });
  const json = path.join(input.packageDir, PR_CONTEXT_JSON);
  const md = path.join(input.packageDir, PR_CONTEXT_MD);
  await writeFile(json, `${JSON.stringify(context, null, 2)}\n`, "utf8");
  await writeFile(md, renderPrContext(context), "utf8");
  return { context, json, md };
}

/** Normalises `gh pr checks --json name,bucket` rows. */
export function parseGhChecks(raw: unknown): CheckSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    const r = row as { name?: unknown; bucket?: unknown; state?: unknown };
    if (typeof r?.name !== "string") return [];
    const bucket = String(r.bucket ?? r.state ?? "").toLowerCase();
    const state: CheckState = bucket === "pass" || bucket === "success" ? "passing" : bucket === "fail" || bucket === "failure" || bucket === "cancel" ? "failing" : bucket === "skipping" || bucket === "skipped" ? "skipped" : "pending";
    return [{ name: r.name, state }];
  });
}
