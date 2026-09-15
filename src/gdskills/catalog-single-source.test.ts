/**
 * One description and one trigger list per skill (flow 257, AC1).
 *
 * The router scores the CATALOG entry — `scoreBundledSkillRoute` reads
 * `entry.description` and `entry.triggers`, never the file — while an agent
 * that loads the skill reads its `SKILL.md` frontmatter. When those were two
 * separate texts they drifted, and both halves of the drift were invisible:
 * 67 of 78 catalog entries fell back to `Use when ${purpose}`, a lowercased
 * echo that reads as an instruction ("Use when run full task pipelines…")
 * rather than a situation, while their SKILL.md carried a real routing
 * description; and the SKILL.md trigger lists still held the overlaps the
 * catalog had already curated away (interview and interviewer both claiming
 * "Clarify requirements", test-gen and tests-creator splitting "write tests").
 *
 * The mechanism now makes divergence impossible rather than detectable: a
 * file-backed entry READS its description and triggers from its SKILL.md. So
 * these tests pin what the loader returns — that the values really do come
 * from the file, that every skill is on exactly one of the two paths, and that
 * no trigger phrase is shared by two skills.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { BUNDLED_GDSKILLS, bundledSkillMarkdownPath } from "./catalog";
import { parseSkillFrontmatter } from "./skill-frontmatter";
import { normalizeRouteText } from "../commands/skills";

const BUNDLED_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "bundled",
  "skills",
);

const fileBacked = BUNDLED_GDSKILLS.filter(
  (entry) => bundledSkillMarkdownPath(entry.category, entry.name) !== undefined,
);
const renderedOnly = BUNDLED_GDSKILLS.filter(
  (entry) => bundledSkillMarkdownPath(entry.category, entry.name) === undefined,
);

/**
 * The words a trigger is actually matched on: normalized, de-duplicated and
 * order-free, because `triggerFires` matches a trigger's words against the
 * query's in any order. So "review MobX" and "mobx review" are ONE trigger
 * wearing two spellings, and a phrase-equality check would call them distinct
 * and miss the collision — which is how `review-frontend` and
 * `code-mobx-store-review` came to claim the same request.
 */
function triggerKey(trigger: string): string {
  return [...new Set(normalizeRouteText(trigger).split(" ").filter(Boolean))].sort().join(" ");
}

test("the sweep has a real denominator: every skill is on exactly one source path", () => {
  // A broken import or a mistyped bundled root would leave one of these empty
  // and every assertion below would pass over nothing.
  expect(BUNDLED_GDSKILLS.length).toBe(fileBacked.length + renderedOnly.length);
  expect(fileBacked.length).toBeGreaterThan(60);
  expect(renderedOnly.length).toBe(11);
  expect(existsSync(BUNDLED_ROOT)).toBe(true);
});

describe("a file-backed skill's routing text comes from its SKILL.md", () => {
  for (const entry of fileBacked) {
    test(`${entry.category}/${entry.name} serves the frontmatter of its own file`, () => {
      const file = bundledSkillMarkdownPath(entry.category, entry.name) as string;
      const frontmatter = parseSkillFrontmatter(readFileSync(file, "utf8"));

      expect(entry.description).toBe(frontmatter.description as string);
      expect(entry.triggers).toEqual(frontmatter.triggers as string[]);

      // Not merely equal to the file — a non-empty routing signal. An entry
      // whose description is blank is routed on nothing at all.
      expect(entry.description.trim().length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(1024);
      expect(entry.triggers.length).toBeGreaterThan(0);
    });
  }

  test("what the router scores is what a YAML parser serves", () => {
    // `parseSkillFrontmatter` is a forgiving line-regex; a harness that parses
    // SKILL.md as real YAML must recover the same text, or "one description"
    // is true only for readers that share our parser. Whitespace is normalized
    // because a literal block scalar (`|`) keeps its newlines where the line
    // parser folds them — a difference in layout, not in content.
    const disagreeing: string[] = [];
    for (const entry of fileBacked) {
      const file = bundledSkillMarkdownPath(entry.category, entry.name) as string;
      const text = readFileSync(file, "utf8");
      const block = text.slice(4, text.indexOf("\n---", 3));
      const parsed = Bun.YAML.parse(block) as { description?: unknown; triggers?: unknown };
      const yamlDescription = String(parsed.description ?? "").replace(/\s+/g, " ").trim();
      if (yamlDescription !== entry.description.replace(/\s+/g, " ").trim()) {
        disagreeing.push(`${entry.name}: description`);
      }
      if (JSON.stringify(parsed.triggers) !== JSON.stringify(entry.triggers)) {
        disagreeing.push(`${entry.name}: triggers`);
      }
    }
    expect(disagreeing).toEqual([]);
  });

  test("every bundled skill directory is registered in the catalog", () => {
    // The other direction: a SKILL.md nobody's entry points at ships with no
    // routing at all, and the loader above would never look at it.
    const onDisk: string[] = [];
    for (const category of readdirSync(BUNDLED_ROOT, { withFileTypes: true })) {
      if (!category.isDirectory() || category.name === "shared") continue;
      for (const skill of readdirSync(path.join(BUNDLED_ROOT, category.name), { withFileTypes: true })) {
        if (!skill.isDirectory()) continue;
        if (!existsSync(path.join(BUNDLED_ROOT, category.name, skill.name, "SKILL.md"))) continue;
        onDisk.push(`${category.name}/${skill.name}`);
      }
    }
    const registered = new Set(fileBacked.map((entry) => `${entry.category}/${entry.name}`));
    expect(onDisk.filter((key) => !registered.has(key))).toEqual([]);
  });
});

describe("a rendered-only skill carries an explicit description", () => {
  for (const entry of renderedOnly) {
    test(`${entry.category}/${entry.name} declares its own routing text`, () => {
      // It ships no file, so install renders SKILL.md FROM this entry: these
      // literals are the only source, and there is no second copy to drift.
      expect(bundledSkillMarkdownPath(entry.category, entry.name)).toBeUndefined();
      expect(entry.description.trim().length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(1024);
      expect(entry.triggers.length).toBeGreaterThan(0);
    });
  }
});

test("no description is the retired `Use when ${purpose}` echo", () => {
  // The fallback is gone from catalog.ts — an entry without a description is
  // now a type error (file-backed skills read one, `renderedSkill` requires
  // one). This asserts the OUTPUT it used to produce is gone too, so the same
  // text cannot be reintroduced by hand.
  const echoes = BUNDLED_GDSKILLS.filter((entry) => {
    const echo = `Use when ${entry.purpose.charAt(0).toLowerCase()}${entry.purpose.slice(1)}`;
    return entry.description === echo;
  }).map((entry) => entry.name);
  expect(echoes).toEqual([]);
});

test("no two skills share a trigger phrase", () => {
  // A shared trigger settles nothing: both skills score the same +55 and the
  // winner is decided by alphabetical tie-break, which is not a routing
  // decision anyone made. Keyed order-free (see `triggerKey`).
  const owners = new Map<string, string[]>();
  for (const entry of BUNDLED_GDSKILLS) {
    for (const trigger of entry.triggers) {
      const key = triggerKey(trigger);
      owners.set(key, [...(owners.get(key) ?? []), entry.name]);
    }
  }

  // Non-vacuity: a catalog that produced no keys would pass trivially.
  expect(owners.size).toBeGreaterThan(300);

  const shared = [...owners.entries()]
    .filter(([, names]) => new Set(names).size > 1)
    .map(([key, names]) => `"${key}" claimed by ${[...new Set(names)].sort().join(", ")}`)
    .sort();
  expect(shared).toEqual([]);
});
