import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { HARNESS_SKILL_RUNTIMES, skillBuildFileName } from "./export";

/**
 * Flow 205: build-vs-build parity.
 *
 * `job-orchestrator` ships five builds — SKILL.md, SKILL.codex.md,
 * SKILL.cursor.md, SKILL.opencode.md, SKILL.zed.md — all declaring
 * `metadata.version: "3.2.0"` and the same `compatible_harnesses`. Nothing
 * compared them, so they drifted: the four non-Claude builds are byte-identical
 * to each other and 33 lines shorter than SKILL.md.
 *
 * `round-bound.test.ts` already implements the analogous bundled-vs-mirror
 * byte-equality check. That guard runs along one axis (source vs installed
 * copy) and this one runs along the other (build vs build) — the axis that was
 * simply never checked.
 *
 * This guard is EXPECTED TO FAIL until the markdown owner reconciles the three
 * hunks it names. Its job is to name them precisely enough to act on.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const SKILL_ROOTS = [
  path.join(REPO_ROOT, "src", "gdskills", "bundled", "skills"),
  path.join(REPO_ROOT, ".metaproject", "skills", "gdskills"),
];

/**
 * Skills whose builds are held to parity today.
 *
 * Deliberately narrow. Every skill in this repo that ships harness builds has
 * drifted the same way — a census at the time of writing found ~50 of them —
 * so enforcing repo-wide would emit a report nobody can act on. The mechanism
 * below is general; this list is the enforced frontier, and skills join it as
 * their builds are reconciled. Absence from this list is a backlog entry, NOT
 * an exemption.
 */
const PARITY_ENFORCED_SKILLS: readonly SkillLocation[] = [
  { category: "orchestration", skill: "job-orchestrator" },
];

type SkillLocation = { category: string; skill: string };

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
 */
type ParityAllowance = {
  /** Substring that must appear in the hunk for this allowance to cover it. */
  anchor: string;
  /** Builds permitted to differ by this hunk. */
  builds: readonly string[];
  /** Why this difference is genuinely harness-specific. */
  reason: string;
};

const BUILD_PARITY_ALLOWANCES: Record<string, readonly ParityAllowance[]> = {
  "job-orchestrator": [],
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
  expect(PARITY_ENFORCED_SKILLS.length).toBeGreaterThan(0);
  expect(SKILL_ROOTS.length).toBe(2);
  for (const root of SKILL_ROOTS) {
    expect(existsSync(root)).toBe(true);
    expect(readdirSync(root).length).toBeGreaterThan(0);
  }

  for (const location of PARITY_ENFORCED_SKILLS) {
    const dirs = locateSkill(location);
    // Both the bundled source and its .metaproject mirror must be found.
    expect(dirs.length).toBe(2);
    for (const dir of dirs) {
      const builds = readdirSync(dir).filter((name) => name.startsWith("SKILL") && name.endsWith(".md"));
      // Five builds: SKILL.md plus one per non-Claude harness.
      expect(builds.length).toBe(HARNESS_SKILL_RUNTIMES.length);
      expect(builds.sort()).toEqual(
        [...HARNESS_SKILL_RUNTIMES].map((runtime) => skillBuildFileName(runtime)).sort(),
      );
    }
  }
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
 * The guard itself. Expected red until the three named hunks are reconciled
 * across all five builds — see BUILD_PARITY_ALLOWANCES above for why none of
 * them qualifies for an allowance.
 */
test("build-parity: every build of an enforced skill matches SKILL.md", () => {
  const sections: string[] = [];
  let comparisons = 0;

  for (const location of PARITY_ENFORCED_SKILLS) {
    const dirs = locateSkill(location);
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      const result = checkSkillDirectory(location.skill, dir);
      comparisons += result.comparisons;
      if (result.report.length > 0) {
        sections.push(result.report);
      }
    }
  }

  // Denominator again, at the point of use: four variants per directory, two
  // directories, per enforced skill.
  expect(comparisons).toBe(PARITY_ENFORCED_SKILLS.length * 2 * (HARNESS_SKILL_RUNTIMES.length - 1));

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
        "job-orchestrator's allow-list is EMPTY on purpose: none of the hunks below",
        "is harness-specific. They call generic `keryx` commands (`keryx skills",
        "learn`) and harness-agnostic rule files (`rules/core/skill-lifecycle.mdc`,",
        "`rules/core/model-selection.mdc`,",
        "`.metaproject/rules/core/execution-metrics.md`), so every build should",
        "carry them. All five builds declare metadata.version 3.2.0 and the same",
        "compatible_harnesses, which is exactly the claim these differences break.",
        "",
        "FIX: add each hunk below to the builds listed as missing it (do not delete",
        "it from SKILL.md), keeping the bundled source and its .metaproject mirror",
        "byte-identical as round-bound.test.ts requires.",
        "",
        ...sections,
      ].join("\n"),
    );
  }
});
