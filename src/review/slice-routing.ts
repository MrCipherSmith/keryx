// Slice routing: which reviewer roles own a slice, and how deep it is read.
//
// Before this, every role in the round owned every slice unless one of five path gates ruled it out, so a large diff
// cost roles x waves dispatches whatever the slices held. Here each slice gets the roles its content needs (a test slice
// gets the testing reviewer, a stylesheet the layout and style reviewers, a slice that spawns processes the security
// reviewer, ...), `review-logic` on every slice, and a depth:
//
// - deep: every role of the roster its path gates allow reads it (the old plan's full set for the slice), when it
//   holds any non-test source code, agent instructions (skills, rules, AGENTS/CLAUDE files, prompts) or a
//   contract/schema; also on a deterministic risk class, a high symbol reach, or an injected Jev risk score >= 0.7.
//   Live evaluation showed that a risk-score gate left every defect in a light slice;
// - light: only when every file is docs, tests, config/data or generated; logic and its content roles read it.
//
// A deterministic sample of light slices (hash of head SHA + slice id) runs deep anyway with the core set, marked
// `audit`, so the light routing is measured against a deep read of the same text: none below 4 light slices,
// otherwise ceil(n x rate) clamped to [ceil(10% n), floor(15% n)] and at least one. Nothing here calls a model: the facts come from the
// changed lines and paths (`computeHunkRiskFacts`, the bundled path gates, content patterns below).

import { createHash } from "node:crypto";
import { BUNDLED_PATH_GATES } from "./coverage";
import { CORE_MANDATORY_REVIEWER_IDS } from "./jev-select";
import { computeHunkRiskFacts, isTestFilePath, type RiskPathClass } from "./jev-risk";
import type { ScopedRegion } from "./scope";
import { type SliceDepth, type SliceEntry, parseScopedDiff } from "./slice";

/** On every slice: one reviewer reads every changed line for correctness. */
export const ALWAYS_ROLE = "review-logic";
export const REGRESSION_ROLE = "review-regression";
/**
 * The generic degradation reviewer (flow 479): profile `full`. A new deep slice (round 1, or a new slice of a delta round)
 * gets it with the rest of the deep roster ({@link deepRosterRoles}); a delta round's fix slice gets it when it changes a
 * source-code file ({@link changesSharedCodeCandidate}), because its lines cannot tell whether they sit inside an exported symbol.
 */
export const DEGRADATION_ROLE = "review-degradation";
/** A deep slice is read by the core set the round would never skip (jev-select's mandatory ids), plus the regression reviewer. */
export const DEEP_ROLES: readonly string[] = [...CORE_MANDATORY_REVIEWER_IDS, REGRESSION_ROLE];
/** Risk classes of `computeHunkRiskFacts` that send a slice deep. `public API`, `config`, `IO` and `concurrency` fire on most code, so they only raise the score. */
export const DEEP_RISK_CLASSES: readonly RiskPathClass[] = ["auth/permissions", "crypto", "migrations", "schema"];
/** A slice whose files reach more than this many dependents (symbol reach, injected) goes deep. */
export const DEFAULT_REACH_THRESHOLD = 25;
/** An injected Jev risk score at or above this sends a slice deep, the same threshold `review jev-risk` uses. */
export const JEV_DEEP_THRESHOLD = 0.7;
/** Share of light slices sampled to run deep (between 10% and 15%). */
export const AUDIT_RATE = 0.125;

