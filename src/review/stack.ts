/**
 * Deterministic stack detection — scopes stack-specific reviewers by what the
 * repository actually depends on (flow 203, AC13, roadmap §3.2).
 *
 * ~440 checklist items across the reviewer set target NestJS, React, MobX and
 * Prisma. A repository that depends on none of them still runs every one of
 * those reviewers on every review, and every run finds nothing to say — keryx
 * itself is the worked example: a zero-dependency Bun CLI running fourteen
 * checklists written for a stack it does not have. This module reads
 * `package.json` once, deterministically, and answers a yes/no per stack tag —
 * no model call, and nothing here asks one.
 *
 * # The one rule this module will not break
 *
 * **Uncertain always means included.** A reviewer that runs needlessly costs
 * tokens; a reviewer wrongly skipped hides a real defect its checklist would
 * have caught, and that asymmetry is why every failure mode below resolves to
 * "keep it": a missing `package.json`, one that fails to parse, one that is not
 * a JSON object, one that declares **no dependencies at all**, or one that
 * declares **workspaces** — each sets `uncertain: true`, and `uncertain` forces
 * every tag `true` regardless of what was or was not found. The only way a tag
 * comes back `false` is a `package.json` that parsed cleanly, declared
 * dependencies, and plainly does not name the one in question.
 *
 * The last two are the ones a "clean parse means certain" rule got wrong, and
 * they are the common shape rather than the exotic one. A monorepo workspace
 * root parses perfectly and names `typescript` and `eslint`; `react` lives in
 * `packages/web`. Reading that root as "this repository does not use React"
 * excluded `review-frontend`, `review-frontend-conventions`, `review-backend`
 * and `code-mobx-store-review` from a React monorepo — the exact inversion of
 * the direction AC13 requires. A manifest declaring nothing has told you
 * nothing, and "nothing" is not "no".
 *
 * Walking the workspace globs would give a real answer, and is deliberately not
 * done here: it needs directory traversal, which turns a single deterministic
 * read into an unbounded filesystem walk whose failure modes (a glob that
 * matches nothing, a sub-package with no manifest, a symlinked package outside
 * the tree) each need their own answer — and every wrong answer among them costs
 * a skipped reviewer. Being uncertain about a monorepo root is cheap and honest;
 * the reason names the globs so an operator can point the detector at a
 * sub-package instead.
 *
 * # What this module does NOT do
 *
 * It does not decide which reviewers run — it answers "would this declared
 * requirement be satisfied here", per reviewer, with a reason. Wiring that
 * answer into `review-orchestrator`'s dispatch decision is a follow-up: the
 * routing table itself is prose in a skill body outside this module's reach.
 */

export const STACK_TAGS = ["nestjs", "react", "mobx", "prisma"] as const;
export type StackTag = (typeof STACK_TAGS)[number];

function isStackTag(value: string): value is StackTag {
  return (STACK_TAGS as readonly string[]).includes(value);
}

export type DetectedStack = {
  /** Present per tag. All `true` when `uncertain`. */
  tags: Record<StackTag, boolean>;
  /** `package.json` could not be read/parsed, or was not a JSON object. */
  uncertain: boolean;
  /** Always present — either how detection succeeded, or why it could not run. */
  reason: string;
  /** Declared dependency names that matched a tag marker. Empty when uncertain. */
  matched: string[];
};

/** Exact dependency names that indicate a tag, checked against the declared name set. `nestjs` is matched separately by `@nestjs/` prefix — no single package name identifies it. */
const TAG_MARKERS: Record<Exclude<StackTag, "nestjs">, readonly string[]> = {
  react: ["react", "react-dom"],
  mobx: ["mobx", "mobx-react", "mobx-react-lite"],
  prisma: ["prisma", "@prisma/client"],
};

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

export type DetectStackOptions = {
  /** Injectable for tests; defaults to reading the real filesystem via Bun. */
  readFile?: ((path: string) => Promise<string>) | undefined;
};

/**
 * Read `<cwd>/package.json` and report which stack tags it declares.
 *
 * Deterministic and side-effect-free beyond the one read: same manifest, same
 * answer, every time. See the module doc for why every failure path resolves
 * to `uncertain: true` (which forces every tag `true`) rather than to `false`.
 */
