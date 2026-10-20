import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkMemory } from "./check";
import { DEFAULT_MEMORY_CONFIG } from "./config";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-memory-check-"));
  roots.push(root);
  return root;
}

async function writeEntry(
  cwd: string,
  folder: string,
  slug: string,
  title: string,
  type: string,
  summary: string,
  tags: readonly string[] = [],
): Promise<void> {
  const dir = path.join(cwd, ".metaproject", "memory", folder);
  await mkdir(dir, { recursive: true });
  const tagSection = tags.length > 0 ? `\n## Tags\n\n${tags.map((tag) => `- ${tag}`).join("\n")}\n` : "";
  await writeFile(
    path.join(dir, `${slug}.md`),
    `# ${title}\n\nVersion: 0.1.0\nType: ${type}\nStatus: draft\nConfidence: medium\n\n## Summary\n\n${summary}\n${tagSection}`,
  );
}

const reviewSummary = (id: string): string =>
  `review-logic raised ${id} (minor) and the round recorded it as \`dismissed-incorrect\` — the one disposition that says the reviewer was wrong.`;

test("two review notes from the shared template are not reported as near-duplicates of each other", async () => {
  const cwd = await project();
  // Two different findings from two different rounds, written the way
  // `src/review/review-notes.ts` writes them.
  for (const [slug, id] of [
    ["2026-09-28-pr-782-round2__L3", "2026-09-28-pr-782-round1#L3"],
    ["2026-09-27-ingest-e0be2cfd__L1", "2026-09-27-pr-9a2bbf62#L1"],
  ] as const) {
    await writeEntry(cwd, "review-notes", slug, `Review finding ${id} was dismissed as incorrect`, "review-note", reviewSummary(id), [
      "review-note",
      "false-positive",
    ]);
  }

  const result = await checkMemory(cwd, DEFAULT_MEMORY_CONFIG);
  expect(result.issues.filter((issue) => issue.kind === "dedup")).toEqual([]);
});

test("near-duplicate detection still reports two other entries with the same title", async () => {
  const cwd = await project();
  await writeEntry(cwd, "lessons", "one", "A fix round needs its own review", "lesson", "Three fix rounds each introduced a blocker.");
  await writeEntry(cwd, "lessons", "two", "A fix round needs its own review", "lesson", "Fix rounds introduce new blockers.");

  const result = await checkMemory(cwd, DEFAULT_MEMORY_CONFIG);
  expect(result.issues.filter((issue) => issue.kind === "dedup")).toHaveLength(1);
});
