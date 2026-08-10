import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { transitionMemoryStatus } from "./lifecycle";
import { createMemoryService } from "./service";
import { writeCanonicalEntry, writeCanonicalPair } from "./write";
import { ingestMemory } from "./ingest";
import { DEFAULT_MEMORY_CONFIG } from "./config";
import { memoryCommand } from "../commands/memory";
import { withCwd } from "../lib/test-cwd";

const draft = (title = "Draft decision") => `# ${title}

Version: 0.1.0
Type: decision
Status: draft
Confidence: medium

## Summary

Valid entry.

## Details

Body.

## Provenance

- Source: test
- Link:
- Created: 2026-08-10
- Updated: 2026-08-10

## Changelog

- 0.1.0 - Initial version.
`;

async function fixture(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-memory-p4-"));
  const file = path.join(root, ".metaproject", "memory", "decisions", "draft.md");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, draft(), "utf8");
  return { root, file };
}

test("P4 lifecycle table is pure, exhaustive, and treats same-state as an idempotent no-op", () => {
  expect(transitionMemoryStatus("draft", "accepted")).toEqual({ ok: true, changed: true });
  expect(transitionMemoryStatus("accepted", "draft")).toEqual({ ok: true, changed: true });
  expect(transitionMemoryStatus("conflict", "accepted")).toEqual({ ok: true, changed: true });
  expect(transitionMemoryStatus("deprecated", "draft")).toEqual({ ok: true, changed: true });
  expect(transitionMemoryStatus("accepted", "accepted")).toEqual({ ok: true, changed: false });
  expect(transitionMemoryStatus("superseded", "accepted")).toMatchObject({
    ok: false,
    error: { code: "terminal-state" },
  });
  expect(transitionMemoryStatus("draft", "superseded" as never)).toMatchObject({
    ok: false,
    error: { code: "invalid-transition" },
  });
});

test("P4 transition is audited once and terminal reactivation leaves bytes identical", async () => {
  const { root, file } = await fixture();
  try {
    const service = createMemoryService();
    const first = await service.transition({ cwd: root, path: "decisions/draft.md", to: "accepted", reason: "reviewed", now: new Date("2026-08-10T00:00:00Z") });
    expect(first).toMatchObject({ changed: true, from: "draft", to: "accepted" });
    const accepted = await readFile(file, "utf8");
    expect(accepted).toContain("Status: accepted");
    expect(accepted).toContain("draft -> accepted on 2026-08-10: reviewed");
    expect((await service.transition({ cwd: root, path: "decisions/draft.md", to: "accepted", reason: "reviewed", now: new Date("2026-08-10T00:00:00Z") })).changed).toBe(false);
    expect(await readFile(file, "utf8")).toBe(accepted);
    await writeFile(file, accepted.replace("Status: accepted", "Status: superseded"), "utf8");
    const terminal = await service.transition({ cwd: root, path: "decisions/draft.md", to: "accepted" });
    expect(terminal).toMatchObject({ changed: false, error: { code: "terminal-state" } });
    expect(await readFile(file, "utf8")).toContain("Status: superseded");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("P4 canonical seam confines paths, guards before write, and leaves no staging files", async () => {
  const { root, file } = await fixture();
  try {
    const outside = await writeCanonicalEntry({ cwd: root, relativePath: "../outside.md", content: draft() });
    expect(outside).toMatchObject({ status: "error", error: { code: "path-outside-memory" } });
    const invalid = await writeCanonicalEntry({ cwd: root, relativePath: "decisions/draft.md", content: "not an entry" });
    expect(invalid).toMatchObject({ status: "error", error: { code: "invalid-entry" } });
    const written = await writeCanonicalEntry({ cwd: root, relativePath: "decisions/draft.md", content: draft("Updated") });
    expect(written).toMatchObject({ status: "written", path: "decisions/draft.md" });
    expect(await readFile(file, "utf8")).toContain("# Updated");
    expect((await readdir(path.dirname(file))).filter((name) => name.includes(".keryx-tmp-")).length).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("P4 pair persistence rolls the first entry back byte-for-byte when the second replacement fails", async () => {
  const { root, file: first } = await fixture();
  const second = path.join(root, ".metaproject", "memory", "decisions", "second.md");
  await writeFile(second, draft("Second"), "utf8");
  const beforeFirst = await readFile(first, "utf8");
  const beforeSecond = await readFile(second, "utf8");
  try {
    const result = await writeCanonicalPair({
      cwd: root,
      entries: [
        { relativePath: "decisions/draft.md", content: draft("Changed first") },
        { relativePath: "decisions/second.md", content: draft("Changed second") },
      ],
      failReplaceAt: 2,
    });
    expect(result).toMatchObject({ status: "error", error: { code: "persistence-failed" } });
    expect(await readFile(first, "utf8")).toBe(beforeFirst);
    expect(await readFile(second, "utf8")).toBe(beforeSecond);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("P4 CLI transition is the canonical explicit acceptance path", async () => {
  const { root, file } = await fixture();
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => lines.push(values.join(" "));
  try {
    await withCwd(root, async () => memoryCommand(["transition", "decisions/draft.md", "--to", "accepted", "--reason", "reviewed"]));
    expect(await readFile(file, "utf8")).toContain("Status: accepted");
    expect(lines.join("\n")).toContain("Transitioned decisions/draft.md: draft -> accepted.");
  } finally {
    console.log = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("P4 automatic ingest remains draft-only even if legacy config requests accepted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-memory-p4-ingest-"));
  const source = path.join(root, "review.json");
  await writeFile(source, JSON.stringify({ findings: [{ message: "Keep lifecycle promotion behind explicit maintainer review." }] }), "utf8");
  try {
    const config = { ...DEFAULT_MEMORY_CONFIG, ingest: { ...DEFAULT_MEMORY_CONFIG.ingest, defaultStatus: "accepted" as const, allowAutoAccept: true } };
    const result = await ingestMemory(root, "review", "review.json", config, new Date("2026-08-10"));
    expect(result.created).toHaveLength(1);
    expect(await readFile(path.join(root, ".metaproject", "memory", result.created[0]!), "utf8")).toContain("Status: draft");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("P4 enforced lifecycle guard rejects a sensitive next value without changing canonical bytes", async () => {
  const { root, file } = await fixture();
  const sensitive = draft().replace("Body.", "Never expose aws_key = AKIAIOSFODNN7EXAMPLE.");
  await writeFile(file, sensitive, "utf8");
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), JSON.stringify({ modules: { security: { enabled: true } } }), "utf8");
  await writeFile(path.join(root, ".metaproject", "security.config.json"), JSON.stringify({ mode: "enforced" }), "utf8");
  try {
    const result = await createMemoryService().transition({ cwd: root, path: "decisions/draft.md", to: "accepted" });
    expect(result).toMatchObject({ changed: false, securitySkipped: expect.any(String) });
    expect(await readFile(file, "utf8")).toBe(sensitive);
  } finally { await rm(root, { recursive: true, force: true }); }
});
