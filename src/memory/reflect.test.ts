import { test, expect } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { reflectMemory } from "./reflect";
import { DEFAULT_MEMORY_CONFIG } from "./config";

function lesson(n: number, tag: string): string {
  return `# Lesson ${n}

Version: 0.1.0
Type: lesson
Status: accepted
Confidence: medium

## Summary

Summary ${n} about ${tag}.

## Tags

- ${tag}
`;
}

test("consolidates a tag cluster into a pattern draft and is idempotent", async () => {
  const root = path.join(import.meta.dir, "..", "..", ".tmp-reflect-test");
  await rm(root, { recursive: true, force: true });
  const lessons = path.join(root, ".metaproject", "memory", "lessons");
  await mkdir(lessons, { recursive: true });

  for (const n of [1, 2, 3]) {
    await writeFile(path.join(lessons, `l${n}.md`), lesson(n, "caching"), "utf8");
  }
  // A tag below the cluster threshold is ignored.
  await writeFile(path.join(lessons, "x.md"), lesson(9, "other"), "utf8");

  try {
    const first = await reflectMemory(root, DEFAULT_MEMORY_CONFIG, new Date("2026-07-07"));
    expect(first.clusters.map((c) => c.tag)).toContain("caching");
    expect(first.clusters.map((c) => c.tag)).not.toContain("other");
    expect(first.created).toContain("patterns/pattern-caching.md");

    // Second run must not recreate the existing pattern.
    const second = await reflectMemory(root, DEFAULT_MEMORY_CONFIG, new Date("2026-07-07"));
    expect(second.created.length).toBe(0);
    expect(second.skippedExisting).toBeGreaterThanOrEqual(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
