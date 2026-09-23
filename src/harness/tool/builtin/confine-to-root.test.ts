// `confineToRoot` — the shared real-path confinement every root-bound tool uses
// (flow 292, AC5).
//
// The flow-292 finding: a path that does not exist yet was checked LEXICALLY, so
// `<root>/link/new.txt`, with `link` a symlink to a directory outside the root,
// passed — and a writer handed that path created the file outside. The fix
// resolves such a path through its nearest existing ancestor. Existing paths
// must resolve exactly as before: every read-only caller depends on that.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { confineToRoot } from "./interactive-tools";

let base = "";
let root = "";
let outside = "";

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-confine-")));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(root, "src", "a.ts"), "a");
  writeFileSync(path.join(outside, "secret.txt"), "s");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("existing paths resolve exactly as before", () => {
  test("an existing file inside the root resolves to its real path", () => {
    expect(confineToRoot(root, "src/a.ts")).toBe(path.join(root, "src", "a.ts"));
  });

  test("the root itself is allowed", () => {
    expect(confineToRoot(root, ".")).toBe(root);
  });

  test("an existing symlinked file pointing outside is refused", () => {
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
    expect(confineToRoot(root, "leak.txt")).toBeNull();
  });

  test("`../` traversal is refused", () => {
    expect(confineToRoot(root, "../outside/secret.txt")).toBeNull();
    expect(confineToRoot(root, "src/../../outside/new.txt")).toBeNull();
  });
});

describe("a path that does not exist yet goes through its nearest existing ancestor", () => {
  test("a new file under a symlinked directory pointing outside is refused", () => {
    symlinkSync(outside, path.join(root, "link"));
    expect(confineToRoot(root, "link/new.txt")).toBeNull();
    expect(confineToRoot(root, "link/deeper/still/new.txt")).toBeNull();
  });

  test("a new file under a real in-root directory is allowed at its real location", () => {
    expect(confineToRoot(root, "src/new/deep/file.ts")).toBe(path.join(root, "src", "new", "deep", "file.ts"));
  });

  test("a new file under an in-root symlink to an in-root directory is allowed", () => {
    symlinkSync(path.join(root, "src"), path.join(root, "alias"));
    expect(confineToRoot(root, "alias/new.ts")).toBe(path.join(root, "src", "new.ts"));
  });

  test("a dangling symlink on the way is refused rather than followed", () => {
    symlinkSync(path.join(outside, "not-yet"), path.join(root, "dangling"));
    expect(confineToRoot(root, "dangling")).toBeNull();
    expect(confineToRoot(root, "dangling/new.txt")).toBeNull();
  });
});
