// `realOr` resolves symlinks for paths that may not exist yet. These tests build
// the symlink themselves, so they exercise the behaviour on Linux CI as well as on
// macOS, where `/var` -> `/private/var` happens to provide one for free.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { realOr, resolvesInsideProject } from "./granted-binary";

let base = "";
let real = "";
let link = "";

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-realor-")));
  real = path.join(base, "real");
  link = path.join(base, "link");
  mkdirSync(real);
  symlinkSync(real, link, "dir");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("realOr", () => {
  test("an existing path under a symlinked directory resolves to its canonical form", () => {
    writeFileSync(path.join(real, "file"), "x");
    expect(realOr(path.join(link, "file"))).toBe(path.join(real, "file"));
    expect(realOr(link)).toBe(real);
  });

  test("a missing leaf resolves through its realpath'd parent", () => {
    expect(realOr(path.join(link, "missing"))).toBe(path.join(real, "missing"));
  });

  test("a missing multi-level tail is rejoined onto the nearest existing ancestor's realpath", () => {
    expect(realOr(path.join(link, "a", "b", "c"))).toBe(path.join(real, "a", "b", "c"));
  });

  test("a path with no symlinks and nothing on disk is returned unchanged", () => {
    const plain = path.join(base, "nope", "deeper");
    expect(realOr(plain)).toBe(plain);
  });
});

describe("resolvesInsideProject through a symlink", () => {
  test("a not-yet-created file under a symlink to the project is inside it", () => {
    expect(resolvesInsideProject(real, path.join(link, "bin", "not-yet"))).toBe(true);
  });

  test("a not-yet-created file under a symlink to somewhere else is outside it", () => {
    const other = path.join(base, "other");
    mkdirSync(other);
    const otherLink = path.join(base, "other-link");
    symlinkSync(other, otherLink, "dir");
    expect(resolvesInsideProject(real, path.join(otherLink, "bin", "not-yet"))).toBe(false);
  });
});
