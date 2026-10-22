import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { completionWriter } from "./completion-write";
import { completionSnapshot } from "./completion-snapshot";

test("rollback restores its own writes but preserves subsequent external edits", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "completion-rollback-"));
  try {
    const names = ["manifest.json", "report.md", "research.json", "findings.json", "decisions.md"];
    const original = names.map((name) => `original ${name}`);
    await Promise.all(names.map((name, index) => writeFile(path.join(dir, name), original[index]!)));
    const writer = completionWriter(dir, JSON.stringify(original));
    await writer.write(path.join(dir, "manifest.json"), "authorized manifest");
    await writer.write(path.join(dir, "report.md"), "authorized report");
    await writeFile(path.join(dir, "report.md"), "external report");
    writer.rollback();
    expect(await readFile(path.join(dir, "manifest.json"), "utf8")).toBe(original[0]!);
    expect(await readFile(path.join(dir, "report.md"), "utf8")).toBe("external report");
    expect((await readdir(dir)).sort()).toEqual([...names].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rollback restores an unchanged authorized report", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "completion-rollback-own-"));
  try {
    const names = ["manifest.json", "report.md", "research.json", "findings.json", "decisions.md"];
    const original = names.map((name) => `original ${name}`);
    await Promise.all(names.map((name, index) => writeFile(path.join(dir, name), original[index]!)));
    const writer = completionWriter(dir, JSON.stringify(original));
    await writer.write(path.join(dir, "report.md"), "authorized report");
    writer.rollback();
    expect(await readFile(path.join(dir, "report.md"), "utf8")).toBe(original[1]!);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const name of ["coverage.md", "scope-files.json", "slices-manifest.json", "blast-radius.json", "chunks.json", "chunk-state.json"]) {
  test(`completion rejects changed or newly created coverage input ${name}`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "completion-coverage-fence-"));
    try {
      for (const core of ["manifest.json", "report.md", "research.json", "findings.json", "decisions.md"]) {
        await writeFile(path.join(dir, core), "original");
      }
      for (const exists of [false, true]) {
        if (exists) await writeFile(path.join(dir, name), "original input");
        const writer = completionWriter(dir, await completionSnapshot(dir));
        await writeFile(path.join(dir, name), "changed input");
        await expect(writer.write(path.join(dir, "manifest.json"), "closed")).rejects.toThrow(/snapshot changed/);
        expect(await readFile(path.join(dir, "manifest.json"), "utf8")).toBe("original");
        await rm(path.join(dir, name));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("completion fences recorded raw reviewer evidence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "completion-raw-fence-"));
  try {
    await writeFile(path.join(dir, "manifest.json"), "original manifest");
    await writeFile(path.join(dir, "research.json"), JSON.stringify({ dispatch: { runs: [{ rawEvidence: "result.txt#L1" }] } }));
    await writeFile(path.join(dir, "result.txt"), "review result");
    const writer = completionWriter(dir, await completionSnapshot(dir));
    await rm(path.join(dir, "result.txt"));
    await expect(writer.write(path.join(dir, "manifest.json"), "closed")).rejects.toThrow(/snapshot changed/);
    expect(await readFile(path.join(dir, "manifest.json"), "utf8")).toBe("original manifest");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
