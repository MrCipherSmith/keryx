import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDiagnosticsJournal } from "./diagnostics-journal";

test("journal writes privately and rotates while retaining recent events", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "diag-journal-"));
  try {
    const journal = createDiagnosticsJournal({ configDir: dir, sessionId: "sess/1", maxFileBytes: 120 });
    for (let n = 0; n < 100; n++) expect(journal.write({ n, text: "ж".repeat(10) }).ok).toBe(true);
    expect(path.basename(journal.path())).toBe("sess_1.events.ndjson");
    const files = readdirSync(path.dirname(journal.path()));
    expect(files).toHaveLength(2);
    for (const file of files) {
      const full = path.join(path.dirname(journal.path()), file);
      expect(statSync(full).size).toBeLessThanOrEqual(120);
      if (process.platform !== "win32") expect(statSync(full).mode & 0o777).toBe(0o600);
      for (const line of readFileSync(full, "utf8").trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(readFileSync(journal.path(), "utf8")).toContain('"n":99');
    expect(journal.write({ text: "x".repeat(200) }).ok).toBe(false);
    expect(readFileSync(journal.path(), "utf8")).toContain('"n":99');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("journal reports filesystem errors without throwing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "diag-journal-"));
  try {
    const file = path.join(dir, "file");
    writeFileSync(file, "block");
    const journal = createDiagnosticsJournal({ configDir: file, sessionId: "bad" });
    expect(journal.write({ kind: "start" }).ok).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A continuous session must write before a stall; registry integration is tested separately.
// Rotation uses byte length, not JavaScript string length (the rows above contain Cyrillic).
// An oversized row must not erase the latest evidence.
// A blocked config directory must not take down the observed review.
