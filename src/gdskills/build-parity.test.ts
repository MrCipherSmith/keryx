import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { HARNESS_SKILL_RUNTIMES, skillBuildFileName } from "./export";

/**
 * Flow 205, widened by flow 209: build-vs-build parity.
 *
 * `job-orchestrator` ships five builds — SKILL.md, SKILL.codex.md,
 * SKILL.cursor.md, SKILL.opencode.md, SKILL.zed.md — all declaring
 * `metadata.version: "3.2.0"` and the same `compatible_harnesses`. Nothing
 * compared them, so they drifted: the four non-Claude builds were
 * byte-identical to each other and 33 lines shorter than SKILL.md.
 *
 * `round-bound.test.ts` already implements the analogous bundled-vs-mirror
 * byte-equality check. That guard runs along one axis (source vs installed
 * copy) and this one runs along the other (build vs build) — the axis that was
 * simply never checked.
 *
 * WHY THE ENROLLED SET IS NOW COMPUTED, NOT LISTED
 *
 * Flow 205 enrolled ONE skill and said so honestly ("Absence from this list is
 * a backlog entry, NOT an exemption"). The 2026-08-31 measurement then counted
 * the backlog: 37 skills ship harness builds and 36 of them diverged — and the
 * one enrolled skill was the one clean skill, so the guard's denominator and
 * the defect were disjoint sets. The worst instance it could not see was
 * `task-implementer`, whose four non-Claude builds were 162 lines short and
 * omitted the entire `## Reporting Results` section that production code parses.
 *
 * A hand-maintained frontier reproduces that failure by construction: a skill
 * that gains harness builds tomorrow is outside the guard until somebody
 * remembers to add it. So the set is taken from the filesystem — every skill
 * directory that ships at least one harness build is enforced, and enrolment is
 * automatic. What remains hand-written is the ALLOW-LIST, which is where a
 * decision belongs: each entry names a hunk that is genuinely harness-specific
 * and says why.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const SKILL_ROOTS = [
  path.join(REPO_ROOT, "src", "gdskills", "bundled", "skills"),
  path.join(REPO_ROOT, ".metaproject", "skills", "gdskills"),
];

type SkillLocation = { category: string; skill: string };

const HARNESS_BUILD_NAMES = HARNESS_SKILL_RUNTIMES.filter((runtime) => runtime !== "claude")
  .map((runtime) => skillBuildFileName(runtime))
  .sort();

/** Does this directory ship at least one harness build next to its SKILL.md? */
function shipsHarnessBuilds(dir: string): boolean {
  if (!existsSync(path.join(dir, "SKILL.md"))) return false;
  return HARNESS_BUILD_NAMES.some((name) => existsSync(path.join(dir, name)));
}

/**
 * Every `<category>/<skill>` in the bundled tree that ships harness builds.
 *
 * Taken from the bundled source only. The `.metaproject` mirror is a partial
 * copy — `round-bound.test.ts` enforces that what it does hold is byte-equal —
 * so using it as the enrolment source would make the denominator depend on
 * which skills happen to be installed here.
 */
