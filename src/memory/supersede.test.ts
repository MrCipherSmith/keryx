import { test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { supersedeEntry } from "./supersede";
import { parseEntry } from "./store";

// AC-C6: supersede is non-destructive and git-diffable. Both files remain on
// disk; the old entry gains Valid-To + Superseded-By + Status: superseded; the
// new entry gains Supersedes. Plain Markdown only.

function decisionMd(title: string, extraHeader = ""): string {
  return `# ${title}

Version: 1.0.0
Type: decision
Status: accepted
Confidence: high
${extraHeader}## Summary

${title}.

## Details

Body.

## Related Scopes

- Module: auth

## Tags

- auth
`;
}

async function scaffold(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-mem-supersede-"));
  const dir = path.join(root, ".metaproject", "memory", "decisions");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "old.md"), decisionMd("Old decision"), "utf8");
  await writeFile(path.join(dir, "new.md"), decisionMd("New decision"), "utf8");
  return root;
}

test("supersede keeps both files and writes bitemporal fields (AC-C6)", async () => {
  const root = await scaffold();
  try {
    const result = await supersedeEntry(
      { cwd: root, oldPath: "decisions/old.md", newPath: "decisions/new.md", date: "2026-05-01" },
      new Date("2026-07-08"),
    );
    expect(result.changed).toBe(true);
    expect(result.superseded).toBe("decisions/old.md");
    expect(result.supersededBy).toBe("decisions/new.md");

    const dir = path.join(root, ".metaproject", "memory", "decisions");
    // Both files remain on disk (non-destructive).
    expect(await pathExists(path.join(dir, "old.md"))).toBe(true);
    expect(await pathExists(path.join(dir, "new.md"))).toBe(true);

    const oldEntry = parseEntry(
      path.join(dir, "old.md"),
      "decisions/old.md",
      "decision",
      await readFile(path.join(dir, "old.md"), "utf8"),
    );
    expect(oldEntry.status).toBe("superseded");
    expect(oldEntry.validTo).toBe("2026-05-01");
    expect(oldEntry.supersededBy).toBe("decisions/new.md");

    const newEntry = parseEntry(
      path.join(dir, "new.md"),
      "decisions/new.md",
      "decision",
      await readFile(path.join(dir, "new.md"), "utf8"),
    );
    expect(newEntry.supersedes).toBe("decisions/old.md");
    expect(newEntry.validFrom).toBe("2026-05-01");

    // Changelog note appended to the old entry (git-diffable).
    const oldRaw = await readFile(path.join(dir, "old.md"), "utf8");
    expect(oldRaw).toContain("Superseded by decisions/new.md on 2026-05-01.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supersede is idempotent (second run reports no change)", async () => {
  const root = await scaffold();
  try {
    const first = await supersedeEntry(
      { cwd: root, oldPath: "decisions/old.md", newPath: "decisions/new.md", date: "2026-05-01" },
      new Date("2026-07-08"),
    );
    expect(first.changed).toBe(true);
    const dir = path.join(root, ".metaproject", "memory", "decisions");
    const afterFirst = await readFile(path.join(dir, "old.md"), "utf8");

    const second = await supersedeEntry(
      { cwd: root, oldPath: "decisions/old.md", newPath: "decisions/new.md", date: "2026-05-01" },
      new Date("2026-07-08"),
    );
    expect(second.changed).toBe(false);
    // No further mutation on the idempotent re-run.
    expect(await readFile(path.join(dir, "old.md"), "utf8")).toBe(afterFirst);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