type RoleRule = {
  role: string;
  why: string;
  /** Matches the changed file's path. */
  path?: (file: string) => boolean;
  /** Matches the region's changed (+/-) lines. */
  content?: RegExp;
  /** Content counts only on a code file that is not a test (a test mentioning `token` is not a security change). */
  codeOnly?: boolean;
};

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|sh)$/i;
const DOC_FILE = /(\.(md|mdx|rst|txt|adoc)$|(^|\/)docs?\/)/i;
const STYLE_FILE = /(\.(css|scss|sass|less|styl)$|(^|\/)(styles?|themes?)(\/|\.)|\.(styles?|theme)\.[jt]sx?$)/i;
const FRONTEND_FILE = /(\.(tsx|jsx|vue|svelte|html|css|scss|sass|less)$|\.store\.ts$|\.stories\.[jt]sx?$)/i;
const CONFIG_FILE = /((^|\/)(package\.json|tsconfig[^/]*\.json|bunfig\.toml|[^/]+\.config\.[cm]?[jt]s|\.[^/]+rc(\.[a-z]+)?)$|\.(ya?ml|toml)$)/i;
const BACKEND_DIR = /(^|\/)src\/(api|services|controllers|modules|server|routes)\//;
const DATA_FILE = /(\.sql$|(^|\/)prisma\/schema\.prisma$|(^|\/)migrations?\/)/;
/** Files an agent reads as instructions: skills, rules, AGENTS/CLAUDE/GEMINI files, prompt templates. */
const AGENT_INSTRUCTION_FILE = /((^|\/)SKILL(\.detail)?\.md$|(^|\/)rules\/.+\.mdc?$|(^|\/)(AGENTS|CLAUDE|GEMINI)(\.[^/]+)?\.md$|(^|\/)prompts?\/|[-_.]prompt[-_.][^/]*$|\.prompt\.(md|txt)$)/i;
/** Contracts and schemas: what other code or agents rely on the shape of. */
const CONTRACT_FILE = /(\.schema\.json$|(^|\/)(contracts?|schemas?)\/|(^|\/)[\w-]*contract[\w-]*\.[cm]?[jt]s$|\.d\.ts$|(^|\/)types\.[cm]?ts$|\.proto$|(^|\/)openapi[^/]*\.(ya?ml|json)$)/i;
/**
 * Changed lines that spawn a process or build its argv or shell string, invoke git, derive a filesystem path from
 * input, read the environment, or talk to the network.
 */
const SECURITY_PRINCIPLE = new RegExp([
  String.raw`\b(git|gh|sh|bash|run|exec)\w*\s*\(\s*\w*\s*,?\s*\[`, // runner(cwd, ["diff", ...]) shaped argv calls
  String.raw`\bgit\w*\(`,
  String.raw`["'\x60](git|gh|sh|bash|zsh|npm|npx|bun|node|curl|wget|ssh|docker|rg|grep)["'\x60]\s*,`,
  String.raw`\bargv\b|process\.argv|--end-of-options|\b(shell|command)(Line|String|Args?)\b|\bsh\s+-c\b|\bquote\w*\(|\bshellEscape|\brevision\w*\(`,
  String.raw`\bpath\.(resolve|join|normalize|relative)\([^)\n]*\b(args?|input|options?|opts|flags?|value|user\w*|params?|query|ref|name|target|from|to|dir|file\w*|request)\b`,
  String.raw`\b(readFile|readdir|stat|lstat|open|createReadStream|createWriteStream|mkdir|copyFile|rename)\w*\(`,
  String.raw`process\.env|\bBun\.env\b|\benv\[`,
  String.raw`\bfetch\(|\bhttps?\.(get|request)|\bnet\.|\bWebSocket\b|\bsocket\b|new URL\(`,
].join("|"));

/** Programming-language source (including shell and SQL), not data or markup. */
const SOURCE_CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|kts|swift|rb|php|cs|c|cc|cpp|cxx|h|hh|hpp|m|mm|scala|lua|dart|ex|exs|sh|bash|zsh|sql|vue|svelte)$/i;
/** Fixtures and snapshots count as tests: they are test data, not product code. */
const FIXTURE_FILE = /((^|\/)(__tests__|__snapshots__|__fixtures__|fixtures?|testdata|test-data)\/|\.snap$)/i;
/** Generated or vendored output. */
const GENERATED_FILE = /((^|\/)(dist|build|out|vendor|node_modules|generated|__generated__)\/|\.(min\.(js|css)|generated\.\w+|lock|lockb)$|(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml)$)/i;

