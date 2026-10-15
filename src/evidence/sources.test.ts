import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const sourceModule = "./sources";
let base: string;
let projectRoot: string;
const scanner = async (text: string) => ({ code: "ok", text, redaction: "not-needed" });
async function read(relativePath: string, overrides: Record<string, unknown> = {}) {
  const { readEvidenceFile } = await import(sourceModule);
  return readEvidenceFile({ projectRoot, path: relativePath, roots: ["docs"],
    maxSourceBytes: 1024, scanner, ...overrides });
}
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "keryx-erl-"));
  projectRoot = path.join(base, "project");
  await mkdir(path.join(projectRoot, "docs"), { recursive: true });
  await writeFile(path.join(projectRoot, "docs/note.txt"), "Evidence π\n");
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

describe("ERL safe file adapter (AC3/AC6)", () => {
  test("returns sanitized text and full raw-byte hash, never policy", async () => {
    const result = await read("docs/note.txt");
    expect(result.code).toBe("ok");
    expect(result.text).toBe("Evidence π\n");
    expect(result.versionHash).toBe(createHash("sha256").update("Evidence π\n").digest("hex"));
    expect(result.trustedAsPolicy).toBe(false);
    expect(result.redaction).toBe("not-needed");
  });
  for (const denied of ["../outside.txt", "/etc/passwd", "docs/../../outside.txt",
    "docs/.env.local", "docs/.git/config", "docs/node_modules/pkg/index.js"]) {
    test(`denies unsafe path ${denied}`, async () => {
      const result = await read(denied);
      expect(result.code).toBe("source-unavailable");
      expect(result.diagnostics).toContain("source-denied");
      expect(result.text).toBeUndefined();
    });
  }
  test("symlink escape cannot authorize outside bytes", async () => {
    await writeFile(path.join(base, "outside.txt"), "outside corpus");
    await symlink(path.join(base, "outside.txt"), path.join(projectRoot, "docs/link.txt"));
    expect((await read("docs/link.txt")).code).toBe("source-unavailable");
  });
  test("no roots means no permission", async () => {
    expect((await read("docs/note.txt", { roots: [] })).code).toBe("source-unavailable");
  });
  test("unavailable scanner fails closed", async () => {
    expect((await read("docs/note.txt", { scanner: undefined })).code).toBe("source-unavailable");
  });
  test("oversize sources are refused, not clipped", async () => {
    expect((await read("docs/note.txt", { maxSourceBytes: 1 })).code).toBe("source-unavailable");
  });
  test("changed scanner output cannot claim identical original bytes", async () => {
    const result = await read("docs/note.txt", { scanner: async () => ({ code: "ok", text: "changed", redaction: "not-needed" }) });
    expect(result.code).toBe("source-unavailable");
    expect(result.text).toBeUndefined();
  });
  test("scanner expansion is bounded before returning sanitized text", async () => {
    const result = await read("docs/note.txt", { scanner: async () => ({ code: "ok", text: "x".repeat(8 * 1024 * 1024 + 1), redaction: "applied" }) });
    expect(result.code).toBe("source-unavailable");
    expect(result.text).toBeUndefined();
  });
  test("redaction precedes any returned text", async () => {
    const redactor = async () => ({ code: "ok", text: "sanitized", redaction: "applied" });
    const result = await read("docs/note.txt", { scanner: redactor });
    expect(result.text).toBe("sanitized");
    expect(result.redaction).toBe("applied");
  });
});

