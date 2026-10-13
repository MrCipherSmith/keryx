// Flow 441 (F-039): `-` is standard input for --diff, --payload and --result only; for any other flag it is a path.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { placeReviewPath, reviewPathFlagRefusal } from "./review-path-flags";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

test("- is standard input for --diff, --payload and --result, and a path that is placed for any other flag", () => {
  const root = tempDir("keryx-flags-");
  mkdirSync(path.join(root, ".git"));
  const where = { projectRoot: root, cwd: root };
  expect(placeReviewPath("slice", "--diff", "-", where)).toEqual({ ok: true, path: "-" });
  expect(placeReviewPath("dispatch-check", "--payload", "-", where)).toEqual({ ok: true, path: "-" });
  expect(placeReviewPath("retry-plan", "--result", "-", where)).toEqual({ ok: true, path: "-" });

  const outside = tempDir("keryx-flags-out-");
  symlinkSync(outside, path.join(root, "-"));
  expect(reviewPathFlagRefusal("slice", ["--out", "-"], where)).toMatch(/outside the project root/);
  expect(reviewPathFlagRefusal("retry-plan", ["--manifest", "-"], where)).toMatch(/outside the project root/);
});
