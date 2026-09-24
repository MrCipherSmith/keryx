// Flow 313 (W4 portability) — docs/requirements/keryx-agent-platform-expansion/
// workstreams/W4-portability.md, "Cross-harness memory handoff", W4-AC6/AC7.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectEntriesStrict, memoryRootFor, parseEntry } from "./store";
import { selectHandoffEntries } from "./handoff";

const IS_ROOT = process.getuid?.() === 0;

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

// R1-F5: an unreadable memory ROOT (not just a type folder inside it) used
// to report `status: "complete"` with zero entries and zero problems —
// `pathExists` swallows EACCES as "absent". Discriminating: this repro is
// exactly the reviewer's (`chmod 000` on the root itself, not a subfolder),
// which the existing "unreadable folder" test above does not cover.
test("R1-F5: an unreadable memory root is an incomplete scan, never a clean-looking complete one", async () => {
  if (IS_ROOT) return; // chmod 000 is unenforced running as root.
  const root = path.join(tmpRoot, "memory-root");
  await mkdir(path.join(root, "lessons"), { recursive: true });
  await writeFile(path.join(root, "lessons", "a.md"), entryMd({ title: "A" }), "utf8");
  await chmod(root, 0o000);
  try {
    const result = await collectEntriesStrict(root);
    expect(result.status).toBe("incomplete");
    expect(result.entries).toEqual([]);
    expect(result.problems.length).toBeGreaterThan(0);
  } finally {
    await chmod(root, 0o755);
  }
});

// R1-F5/R1-F27: a symlinked type folder (dangling or live) must never be
// silently skipped as though it were simply absent, and must never be
// traversed either way.
test("R1-F5/R1-F27: a symlinked (dangling) type folder is a named problem, not silently skipped", async () => {
  const root = path.join(tmpRoot, "memory-root");
  await mkdir(root, { recursive: true });
  await symlink(path.join(tmpRoot, "does-not-exist"), path.join(root, "lessons"));

  const result = await collectEntriesStrict(root);
  expect(result.status).toBe("incomplete");
  expect(result.problems.some((p) => p.reason === "not-a-regular-file" && p.path === "lessons/")).toBe(true);
});

// R1-F27: a memory FILE that is a symlink (even to a real, valid entry
// outside the root) is never followed/read as an entry — refused by name.
test("R1-F27: a symlinked memory file is refused, never read through", async () => {
  const root = path.join(tmpRoot, "memory-root");
  const outside = path.join(tmpRoot, "outside");
  await mkdir(path.join(root, "lessons"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.md"), entryMd({ title: "Secret" }), "utf8");
  await symlink(path.join(outside, "secret.md"), path.join(root, "lessons", "link.md"));

  const result = await collectEntriesStrict(root);
  expect(result.status).toBe("incomplete");
  expect(result.entries.map((e) => e.relativePath)).not.toContain("lessons/link.md");
  expect(result.problems.some((p) => p.reason === "not-a-regular-file" && p.path === "lessons/link.md")).toBe(true);
});

// R1-F27: non-UTF-8 bytes used to be silently decoded lossily (readFile's
// default "utf8" replaces invalid sequences with U+FFFD) instead of being
// reported — a corrupted entry read as "complete" with mangled content.
test("R1-F27: non-UTF-8 file bytes are a named unreadable-file problem, not a lossy decode", async () => {
  const root = path.join(tmpRoot, "memory-root");
  await mkdir(path.join(root, "lessons"), { recursive: true });
  const bad = Buffer.concat([
    Buffer.from("# T\n\nSource-Harness: claude\n\n"),
    Buffer.from([0xff, 0xfe, 0xc3, 0x28]),
  ]);
  await writeFile(path.join(root, "lessons", "bad.md"), bad);

  const result = await collectEntriesStrict(root);
  expect(result.status).toBe("incomplete");
  expect(result.entries.map((e) => e.relativePath)).not.toContain("lessons/bad.md");
  expect(result.problems.some((p) => p.reason === "unreadable-file" && p.path === "lessons/bad.md")).toBe(true);
});

// R1-F27: a `.md` file in an unrecognized top-level folder, nested inside a
// known type folder, or spelled with an uppercase `.MD` extension all used
// to be silently invisible to the scan — none of them raised a problem or
// appeared in `entries`, so a scan reporting "complete" could still be
// missing real content.
test("R1-F27: unknown-folder, nested and .MD-case memory files are named problems, not silently ignored", async () => {
  const root = path.join(tmpRoot, "memory-root");
  await mkdir(path.join(root, "misc"), { recursive: true });
  await mkdir(path.join(root, "lessons", "sub"), { recursive: true });
  const ok = "# T\n\nSource-Harness: claude\n\n## Summary\n\nx\n";
  await writeFile(path.join(root, "misc", "x.md"), ok, "utf8");
  await writeFile(path.join(root, "lessons", "sub", "y.md"), ok, "utf8");
  await writeFile(path.join(root, "lessons", "Z.MD"), ok, "utf8");
  await writeFile(path.join(root, "top.md"), ok, "utf8");

  const result = await collectEntriesStrict(root);
  expect(result.status).toBe("incomplete");
  const problemPaths = result.problems.filter((p) => p.reason === "unexpected-entry").map((p) => p.path);
  expect(problemPaths).toContain("misc/x.md");
  expect(problemPaths).toContain("lessons/sub/y.md");
  expect(problemPaths).toContain("lessons/Z.MD");
  expect(problemPaths).toContain("top.md");
  expect(result.entries.map((e) => e.relativePath)).not.toContain("misc/x.md");
});

// R1-F14: a present-but-invalid Target-Harnesses value must exclude the
// entry from the strict result's `entries` (fail closed for handoff), while
// still recording the problem — never silently included with a misleading
// null `targetHarnesses` that a naive reader could mistake for "no
// restriction".
test("R1-F14: an entry with a malformed Target-Harnesses header is excluded from entries, named in problems", async () => {
  const root = path.join(tmpRoot, "memory-root");
  await mkdir(path.join(root, "decisions"), { recursive: true });
  await writeFile(
    path.join(root, "decisions", "bad-target.md"),
    entryMd({ title: "Bad target", sourceHarness: "claude", targetHarnesses: "codex, Claude" }),
    "utf8",
  );

  const result = await collectEntriesStrict(root);
  expect(result.status).toBe("incomplete");
  expect(result.entries.map((e) => e.relativePath)).not.toContain("decisions/bad-target.md");
  expect(
    result.problems.some((p) => p.reason === "invalid-target-harnesses" && p.path === "decisions/bad-target.md"),
  ).toBe(true);
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
