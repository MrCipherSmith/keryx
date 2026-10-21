import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { completionWriter } from "./completion-write";

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
