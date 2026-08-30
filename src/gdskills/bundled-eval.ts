// Flow 207, §5.3 — structural evaluation of the BUNDLED skill tree.
//
// WHAT THIS IS, STATED BEFORE ANYTHING ELSE
//
// This is LAYER ONE of the three-layer bar the roadmap names, and only layer
// one. The roadmap asks for:
//
//   1. static structural validation        <- this file
//   2. a judge across named dimensions     <- NOT BUILT
//   3. reliability over repeated runs      <- NOT BUILT
//
// Layers two and three need a model in the loop and a corpus of repeated runs.
// Neither exists, and no part of this file approximates either. Saying so here
// is not modesty: the Phase 7 audit spent 217 rows on documents that described
// pipelines nobody built, and a file called `bundled-eval` that implied a judge
// would be the same defect one directory over. What runs here is decidable by
// reading files, and everything it reports is a fact about bytes on disk.
//
// WHY IT EXISTS
//
// `keryx skills verify` (src/gdskills/verify.ts) evaluates PROJECT skills — the
// ones a user generates into their own `.metaproject/project-skills/`. Nothing
// evaluated `src/gdskills/bundled/`, the 65 `SKILL.md` files copied verbatim
// into every installation. They were assumed correct, and were not. This sweep's
// first clean run over the shipped tree returned 27 findings:
//
//   - 1 skill named but never bundled — `feature-dev` said "Launch `code-review`
//     skill", and no `code-review` has ever shipped;
//   - 25 paths into the shipped tree that resolved to nothing, in 9 distinct
//     forms, every one of them missing its category segment: four contract
//     schemas under `skills/review-orchestrator/` (the directory is
//     `skills/review/review-orchestrator/`), and five sibling skills addressed
//     as `skills/<name>` rather than `skills/<category>/<name>`;
//   - 1 script, `.metaproject/scripts/detect-models.sh`, cited by
//     `flow-orchestrator` as the way to find a cheaper model. It has never
//     existed in any tree, in any release.
//
// All 27 are fixed in the same change that added this file, in both the bundled
// source and its `.metaproject` mirror.
//
// COMPOSITION, NOT DUPLICATION
//
// Two of the rules this sweep applies already had one executable definition
// each, and both are imported rather than restated:
//
//   - `concreteModelDeclarations` (model-tier.ts) is the AC14 rule about naming
//     a model where a tier belongs.
//   - `personaOffenders` / `homePathOffenders` live HERE and
//     `bundled-no-persona.test.ts` imports them, so flow 206's guard and this
//     sweep cannot drift apart. They moved out of the test file for that reason
//     and for no other; the wording of their justifications moved with them.
//
// THE DENOMINATOR IS PART OF THE RESULT
//
// `evaluateBundledTree` returns `skills` alongside `findings` because a sweep
// that walked nothing reports zero findings and reads as a pass. Every caller —
// the guard test and the command — asserts on that number. It is the same
// non-vacuity rule flow 204 wrote into `model-tier.test.ts` after finding five
// vacuous sweeps.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { BUNDLED_GDSKILLS } from "./catalog";
import { concreteModelDeclarations } from "./model-tier";

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * The checks this evaluator runs. Ids, not prose: they are asserted in tests and
 * printed for operators, so they must not drift with wording.
 */
export const BUNDLED_SKILL_CHECKS = [
  "frontmatter:block",
  "frontmatter:name",
  "frontmatter:name-unique",
  "frontmatter:description",
  "frontmatter:metadata",
  "catalog:registered",
  "model:concrete-declaration",
  "persona:name",
  "persona:marker",
  "path:personal-home",
  "xref:skill",
  "xref:path",
] as const;

export type BundledSkillCheck = (typeof BUNDLED_SKILL_CHECKS)[number];

/** One structural defect, located precisely enough to fix without searching. */
export interface BundledSkillFinding {
  /** Which rule fired. */
  readonly check: BundledSkillCheck;
  /** Skill directory name, e.g. `feature-dev`. */
  readonly skill: string;
  /** Path relative to the swept root, e.g. `orchestration/feature-dev/SKILL.md`. */
  readonly file: string;
  /** 1-based line, or `null` when the defect is the absence of something. */
  readonly line: number | null;
  /** What is wrong, and what would make it right. */
  readonly message: string;
}

