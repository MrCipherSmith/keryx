// Flow 206, AC1 — the shipped tree names no person and no machine.
//
// WHAT THIS GUARDS, AND WHY A LIST OF WORDS IS THE RIGHT SHAPE
//
// `src/gdskills/bundled/` is copied verbatim into every installation. Until this
// flow, it carried one specific reviewer: a skill named after them, a rule
// replicating their style, their speech markers, and their team's store
// conventions stated as universal rules. A general tool cannot ship knowledge of
// a particular user, and the removal is only durable if re-adding it fails.
//
// A guard over a fixed list of words has an obvious weakness — it cannot notice
// a NEW persona under a NEW name — and that is accepted deliberately. No test
// can decide whether prose describes a mechanism or a person; that is what AC2's
// reading test is for, and it is a human one. What a test can do is make the
// specific regression this flow removed impossible to reintroduce silently,
// which is the failure mode that actually happened: the names sat in the public
// repository through nineteen releases because nothing looked.
//
// The path check is the part that generalises. A shipped file pointing into
// somebody's home directory is broken for every reader but its author, and that
// IS decidable.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const BUNDLED = path.join(import.meta.dir, "bundled");

function bundledFiles(dir = BUNDLED): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...bundledFiles(full));
      continue;
    }
    files.push(full);
  }
  return files;
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

function relative(file: string): string {
  return path.relative(BUNDLED, file);
}

/**
 * The reviewer this flow removed, in every spelling the repository used.
 *
 * `b091` was the name on disk; `boss` was the name eleven files asked for. Both
 * name the same person, and a rename between them is not a de-personalisation —
 * which is why both are listed rather than only the one that shipped.
 */
const PERSONA = [
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
const PERSONAL_MARKERS = [
  { pattern: /not today ;P/i, why: "the reviewer's own catchphrase" },
  { pattern: /\bducttape\b/i, why: "the reviewer's own term, spelled their way" },
  { pattern: /\bbroken thinking\b/i, why: "the reviewer's own verdict vocabulary" },
];

test("AC1: no file under src/gdskills/bundled names the reviewer this flow removed", () => {
  const offenders: string[] = [];
  for (const file of bundledFiles()) {
    const text = read(file);
    for (const { pattern, why } of PERSONA) {
      if (pattern.test(text)) offenders.push(`${relative(file)}: ${why}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("AC1: no file under src/gdskills/bundled carries the reviewer's speech markers", () => {
  const offenders: string[] = [];
  for (const file of bundledFiles()) {
    const text = read(file);
    for (const { pattern, why } of PERSONAL_MARKERS) {
      if (pattern.test(text)) offenders.push(`${relative(file)}: ${why}`);
    }
  }
  expect(offenders).toEqual([]);
});

/**
 * Home directories.
 *
 * `~/.claude`, `~/.cursor`, `${CODEX_HOME:-~/.codex}` and friends are NOT
 * violations: they are where the harnesses themselves keep their configuration,
 * they are the same path on every machine, and a skill that installs into a
 * harness has to name them. The violation is a path into a PARTICULAR person's
 * home — an absolute `/home/<user>/…` or `/Users/<user>/…`, or a `~/`-rooted
 * directory that is not a known harness's own.
 *
 * So the check is an allow-list of harness roots plus a refusal of absolute home
 * paths, rather than a blanket ban on `~` that would fire on twenty-five correct
 * lines and be deleted within the week.
 */
const HARNESS_HOME_ROOTS = [
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
 * `codebase_path` field has to show one. `/home/altsay/keryx` is a personal
 * path, and it is the shape that actually leaks — it arrives by someone pasting
 * a real session into a template.
 *
 * So the user segment is what decides, not the prefix. A placeholder account is
 * fine anywhere; a real login is refused everywhere.
 */
const PLACEHOLDER_ACCOUNTS = new Set(["dev", "user", "you", "me", "username", "youruser"]);

test("AC1: no file under src/gdskills/bundled points into a particular person's home directory", () => {
  const ABSOLUTE_HOME = /(?:^|[\s"'`(=])(?:\/home|\/Users)\/([A-Za-z<][\w.<>-]*)\//g;
  const TILDE = /~\/[\w.\-/${}:]+/g;

  const offenders: string[] = [];
  for (const file of bundledFiles()) {
    const text = read(file);
    text.split("\n").forEach((line, index) => {
      const where = `${relative(file)}:${index + 1}`;
      for (const match of line.matchAll(ABSOLUTE_HOME)) {
        const account = match[1] ?? "";
        // `<user>`, `<USER>` and friends are the field, not an occupant of it.
        if (account.startsWith("<") || PLACEHOLDER_ACCOUNTS.has(account.toLowerCase())) continue;
        offenders.push(`${where}: absolute path into ${account}'s home — ${line.trim().slice(0, 100)}`);
      }
      for (const match of line.match(TILDE) ?? []) {
        // `${CODEX_HOME:-~/.codex}` and the like: the default inside the
        // expansion is the thing being checked.
        const normalised = match.replace(/^.*:-/, "");
        if (!HARNESS_HOME_ROOTS.some((root) => normalised.startsWith(root))) {
          offenders.push(`${where}: home path outside the known harness roots — ${match}`);
        }
      }
    });
  }
  expect(offenders).toEqual([]);
});

test("AC1: the guard reads a real tree — the denominator is not zero", () => {
  // Every assertion above passes vacuously over an empty file list, and a
  // renamed directory would empty it.
  const files = bundledFiles();
  expect(files.length).toBeGreaterThan(100);
  expect(files.some((file) => relative(file).startsWith(path.join("skills", "review")))).toBe(true);
  expect(files.some((file) => relative(file).startsWith(path.join("rules", "core")))).toBe(true);
});

/**
 * AC2's mechanism claim, in the one place a test can reach it.
 *
 * Whether prose reads as a mechanism is a human judgement. Whether it says the
 * three things the mechanism actually consists of — learned locally, from
 * pull-request comments, by people the project names — is not, and a rewrite
 * that quietly drops one of them is a rewrite back toward a style guide.
 */
test("AC2: the shipped learned-review skill and rule describe the mechanism, in all five builds", () => {
  const skillDir = path.join(BUNDLED, "skills", "review", "code-learned-review");
  const builds = readdirSync(skillDir).filter((name) => name.startsWith("SKILL") && name.endsWith(".md"));
  expect(builds).toHaveLength(5);

  const texts = [
    ...builds.map((name) => read(path.join(skillDir, name))),
    read(path.join(BUNDLED, "rules", "core", "code-review-learned-profile.mdc")),
  ];
  for (const text of texts) {
    expect(text).toMatch(/review-learning\.config\.json/);
    expect(text).toMatch(/pull-request comments|pull request comments/i);
    expect(text).toMatch(/\.metaproject\/project-skills/);
    // The name it must not carry: a checklist of its own.
    expect(text).toMatch(/no (review )?conventions of its own|carries no conventions/i);
  }
});

test("AC2: the shipped learned-review skill points at the commands that exist", () => {
  // AC10: a claim about a mechanism is wired or it is not made. These three are
  // the commands the prose names, and `review learn` is the one this flow added —
  // asserted here so that renaming it breaks the document that advertises it.
  const skill = read(path.join(BUNDLED, "skills", "review", "code-learned-review", "SKILL.md"));
  expect(skill).toContain("keryx review comments collect");
  expect(skill).toContain("keryx review learn");
  expect(skill).toContain("keryx skills learn apply");
});
