import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeWikiConfig } from "./config";
import {
  createWikiWriteContext,
  deleteWikiPage,
  listWikiRuns,
  pageHistoryDir,
  parsePageHistoryIndex,
  readPageHistory,
  readWikiRuns,
  renderPageHistoryIndex,
  restoreWikiPage,
  restoreWikiRun,
  type WikiWriteContext,
  wikiHistoryRoot,
  writeWikiPage,
} from "./history";

let root: string;
let clock: number;

// A 0o444 page is only unwritable for a non-root user on a POSIX filesystem;
// as root, or on Windows, the read-only tests would assert nothing (review r1 T-007).
const canMakeReadOnly = process.platform !== "win32" && process.getuid?.() !== 0;

function ctx(command: string, keep?: number): WikiWriteContext {
  return createWikiWriteContext(root, command, {
    now: () => new Date((clock += 1000)),
    ...(keep !== undefined ? { keep } : {}),
  });
}

function wikiPath(page: string): string {
  return path.join(root, ".metaproject", "wiki", ...page.split("/"));
}

async function seed(page: string, content: string): Promise<void> {
  await mkdir(path.dirname(wikiPath(page)), { recursive: true });
  await writeFile(wikiPath(page), content, "utf8");
}

async function live(page: string): Promise<string | null> {
  try {
    return await readFile(wikiPath(page), "utf8");
  } catch {
    return null;
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-wiki-history-"));
  clock = Date.parse("2026-10-01T10:00:00.000Z");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("writeWikiPage", () => {
  test("AC1: the prior bytes are stored as a version file before the page changes", async () => {
    const original = "---\nTitle: A\nVersion: 0.2.0\n---\n# A\n\nHand-written prose.\n";
    await seed("components/a.md", original);

    const result = await writeWikiPage(ctx("wiki enrich"), wikiPath("components/a.md"), "# A\n\nreplaced\n");

    expect(result).toEqual({ changed: true, action: "updated" });
    const history = await readPageHistory(root, "components/a.md");
    expect(history!.rows.map((row) => [row.version, row.by])).toEqual([
      [2, "wiki enrich"],
      [1, "baseline (before history)"],
    ]);
    const stored = await readFile(path.join(pageHistoryDir(root, "components/a.md"), history!.rows[1]!.file), "utf8");
    expect(stored).toBe(original);
    expect(await live("components/a.md")).toBe("# A\n\nreplaced\n");
  });

  test("AC1: the history lives outside the wiki root, as plain .md files, never an archive", async () => {
    await seed("components/a.md", "one\n");
    await writeWikiPage(ctx("wiki enrich"), wikiPath("components/a.md"), "two\n");

    const files = (await readdir(pageHistoryDir(root, "components/a.md"))).sort();
    expect(files.length).toBe(3);
    expect(files[0]).toBe("index.md");
    expect(files[1]).toMatch(/^v0001-[0-9T-]+Z\.md$/);
    expect(files[2]).toMatch(/^v0002-[0-9T-]+Z\.md$/);
    expect(await readdir(path.join(root, ".metaproject", "wiki", "components"))).toEqual(["a.md"]);
  });

  test("AC1: index.md marks the current version and links every stored version", async () => {
    await seed("components/a.md", "one\n");
    const run = ctx("wiki collect --force");
    await writeWikiPage(run, wikiPath("components/a.md"), "two\n");

    const index = await readFile(path.join(pageHistoryDir(root, "components/a.md"), "index.md"), "utf8");
    expect(index).toContain("current: v0002");
    expect(index).toContain(`| v0002 (current) |`);
    expect(index).toContain(`| wiki collect --force | ${run.runId} |`);
    expect(index).toMatch(/\[v0001\]\(v0001-[^)]+\.md\)/);
    expect(index).toMatch(/\[v0002\]\(v0002-[^)]+\.md\)/);
  });

  test("AC3: byte-identical content records nothing", async () => {
    await seed("components/a.md", "same\n");
    const result = await writeWikiPage(ctx("wiki enrich"), wikiPath("components/a.md"), "same\n");
    expect(result).toEqual({ changed: false });
    expect(await readPageHistory(root, "components/a.md")).toBeNull();
  });

  test("a page keryx creates gets a single version and no baseline", async () => {
    const result = await writeWikiPage(ctx("wiki collect"), wikiPath("decisions/new.md"), "new\n");
    expect(result).toEqual({ changed: true, action: "created" });
    const history = await readPageHistory(root, "decisions/new.md");
    expect(history!.rows.map((row) => row.by)).toEqual(["wiki collect"]);
  });

  test("AC3: a hand edit since the last keryx write is recorded as manual (detected) before the next write", async () => {
    await seed("components/a.md", "one\n");
    await writeWikiPage(ctx("wiki enrich"), wikiPath("components/a.md"), "two\n");
    await writeFile(wikiPath("components/a.md"), "hand edit\n", "utf8");

    await writeWikiPage(ctx("wiki enrich"), wikiPath("components/a.md"), "three\n");

    const history = await readPageHistory(root, "components/a.md");
    expect(history!.rows.map((row) => [row.version, row.by])).toEqual([
      [4, "wiki enrich"],
      [3, "manual (detected)"],
      [2, "wiki enrich"],
      [1, "baseline (before history)"],
    ]);
    const manual = await readFile(path.join(pageHistoryDir(root, "components/a.md"), history!.rows[1]!.file), "utf8");
    expect(manual).toBe("hand edit\n");
    // The keryx version the hand edit replaced is still there.
    const keryxV2 = await readFile(path.join(pageHistoryDir(root, "components/a.md"), history!.rows[2]!.file), "utf8");
    expect(keryxV2).toBe("two\n");
  });

  test("a hand revert to the previous content drops no version", async () => {
    await seed("components/a.md", "one\n");
    await writeWikiPage(ctx("wiki enrich"), wikiPath("components/a.md"), "two\n");
    await writeFile(wikiPath("components/a.md"), "one\n", "utf8");

    await writeWikiPage(ctx("wiki enrich"), wikiPath("components/a.md"), "three\n");

    const history = await readPageHistory(root, "components/a.md");
    expect(history!.rows.map((row) => [row.version, row.by])).toEqual([
      [4, "wiki enrich"],
      [3, "manual (detected)"],
      [2, "wiki enrich"],
      [1, "baseline (before history)"],
    ]);
    const v2 = await readFile(path.join(pageHistoryDir(root, "components/a.md"), history!.rows[2]!.file), "utf8");
    expect(v2).toBe("two\n");
  });

  test("AC3: a failure to record the prior version leaves the page untouched", async () => {
    await seed("components/a.md", "one\n");
    // A file where the page's history folder must go makes recording impossible.
    await mkdir(path.join(wikiHistoryRoot(root), "components"), { recursive: true });
    await writeFile(path.join(wikiHistoryRoot(root), "components", "a"), "not a directory", "utf8");

    await expect(writeWikiPage(ctx("wiki enrich"), wikiPath("components/a.md"), "two\n")).rejects.toThrow();
    expect(await live("components/a.md")).toBe("one\n");
  });

  test.skipIf(!canMakeReadOnly)("a read-only page is refused, not replaced, and the history is left as it was", async () => {
    await seed("components/a.md", "one\n");
    await writeWikiPage(ctx("wiki enrich"), wikiPath("components/a.md"), "two\n");
    const before = await readFile(path.join(pageHistoryDir(root, "components/a.md"), "index.md"), "utf8");
    const filesBefore = (await readdir(pageHistoryDir(root, "components/a.md"))).sort();
    await chmod(wikiPath("components/a.md"), 0o444);
    try {
      await expect(writeWikiPage(ctx("wiki enrich"), wikiPath("components/a.md"), "three\n")).rejects.toThrow();
      expect(await live("components/a.md")).toBe("two\n");
      expect(await readFile(path.join(pageHistoryDir(root, "components/a.md"), "index.md"), "utf8")).toBe(before);
      expect((await readdir(pageHistoryDir(root, "components/a.md"))).sort()).toEqual(filesBefore);
    } finally {
      await chmod(wikiPath("components/a.md"), 0o644);
    }
  });

  test.skipIf(!canMakeReadOnly)("a failed write never leaves the index pointing at a pruned (deleted) version file", async () => {
    await seed("components/a.md", "v1\n");
    await writeWikiPage(ctx("wiki enrich", 2), wikiPath("components/a.md"), "v2\n");
    await chmod(wikiPath("components/a.md"), 0o444);
    try {
      // keep=2 would prune v1 on this write; the write fails, so nothing may be pruned.
      await expect(writeWikiPage(ctx("wiki enrich", 2), wikiPath("components/a.md"), "v3\n")).rejects.toThrow();
    } finally {
      await chmod(wikiPath("components/a.md"), 0o644);
    }
    const history = await readPageHistory(root, "components/a.md");
    for (const row of history!.rows) {
      if (row.file.endsWith(".md")) {
        expect(await readFile(path.join(pageHistoryDir(root, "components/a.md"), row.file), "utf8")).toBeDefined();
      }
    }
    expect((await restoreWikiPage(ctx("wiki restore"), "components/a.md", 1)).restoredTo).toBe("v0001");
  });

  test("AC3: retention keeps the newest N stored versions and marks older ones pruned", async () => {
    await seed("components/a.md", "v1\n");
    for (const content of ["v2\n", "v3\n", "v4\n"]) {
      await writeWikiPage(ctx("wiki enrich", 2), wikiPath("components/a.md"), content);
    }
    const history = await readPageHistory(root, "components/a.md");
    expect(history!.rows.map((row) => [row.version, row.file.endsWith(".md") ? "stored" : row.file])).toEqual([
      [4, "stored"],
      [3, "stored"],
      [2, "(pruned)"],
      [1, "(pruned)"],
    ]);
    const files = (await readdir(pageHistoryDir(root, "components/a.md"))).filter((file) => file !== "index.md");
    expect(files.length).toBe(2);
  });

  test("retention config: missing, zero and negative all degrade to a positive keep", () => {
    expect(mergeWikiConfig({}).history.keep).toBe(20);
    expect(mergeWikiConfig({ history: { keep: 5 } }).history.keep).toBe(5);
    expect(mergeWikiConfig({ history: { keep: 0 } }).history.keep).toBe(20);
    expect(mergeWikiConfig({ history: { keep: -3 } }).history.keep).toBe(20);
    expect(mergeWikiConfig({ history: { keep: 0.5 } }).history.keep).toBe(1);
  });
});

