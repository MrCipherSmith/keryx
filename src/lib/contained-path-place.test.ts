// Flow 441 AC8/AC9: where a path a command is about to write would really land (placePathWithinSync).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { placePathWithinSync } from "./contained-path";

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-place-")));
  root = path.join(base, "project");
  outside = path.join(base, "elsewhere");
  mkdirSync(path.join(root, ".git"), { recursive: true });
  mkdirSync(path.join(root, ".metaproject"));
  mkdirSync(path.join(root, "sub"));
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

test("a target that does not exist yet is placed by its nearest existing ancestor, through several missing components", () => {
  const placed = placePathWithinSync(root, "a/b/c/out.json", root);
  expect(placed).toEqual({ ok: true, path: path.join(root, "a", "b", "c", "out.json") });
});

test("a command started from a subdirectory resolves the candidate against that directory", () => {
  const placed = placePathWithinSync(root, "../out/slices", path.join(root, "sub"));
  expect(placed).toEqual({ ok: true, path: path.join(root, "out", "slices") });
  expect(placePathWithinSync(root, "../../elsewhere", path.join(root, "sub")).ok).toBe(false);
});

test("a symlink inside the project that points outside is refused, even for a target below it that does not exist", () => {
  symlinkSync(outside, path.join(root, "escape"));
  const placed = placePathWithinSync(root, "escape/new/dir/x.json", root);
  expect(placed.ok).toBe(false);
  if (!placed.ok) expect(placed.message).toMatch(/resolves outside the project root/);
});

test("a dangling symlink and a looping pair are refused, and the message says why instead of claiming an escape", () => {
  symlinkSync(path.join(root, "nowhere"), path.join(root, "dangling"));
  symlinkSync(path.join(root, "loop-b"), path.join(root, "loop-a"));
  symlinkSync(path.join(root, "loop-a"), path.join(root, "loop-b"));
  for (const candidate of ["dangling", "dangling/x", "loop-a/x"]) {
    const placed = placePathWithinSync(root, candidate, root);
    expect({ candidate, ok: placed.ok }).toEqual({ candidate, ok: false });
    if (!placed.ok) {
      expect(placed.message).toMatch(/cannot be resolved/);
      expect(placed.message).not.toMatch(/outside the project root/);
    }
  }
});

test("an extra root is allowed, and a symlinked extra root is not widened to wherever the link points", () => {
  expect(placePathWithinSync(root, ".metaproject/reviews/r1", root, [".metaproject"]).ok).toBe(true);

  rmSync(path.join(root, ".metaproject"), { recursive: true });
  symlinkSync(outside, path.join(root, ".metaproject"));
  const viaLink = placePathWithinSync(root, ".metaproject/reviews/r1", root, [".metaproject"]);
  expect(viaLink.ok).toBe(false);
  const direct = placePathWithinSync(root, path.join(outside, "x.json"), root, [".metaproject"]);
  expect(direct.ok).toBe(false);
});

test("an extra root that is a symlink to a directory inside the project stays usable", () => {
  rmSync(path.join(root, ".metaproject"), { recursive: true });
  mkdirSync(path.join(root, "shared-meta"));
  symlinkSync(path.join(root, "shared-meta"), path.join(root, ".metaproject"));
  expect(placePathWithinSync(root, ".metaproject/reviews/r1", root, [".metaproject"])).toEqual({
    ok: true,
    path: path.join(root, "shared-meta", "reviews", "r1"),
  });
});
