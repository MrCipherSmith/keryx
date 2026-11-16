// `review slice --ref <base> --head <sha>` cuts base..head, never base..HEAD or the working tree: `review plan --head`
// passes the pinned head to every stage, and scope already read it while slice did not (11 slices of unrelated files
// for a 10-file scope). Throwaway git repository, no network.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";
import type { SliceManifest } from "../review/slice";

describe("review slice with a pinned --head", () => {
  let root: string;
  const originalCwd = process.cwd();
  let base = "";
  let head = "";

  const git = (...args: string[]): string => {
    const email = "200531777+MrCipherSmith@users.noreply.github.com";
    const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_COMMITTER_NAME: "t", GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email },
    });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  const write = (rel: string, content: string): void => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  };
  const commit = (message: string, files: Record<string, string>): string => {
    for (const [rel, content] of Object.entries(files)) write(rel, content);
    git("add", "--", ...Object.keys(files));
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const lines = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `export const ${tag}${i + 1} = ${i + 1};`).join("\n") + "\n";

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "keryx-slice-head-"));
    git("init", "-q", "-b", "main");
    base = commit("base", { "src/base.ts": lines(5, "b") });
    head = commit("head", { "src/head-change.ts": lines(8, "h") });
    // A later commit and an uncommitted edit: neither belongs to the pinned range.
    commit("later", { "src/later-change.ts": lines(8, "l"), "src/base.ts": lines(9, "b") });
    write("src/uncommitted.ts", lines(4, "u"));
    git("add", "--", "src/uncommitted.ts");
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  });

  test("slices only the files of base..head, not the later commit or the working tree", async () => {
    const out = path.join(root, "slices-out");
    const logged: string[] = [];
    const log = console.log;
    console.log = (...items: unknown[]) => void logged.push(items.join(" "));
    try {
      await reviewCommand(["slice", "--ref", base, "--head", head, "--host", "claude-code", "--out", out, "--json"]);
    } finally {
      console.log = log;
    }
    const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8")) as SliceManifest;
    const files = [...new Set(manifest.slices.flatMap((slice) => slice.files))].sort();
    expect(files).toEqual(["src/head-change.ts"]);
    const sliceText = manifest.slices.map((slice) => readFileSync(path.join(out, `${slice.id}.diff`), "utf8")).join("\n");
    expect(sliceText).not.toContain("later-change");
    expect(sliceText).not.toContain("uncommitted");
  });
});
