// Slice routing: which reviewer roles own a slice, and how deep it is read.
//
// Before this, every role in the round owned every slice unless one of five path gates ruled it out, so a large diff
// cost roles x waves dispatches whatever the slices held. Here each slice gets the roles its content needs (a test slice
// gets the testing reviewer, a stylesheet the layout and style reviewers, a slice that spawns processes the security
// reviewer, ...), `review-logic` on every slice, and a depth:
//
// - deep: the full core set reads it, when a deterministic risk class hits (auth, crypto, migrations, schema), the
//   slice's symbol reach is high, or an injected Jev risk score is >= 0.7;
// - light: only its content roles read it.
//
// A deterministic 10-15% sample of light slices (hash of head SHA + slice id) runs deep anyway, marked `audit`, so the
// light routing is measured against a deep read of the same text. Nothing here calls a model: the facts come from the
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
const ENTRY_FILE = /(^|\/)(index|mod|main)\.[cm]?[jt]sx?$/;

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
};

export type SliceRouting = { roles: string[]; depth: SliceDepth; risk: { score: number; why: string[] }; audit?: boolean };

const changedLinesOf = (text: string): string => text.split("\n").filter((line) => line.startsWith("+") || line.startsWith("-")).join("\n");

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
  if (deep) for (const role of DEEP_ROLES) roles.add(role);
  return { roles: [...roles].sort(), depth: deep ? "deep" : "light", risk: { score: Number(score.toFixed(2)), why } };
}

const auditKey = (head: string, id: string): string => createHash("sha256").update(`${head}\0${id}`).digest("hex");

/** The light slices sampled to run deep: round(n x rate) of them, the lowest hashes of head + id. Same head, same picks. */
export function auditSample(head: string, lightIds: readonly string[], rate: number = AUDIT_RATE): Set<string> {
  const count = Math.round(lightIds.length * rate);
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