export async function detectProjectStack(cwd: string, options: DetectStackOptions = {}): Promise<DetectedStack> {
  const readFile = options.readFile ?? defaultReadFile;
  const manifestPath = `${cwd.replace(/\/+$/, "")}/package.json`;

  let raw: string;
  try {
    raw = await readFile(manifestPath);
  } catch {
    return uncertainStack(`package.json not found at ${manifestPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return uncertainStack(
      `package.json at ${manifestPath} did not parse as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return uncertainStack(`package.json at ${manifestPath} is not a JSON object`);
  }

  const record = parsed as Record<string, unknown>;
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const value = record[field];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const name of Object.keys(value as Record<string, unknown>)) {
        names.add(name);
      }
    }
  }

  // A manifest that parses is not a manifest that TOLD you something. Both
  // checks below reached `uncertain: false` before, and both then excluded every
  // stack-gated reviewer from repositories that plainly use the stack.
  const workspaceGlobs = workspacePatterns(record);
  if (workspaceGlobs.length > 0) {
    return uncertainStack(
      `package.json at ${manifestPath} declares workspaces (${workspaceGlobs.join(
        ", ",
      )}); the dependencies that decide the stack live in the sub-packages, which this module does not walk`,
    );
  }
  if (names.size === 0) {
    return uncertainStack(
      `package.json at ${manifestPath} declares no dependencies in ${DEPENDENCY_FIELDS.join(
        "/",
      )} — a manifest that declares nothing has not said the repository uses nothing`,
    );
  }

  const matched: string[] = [];
  const nestjsMatches = [...names].filter((name) => name.startsWith("@nestjs/")).sort();
  matched.push(...nestjsMatches);

  const tags = { nestjs: nestjsMatches.length > 0 } as Record<StackTag, boolean>;
  for (const tag of Object.keys(TAG_MARKERS) as Array<Exclude<StackTag, "nestjs">>) {
    const hit = TAG_MARKERS[tag].filter((marker) => names.has(marker));
    tags[tag] = hit.length > 0;
    matched.push(...hit);
  }

  return {
    tags,
    uncertain: false,
    reason: `detected from ${manifestPath} (${names.size} declared dependenc${names.size === 1 ? "y" : "ies"})`,
    matched,
  };
}

/**
 * The workspace globs a root manifest declares, in either accepted form.
 *
 * `"workspaces": ["packages/*"]` is the yarn/bun/pnpm-compatible array; npm also
 * accepts `{"packages": [...]}`. An EMPTY list is not a workspace root: it
 * enumerates no sub-package, so there is nothing unread and nothing to be
 * uncertain about.
 */
function workspacePatterns(record: Record<string, unknown>): string[] {
  const declared = record["workspaces"];
  const list = Array.isArray(declared)
    ? declared
    : typeof declared === "object" && declared !== null
      ? (declared as Record<string, unknown>)["packages"]
      : undefined;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string" && item !== "") : [];
}

function uncertainStack(reason: string): DetectedStack {
  const tags = Object.fromEntries(STACK_TAGS.map((tag) => [tag, true])) as Record<StackTag, boolean>;
  return { tags, uncertain: true, reason, matched: [] };
}

async function defaultReadFile(path: string): Promise<string> {
  return await Bun.file(path).text();
}

/**
 * Parse a `metadata.stack_requires` frontmatter value (comma-separated tags,
 * e.g. `"nestjs,prisma"`) into known {@link StackTag}s. An unrecognised token is
 * dropped rather than thrown on: a skill declaring a tag this build does not
 * know should degrade toward "no requirement understood" (which
 * {@link scopeReviewerByStack} treats as "always include"), never toward a
 * crash that would take an unrelated reviewer down with it.
 */
export function parseStackRequires(value: string | undefined): StackTag[] {
  if (value === undefined) {
    return [];
  }
  const seen = new Set<StackTag>();
  for (const token of value.split(",")) {
    const trimmed = token.trim().toLowerCase();
    if (isStackTag(trimmed)) {
      seen.add(trimmed);
    }
  }
  return [...seen];
}

/**
 * Extract `metadata.stack_requires` from a `SKILL.md`'s YAML frontmatter.
 *
 * Forgiving by construction, matching `parseSkillFrontmatter` in
 * `metaproject-adapter.ts`: a missing frontmatter block, a missing `metadata:`
 * key, or a missing `stack_requires:` line all degrade to `undefined` (which
 * {@link parseStackRequires} turns into "no requirement declared"), never to a
 * thrown error. A reviewer with no declared requirement is a generic reviewer,
 * and generic reviewers must never accidentally become stack-gated because a
 * parse quirk swallowed their frontmatter.
 */