describe("deleteWikiPage", () => {
  test("keeps the last content before deleting", async () => {
    await seed("components/gone.md", "last words\n");
    const result = await deleteWikiPage(ctx("sync --apply"), wikiPath("components/gone.md"));

    expect(result).toEqual({ changed: true, action: "deleted" });
    expect(await live("components/gone.md")).toBeNull();
    const history = await readPageHistory(root, "components/gone.md");
    expect(history!.rows[0]!.sha).toBe("(deleted)");
    const kept = await readFile(path.join(pageHistoryDir(root, "components/gone.md"), history!.rows[1]!.file), "utf8");
    expect(kept).toBe("last words\n");
  });
});

describe("restore", () => {
  test("AC2: restore <page> --version puts back the exact bytes", async () => {
    const original = "---\nTitle: A\n---\n﻿unicode — ok\r\nCRLF line\n";
    await seed("components/a.md", original);
    await writeWikiPage(ctx("wiki enrich"), wikiPath("components/a.md"), "rewritten\n");

    const outcome = await restoreWikiPage(ctx("wiki restore"), "components/a.md", 1);

    expect(outcome).toEqual({ page: "components/a.md", restoredTo: "v0001", action: "restored" });
    expect(Buffer.compare(await readFile(wikiPath("components/a.md")), Buffer.from(original, "utf8"))).toBe(0);
    // The restore is itself a version, so it can be undone.
    const history = await readPageHistory(root, "components/a.md");
    expect(history!.rows[0]!.by).toBe("wiki restore");
  });

  test("AC2/AC4: restore --run undoes every page a run touched, incl. created and deleted pages", async () => {
    await seed("components/changed.md", "changed: before\n");
    await seed("components/removed.md", "removed: before\n");
    await seed("components/untouched.md", "untouched\n");
    const snapshot = await readTree(path.join(root, ".metaproject", "wiki"));

    const run = ctx("sync --apply");
    await writeWikiPage(run, wikiPath("components/changed.md"), "changed: after\n");
    await writeWikiPage(run, wikiPath("components/added.md"), "added\n");
    await deleteWikiPage(run, wikiPath("components/removed.md"));
    // The same page twice in one run: restore goes to the version before the FIRST.
    await writeWikiPage(run, wikiPath("components/changed.md"), "changed: after again\n");

    const result = await restoreWikiRun(ctx("wiki restore"), run.runId);

    expect(result.conflicts).toEqual([]);
    expect(result.restored.map((r) => [r.page, r.action, r.restoredTo])).toEqual([
      ["components/added.md", "deleted", "(absent)"],
      ["components/changed.md", "restored", "v0001"],
      ["components/removed.md", "restored", "v0001"],
    ]);
    expect(await readTree(path.join(root, ".metaproject", "wiki"))).toEqual(snapshot);
  });

  test("AC4: a run that aborts after K pages is undone by restore --run", async () => {
    for (const name of ["p1", "p2", "p3", "p4"]) await seed(`components/${name}.md`, `${name} before\n`);
    const snapshot = await readTree(path.join(root, ".metaproject", "wiki"));

    const run = ctx("wiki enrich --all --force");
    const pages = ["p1", "p2", "p3", "p4"];
    await expect((async () => {
      for (const [index, name] of pages.entries()) {
        if (index === 2) throw new Error("provider 406");
        await writeWikiPage(run, wikiPath(`components/${name}.md`), `${name} after\n`);
      }
    })()).rejects.toThrow("provider 406");

    const result = await restoreWikiRun(ctx("wiki restore"), run.runId);
    expect(result.restored.length).toBe(2);
    expect(await readTree(path.join(root, ".metaproject", "wiki"))).toEqual(snapshot);
  });

  test("restore --run leaves a page changed after the run alone, unless forced", async () => {
    await seed("components/a.md", "before\n");
    const run = ctx("wiki enrich");
    await writeWikiPage(run, wikiPath("components/a.md"), "run output\n");
    await writeFile(wikiPath("components/a.md"), "edited by hand later\n", "utf8");

    const cautious = await restoreWikiRun(ctx("wiki restore"), run.runId);
    expect(cautious.restored).toEqual([]);
    expect(cautious.conflicts.map((c) => c.page)).toEqual(["components/a.md"]);
    expect(await live("components/a.md")).toBe("edited by hand later\n");

    const forced = await restoreWikiRun(ctx("wiki restore"), run.runId, { force: true });
    expect(forced.restored.map((r) => r.action)).toEqual(["restored"]);
    expect(await live("components/a.md")).toBe("before\n");
    // The hand edit forced over is itself kept as a version.
    const history = await readPageHistory(root, "components/a.md");
    expect(history!.rows.some((row) => row.by === "manual (detected)")).toBe(true);
  });

  test("restore <page> without --version undoes a hand edit back to the last recorded version", async () => {
    await seed("components/a.md", "v1\n");
    await writeWikiPage(ctx("wiki collect --force"), wikiPath("components/a.md"), "v2 from collect\n");
    await writeFile(wikiPath("components/a.md"), "damaged by hand\n", "utf8");

    const outcome = await restoreWikiPage(ctx("wiki restore"), "components/a.md");

    expect(outcome.restoredTo).toBe("v0002");
    expect(await live("components/a.md")).toBe("v2 from collect\n");
    // The damaged content is not lost either: recorded as a manual version.
    const history = await readPageHistory(root, "components/a.md");
    expect(history!.rows.some((row) => row.by === "manual (detected)")).toBe(true);
  });

  test("a pruned version cannot be restored and says so", async () => {
    await seed("components/a.md", "v1\n");
    for (const content of ["v2\n", "v3\n"]) await writeWikiPage(ctx("wiki enrich", 1), wikiPath("components/a.md"), content);
    await expect(restoreWikiPage(ctx("wiki restore"), "components/a.md", 1)).rejects.toThrow("no stored copy");
  });

  test("a version file altered on disk is refused, not restored", async () => {
    await seed("components/a.md", "v1\n");
    await writeWikiPage(ctx("wiki enrich"), wikiPath("components/a.md"), "v2\n");
    const history = await readPageHistory(root, "components/a.md");
    await writeFile(path.join(pageHistoryDir(root, "components/a.md"), history!.rows[1]!.file), "tampered\n", "utf8");
    await expect(restoreWikiPage(ctx("wiki restore"), "components/a.md", 1)).rejects.toThrow("sha256");
    expect(await live("components/a.md")).toBe("v2\n");
  });
});

