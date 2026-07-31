// Path containment (flow 126 / S-003).
//
// Three commands take a path from the caller and read it. `test suggest` sends
// the contents to a model provider, so an uncontained path does not merely read
// a local file — it ships it off the machine.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveContainedPath, resolveContainedPathSync, resolveProjectRoot } from "./contained-path";

let root = "";
let outsideDir = "";
let outsideFile = "";

beforeAll(async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-contain-")));
  root = path.join(base, "project");
  outsideDir = path.join(base, "elsewhere");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(outsideDir, { recursive: true });

  await writeFile(path.join(root, "src", "inside.ts"), "export const a = 1;\n", "utf8");
  outsideFile = path.join(outsideDir, "secret.txt");
  await writeFile(outsideFile, "TOP SECRET\n", "utf8");

  // A symlink INSIDE the project that points OUTSIDE it. This is the case a
  // string-prefix check passes and a real-path check catches.
  await symlink(outsideFile, path.join(root, "src", "escape.txt"));
  // A symlink inside the project pointing inside it — must keep working.
  await symlink(path.join(root, "src", "inside.ts"), path.join(root, "src", "alias.ts"));
  // A sibling directory whose name merely starts with the project's name.
  await mkdir(`${root}-secrets`, { recursive: true });
  await writeFile(path.join(`${root}-secrets`, "keys.txt"), "k\n", "utf8");
});

afterAll(async () => {
  if (root.length > 0) {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

describe("resolveContainedPath", () => {
  test("accepts a path inside the project", async () => {
    const result = await resolveContainedPath(root, "src/inside.ts");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path.endsWith(path.join("src", "inside.ts"))).toBe(true);
    }
  });

  test("accepts a symlink that stays inside the project", async () => {
    const result = await resolveContainedPath(root, "src/alias.ts");
    expect(result.ok).toBe(true);
  });

  test("refuses a relative traversal", async () => {
    const result = await resolveContainedPath(root, "../elsewhere/secret.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("outside-project");
    }
  });

  test("refuses an absolute path outside the project", async () => {
    const result = await resolveContainedPath(root, outsideFile);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("outside-project");
    }
  });

  test("refuses a symlink that escapes the project", async () => {
    // The path string is inside the project; only real-path resolution catches
    // it. Deleting the realpath step makes exactly this test fail.
    const result = await resolveContainedPath(root, "src/escape.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("outside-project");
    }
  });

  test("refuses a sibling directory that merely shares the name prefix", async () => {
    // A plain startsWith() containment check passes this and reads the file.
    const result = await resolveContainedPath(root, path.join(`${root}-secrets`, "keys.txt"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("outside-project");
    }
  });

  test("distinguishes a missing file from an escape", async () => {
    const result = await resolveContainedPath(root, "src/nope.ts");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not-found");
    }
  });

  test("reports a traversal to a missing file as an escape, not as not-found", async () => {
    // Otherwise the refusal doubles as an existence oracle for paths the caller
    // is not allowed to ask about.
    const result = await resolveContainedPath(root, "../elsewhere/does-not-exist");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("outside-project");
    }
  });

  test("accepts the project root itself", async () => {
    const result = await resolveContainedPath(root, ".");
    expect(result.ok).toBe(true);
  });
});

describe("names that merely look like traversals", () => {
  test("accepts an in-project file whose name starts with two dots", async () => {
    // A plain startsWith("..") check refuses this, and it is plainly inside the
    // root. Over-restriction is a real cost: a caller who hits a false refusal
    // works around containment instead of trusting it.
    await writeFile(path.join(root, "..hidden.ts"), "export const x = 1;\n", "utf8");
    const result = await resolveContainedPath(root, "..hidden.ts");
    expect(result.ok).toBe(true);
  });
});

describe("resolveProjectRoot", () => {
  test("finds the root from a nested subdirectory", async () => {
    // Rooted at cwd instead, `keryx security scan ../lib/x.ts` from a
    // subdirectory refuses a path that is inside the project.
    await mkdir(path.join(root, ".git"), { recursive: true });
    expect(resolveProjectRoot(path.join(root, "src"))).toBe(root);
  });

  test("returns the start directory when no project marker exists", () => {
    // Falls back to containing the directory to itself rather than widening
    // silently to the filesystem root.
    expect(resolveProjectRoot(outsideDir)).toBe(outsideDir);
  });
});

describe("resolveContainedPathSync", () => {
  test("matches the async result for an inside path", () => {
    const result = resolveContainedPathSync(root, "src/inside.ts");
    expect(result.ok).toBe(true);
  });

  test("matches the async result for an escaping symlink", () => {
    const result = resolveContainedPathSync(root, "src/escape.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("outside-project");
    }
  });

  test("matches the async result for a traversal", () => {
    const result = resolveContainedPathSync(root, "../elsewhere/secret.txt");
    expect(result.ok).toBe(false);
  });
});