/** What makes a file force a deep read, or undefined when it is docs, tests, config/data or generated. */
export function deepReasonOfFile(file: string): string | undefined {
  if (isTestFilePath(file) || FIXTURE_FILE.test(file) || GENERATED_FILE.test(file)) return undefined;
  if (AGENT_INSTRUCTION_FILE.test(file)) return "agent instructions";
  if (CONTRACT_FILE.test(file)) return "schema";
  if (SOURCE_CODE_FILE.test(file)) return "source code";
  return undefined;
}

/**
 * A changed line that adds, removes or edits an exported symbol, a re-export or a default export. It matches the
 * declaration line only, so it routes a round-1 light slice; a delta round's fix slice is routed by
 * {@link changesSharedCodeCandidate} instead, which also covers a body-only edit of an exported function.
 */
const SHARED_SYMBOL_CHANGE = /^[+-]\s*export\s+(\*|\{|default\b|declare\b|abstract\b|(async\s+)?(function|class|interface|type|const|let|var|enum)\b)/m;

const ENTRY_FILE =/(^|\/)(index|mod|main)\.[cm]?[jt]sx?$/;

/**
 * Role rules. Every role here is a bundled reviewer id (`src/gdskills/bundled/skills/review/`); `review-logic` is not
 * listed because it is on every slice, and the core set is added by depth.
 */
const ROLE_RULES: readonly RoleRule[] = [
  { role: "review-testing-practices", why: "test file", path: (f) => isTestFilePath(f) || BUNDLED_PATH_GATES["review-testing-practices"]!(f) || /\.stories\.[jt]sx?$/.test(f) },
  { role: "review-frontend", why: "frontend file", path: (f) => FRONTEND_FILE.test(f) },
  { role: "review-frontend", why: "React/MobX code", content: /\b(useState|useEffect|useMemo|useCallback|observer\(|makeAutoObservable|makeObservable|runInAction|React\.)/, codeOnly: true },
  { role: "review-frontend-conventions", why: "frontend file", path: (f) => FRONTEND_FILE.test(f) && !isTestFilePath(f) },
  { role: "review-layout", why: "stylesheet or theme", path: (f) => STYLE_FILE.test(f) },
  { role: "review-layout", why: "markup or styling in a component", path: (f) => /\.(tsx|jsx|vue|svelte)$/.test(f) && !isTestFilePath(f), content: /\b(className|style=|styled\.|css`|sx=|theme\.|padding|margin|flex|grid|z-index|width|height)\b/ },
  { role: "review-style", why: "documentation", path: (f) => DOC_FILE.test(f) },
  { role: "review-style", why: "stylesheet or theme", path: (f) => STYLE_FILE.test(f) },
  { role: "review-clean-code", why: "new functions or classes", content: /^\+\s*(export\s+)?(default\s+)?(async\s+)?(function\s+\w|class\s+\w|(const|let)\s+\w+\s*=\s*(async\s*)?\([^)]*\)\s*(:\s*[^=]+)?=>)/m, codeOnly: true },
  { role: "review-architecture", why: "imports or exports changed", content: /^[+-]\s*(import\b.*\bfrom\b|export\s+(\*|\{)|export\s+(default\s+)?(async\s+)?(function|class|interface|type|const|enum)\b)/m, codeOnly: true },
  { role: "review-architecture", why: "entry point or project config", path: (f) => ENTRY_FILE.test(f) || CONFIG_FILE.test(f) },
  // Agent instructions are the program an agent runs: a changed skill, rule, AGENTS/CLAUDE file or prompt changes behaviour.
  { role: "review-architecture", why: "agent instructions (skill, rule, AGENTS/CLAUDE file, prompt)", path: (f) => AGENT_INSTRUCTION_FILE.test(f) },
  { role: "review-architecture", why: "contract or schema", path: (f) => CONTRACT_FILE.test(f) },
  { role: "review-architecture", why: "exported signature or contract type changed", content: /^[+-]\s*export\s+(declare\s+)?(type|interface|abstract\s+class|enum)\b|^[+-]\s*export\s+(async\s+)?function\s+\w+\s*[<(]/m },
  // Flow 479: a changed exported symbol has consumers whose assumptions the change may move. A light slice gets the
  // degradation reviewer only through this rule; a deep slice also gets it from deepRosterRoles, and a delta round's fix
  // slice from changesSharedCodeCandidate (which also covers a body-only edit).
  { role: DEGRADATION_ROLE, why: "shared (exported) symbol changed", content: SHARED_SYMBOL_CHANGE, codeOnly: true },
  // Process and argv construction, git invocations, input-derived paths, env, network: where injection and traversal live.
  { role: "review-security-code", why: "process, argv, git, input-derived path, env or network", content: SECURITY_PRINCIPLE, codeOnly: true },
  { role: "review-security-code", why: "process, filesystem write or trust-sensitive code", content: /\b(exec|execSync|execFile|spawn|spawnSync|Bun\.spawn|child_process|eval|new Function|innerHTML|dangerouslySetInnerHTML|password|passwd|secret|token|credential|api[_-]?key|sanitiz\w*|escape\w*|redact\w*|untrusted|trust\w*|permission\w*|allow-?list|deny-?list|sandbox\w*|cookie|cors|csrf|jwt|writeFile\w*|rm|unlink|rmdir|chmod|symlink\w*|realpath)\b/i, codeOnly: true },
  { role: "review-security-code", why: "auth, crypto or secret path", path: (f) => /\b(auth|login|session|permission|acl|rbac|credential|crypto|cipher|secret|security|trust|sandbox)\w*/i.test(f) && !isTestFilePath(f) && !DOC_FILE.test(f) },
  { role: "review-performance", why: "synchronous IO, timers, caching or hot loops", content: /\b(readFileSync|writeFileSync|statSync|existsSync|execSync|spawnSync|setInterval|setTimeout|requestAnimationFrame|useEffect|useMemo|cache\w*|memo\w*|debounce|throttle|for await|while\s*\(|\.sort\(|new RegExp)/, codeOnly: true },
  { role: "review-highload", why: "concurrency, queues or retries", content: /\b(Promise\.(all|race|allSettled|any)|mutex|semaphore|lock\w*|queue\w*|concurren\w*|worker\w*|retry|retries|backoff|pool|rate.?limit|throttle|stream\w*|batch\w*|AbortController)\b/i, codeOnly: true },
  { role: "review-backend", why: "backend or data path", path: (f) => BACKEND_DIR.test(f) || DATA_FILE.test(f) },
  { role: "review-backend", why: "endpoint, ORM or SQL", content: /\b(@(Get|Post|Put|Patch|Delete|Controller|Injectable)\b|router\.(get|post|put|patch|delete)|app\.(get|post|put|patch|delete)\(|prisma\.|knex|SELECT\s+\S|INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM)/, codeOnly: true },
  { role: "review-core-boundaries", why: "core/shared module", path: (f) => BUNDLED_PATH_GATES["review-core-boundaries"]!(f) },
  { role: "review-flow-graph", why: "flow/graph module", path: (f) => BUNDLED_PATH_GATES["review-flow-graph"]!(f) },
];

/**
 * Roles slice routing decides for. A reviewer outside this set (a project reviewer, `review-pr-contract`) keeps the
 * old ownership: every slice its path gate matches.
 */
export const ROUTABLE_ROLES: ReadonlySet<string> = new Set([ALWAYS_ROLE, ...DEEP_ROLES, ...ROLE_RULES.map((rule) => rule.role)]);

/**
 * The roles a deep slice gets: every routable role whose bundled path gate (when it has one) matches a file of the
 * slice — the old plan's full set for that slice (style, clean-code, performance, highload, testing-practices, ...
 * where their gates allow), not only the core set. Only the round's own roles are dispatched (`estimateRound`,
 * `requiredSlices` count the roster's roles), so listing a role the round does not run costs nothing.
 */
export function deepRosterRoles(files: readonly string[]): string[] {
  return [...ROUTABLE_ROLES].filter((role) => {
    const gate = BUNDLED_PATH_GATES[role];
    return gate === undefined || files.some((file) => gate(file));
  });
}

/**
 * Overlap groups of the bundled reviewers (flow 458 AC6): members read the same lines, so a slice gets ONE of them, the
 * first listed that its content routes. Ranked most specific first, the order `overlapGroupsOf` derives from the
 * reviewers' `metadata.overlap_group` / `overlap_rank` frontmatter; `slice-routing.test.ts` pins this constant to that
 * frontmatter so the two cannot drift. A constant rather than a read, because routing is pure and both the router
 * (`keryx review slice`) and the narrowing check (`routing-check.ts`) must collapse the same way.
 *
 * `frontend`: review-frontend is kept over review-frontend-conventions. Its rubric is the broader one — React component
 * correctness, the full MobX store checklist and TypeScript safety, consolidated from code-style-review and
 * code-mobx-store-review — while the conventions reviewer restates whatever a repository's CLAUDE.md says about the same
 * code, which a project overlay states more precisely when the project has one.
 */
export const BUNDLED_OVERLAP_GROUPS: Readonly<Record<string, readonly string[]>> = {
  frontend: ["review-frontend", "review-frontend-conventions"],
};

/** Keep one member of each overlap group: the first-ranked one present in `roles`. */
export function collapseOverlapGroups(roles: Iterable<string>, groups: Readonly<Record<string, readonly string[]>> = BUNDLED_OVERLAP_GROUPS): string[] {
  const kept = new Set(roles);
  for (const members of Object.values(groups)) {
    const winner = members.find((member) => kept.has(member));
    if (winner === undefined) continue;
    for (const member of members) if (member !== winner) kept.delete(member);
  }
  return [...kept];
}

/** Routable roles that still run with no slice routed to them: the regression reviewer reads scope B (blast-radius chunks), not only slices. */
export const ROLES_RUN_WITHOUT_SLICES: ReadonlySet<string> = new Set([REGRESSION_ROLE]);

export function isRoutedManifest(manifest: { slices: readonly SliceEntry[] }): boolean {
  return manifest.slices.some((slice) => slice.retryOf === undefined && Array.isArray(slice.roles));
}

export type RoutingOptions = {
  /** The head SHA the round reviews: seeds the audit sample, so the same head picks the same slices. */
  head: string;
  /** Changed file -> how many files its changed symbols reach (symbol reach). Absent: reach does not decide depth. */
  reach?: Readonly<Record<string, number>> | undefined;
  reachThreshold?: number | undefined;
  /** Slice id or changed file -> Jev risk probability 0..1. Absent: Jev does not decide depth. */
  jevScores?: Readonly<Record<string, number>> | undefined;
  /** Every changed file of the diff, for the nearby-test fact. Defaults to the files of the slices routed. */
  changedFiles?: readonly string[] | undefined;
  auditRate?: number | undefined;
  /** Overlap groups to collapse per slice; defaults to {@link BUNDLED_OVERLAP_GROUPS}. */
  overlapGroups?: Readonly<Record<string, readonly string[]>> | undefined;
};

export type SliceRouting = { roles: string[]; depth: SliceDepth; risk: { score: number; why: string[] }; audit?: boolean };

const changedLinesOf = (text: string): string => text.split("\n").filter((line) => line.startsWith("+") || line.startsWith("-")).join("\n");

/**
 * Whether a region changes product source code (not a test, a document or data). A fix slice holds only the lines of its
 * fix hunks, so it cannot tell whether they sit inside an exported function; any such change is a candidate for a
 * shared-symbol change, and the `review blast-radius --degradation` payload (empty for a file-private edit) settles it.
 */
export function changesSharedCodeCandidate(region: Pick<ScopedRegion, "path">): boolean {
  return deepReasonOfFile(region.path) === "source code";
}

/** Content roles of one region: the rules whose path or changed-line pattern matches, with the reason. */
export function contentRolesOf(region: Pick<ScopedRegion, "path" | "text">): Array<{ role: string; why: string }> {
  const changed = changedLinesOf(region.text);
  const code = CODE_FILE.test(region.path) && !isTestFilePath(region.path) && !DOC_FILE.test(region.path);
  const hits: Array<{ role: string; why: string }> = [];
  for (const rule of ROLE_RULES) {
    if (rule.codeOnly === true && !code) continue;
    if (rule.path !== undefined && !rule.path(region.path)) continue;
    if (rule.content !== undefined && !rule.content.test(changed)) continue;
    hits.push({ role: rule.role, why: `${rule.why}: ${region.path}` });
  }
  return hits;
}

/** The roles and risk of one slice, before the audit sample. `regions` are the slice's own scoped regions. */
export function routeSliceRegions(id: string, regions: readonly ScopedRegion[], options: Omit<RoutingOptions, "head" | "auditRate">): SliceRouting {
  const roles = new Set<string>([ALWAYS_ROLE]);
  const why: string[] = [];
  const changedFiles = options.changedFiles ?? [...new Set(regions.map((region) => region.path))];
  let score = 0;
  let deep = false;
  for (const region of regions) {
    for (const hit of contentRolesOf(region)) roles.add(hit.role);
    if (DOC_FILE.test(region.path) || isTestFilePath(region.path)) continue;
    const facts = computeHunkRiskFacts(region, changedFiles);
    const deepClass = facts.pathClasses.find((cls) => DEEP_RISK_CLASSES.includes(cls));
    if (deepClass !== undefined) {
      deep = true;
      score = Math.max(score, 0.9);
      why.push(`risk class ${deepClass}: ${region.path}`);
    } else if (facts.pathClasses.length > 0) {
      score = Math.max(score, Math.min(0.5, 0.15 * facts.pathClasses.length));
    }
  }
  const kinds = new Map<string, string[]>();
  for (const file of new Set(regions.map((region) => region.path))) {
    const reason = deepReasonOfFile(file);
    if (reason !== undefined) kinds.set(reason, [...(kinds.get(reason) ?? []), file]);
  }
  if (kinds.size > 0) {
    deep = true;
    score = Math.max(score, 0.5);
    for (const [reason, kindFiles] of kinds) why.push(`${reason}: ${kindFiles.slice(0, 3).join(", ")}${kindFiles.length > 3 ? ` (+${kindFiles.length - 3})` : ""}`);
  } else if (regions.length > 0 && !deep) {
    why.push("docs, tests, config or generated files only");
  }
  const threshold = options.reachThreshold ?? DEFAULT_REACH_THRESHOLD;
  const files = [...new Set(regions.map((region) => region.path))];
  if (options.reach !== undefined) {
    const widest = files.reduce<{ file?: string; count: number }>((best, file) => {
      const count = options.reach![file];
      return typeof count === "number" && Number.isFinite(count) && count > best.count ? { file, count } : best;
    }, { count: 0 });
    if (widest.file !== undefined && widest.count > threshold) {
      deep = true;
      score = Math.max(score, 0.8);
      why.push(`reach ${widest.count} > ${threshold}: ${widest.file}`);
    }
  }
  if (options.jevScores !== undefined) {
    const scores = [id, ...files].map((key) => options.jevScores![key]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const jev = scores.length === 0 ? undefined : Math.max(...scores);
    if (jev !== undefined) {
      score = Math.max(score, Math.min(1, Math.max(0, jev)));
      if (jev >= JEV_DEEP_THRESHOLD) {
        deep = true;
        why.push(`Jev risk ${jev.toFixed(2)} >= ${JEV_DEEP_THRESHOLD}`);
      }
    }
  }
  if (deep) for (const role of deepRosterRoles(files)) roles.add(role);
  return { roles: collapseOverlapGroups(roles, options.overlapGroups).sort(), depth: deep ? "deep" : "light", risk: { score: Number(score.toFixed(2)), why } };
}

const auditKey = (head: string, id: string): string => createHash("sha256").update(`${head}\0${id}`).digest("hex");

/** Light slices below this count get no audit sample: one of three would be a third of them, far over 15%. */
export const AUDIT_MIN_LIGHT = 4;

/**
 * How many of `n` light slices the audit samples. None below {@link AUDIT_MIN_LIGHT} or at a rate of 0; otherwise
 * ceil(n x rate) clamped to [ceil(10% n), floor(15% n)] — the 15% cap wins when no whole count lies in the band
 * (n = 11-13: one, just under 10%) — and at least one (for 4-6 light slices the one sampled is 17-25%:
 * the floor of one wins over the cap, so a small light set is still measured).
 */
export function auditCount(n: number, rate: number = AUDIT_RATE): number {
  if (n < AUDIT_MIN_LIGHT || !(rate > 0)) return 0;
  const low = Math.ceil(n * 0.1);
  const high = Math.floor(n * 0.15);
  return Math.max(1, Math.min(high, Math.max(low, Math.ceil(n * rate))));
}

/** The light slices sampled to run deep: {@link auditCount} of them, the lowest hashes of head + id. Same head, same picks. */
export function auditSample(head: string, lightIds: readonly string[], rate: number = AUDIT_RATE): Set<string> {
  const count = auditCount(lightIds.length, rate);
  return new Set([...lightIds].sort((a, b) => auditKey(head, a).localeCompare(auditKey(head, b))).slice(0, count));
}

/**
 * Route slices that carry their text (what `buildSlices` returns). Original slices only; a retry piece keeps whatever
 * it was given. Every slice ends with at least `review-logic`.
 */
export function routeSlices<T extends SliceEntry & { text: string }>(slices: readonly T[], options: RoutingOptions): T[] {
  const regionsOf = new Map(slices.map((slice) => [slice.id, parseScopedDiff(slice.text)]));
  const changedFiles = options.changedFiles ?? [...new Set(slices.flatMap((slice) => slice.files))];
  const routed = slices.map((slice) => (slice.retryOf !== undefined ? slice : { ...slice, ...routeSliceRegions(slice.id, regionsOf.get(slice.id) ?? [], { ...options, changedFiles }) }));
  const audited = auditSample(options.head, routed.filter((slice) => slice.retryOf === undefined && slice.depth === "light").map((slice) => slice.id), options.auditRate);
  return routed.map((slice) => {
    if (!audited.has(slice.id)) return slice;
    return { ...slice, depth: "deep" as const, audit: true, roles: [...new Set([...(slice.roles ?? []), ...DEEP_ROLES])].sort(), risk: { score: slice.risk?.score ?? 0, why: [...(slice.risk?.why ?? []), "audit sample: a light slice read deep to measure light routing"] } };
  });
}

/** Re-open a light slice deep: every core role joins it. Returns the slice unchanged when it is deep already. */
export function escalateSlice(slice: SliceEntry, by: string, finding: string): SliceEntry {
  if (slice.depth !== "light") return slice;
  return { ...slice, depth: "deep", roles: [...new Set([...(slice.roles ?? [ALWAYS_ROLE]), ...DEEP_ROLES])].sort(), escalated: { by, finding } };
}

export type RoutingSummary = { slices: number; deep: number; light: number; audit: number; byRole: Record<string, number> };

export function summarizeRouting(slices: readonly SliceEntry[]): RoutingSummary {
  const originals = slices.filter((slice) => slice.retryOf === undefined);
  const byRole: Record<string, number> = {};
  for (const slice of originals) for (const role of slice.roles ?? []) byRole[role] = (byRole[role] ?? 0) + 1;
  return {
    slices: originals.length,
    deep: originals.filter((slice) => slice.depth === "deep").length,
    light: originals.filter((slice) => slice.depth === "light").length,
    audit: originals.filter((slice) => slice.audit === true).length,
    byRole,
  };
}

export function renderRoutingSummary(summary: RoutingSummary): string {
  const roles = Object.entries(summary.byRole).sort(([a], [b]) => a.localeCompare(b)).map(([role, count]) => `${role} ${count}`).join(", ");
  return `routing: ${summary.deep} deep (${summary.audit} audit), ${summary.light} light of ${summary.slices} slice(s); slices per role: ${roles || "none"}`;
}