describe("review round 1 fixes", () => {
  const indexOf = (page: string): string => path.join(pageHistoryDir(root, page), "index.md");

  test("S-001: a crafted index row naming a file outside the history folder is neither pruned nor restored", async () => {
    await seed("components/a.md", "v1\n");
    await writeWikiPage(ctx("wiki enrich"), wikiPath("components/a.md"), "v2\n");
    await writeFile(path.join(root, "victim.md"), "must survive\n", "utf8");
    await writeFile(path.join(root, "secret.md"), "secret\n", "utf8");
    // Point v1 at a file two levels above the history folder.
    const index = await readFile(indexOf("components/a.md"), "utf8");
    const crafted = index.replace(/\[v0001\]\([^)]+\)/, "[v0001](../../../../../victim.md)");
    await writeFile(indexOf("components/a.md"), crafted, "utf8");

    // keep=1 would prune v1 on this write: the traversal row must not be deleted.
    await writeWikiPage(ctx("wiki enrich", 1), wikiPath("components/a.md"), "v3\n");
    expect(await readFile(path.join(root, "victim.md"), "utf8")).toBe("must survive\n");

    const history = await readPageHistory(root, "components/a.md");
    expect(history!.rows.find((row) => row.version === 1)!.file).not.toContain("victim");
    await expect(restoreWikiPage(ctx("wiki restore"), "components/a.md", 1)).rejects.toThrow("no stored copy");
  });

  test("S-006: a command label cannot break the index table or open a code span", () => {
    const label = createWikiWriteContext(root, "wiki enrich --prompt `a | b`\nnext").command;
    expect(label).toBe("wiki enrich --prompt 'a b' next");
  });

  test("S-002: a page key with .. segments is refused before any path is built", async () => {
    await expect(restoreWikiPage(ctx("wiki restore"), "../../secret.md")).rejects.toThrow("not a wiki page path");
    expect(() => pageHistoryDir(root, "components/../../x.md")).toThrow("not a wiki page path");
    expect(() => pageHistoryDir(root, "/etc/passwd")).toThrow("not a wiki page path");
  });

  test("S-003: the history tree ignores itself for git, whatever the project's gitignore says", async () => {
    await writeWikiPage(ctx("wiki collect"), wikiPath("components/a.md"), "a\n");
    expect(await readFile(path.join(wikiHistoryRoot(root), ".gitignore"), "utf8")).toMatch(/^\*$/m);
  });

  test("S-004: the index is bounded; old rows go once their copies are pruned", async () => {
    await seed("components/a.md", "0\n");
    for (let index = 1; index <= 10; index += 1) {
      await writeWikiPage({ ...ctx("wiki enrich", 3), maxIndexRows: 6 }, wikiPath("components/a.md"), `${index}\n`);
    }
    const history = await readPageHistory(root, "components/a.md");
    expect(history!.rows.length).toBe(6);
    expect(history!.rows[0]!.version).toBe(11);
    expect(history!.rows.filter((row) => row.file.endsWith(".md")).length).toBe(3);
  });

  test("S-004: runs.jsonl is trimmed to its newest half once it passes 2 MB", async () => {
    await mkdir(wikiHistoryRoot(root), { recursive: true });
    const filler = `${JSON.stringify({ runId: "run-old", command: "x", page: "components/old.md", at: "2026-01-01T00:00:00.000Z", action: "updated" })}\n`;
    await writeFile(path.join(wikiHistoryRoot(root), "runs.jsonl"), filler.repeat(Math.ceil((2 * 1024 * 1024) / filler.length) + 10), "utf8");

    const run = ctx("wiki enrich");
    await writeWikiPage(run, wikiPath("components/a.md"), "a\n");

    const { size } = await stat(path.join(wikiHistoryRoot(root), "runs.jsonl"));
    expect(size).toBeLessThan(2 * 1024 * 1024);
    expect((await listWikiRuns(root)).some((entry) => entry.runId === run.runId)).toBe(true);
  });

  test("L-002: restore --run reports a page it cannot restore and still restores the rest", async () => {
    await seed("components/a.md", "a before\n");
    await seed("components/b.md", "b before\n");
    const run = ctx("wiki enrich");
    await writeWikiPage(run, wikiPath("components/a.md"), "a after\n");
    await writeWikiPage(run, wikiPath("components/b.md"), "b after\n");
    // Prune a's pre-run copy by writing it twice more with keep=1, then put the run's bytes back.
    await writeWikiPage(ctx("wiki enrich", 1), wikiPath("components/a.md"), "a later\n");
    await writeWikiPage(ctx("wiki enrich", 1), wikiPath("components/a.md"), "a after\n");

    const result = await restoreWikiRun(ctx("wiki restore"), run.runId, { force: true });

    expect(result.conflicts.map((conflict) => conflict.page)).toEqual(["components/a.md"]);
    expect(result.restored.map((outcome) => outcome.page)).toEqual(["components/b.md"]);
    expect(await live("components/b.md")).toBe("b before\n");
  });

  test.skipIf(!canMakeReadOnly)("L-009: a page the run logged but could not write is a conflict on restore, not an abort", async () => {
    await seed("components/a.md", "a\n");
    await seed("components/b.md", "b before\n");
    const run = ctx("wiki enrich");
    await writeWikiPage(run, wikiPath("components/b.md"), "b after\n");
    await chmod(wikiPath("components/a.md"), 0o444);
    try {
      await expect(writeWikiPage(run, wikiPath("components/a.md"), "a after\n")).rejects.toThrow();
    } finally {
      await chmod(wikiPath("components/a.md"), 0o644);
    }
    expect((await readWikiRuns(root)).filter((entry) => entry.runId === run.runId).map((entry) => entry.page).sort())
      .toEqual(["components/a.md", "components/b.md"]);

    const result = await restoreWikiRun(ctx("wiki restore"), run.runId);
    expect(result.restored.map((outcome) => outcome.page)).toEqual(["components/b.md"]);
    expect(result.conflicts.map((conflict) => conflict.page)).toEqual(["components/a.md"]);
    expect(await live("components/a.md")).toBe("a\n");
  });
});

