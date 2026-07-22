import { test, expect } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ingestMemory } from "./ingest";
import { DEFAULT_MEMORY_CONFIG } from "./config";
import { uniqueTestRoot } from "../lib/test-tmp";

const EXISTING = `# Avoid any in the wiki service loader

Version: 0.1.0
Type: known-mistake
Status: accepted
Confidence: medium

## Summary

Avoid using any in the loader.

## Provenance

- Source: manual
- Created: 2026-01-01
- Updated: 2026-01-01

## Tags

- health
`;

test("ingest reconciles a near-duplicate instead of creating a twin", async () => {
  const root = uniqueTestRoot(path.join(import.meta.dir, "..", ".."), ".tmp-ingest-test");
  await rm(root, { recursive: true, force: true });
  const dir = path.join(root, ".metaproject", "memory", "known-mistakes");
  await mkdir(dir, { recursive: true });
  const existingPath = path.join(dir, "avoid-any.md");
  await writeFile(existingPath, EXISTING, "utf8");
  await writeFile(
    path.join(root, "health.json"),
    JSON.stringify({ findings: [{ message: "Avoid any in the wiki service loader" }] }),
  );

  try {
    const result = await ingestMemory(root, "health", "health.json", DEFAULT_MEMORY_CONFIG, new Date("2026-07-07"));
    expect(result.created.length).toBe(0);
    expect(result.reconciled).toContain("known-mistakes/avoid-any.md");

    const updated = await readFile(existingPath, "utf8");
    expect(updated).toContain("Reconciled: health 2026-07-07");
    expect(updated).toContain("- Updated: 2026-07-07");

    // Idempotent: re-ingesting the same source/date adds nothing.
    const again = await ingestMemory(root, "health", "health.json", DEFAULT_MEMORY_CONFIG, new Date("2026-07-07"));
    expect(again.reconciled.length).toBe(0);
    expect(again.created.length).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
