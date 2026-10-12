// `configDirInsideProjectReason` resolves the config dir with `realOr`, so a
// not-yet-created config dir reached through a symlink into the project is still
// recognised as inside it. The symlink is built here, so this holds off macOS too.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { configDirInsideProjectReason } from "./schedule-key";

let base = "";
let project = "";

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-schedule-key-")));
  project = path.join(base, "project");
  mkdirSync(project);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("configDirInsideProjectReason", () => {
  test("a missing config dir under a symlink into the project is refused", () => {
    const link = path.join(base, "link");
    symlinkSync(project, link, "dir");
    const reason = configDirInsideProjectReason(project, path.join(link, "missing", "keryx"));
    expect(reason).toContain(path.join(project, "missing", "keryx"));
    expect(reason).toContain("is inside this project");
  });

  test("a missing config dir under a symlink to elsewhere is accepted", () => {
    const elsewhere = path.join(base, "elsewhere");
    mkdirSync(elsewhere);
    const link = path.join(base, "elsewhere-link");
    symlinkSync(elsewhere, link, "dir");
    expect(configDirInsideProjectReason(project, path.join(link, "missing", "keryx"))).toBeUndefined();
  });
});