describe("index and runs", () => {
  test("index.md round-trips through render and parse", async () => {
    await seed("components/a.md", "v1\n");
    await writeWikiPage(ctx("wiki enrich"), wikiPath("components/a.md"), "v2\n");
    await deleteWikiPage(ctx("sync --apply"), wikiPath("components/a.md"));
    const history = await readPageHistory(root, "components/a.md");
    expect(parsePageHistoryIndex(renderPageHistoryIndex(history!), "components/a.md")).toEqual(history!);
  });

  test("listWikiRuns groups pages per run, newest first", async () => {
    const first = ctx("wiki collect");
    await writeWikiPage(first, wikiPath("components/a.md"), "a\n");
    await writeWikiPage(first, wikiPath("components/b.md"), "b\n");
    const second = ctx("wiki enrich");
    await writeWikiPage(second, wikiPath("components/a.md"), "a2\n");

    const runs = await listWikiRuns(root);
    expect(runs.map((run) => [run.runId, run.command, run.pages])).toEqual([
      [second.runId, "wiki enrich", 1],
      [first.runId, "wiki collect", 2],
    ]);
  });

  test("a page whose mtime predates history gets that mtime as its baseline time", async () => {
    await seed("components/a.md", "old\n");
    await utimes(wikiPath("components/a.md"), new Date("2026-09-01T00:00:00Z"), new Date("2026-09-01T00:00:00Z"));
    await writeWikiPage(ctx("wiki enrich"), wikiPath("components/a.md"), "new\n");
    const history = await readPageHistory(root, "components/a.md");
    expect(history!.rows[1]!.at).toBe("2026-09-01T00:00:00.000Z");
  });
});

async function readTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[path.relative(dir, full)] = await readFile(full, "base64");
    }
  };
  await walk(dir);
  return out;
}
