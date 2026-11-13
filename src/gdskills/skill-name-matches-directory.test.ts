// A skill's frontmatter `name` must match the directory it ships in.
//
// Two naming systems are live at once and they must agree:
//
//   - `installGdskills` copies by DIRECTORY, and `BUNDLED_GDSKILLS` in
//     `catalog.ts` names directories. That is what decides whether a skill is
//     installed at all.
//   - Harnesses register a skill by its frontmatter `name`. That is what decides
//     whether a dispatch resolves once it is installed.
//
// When they disagree, a skill installs under one name and answers to another —
// which is how `code-boss-review` came to be referenced by eleven files while the
// directory on disk was `code-b091-review`, resolving only on the one machine
// that happened to have the other copy installed privately.
//
// # Why this guard did not exist until now
//
// Flow 207's skill evaluator found this class and deliberately did NOT ship a
// check for it, because seven `planning/` skills disagreed — every one carried a
// prefix its directory lacked — and a rule that must be excepted seven times on
// the day it ships is a rule somebody deletes rather than understands. That was
// the right call then.
//
// Those seven skills have since been removed, so the exemption list is empty and
// the rule can be stated plainly. That ordering is the point: fix the
// instances, THEN write the guard, rather than shipping a guard whose
// exceptions outnumber its enforcement.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundledSkillFiles, defaultBundledRoot } from "./bundled-eval";

/** The frontmatter `name`, or `undefined` when the file declares none. */
function frontmatterName(text: string): string | undefined {
  if (!text.startsWith("---")) return undefined;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const match = /^name:\s*(.+)$/m.exec(text.slice(3, end));
  return match?.[1]?.trim().replace(/^["']|["']$/g, "");
}

/** One line per `SKILL.md` under `root` whose frontmatter name is not its directory's. */
function nameDisagreements(root: string): string[] {
  const offenders: string[] = [];
  for (const file of bundledSkillFiles(root)) {
    const directory = path.basename(path.dirname(file));
    const declared = frontmatterName(readFileSync(file, "utf8"));
    if (declared !== directory) {
      offenders.push(
        `${path.relative(root, file)}: installs as "${directory}" but answers to "${declared ?? "(no name)"}"`,
      );
    }
  }
  return offenders;
}

test("every shipped skill's frontmatter name matches its directory", () => {
  expect(nameDisagreements(defaultBundledRoot())).toEqual([]);
});

test("the sweep reads the whole tree — an empty denominator would pass vacuously", () => {
  // `bundledSkillFiles` returns [] for a missing root. This assertion is the
  // difference between "65 skills agree" and "no skill was looked at", and the
  // fifth place in this codebase it has been needed.
  expect(bundledSkillFiles(defaultBundledRoot()).length).toBeGreaterThan(60);
});

test("the check fires on a disagreement, so it is not vacuously true", () => {
  // Non-vacuity from the other side, on a synthetic tree: the sweep must reject
  // the shape that once shipped for seven skills (a name carrying a prefix its
  // directory lacks) and a file with no frontmatter name at all, and must pass
  // a skill whose name is its directory.
  const root = mkdtempSync(path.join(tmpdir(), "keryx-skill-name-"));
  try {
    const write = (directory: string, text: string): void => {
      mkdirSync(path.join(root, "planning", directory), { recursive: true });
      writeFileSync(path.join(root, "planning", directory, "SKILL.md"), text);
    };
    const frontmatter = (name: string): string => ["---", `name: ${name}`, "description: x", "---", ""].join("\n");
    write("agrees", frontmatter("agrees"));
    write("prefixed", frontmatter("acme-prefixed"));
    write("unnamed", "# just a heading\n");

    expect(frontmatterName(frontmatter("acme-prefixed"))).toBe("acme-prefixed");
    expect(frontmatterName("# just a heading\n")).toBeUndefined();
    expect(nameDisagreements(root)).toEqual([
      'planning/prefixed/SKILL.md: installs as "prefixed" but answers to "acme-prefixed"',
      'planning/unnamed/SKILL.md: installs as "unnamed" but answers to "(no name)"',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
