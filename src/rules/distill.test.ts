// Flow 313 (W4 portability), review round 2 fix (R2-F7): `keryx rules
// distill` used to know only about its own `keryx:index` managed block —
// a sibling managed block already installed in the same entrypoint file
// (`keryx:rules`, from `src/integrations/surfaces-rules.ts`'s opt-in
// rules-export surface, or `keryx:instructions`, from `markdown-block.ts`)
// fell through to the section splitter, which has no notion of a managed
// block and could split its start marker into one section and its end
// marker into another — leaving an ORPHANED start marker in the rewritten
// entrypoint that then made every later rules-export install/uninstall/
// doctor fail with "unterminated ... block". These tests fail on the
// pre-fix `stripManagedBlock` (which strips only `keryx:index`).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { distillAgentEntrypoints } from "./distill";

let projectRoot: string;
let metaprojectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(os.tmpdir(), "keryx-distill-"));
  metaprojectRoot = path.join(projectRoot, ".metaproject");
  await mkdir(metaprojectRoot, { recursive: true });
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

const RULES_BLOCK =
  "<!-- keryx:rules -->\n## Project rules (Keryx)\n\nCanonical source: `.metaproject/rules/`.\n<!-- /keryx:rules -->";

const INSTRUCTIONS_BLOCK =
  "<!-- keryx:instructions -->\n## Keryx\n\nA short pointer.\n<!-- /keryx:instructions -->";

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("distillAgentEntrypoints: R2-F7 a sibling keryx:rules block survives distillation intact", () => {
  test("the keryx:rules block is never split — both markers appear exactly once, still paired", async () => {
    const claudeMd = path.join(projectRoot, "CLAUDE.md");
    const content = [
      "# CLAUDE Instructions",
      "",
      "## Personal preferences",
      "",
      "Always ask before anything destructive; keep responses short and never use a harsh tone.",
      "",
      RULES_BLOCK,
      "",
      "## Architecture notes",
      "",
      "This project uses src/ TypeScript, a database, and a React frontend with MobX stores.",
      "",
    ].join("\n");
    await writeFile(claudeMd, content, "utf8");

    await distillAgentEntrypoints(projectRoot, metaprojectRoot, { enableTasks: false });

    const after = await readFile(claudeMd, "utf8");
    expect(countOccurrences(after, "<!-- keryx:rules -->")).toBe(1);
    expect(countOccurrences(after, "<!-- /keryx:rules -->")).toBe(1);
    // The block's OWN body survived byte-for-byte, not merely its markers.
    expect(after).toContain("Canonical source: `.metaproject/rules/`.");
    const start = after.indexOf("<!-- keryx:rules -->");
    const end = after.indexOf("<!-- /keryx:rules -->");
    expect(end).toBeGreaterThan(start);
  });

  test("a sibling keryx:instructions block also survives, alongside keryx:rules and the module's own keryx:index", async () => {
    const claudeMd = path.join(projectRoot, "CLAUDE.md");
    const content = [
      "# CLAUDE Instructions",
      "",
      "## Personal preferences",
      "",
      "Always ask before anything destructive; keep responses short and never use a harsh tone.",
      "",
      RULES_BLOCK,
      "",
      INSTRUCTIONS_BLOCK,
      "",
    ].join("\n");
    await writeFile(claudeMd, content, "utf8");

    await distillAgentEntrypoints(projectRoot, metaprojectRoot, { enableTasks: false });

    const after = await readFile(claudeMd, "utf8");
    expect(countOccurrences(after, "<!-- keryx:rules -->")).toBe(1);
    expect(countOccurrences(after, "<!-- /keryx:rules -->")).toBe(1);
    expect(countOccurrences(after, "<!-- keryx:instructions -->")).toBe(1);
    expect(countOccurrences(after, "<!-- /keryx:instructions -->")).toBe(1);
    expect(countOccurrences(after, "<!-- keryx:index -->")).toBe(1);
    expect(countOccurrences(after, "<!-- /keryx:index -->")).toBe(1);
  });

  test("re-running distill again (idempotent) still keeps the keryx:rules block paired", async () => {
    const claudeMd = path.join(projectRoot, "CLAUDE.md");
    const content = ["# CLAUDE Instructions", "", RULES_BLOCK, ""].join("\n");
    await writeFile(claudeMd, content, "utf8");

    await distillAgentEntrypoints(projectRoot, metaprojectRoot, { enableTasks: false });
    await distillAgentEntrypoints(projectRoot, metaprojectRoot, { enableTasks: false });

    const after = await readFile(claudeMd, "utf8");
    expect(countOccurrences(after, "<!-- keryx:rules -->")).toBe(1);
    expect(countOccurrences(after, "<!-- /keryx:rules -->")).toBe(1);
  });
});

// R3-F4: `stripManagedBlock`/`extractOtherManagedBlocks` used to match every
// marker as a bare substring (`content.indexOf(marker)`), exactly like
// `syncAgentRules`'s marker check did before its own R2-F15 fix. A line of
// PROSE that merely mentions the marker text (documenting it, not using it)
// was indistinguishable from a real block boundary, and paired with a real
// `<!-- keryx:index -->`/`<!-- /keryx:index -->` block further down —
// silently deleting every human section in between. This test fails on the
// pre-fix `indexOf`-based matchers.
describe("R3-F4: a prose mention of a marker is not mistaken for a real block boundary", () => {
  test("distill keeps human sections between a prose mention and the real keryx:index block", async () => {
    const claudeMd = path.join(projectRoot, "CLAUDE.md");
    const content = [
      "# Project",
      "",
      "Our docs mention the `<!-- keryx:index -->` marker inline in prose.",
      "",
      "## Personal tone",
      "",
      "KEEP-ME-1 never use emojis in replies.",
      "",
      "## Build",
      "",
      "KEEP-ME-2 run bun test src/ before pushing.",
      "",
      "<!-- keryx:index -->",
      "old index",
      "<!-- /keryx:index -->",
      "",
    ].join("\n");
    await writeFile(claudeMd, content, "utf8");

    const result = await distillAgentEntrypoints(projectRoot, metaprojectRoot, { enableTasks: false });

    // KEEP-ME-1/2 must survive SOMEWHERE distill's own output accounts for —
    // either kept in the rewritten entrypoint (root section) or moved into a
    // distilled rule/skill file under `metaprojectRoot` — never silently
    // dropped, which is what the pre-fix substring match did (both sections
    // ended up BETWEEN the false marker match and the real one, and the
    // whole span between them was deleted).
    const after = await readFile(claudeMd, "utf8");
    const distilledTexts = await Promise.all(
      [...result.rules, ...result.skills]
        .filter((entry): entry is typeof entry & { path: string } => entry.path !== undefined)
        .map((entry) => readFile(path.join(metaprojectRoot, entry.path), "utf8")),
    );
    const everywhere = [after, ...distilledTexts].join("\n---\n");
    expect(everywhere).toContain("KEEP-ME-1");
    expect(everywhere).toContain("KEEP-ME-2");
  });
});