/** What one sweep produced. `skills` is the denominator, and it is load-bearing. */
export interface BundledSkillEvaluation {
  /** Absolute path of the tree that was walked. */
  readonly root: string;
  /** How many `SKILL.md` files were found. Zero means the sweep proved nothing. */
  readonly skills: number;
  /** Every skill directory name found, sorted — the resolvable cross-reference set. */
  readonly skillNames: readonly string[];
  readonly findings: readonly BundledSkillFinding[];
}

// ---------------------------------------------------------------------------
// Persona and home-directory rules (flow 206 AC1, moved here to be shared)
// ---------------------------------------------------------------------------

/**
 * The reviewer flow 206 removed, in every spelling the repository used.
 *
 * `b091` was the name on disk; `boss` was the name eleven files asked for. Both
 * name the same person, and a rename between them is not a de-personalisation —
 * which is why both are listed rather than only the one that shipped.
 */
export const PERSONA_PATTERNS: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\bb091\b/i, why: "the reviewer's handle as it appeared on disk" },
  { pattern: /\bboss\b/i, why: "the reviewer's handle as eleven files referred to them" },
];

/**
 * Their speech and their team's conventions, stated as universal rules.
 *
 * Replacing a name with a placeholder was explicitly not enough, so the markers
 * that identify the same person without naming them are listed too. Each is a
 * phrase that carries no meaning outside that reviewer's own repository.
 */
export const PERSONAL_MARKER_PATTERNS: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /not today ;P/i, why: "the reviewer's own catchphrase" },
  { pattern: /\bducttape\b/i, why: "the reviewer's own term, spelled their way" },
  { pattern: /\bbroken thinking\b/i, why: "the reviewer's own verdict vocabulary" },
];

/**
 * Home directories.
 *
 * `~/.claude`, `~/.cursor`, `${CODEX_HOME:-~/.codex}` and friends are NOT
 * violations: they are where the harnesses themselves keep their configuration,
 * they are the same path on every machine, and a skill that installs into a
 * harness has to name them. The violation is a path into a PARTICULAR person's
 * home — an absolute `/home/<user>/…` or `/Users/<user>/…`, or a `~/`-rooted
 * directory that is not a known harness's own.
 */
export const HARNESS_HOME_ROOTS: readonly string[] = [
  "~/.claude",
  "~/.codex",
  "~/.cursor",
  "~/.antigravity",
  "~/.config/zed",
  "~/.config/opencode",
  "~/.config/keryx",
  "~/.gemini",
  "~/.windsurf",
];

/**
 * The account names a documentation example is allowed to use.
 *
 * `/Users/dev/<PROJECT>` in a schema's `examples` is not a personal path: it
 * names nobody, it is the same on every machine, and a skill documenting a
 * `codebase_path` field has to show one. A real login is refused everywhere.
 */
export const PLACEHOLDER_ACCOUNTS: ReadonlySet<string> = new Set([
  "dev",
  "user",
  "you",
  "me",
  "username",
  "youruser",
]);