describe("ERL scanner and archive fail-closed contracts", () => {
  test("scanner failures never return raw text", async () => {
    for (const scanner of [async () => { throw Error("private content"); }, async () => ({ code: "blocked" }), async () => ({ code: "ok", text: "x", redaction: "unknown" })]) {
      const result = await read("docs/note.txt", { scanner });
      expect(result.code).toBe("source-unavailable"); expect(result.text).toBeUndefined(); expect(JSON.stringify(result)).not.toContain("private content");
    }
  });
  test("directory and invalid UTF8 are refused", async () => {
    expect((await read("docs")).code).toBe("source-unavailable");
    await writeFile(path.join(projectRoot, "docs/binary"), Buffer.from([255, 254]));
    expect((await read("docs/binary")).code).toBe("source-unavailable");
  });
  async function fixture() {
    const { createSession, persistHistory } = await import("../session/store");
    const handle = createSession({ cwd: projectRoot, dataDir: path.join(base, "data"), id: "fixture-session" });
    persistHistory(handle, [{ role: "user", content: "original evidence" }, { role: "assistant", content: "reply" }, { role: "system", content: "not evidence policy" }]);
    return handle;
  }
  async function archive(overrides: Record<string, unknown> = {}) {
    const { readEvidenceArchive } = await import(sourceModule);
    return readEvidenceArchive({ projectRoot, sessionId: "fixture-session", dataDir: path.join(base, "data"), sessionArchives: true, maxSourceBytes: 4096, scanner, ...overrides });
  }
  test("archives require opt-in, scanner and contained session id", async () => {
    await fixture();
    for (const opts of [{ sessionArchives: false }, { scanner: undefined }, { sessionId: "../fixture-session" }]) expect((await archive(opts)).code).toBe("source-unavailable");
  });
  test("complete textual records only; torn bytes bind full version hash", async () => {
    const handle = await fixture(); const before = await archive();
    expect(before.code).toBe("ok"); expect(before.records.map((r: { text: string }) => r.text)).toEqual(["original evidence", "reply"]);
    expect(before.records.every((r: { recordId: string; trustedAsPolicy: boolean }) => r.recordId && r.trustedAsPolicy === false)).toBe(true);
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path.join(handle.dir, "archive.jsonl"), '{"role":"user","content":"torn');
    const after = await archive(); expect(after.records).toEqual(before.records); expect(after.versionHash).not.toBe(before.versionHash);
    expect(after.archiveCheckpoint).toEqual(before.archiveCheckpoint);
    expect(after.canReuseArchive(before.archiveCheckpoint)).toBe(true);
    expect(after.canReuseArchive({ ...before.archiveCheckpoint, ino: "0" })).toBe(false);
    expect(JSON.stringify(after.archiveCheckpoint)).not.toContain("original evidence");
  });
  test("missing or foreign ownership refuses bytes", async () => {
    const handle = await fixture();
    await writeFile(path.join(handle.dir, "summary.json"), JSON.stringify({ projectPath: base, id: "fixture-session" }));
    expect((await archive()).code).toBe("source-unavailable"); await rm(path.join(handle.dir, "summary.json")); expect((await archive()).code).toBe("source-unavailable");
  });
  test("archive records are sanitized before return", async () => {
    await fixture(); const result = await archive({ scanner: async () => ({ code: "ok", text: "sanitized", redaction: "applied" }) });
    expect(result.code).toBe("ok"); expect(result.records.every((r: { text: string }) => r.text === "sanitized")).toBe(true);
  });
  test("a warm archive cursor reruns the current scanner and fails closed", async () => {
    const { ArchiveCursor } = await import("./archive-cursor");
    const cursor = new ArchiveCursor();
    const cursorAccess = { cursor, checkpoint: () => {} };
    try {
      await fixture();
      expect((await archive({ cursorAccess })).code).toBe("ok");
      let scanned = 0;
      const changed = await archive({ cursorAccess, scanner: async () => {
        scanned++; return { code: "ok", text: "new policy redaction", redaction: "applied" };
      } });
      expect(scanned).toBe(2);
      expect(changed.records.map((r: { text: string }) => r.text)).toEqual(["new policy redaction", "new policy redaction"]);
      const blocked = await archive({ cursorAccess, scanner: async () => ({ code: "blocked" }) });
      expect(blocked.code).toBe("source-unavailable");
      expect(blocked.records).toBeUndefined();
    } finally { cursor.clear(); }
  });
});