export function extractStackRequiresField(skillMdContent: string): string | undefined {
  if (!skillMdContent.startsWith("---")) {
    return undefined;
  }
  const end = skillMdContent.indexOf("\n---", 3);
  if (end === -1) {
    return undefined;
  }
  const lines = skillMdContent.slice(3, end).split("\n");
  let inMetadata = false;
  for (const line of lines) {
    const topMatch = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (topMatch) {
      inMetadata = topMatch[1] === "metadata";
      continue;
    }
    if (!inMetadata) {
      continue;
    }
    const fieldMatch = /^\s+stack_requires:\s*(.+)$/.exec(line);
    if (fieldMatch && fieldMatch[1] !== undefined) {
      return stripQuotes(fieldMatch[1].trim());
    }
  }
  return undefined;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export type StackScopingDecision = {
  reviewer: string;
  requires: StackTag[];
  include: boolean;
  reason: string;
};

/**
 * Decide whether one reviewer runs, given what it declared and what was
 * detected.
 *
 * Three ways this returns `include: true`, and exactly one way it returns
 * `false` — matching the module doc's asymmetry:
 *
 * 1. `requires` is empty: a generic reviewer, always included.
 * 2. `detected.uncertain`: detection could not run, so nothing is excluded.
 * 3. At least one required tag was detected present.
 * 4. (the one `false` case) Detection ran cleanly and none of the reviewer's
 *    required tags are present in `package.json`.
 */
export function scopeReviewerByStack(
  reviewer: string,
  requires: readonly StackTag[],
  detected: DetectedStack,
): StackScopingDecision {
  const requiresCopy = [...requires];
  if (requiresCopy.length === 0) {
    return { reviewer, requires: requiresCopy, include: true, reason: "no stack requirement declared — generic reviewer" };
  }
  if (detected.uncertain) {
    return {
      reviewer,
      requires: requiresCopy,
      include: true,
      reason: `stack detection uncertain (${detected.reason}); failing open`,
    };
  }
  const present = requiresCopy.filter((tag) => detected.tags[tag]);
  if (present.length > 0) {
    return { reviewer, requires: requiresCopy, include: true, reason: `detected: ${present.join(", ")}` };
  }
  return {
    reviewer,
    requires: requiresCopy,
    include: false,
    reason: `none of [${requiresCopy.join(", ")}] detected in package.json (${detected.reason})`,
  };
}

/** `## Stack scoping` — every reviewer's decision, with the reason, in the same style as `renderCapsMarkdown`. */
export function renderStackScopingMarkdown(detected: DetectedStack, decisions: readonly StackScopingDecision[]): string {
  const lines: string[] = [];
  lines.push("## Stack scoping");
  lines.push("");
  lines.push(
    detected.uncertain
      ? `stack detection: uncertain — ${detected.reason}. Every stack-gated reviewer is included; uncertain never excludes.`
      : `stack detection: ${detected.reason}`,
  );
  if (!detected.uncertain) {
    const present = STACK_TAGS.filter((tag) => detected.tags[tag]);
    lines.push(`tags present: ${present.length > 0 ? present.join(", ") : "none"}`);
    if (detected.matched.length > 0) {
      lines.push(`matched dependencies: ${detected.matched.join(", ")}`);
    }
  }
  lines.push("");
  if (decisions.length === 0) {
    lines.push("_no stack-gated reviewers were evaluated_");
    return lines.join("\n");
  }
  lines.push("| reviewer | requires | include | reason |");
  lines.push("|---|---|---|---|");
  for (const decision of decisions) {
    lines.push(
      `| ${decision.reviewer} | ${decision.requires.length > 0 ? decision.requires.join(", ") : "-"} | ${
        decision.include ? "yes" : "no"
      } | ${decision.reason} |`,
    );
  }
  const excluded = decisions.filter((decision) => !decision.include);
  lines.push("");
  lines.push(
    excluded.length === 0
      ? "No reviewer was excluded by stack scoping."
      : `Excluded (never run this round): ${excluded.map((decision) => decision.reviewer).join(", ")}.`,
  );
  return lines.join("\n");
}