const ABSOLUTE_HOME = /(?:^|[\s"'`(=])(?:\/home|\/Users)\/([A-Za-z<][\w.<>-]*)\//g;
const TILDE_PATH = /~\/[\w.\-/${}:]+/g;

/**
 * Every persona name or speech marker `text` carries.
 *
 * `kind` distinguishes the two, because they are two different findings: a NAME
 * is the reviewer's handle, a MARKER is their speech surviving a rename. A
 * removal that swaps the name for a placeholder and leaves the catchphrase is
 * the exact half-fix flow 206 refused, so the two must stay separable rather
 * than collapse into one count.
 */
export function personaOffenders(text: string): { line: number; kind: "name" | "marker"; why: string }[] {
  const out: { line: number; kind: "name" | "marker"; why: string }[] = [];
  text.split("\n").forEach((line, index) => {
    for (const { pattern, why } of PERSONA_PATTERNS) {
      if (pattern.test(line)) out.push({ line: index + 1, kind: "name", why });
    }
    for (const { pattern, why } of PERSONAL_MARKER_PATTERNS) {
      if (pattern.test(line)) out.push({ line: index + 1, kind: "marker", why });
    }
  });
  return out;
}

/** Every path into a particular person's home directory, as `{ line, why }`. */
export function homePathOffenders(text: string): { line: number; why: string }[] {
  const out: { line: number; why: string }[] = [];
  text.split("\n").forEach((raw, index) => {
    for (const match of raw.matchAll(ABSOLUTE_HOME)) {
      const account = match[1] ?? "";
      // `<user>`, `<USER>` and friends are the field, not an occupant of it.
      if (account.startsWith("<") || PLACEHOLDER_ACCOUNTS.has(account.toLowerCase())) continue;
      out.push({ line: index + 1, why: `absolute path into ${account}'s home directory` });
    }
    for (const match of raw.match(TILDE_PATH) ?? []) {
      // `${CODEX_HOME:-~/.codex}` and the like: the default inside the
      // expansion is the thing being checked.
      const normalised = match.replace(/^.*:-/, "");
      if (HARNESS_HOME_ROOTS.some((root) => normalised.startsWith(root))) continue;
      out.push({ line: index + 1, why: `home path outside the known harness roots — ${match}` });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/** The YAML frontmatter block, or `undefined` when the file opens without one. */
export function frontmatterBlock(markdown: string): string | undefined {
  if (!markdown.startsWith("---")) return undefined;
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return undefined;
  return markdown.slice(3, end);
}

/**
 * Top-level frontmatter keys and their scalar values.
 *
 * Deliberately shallow: `metadata:` opens a nested block and its value here is
 * the empty string, which is enough to answer "is the key present". Parsing YAML
 * properly would add a dependency to answer a question nothing asks.
 */
function frontmatterKeys(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of block.split("\n")) {
    const match = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
    if (match === null) continue;
    out.set(match[1] as string, (match[2] ?? "").trim());
  }
  return out;
}

/**
 * Frontmatter fields every bundled skill must carry, each mapped to the check id
 * its absence reports under.
 *
 * The set is what all 65 files already declare, which is the only defensible
 * place to set the bar: a required field that some shipped skill lacks is a
 * guard that fails on arrival and gets deleted, and a field none of them
 * declares is an aspiration rather than a rule.
 *
 * A map rather than a list, and `satisfies` rather than a cast, so adding a
 * required field without adding its check id is a COMPILE error. The cast this
 * replaced would have produced a finding carrying an id absent from
 * `BUNDLED_SKILL_CHECKS`, which the renderer would then never print.
 */
export const REQUIRED_FRONTMATTER_CHECKS = {
  name: "frontmatter:name",
  description: "frontmatter:description",
  metadata: "frontmatter:metadata",
} as const satisfies Record<string, BundledSkillCheck>;

/** The required field names, for callers that only need the list. */
export const REQUIRED_FRONTMATTER_FIELDS = Object.keys(
  REQUIRED_FRONTMATTER_CHECKS,
) as readonly (keyof typeof REQUIRED_FRONTMATTER_CHECKS)[];

// ---------------------------------------------------------------------------
// Cross-references
// ---------------------------------------------------------------------------

/**
 * Forms that DECLARE a dependency on another skill.
 *
 * Every pattern requires the word `skill` (or the `Skill(...)` call form)
 * adjacent to the name. That narrowness is the whole design. A first attempt
 * matched every backticked hyphenated token and produced 53 candidates, of
 * which the overwhelming majority were enum values (`dismissed-wont-fix`),
 * npm packages (`mobx-react-lite`) and DOM attributes (`data-testid`). A guard
 * with that false-positive rate is routed around within a week.
 *
 * The narrow form still catches the defect that actually shipped:
 * `feature-dev` said "Launch `code-review` skill" for a skill that was never
 * bundled.
 */
const SKILL_REFERENCE_PATTERNS: readonly RegExp[] = [
  /`([a-z][a-z0-9-]*)`\s+skill\b/g,
  /\bskill\s+`([a-z][a-z0-9-]*)`/g,
  /\bSkill\(\s*["']([a-z][a-z0-9-]*)["']\s*\)/g,
];

/**
 * Names that are not bundled skills and are not meant to be.
 *
 * Each entry names something REAL that lives elsewhere, so an unresolvable
 * reference stays unresolvable. An allowance is not an exemption from the check;
 * it is a statement that the referent exists in a place this sweep cannot see.
 */
export const KNOWN_EXTERNAL_SKILL_REFERENCES: ReadonlyMap<string, string> = new Map([
  ["general-purpose", "the harness's own built-in agent type, not a keryx skill"],
]);

/**
 * Path namespaces this sweep can decide.
 *
 * `skills/`, `rules/` and `scripts/` name artifacts the bundled tree itself
 * ships, so a reference into them either resolves or is broken. Everything else
 * a skill mentions — `src/**`, `docs/**`, `.metaproject/data/**` — belongs to
 * the USER's project or is produced at runtime, and this evaluator has no
 * standing to call any of it missing. Checking those would be the "judge that
 * flags everything" failure from the other direction.
 */
const CHECKED_PATH_ROOTS = ["skills", "rules", "scripts"] as const;

/**
 * Prefixes that address the same artifacts through the INSTALLED layout.
 *
 * A skill may name `.metaproject/skills/gdskills/review/…` (where the file lands
 * for a user) or `skills/review/…` (where it lives in the source tree). Both
 * denote one file, so both normalise to the bundled-relative form before
 * resolution.
 */
const INSTALLED_PREFIXES: readonly [string, string][] = [
  [".metaproject/skills/gdskills/", "skills/"],
  // The same address written `.metaproject`-relative rather than project-relative.
  // `installGdskills` writes the tree to `.metaproject/skills/gdskills/`, so both
  // spellings denote one file and both must resolve.
  ["skills/gdskills/", "skills/"],
  [".metaproject/rules/", "rules/"],
  [".metaproject/scripts/", "scripts/"],
];

/**
 * Directories inside the checked namespaces that a `keryx` command CREATES.
 *
 * `agent-entrypoint-distiller` lists `.metaproject/rules/entrypoints/index.md`
 * under "verify the generated outputs" — it is an output of `keryx rules
 * distill`, so its absence from the shipped tree is correct rather than broken.
 * Each entry names the command that produces it, because an allowance without a
 * producer is indistinguishable from a reference nobody checked.
 */
export const GENERATED_PATH_ROOTS: readonly { prefix: string; producedBy: string }[] = [
  { prefix: "rules/entrypoints/", producedBy: "keryx rules distill" },
];

const PATH_REFERENCE = /(?:^|[\s"'`(\[])((?:\.metaproject\/|skills\/|rules\/|scripts\/)[\w./@-]*[\w.@-])/g;

/** Normalise an installed-layout path to its bundled-relative form. */
function normaliseReferencePath(reference: string): string | undefined {
  for (const [from, to] of INSTALLED_PREFIXES) {
    if (reference.startsWith(from)) return to + reference.slice(from.length);
  }
  if (reference.startsWith(".metaproject/")) return undefined;
  const root = reference.split("/")[0] ?? "";
  return (CHECKED_PATH_ROOTS as readonly string[]).includes(root) ? reference : undefined;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/** Every `SKILL.md` under `root`, absolute, sorted. `[]` when `root` is absent. */
export function bundledSkillFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name === "SKILL.md") out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/** The default tree: the 65 skills shipped inside this package. */
export function defaultBundledRoot(): string {
  return path.join(import.meta.dir, "bundled");
}

/**
 * Evaluate one bundled tree.
 *
 * `root` is the directory holding `skills/` and `rules/` — `src/gdskills/bundled`
 * for the shipped tree, or a fixture root for a test. Taking it as an argument
 * is what lets AC8's broken fixture be evaluated by the SAME code that sweeps
 * the real tree, rather than by a second implementation that could disagree.
 */
export function evaluateBundledTree(root: string = defaultBundledRoot()): BundledSkillEvaluation {
  const skillsRoot = path.join(root, "skills");
  const files = bundledSkillFiles(skillsRoot);
  const skillNames = [...new Set(files.map((file) => path.basename(path.dirname(file))))].sort();
  const known = new Set(skillNames);
  const findings: BundledSkillFinding[] = [];
  /** Declared frontmatter name -> the first file that declared it. */
  const declaredNames = new Map<string, string>();
  /** `<category>/<directory>` pairs the install catalogue names. */
  const catalogued = new Set(BUNDLED_GDSKILLS.map((entry) => `${entry.category}/${entry.name}`));

  for (const file of files) {
    const skill = path.basename(path.dirname(file));
    const rel = path.relative(skillsRoot, file).split(path.sep).join("/");
    const text = readFileSync(file, "utf8");
    const add = (check: BundledSkillCheck, line: number | null, message: string): void => {
      findings.push({ check, skill, file: rel, line, message });
    };

    // --- frontmatter -------------------------------------------------------
    const block = frontmatterBlock(text);
    if (block === undefined) {
      add(
        "frontmatter:block",
        1,
        "no YAML frontmatter block: the file must open with `---` and close the block with a `---` line.",
      );
    } else {
      const keys = frontmatterKeys(block);
      for (const [field, check] of Object.entries(REQUIRED_FRONTMATTER_CHECKS)) {
        if (!keys.has(field)) {
          add(check, 1, `frontmatter is missing the required \`${field}\` field.`);
        }
      }
      const name = keys.get("name");
      if (name !== undefined && name.replace(/^["']|["']$/g, "").length === 0) {
        add("frontmatter:name", 1, "frontmatter `name` is present but empty.");
      }
      const declaredName = name === undefined ? undefined : name.replace(/^["']|["']$/g, "");
      if (declaredName !== undefined && declaredName.length > 0) {
        const previous = declaredNames.get(declaredName);
        if (previous !== undefined) {
          add(
            "frontmatter:name-unique",
            1,
            `frontmatter \`name: ${declaredName}\` is already declared by \`${previous}\`; a harness registers skills by this name and cannot tell two of them apart.`,
          );
        } else {
          declaredNames.set(declaredName, rel);
        }
      }
      const description = keys.get("description");
      if (description !== undefined && description.replace(/^["']|["']$/g, "").length === 0) {
        add(
          "frontmatter:description",
          1,
          "frontmatter `description` is present but empty; it is the text a harness matches a request against.",
        );
      }
      if (keys.has("metadata")) {
        const metadataVersion = /^\s{2,}version\s*:\s*(.+)$/m.exec(block);
        if (metadataVersion === null) {
          add(
            "frontmatter:metadata",
            1,
            "frontmatter `metadata` declares no `version`; without one a skill cannot be said to have changed.",
          );
        }
      }
    }

    // --- the install catalogue names this directory ------------------------
    //
    // `installGdskills` iterates `BUNDLED_GDSKILLS` and copies
    // `bundled/skills/<category>/<entry.name>`. A directory the catalogue does
    // not name is never copied anywhere: it ships inside the package, is read by
    // nobody, and every claim its prose makes is inert. That is decidable here
    // and nowhere else, because the sweep is the only thing that sees both lists.
    const category = path.dirname(rel).split("/")[0] ?? "";
    if (!catalogued.has(`${category}/${skill}`)) {
      add(
        "catalog:registered",
        null,
        `BUNDLED_GDSKILLS (src/gdskills/catalog.ts) does not name \`${category}/${skill}\`, so \`keryx skills install\` never copies this directory and no user ever sees it.`,
      );
    }

    // --- no concrete model name (AC14's existing executable rule) -----------
    for (const offender of concreteModelDeclarations(text)) {
      const line = Number.parseInt(offender.split(":")[0] ?? "", 10);
      add(
        "model:concrete-declaration",
        Number.isFinite(line) ? line : null,
        `${offender.slice(offender.indexOf(":") + 1).trim()} — declare a model_tier, never a model id.`,
      );
    }

    // --- no persona, no personal home path (flow 206's existing rules) ------
    for (const offender of personaOffenders(text)) {
      add(offender.kind === "name" ? "persona:name" : "persona:marker", offender.line, offender.why);
    }
    for (const offender of homePathOffenders(text)) {
      add("path:personal-home", offender.line, offender.why);
    }

    // --- cross-references resolve ------------------------------------------
    text.split("\n").forEach((line, index) => {
      for (const pattern of SKILL_REFERENCE_PATTERNS) {
        for (const match of line.matchAll(pattern)) {
          const referenced = match[1] as string;
          if (!referenced.includes("-")) continue;
          if (known.has(referenced)) continue;
          if (KNOWN_EXTERNAL_SKILL_REFERENCES.has(referenced)) continue;
          add(
            "xref:skill",
            index + 1,
            `names a skill \`${referenced}\` that this tree does not ship; either bundle it or stop naming it.`,
          );
        }
      }
      for (const match of line.matchAll(PATH_REFERENCE)) {
        const raw = match[1] as string;
        if (raw.includes("<") || raw.includes("*") || raw.includes("$")) continue;
        const normalised = normaliseReferencePath(raw);
        if (normalised === undefined) continue;
        if (
          GENERATED_PATH_ROOTS.some(
            (entry) => normalised === entry.prefix.replace(/\/$/, "") || normalised.startsWith(entry.prefix),
          )
        ) {
          continue;
        }
        if (existsSync(path.join(root, normalised))) continue;
        add(
          "xref:path",
          index + 1,
          `path \`${raw}\` resolves to nothing under the shipped tree (looked for \`${normalised}\`).`,
        );
      }
    });
  }

  return { root, skills: files.length, skillNames, findings };
}

/**
 * Evaluate a tree and say plainly what was and was not checked.
 *
 * The closing section is not decoration. A report that lists a column of passing
 * checks and stops reads as "the skills are good"; this evaluator can only say
 * the files are well formed and their references resolve. The distinction is the
 * one the Phase 7 audit found missing 217 times.
 */
export function renderBundledEvaluation(evaluation: BundledSkillEvaluation): string {
  const lines: string[] = [];
  lines.push("# bundled skill evaluation (layer 1 of 3: structural)");
  lines.push("");
  lines.push(`root: ${evaluation.root}`);
  lines.push(`skills_evaluated: ${evaluation.skills}`);
  lines.push(`findings: ${evaluation.findings.length}`);
  lines.push("");

  if (evaluation.skills === 0) {
    lines.push(
      "NOTHING WAS EVALUATED. The root holds no SKILL.md, so `findings: 0` means the sweep walked an empty tree — not that the tree is clean.",
    );
    return lines.join("\n");
  }

  const byCheck = new Map<string, number>();
  for (const finding of evaluation.findings) {
    byCheck.set(finding.check, (byCheck.get(finding.check) ?? 0) + 1);
  }
  lines.push("## checks");
  lines.push("");
  for (const check of BUNDLED_SKILL_CHECKS) {
    const count = byCheck.get(check) ?? 0;
    lines.push(`- ${check}: ${count === 0 ? "pass" : `${count} finding(s)`}`);
  }
  lines.push("");

  if (evaluation.findings.length > 0) {
    lines.push("## findings");
    lines.push("");
    for (const finding of evaluation.findings) {
      lines.push(`- ${finding.file}:${finding.line ?? "-"} [${finding.check}] ${finding.message}`);
    }
    lines.push("");
  }

  lines.push("## what this did NOT check");
  lines.push("");
  lines.push(
    "This is STRUCTURAL validation only — layer one of the three-layer bar. It says the files are well formed and that every reference into the shipped tree resolves. It says nothing about whether a skill's instructions are correct, useful, or followed: that needs a judge across named dimensions (layer 2) and reliability over repeated runs (layer 3), neither of which is built. A clean report here is not a quality claim.",
  );
  return lines.join("\n");
}
