import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MEMORY_CONFIG as C } from "./config";
import { searchEntries } from "./search";
import { collectEntries } from "./store";

// AC-C5: temporal resolution is 100% correct against the committed
// fixtures/temporal corpus (default `current` exclusion + `--as-of` interval).

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "temporal",
);

type Manifest = {
  query: string;
  current: { excludes: string[]; includes: string[] };
  asOf: Array<{ date: string; expected: string }>;
};

async function loadManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(path.join(FIXTURE, "queries.json"), "utf8")) as Manifest;
}

test("default current query excludes superseded / expired entries (AC-C5)", async () => {
  const manifest = await loadManifest();
  const entries = await collectEntries(FIXTURE);
  // Sanity: all four fixture entries parsed.
  expect(entries.length).toBe(4);

  const results = searchEntries(entries, manifest.query, {}, C, new Date("2026-07-08"));
  const paths = new Set(results.map((r) => r.entry.relativePath));

  for (const excluded of manifest.current.excludes) {
    expect(paths.has(excluded)).toBe(false);
  }
  for (const included of manifest.current.includes) {
    expect(paths.has(included)).toBe(true);
  }
});

test("--as-of returns the entry whose validity interval contains the date (AC-C5)", async () => {
  const manifest = await loadManifest();
  const entries = await collectEntries(FIXTURE);

  for (const { date, expected } of manifest.asOf) {
    const results = searchEntries(
      entries,
      manifest.query,
      { asOf: date },
      C,
      new Date("2026-07-08"),
    );
    const authPaths = results
      .map((r) => r.entry.relativePath)
      .filter((p) => p.startsWith("decisions/auth-"));
    // Exactly one authentication decision is valid at any given date.
    expect(authPaths).toEqual([expected]);
  }
});

test("control entry with no validity fields is always current and back-compatible", async () => {
  const entries = await collectEntries(FIXTURE);
  const control = entries.find((e) => e.relativePath === "decisions/logging-json.md");
  expect(control).toBeDefined();
  expect(control?.validFrom).toBeNull();
  expect(control?.validTo).toBeNull();
  expect(control?.supersededBy).toBeNull();
  // Class resolves via MEMORY_CLASS_MAP (decision ⇒ semantic) even without a header.
  expect(control?.class).toBe("semantic");
});
