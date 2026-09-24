// Flow 313 (W4 portability) — docs/requirements/keryx-agent-platform-expansion/
// workstreams/W4-portability.md, "Cross-harness memory handoff", W4-AC6/AC7.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectEntriesStrict, memoryRootFor, parseEntry } from "./store";
import { selectHandoffEntries } from "./handoff";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "keryx-memory-handoff-test-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function entryMd(opts: { title?: string; sourceHarness?: string; targetHarnesses?: string } = {}): string {
  return `# ${opts.title ?? "Entry"}

Version: 0.1.0
Type: decision
Status: accepted
Confidence: high
${opts.sourceHarness ? `Source-Harness: ${opts.sourceHarness}\n` : ""}${opts.targetHarnesses ? `Target-Harnesses: ${opts.targetHarnesses}\n` : ""}
## Summary

A summary.

## Details

Body.

## Provenance

- Source: manual
- Created: 2026-01-01
- Updated: 2026-01-01

## Related Scopes

- Module:
- Entity:
- Files:
- Skills:

## Tags
`;
}

test("parseEntry: Source-Harness and Target-Harnesses parse when valid, null when absent/invalid", () => {
  const withFields = parseEntry(
    "/abs/decisions/a.md",
    "decisions/a.md",
    "decision",
    entryMd({ sourceHarness: "claude", targetHarnesses: "codex, cursor" }),
  );
  expect(withFields.sourceHarness).toBe("claude");
  expect(withFields.targetHarnesses).toEqual(["codex", "cursor"]);

  const absent = parseEntry("/abs/decisions/b.md", "decisions/b.md", "decision", entryMd());
  expect(absent.sourceHarness ?? null).toBeNull();
  expect(absent.targetHarnesses ?? null).toBeNull();

  const invalid = parseEntry(
    "/abs/decisions/c.md",
    "decisions/c.md",
    "decision",
    entryMd({ sourceHarness: "not-a-real-harness" }),
  );
  expect(invalid.sourceHarness ?? null).toBeNull();
});

test("memoryRootFor: project scope is the existing memoryRoot; user scope is ~/.keryx/memory", () => {
  const project = memoryRootFor("project", tmpRoot);
  expect(project).toBe(path.join(tmpRoot, ".metaproject", "memory"));

  const user = memoryRootFor("user", tmpRoot, {}, "/home/someone");
  expect(user).toBe(path.join("/home/someone", ".keryx", "memory"));
});

test("collectEntriesStrict: a clean root reports complete", async () => {
  const root = path.join(tmpRoot, "memory-root");
  await mkdir(path.join(root, "decisions"), { recursive: true });
  await writeFile(
    path.join(root, "decisions", "a.md"),
    entryMd({ title: "A", sourceHarness: "claude", targetHarnesses: "codex" }),
    "utf8",
  );

  const result = await collectEntriesStrict(root);
  expect(result.status).toBe("complete");
  expect(result.problems).toEqual([]);
  expect(result.entries.length).toBe(1);
  expect(result.entries[0]?.sourceHarness).toBe("claude");
});

test("collectEntriesStrict: an entry missing its title makes the scan incomplete", async () => {
  const root = path.join(tmpRoot, "memory-root");
  await mkdir(path.join(root, "decisions"), { recursive: true });
  await writeFile(
    path.join(root, "decisions", "bad.md"),
    "Version: 0.1.0\nType: decision\nStatus: accepted\n\n## Summary\n\ntext\n",
    "utf8",
  );

  const result = await collectEntriesStrict(root);
  expect(result.status).toBe("incomplete");
  expect(result.problems).toEqual([{ path: "decisions/bad.md", reason: "missing-title" }]);
  // Never silently drops the entry from the result either — the caller sees
  // both the entry AND that it must not be trusted as a complete answer.
  expect(result.entries.length).toBe(1);
});

test("collectEntriesStrict: an unreadable folder is named and makes the scan incomplete", async () => {
  const root = path.join(tmpRoot, "memory-root");
  const decisionsDir = path.join(root, "decisions");
  await mkdir(decisionsDir, { recursive: true });
  await writeFile(path.join(decisionsDir, "a.md"), entryMd({ title: "A" }), "utf8");
  await import("node:fs/promises").then((fs) => fs.chmod(decisionsDir, 0o000));

  try {
    const result = await collectEntriesStrict(root);
    expect(result.status).toBe("incomplete");
    expect(result.problems.some((p) => p.reason === "unreadable-folder" && p.path === "decisions/")).toBe(true);
  } finally {
    await import("node:fs/promises").then((fs) => fs.chmod(decisionsDir, 0o755));
  }
});

test("selectHandoffEntries: filters by sourceHarness and targetHarnesses inclusion", () => {
  const entries = [
    parseEntry("/a", "decisions/a.md", "decision", entryMd({ title: "A", sourceHarness: "claude", targetHarnesses: "codex" })),
    parseEntry("/b", "decisions/b.md", "decision", entryMd({ title: "B", sourceHarness: "claude" })), // no target -> all
    parseEntry("/c", "decisions/c.md", "decision", entryMd({ title: "C", sourceHarness: "claude", targetHarnesses: "cursor" })),
    parseEntry("/d", "decisions/d.md", "decision", entryMd({ title: "D", sourceHarness: "codex", targetHarnesses: "codex" })),
  ];

  const selected = selectHandoffEntries(entries, { from: "claude", target: "codex" });
  expect(selected.map((e) => e.relativePath)).toEqual(["decisions/a.md", "decisions/b.md"]);
});