function enrolledSkills(): SkillLocation[] {
  const root = SKILL_ROOTS[0] as string;
  const out: SkillLocation[] = [];
  for (const category of readdirSync(root, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    for (const skill of readdirSync(path.join(root, category.name), { withFileTypes: true })) {
      if (!skill.isDirectory()) continue;
      if (!shipsHarnessBuilds(path.join(root, category.name, skill.name))) continue;
      out.push({ category: category.name, skill: skill.name });
    }
  }
  return out.sort((left, right) =>
    `${left.category}/${left.skill}`.localeCompare(`${right.category}/${right.skill}`),
  );
}

const PARITY_ENFORCED_SKILLS: readonly SkillLocation[] = enrolledSkills();

/**
 * The census the 2026-08-31 measurement ran, pinned as a floor.
 *
 * Not an equality: a new skill that ships builds must raise this number without
 * anyone editing this file, and that is the point of computing the set. A DROP
 * is the failure mode worth catching — a skill whose builds are deleted, or a
 * category renamed, would silently shrink the denominator back toward the
 * one-skill frontier this flow replaced.
 */
const CENSUS_FLOOR = 37;

/**
 * A documented, harness-specific difference that a build is allowed to carry.
 *
 * The bar is high on purpose: an allowance is legitimate only when the text is
 * genuinely specific to one harness — it names a harness-only command, path,
 * tool, or capability that the other harnesses cannot honour. "This build is
 * older" is never a reason; that is drift, and drift belongs in a fix, not
 * here.
 *
 * `job-orchestrator`'s list is EMPTY, and that is a finding rather than an
 * oversight. Its three drifted hunks — the `2.8.2 SKILL LEARNING` step, its
 * `## Skill Updates` report section, and the execution-metrics opt-in — call
 * generic `keryx` commands (`keryx skills learn`) and harness-agnostic rule
 * files (`rules/core/skill-lifecycle.mdc`, `rules/core/model-selection.mdc`,
 * `.metaproject/rules/core/execution-metrics.md`). Nothing in them is
 * Claude-specific, so all five builds should carry all three.
 *
 * FLOW 209'S VERDICT ON THE OTHER 36
 *
 * All 36 diverging skills were read hunk by hunk, and the divergences were
 * classified by asking one question of each: does this text name a harness-only
 * command, path, tool, or invocation syntax? For 35 of them the answer was no in
 * every hunk — the builds were stale ancestors of their own `SKILL.md`, carrying
 * pre-extraction inline scripts (`code-*-review`), a superseded output format
 * (`issue-analyzer`'s Gherkin against `SKILL.md`'s JSON), hard-coded
 * `.metaproject/jobs` where `SKILL.md` had moved to `<JOBS_ROOT>`, a
 * seven-phase pipeline against `SKILL.md`'s eight (`feature-dev`), and
 * pre-split monolithic bodies (`feature-analyzer`). Those are drift and were
 * reconciled by writing the canonical build into every variant. The text that
 * looked harness-specific pointed the WRONG way — `.cursor/rules/core/*.mdc` in
 * a Codex build is not a Cursor accommodation, it is an old path `SKILL.md` had
 * already replaced.
 *
 * The one surviving class is below. Seven `gproject-*` subagent skills declare
 * `metadata.compatible_harnesses: "cursor,codex,zed,opencode"` in their
 * non-Claude builds. That field's entire purpose is to name harnesses
 * (`rules/core/skills-storage-workflow.mdc` defines it as the machine-readable
 * CSV of supported harnesses), and its value cannot be shared with the Claude
 * build without that build claiming compatibility with four harnesses and not
 * with the one reading it. It is the only field in this tree whose correct
 * value differs per build.
 */
type ParityAllowance = {
  /** Substring that must appear in the hunk for this allowance to cover it. */
  anchor: string;
  /** Builds permitted to differ by this hunk. */
  builds: readonly string[];
  /** Why this difference is genuinely harness-specific. */
  reason: string;
};

/**
 * The non-Claude harness family, declared by the builds that serve it.
 *
 * One shared allowance rather than seven copies: they are the same decision
 * about the same field, and a per-skill restatement would let six of them drift
 * from the seventh without anything noticing.
 */
const HARNESS_FAMILY_DECLARATION: ParityAllowance = {
  anchor: 'compatible_harnesses: "cursor,codex,zed,opencode"',
  builds: HARNESS_BUILD_NAMES,
  reason:
    "`metadata.compatible_harnesses` is the machine-readable CSV of supported harnesses (rules/core/skills-storage-workflow.mdc). These builds serve the four non-Claude harnesses and say so; SKILL.md is the Claude build and cannot carry a list that excludes Claude. The value differs per build BECAUSE the field names harnesses — it is the only such field in the tree.",
};

const BUILD_PARITY_ALLOWANCES: Record<string, readonly ParityAllowance[]> = {
  "job-orchestrator": [],
  // The seven gproject-* subagents. Named one by one rather than matched by
  // prefix: an allowance that covers a pattern covers skills nobody looked at.
  "project-discovery": [HARNESS_FAMILY_DECLARATION],
  "problem-definer": [HARNESS_FAMILY_DECLARATION],
  "patterns-researcher": [HARNESS_FAMILY_DECLARATION],
  planner: [HARNESS_FAMILY_DECLARATION],
  "consistency-checker": [HARNESS_FAMILY_DECLARATION],
  "spec-writer": [HARNESS_FAMILY_DECLARATION],
  "stack-advisor": [HARNESS_FAMILY_DECLARATION],
};

// --- diff engine -----------------------------------------------------------

type Hunk = {
  /** `missing` = in SKILL.md but not the variant. `extra` = the reverse. */
  kind: "missing" | "extra";
  /** 1-based inclusive line range in SKILL.md (start === end + 1 when empty). */
  canonicalStart: number;
  canonicalEnd: number;
  /** 1-based inclusive line range in the variant. */
  variantStart: number;
  variantEnd: number;
  lines: string[];
};

/**
 * Line-level diff via LCS, with common prefix/suffix trimmed first so the DP
 * table stays small on files that differ in a few localized places.
 */
function diffLines(canonical: string[], variant: string[]): Hunk[] {
  let prefix = 0;
  while (
    prefix < canonical.length &&
    prefix < variant.length &&
    canonical[prefix] === variant[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < canonical.length - prefix &&
    suffix < variant.length - prefix &&
    canonical[canonical.length - 1 - suffix] === variant[variant.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const a = canonical.slice(prefix, canonical.length - suffix);
  const b = variant.slice(prefix, variant.length - suffix);
  const n = a.length;
  const m = b.length;

  // dp[i][j] = LCS length of a[i..] and b[j..]
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j]
        ? (dp[(i + 1) * width + (j + 1)] as number) + 1
        : Math.max(dp[(i + 1) * width + j] as number, dp[i * width + (j + 1)] as number);
    }
  }

  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let pending: Hunk | null = null;

  const flush = (): void => {
    if (pending !== null) {
      hunks.push(pending);
      pending = null;
    }
  };

  const push = (kind: "missing" | "extra", line: string): void => {
    // Absolute 1-based positions in the untrimmed files.
    const aLine = prefix + i + 1;
    const bLine = prefix + j + 1;
    if (pending !== null && pending.kind === kind) {
      pending.lines.push(line);
      if (kind === "missing") {
        pending.canonicalEnd = aLine;
      } else {
        pending.variantEnd = bLine;
      }
      return;
    }
    flush();
    pending = {
      kind,
      canonicalStart: aLine,
      canonicalEnd: aLine,
      variantStart: bLine,
      variantEnd: bLine,
      lines: [line],
    };
  };

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush();
      i += 1;
      j += 1;
    } else if ((dp[(i + 1) * width + j] as number) >= (dp[i * width + (j + 1)] as number)) {
      push("missing", a[i] as string);
      i += 1;
    } else {
      push("extra", b[j] as string);
      j += 1;
    }
  }
  while (i < n) {
    push("missing", a[i] as string);
    i += 1;
  }
  while (j < m) {
    push("extra", b[j] as string);
    j += 1;
  }
  flush();

  return hunks;
}

// --- report ----------------------------------------------------------------

function firstMeaningfulLine(lines: string[]): string {
  const line = lines.find((candidate) => candidate.trim().length > 0) ?? "(blank lines only)";
  const trimmed = line.trim();
  return trimmed.length > 140 ? `${trimmed.slice(0, 137)}...` : trimmed;
}

function isAllowed(skill: string, hunk: Hunk, builds: string[]): boolean {
  const text = hunk.lines.join("\n");
  const allowances = BUILD_PARITY_ALLOWANCES[skill] ?? [];
  return allowances.some(
    (allowance) =>
      text.includes(allowance.anchor) &&
      builds.every((build) => allowance.builds.includes(build)),
  );
}

const MAX_HUNK_LINES = 40;

type SkillParityReport = { report: string; comparisons: number; buildsSeen: Set<string> };

/**
 * Compare every harness build of one skill directory against SKILL.md and
 * render an actionable report. Returns an empty report when the builds agree
 * (or differ only by an allowance).
 */
function checkSkillDirectory(skill: string, dir: string): SkillParityReport {
  const buildsSeen = new Set<string>();
  const canonicalPath = path.join(dir, "SKILL.md");
  if (!existsSync(canonicalPath)) {
    return { report: `${relative(dir)}: no SKILL.md — cannot compare builds.\n`, comparisons: 0, buildsSeen };
  }
  buildsSeen.add("SKILL.md");

  const canonical = readLines(canonicalPath);
  const variants = HARNESS_SKILL_RUNTIMES
    .filter((runtime) => runtime !== "claude")
    .map((runtime) => skillBuildFileName(runtime))
    .filter((name) => existsSync(path.join(dir, name)))
    .sort();

  // Group identical hunks so the four builds that all lack the same block are
  // reported once, naming all four — not four times.
  const grouped = new Map<string, { hunk: Hunk; builds: string[] }>();
  let comparisons = 0;

  for (const name of variants) {
    buildsSeen.add(name);
    comparisons += 1;
    const variant = readLines(path.join(dir, name));
    for (const hunk of diffLines(canonical, variant)) {
      const key = `${hunk.kind} ${hunk.lines.join("\n")}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.builds.push(name);
      } else {
        grouped.set(key, { hunk, builds: [name] });
      }
    }
  }

  const offenders = [...grouped.values()]
    .filter(({ hunk, builds }) => !isAllowed(skill, hunk, builds))
    .sort((left, right) => left.hunk.canonicalStart - right.hunk.canonicalStart);

  if (offenders.length === 0) {
    return { report: "", comparisons, buildsSeen };
  }

  const sizes = [`SKILL.md ${canonical.length} lines`];
  for (const name of variants) {
    sizes.push(`${name} ${readLines(path.join(dir, name)).length} lines`);
  }

  const lines: string[] = [];
  lines.push(`Root: ${relative(dir)}`);
  lines.push(`  ${sizes.join(", ")}`);
  lines.push("");

  offenders.forEach(({ hunk, builds }, index) => {
    const sorted = [...builds].sort();
    if (hunk.kind === "missing") {
      const count = hunk.canonicalEnd - hunk.canonicalStart + 1;
      lines.push(
        `  [${index + 1}] SKILL.md lines ${hunk.canonicalStart}-${hunk.canonicalEnd} (${count} line${count === 1 ? "" : "s"})`,
      );
      lines.push(`      MISSING FROM: ${sorted.join(", ")}`);
    } else {
      const count = hunk.variantEnd - hunk.variantStart + 1;
      lines.push(
        `  [${index + 1}] present ONLY in ${sorted.join(", ")} at lines ${hunk.variantStart}-${hunk.variantEnd} (${count} line${count === 1 ? "" : "s"}), absent from SKILL.md near line ${hunk.canonicalStart}`,
      );
    }
    lines.push(`      opens with: ${firstMeaningfulLine(hunk.lines)}`);
    const body = hunk.lines.slice(0, MAX_HUNK_LINES);
    for (const line of body) {
      lines.push(`      | ${line}`);
    }
    if (hunk.lines.length > MAX_HUNK_LINES) {
      lines.push(`      | ... ${hunk.lines.length - MAX_HUNK_LINES} more line(s)`);
    }
    lines.push("");
  });

  return { report: `${lines.join("\n")}\n`, comparisons, buildsSeen };
}

/**
 * Read a file as lines, dropping the empty element a trailing newline
 * produces. Reported line numbers must match what an editor shows, because the
 * whole point of the report is that someone acts on it.
 */
function readLines(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

function relative(target: string): string {
  return path.relative(REPO_ROOT, target).split(path.sep).join("/");
}

function locateSkill(location: SkillLocation): string[] {
  return SKILL_ROOTS.map((root) => path.join(root, location.category, location.skill)).filter((dir) =>
    existsSync(dir),
  );
}

// --- guards ----------------------------------------------------------------

/**
 * Non-vacuity. `readdirSync` on a missing root throws, but a mistyped
 * category would simply locate nothing and every sweep below would pass over
 * an empty set — the exact defect class this flow exists to remove.
 */
test("build-parity: the enforced sweep has a real denominator", () => {
  expect(SKILL_ROOTS.length).toBe(2);
  for (const root of SKILL_ROOTS) {
    expect(existsSync(root)).toBe(true);
    expect(readdirSync(root).length).toBeGreaterThan(0);
  }

  // The census floor. One enrolled skill is what flow 205 shipped and what the
  // measurement then showed to be disjoint from the defect; anything near that
  // number again means enrolment has stopped working.
  expect(PARITY_ENFORCED_SKILLS.length).toBeGreaterThanOrEqual(CENSUS_FLOOR);

  // Named members, so a sweep that enrolled 37 of the wrong directories fails.
  // `job-orchestrator` was the only clean skill and `task-implementer` the worst
  // offender: a denominator containing both is one that covers the range.
  const enrolled = new Set(PARITY_ENFORCED_SKILLS.map((location) => `${location.category}/${location.skill}`));
  expect(enrolled.has("orchestration/job-orchestrator")).toBe(true);
  expect(enrolled.has("orchestration/task-implementer")).toBe(true);

  for (const location of PARITY_ENFORCED_SKILLS) {
    const dirs = locateSkill(location);
    // The bundled source at minimum. The `.metaproject` mirror is a partial
    // copy of the tree, so its absence for a given skill is normal; what is not
    // normal is a location that resolves nowhere.
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      // Enrolment is by shape, so re-check the shape at the point of use: a
      // SKILL.md and at least one harness build, all with known names.
      expect(existsSync(path.join(dir, "SKILL.md"))).toBe(true);
      const builds = readdirSync(dir).filter((name) => HARNESS_BUILD_NAMES.includes(name));
      expect(builds.length).toBeGreaterThan(0);
    }
  }
});

/**
 * Every allowance states why it is one, and every allowance is USED.
 *
 * `bundled-eval.test.ts` established the first half; the second half matters
 * more here. An allowance that no longer matches any hunk is a decision that
 * has outlived its subject — usually because the text it excused was rewritten
 * — and left in place it quietly widens the permitted surface for whatever
 * lands on that anchor next.
 */
describe("build-parity: the allow-list", () => {
  test("every entry names a real skill, its builds, and its reason", () => {
    const enrolled = new Set(PARITY_ENFORCED_SKILLS.map((location) => location.skill));
    for (const [skill, allowances] of Object.entries(BUILD_PARITY_ALLOWANCES)) {
      expect(enrolled.has(skill)).toBe(true);
      for (const allowance of allowances) {
        expect(allowance.anchor.trim().length).toBeGreaterThan(0);
        expect(allowance.builds.length).toBeGreaterThan(0);
        for (const build of allowance.builds) expect(HARNESS_BUILD_NAMES).toContain(build);
        // A reason, not a label. The bar is a sentence that survives being read
        // out loud in a review.
        expect(allowance.reason.length).toBeGreaterThan(60);
      }
    }
  });

  test("every allowance still covers a hunk that exists", () => {
    const unused: string[] = [];
    for (const [skill, allowances] of Object.entries(BUILD_PARITY_ALLOWANCES)) {
      if (allowances.length === 0) continue;
      const location = PARITY_ENFORCED_SKILLS.find((candidate) => candidate.skill === skill);
      const dirs = location === undefined ? [] : locateSkill(location);
      const text = dirs
        .flatMap((dir) => HARNESS_BUILD_NAMES.filter((name) => existsSync(path.join(dir, name))).map((name) => readFileSync(path.join(dir, name), "utf8")))
        .join("\n");
      for (const allowance of allowances) {
        if (!text.includes(allowance.anchor)) unused.push(`${skill}: ${allowance.anchor}`);
      }
    }
    expect(unused).toEqual([]);
  });

  test("the harness-family allowance is the only class flow 209 kept", () => {
    // 36 skills diverged; 35 of them were drift and were reconciled outright.
    // If a later change adds allowances, this assertion is where the widening
    // has to be argued for rather than absorbed.
    const entries = Object.values(BUILD_PARITY_ALLOWANCES).flat();
    expect(entries.length).toBe(7);
    for (const allowance of entries) {
      expect(allowance.anchor).toBe(HARNESS_FAMILY_DECLARATION.anchor);
    }
  });
});

/**
 * The diff engine must bite. A guard whose comparator silently returns "no
 * differences" would pass over real drift forever, so prove on synthetic input
 * that it finds a removal, an addition, and reports the right line numbers —
 * without depending on any repo file staying drifted.
 */
test("build-parity: the comparator detects removals and additions with correct line numbers", () => {
  const canonical = ["a", "b", "c", "d", "e"];

  const removed = diffLines(canonical, ["a", "b", "e"]);
  expect(removed.length).toBe(1);
  expect(removed[0]?.kind).toBe("missing");
  expect(removed[0]?.lines).toEqual(["c", "d"]);
  expect(removed[0]?.canonicalStart).toBe(3);
  expect(removed[0]?.canonicalEnd).toBe(4);

  const added = diffLines(canonical, ["a", "b", "c", "X", "d", "e"]);
  expect(added.length).toBe(1);
  expect(added[0]?.kind).toBe("extra");
  expect(added[0]?.lines).toEqual(["X"]);
  expect(added[0]?.variantStart).toBe(4);

  // Identical input yields nothing, which is what a clean skill must produce.
  expect(diffLines(canonical, [...canonical])).toEqual([]);
});

/**
 * The guard itself, over every skill that ships harness builds.
 */
test("build-parity: every build of an enforced skill matches SKILL.md", () => {
  const sections: string[] = [];
  let comparisons = 0;
  let expected = 0;

  for (const location of PARITY_ENFORCED_SKILLS) {
    const dirs = locateSkill(location);
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      // What SHOULD be compared, counted from the filesystem independently of
      // what the comparator says it did.
      expected += HARNESS_BUILD_NAMES.filter((name) => existsSync(path.join(dir, name))).length;
      const result = checkSkillDirectory(location.skill, dir);
      comparisons += result.comparisons;
      if (result.report.length > 0) {
        sections.push(result.report);
      }
    }
  }

  // Denominator again, at the point of use. Builds per skill vary (some ship
  // two, some four) and the mirror holds only part of the tree, so the count is
  // derived rather than assumed — but it is still asserted, because a
  // comparator that quietly compared nothing is what this whole file guards.
  expect(comparisons).toBe(expected);
  expect(comparisons).toBeGreaterThanOrEqual(CENSUS_FLOOR);

  if (sections.length > 0) {
    throw new Error(
      [
        "",
        "Build parity failed.",
        "",
        "The builds of a skill must be identical except for differences on the",
        "documented allow-list (BUILD_PARITY_ALLOWANCES in",
        "src/gdskills/build-parity.test.ts). An allowance is legitimate only when",
        "the text names a harness-only command, path, tool, or capability.",
        "",
        "Almost every allow-list here is EMPTY, and that is the finding rather",
        "than an oversight. Flow 209 read all 36 diverging skills hunk by hunk:",
        "35 were stale ancestors of their own SKILL.md — pre-extraction inline",
        "scripts, a superseded output format, hard-coded paths SKILL.md had",
        "already replaced — and none of that is harness-specific. The single",
        "surviving class is `metadata.compatible_harnesses`, whose value names",
        "harnesses and therefore cannot be shared with the Claude build.",
        "",
        "FIX: add each hunk below to the builds listed as missing it (do not delete",
        "it from SKILL.md — the Claude build is the complete one), keeping the",
        "bundled source and its .metaproject mirror byte-identical as",
        "round-bound.test.ts requires.",
        "",
        ...sections,
      ].join("\n"),
    );
  }
});
