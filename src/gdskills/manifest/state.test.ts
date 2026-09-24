// Flow 309 (W1) review round 1 fixes: F2 (path containment), F3 (target id
// validation), F19 (real schema validation, not a hand-rolled shape check).

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  readSkillsInstallState,
  resolveContainedPath,
  skillsInstallStatePath,
  skillsInstallStateIsUnreadable,
} from "./state";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-install-state-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("skillsInstallStatePath throws for a target id that doesn't match the id pattern (F3)", () => {
  expect(() => skillsInstallStatePath(root, "../../victim")).toThrow();
  expect(() => skillsInstallStatePath(root, "claude/../../victim")).toThrow();
  expect(() => skillsInstallStatePath(root, "")).toThrow();
  expect(() => skillsInstallStatePath(root, "claude")).not.toThrow();
  expect(() => skillsInstallStatePath(root, "keryx-shell")).not.toThrow();
});

test("resolveContainedPath rejects an absolute path", async () => {
  const result = await resolveContainedPath(root, "/etc/passwd");
  expect(result.ok).toBe(false);
});

test("resolveContainedPath rejects a `..` escape", async () => {
  const result = await resolveContainedPath(root, "../victim.txt");
  expect(result.ok).toBe(false);
});

test("resolveContainedPath rejects a path outside the given destination roots even when it stays under repoRoot", async () => {
  const result = await resolveContainedPath(root, "some/other/dir/file.txt", [".claude/skills", ".claude/rules"]);
  expect(result.ok).toBe(false);
});

test("resolveContainedPath accepts a path under repoRoot and under a destination root", async () => {
  const result = await resolveContainedPath(root, ".claude/rules/a.mdc", [".claude/skills", ".claude/rules"]);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.abs).toBe(path.join(root, ".claude", "rules", "a.mdc"));
  }
});

test("resolveContainedPath rejects a path that escapes repoRoot through a symlinked intermediate directory", async () => {
  const outside = await mkdtemp(path.join(tmpdir(), "keryx-outside-"));
  try {
    // `.claude` inside `root` is a symlink pointing OUTSIDE root — textually
    // `.claude/rules/a.mdc` looks contained, but on disk it is not.
    await symlink(outside, path.join(root, ".claude"));
    const result = await resolveContainedPath(root, ".claude/rules/a.mdc");
    expect(result.ok).toBe(false);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

// R2-1: round 1's destination-root check compared the RAW, un-normalized
// relPath against destinationRoots by string prefix. A recorded
// `.claude/skills/../../package.json` resolves to `<root>/package.json`
// (inside root) and textually starts with `.claude/skills/`, so it passed
// both checks even though it is nowhere near `.claude/skills`.
test("resolveContainedPath rejects a recorded path with a `..` segment even when it textually starts with a destination root (R2-1)", async () => {
  const result = await resolveContainedPath(root, ".claude/skills/../../package.json", [".claude/skills", ".claude/rules"]);
  expect(result.ok).toBe(false);
});

test("resolveContainedPath rejects a `..` escape into .git even under a destination-root prefix (R2-1)", async () => {
  const result = await resolveContainedPath(root, ".claude/skills/../../.git/config", [".claude/skills", ".claude/rules"]);
  expect(result.ok).toBe(false);
});

test("resolveContainedPath rejects a raw path containing a `..` segment outright, even though path.resolve would keep it inside root (R2-1)", async () => {
  // `.claude/skills/foo/../bar.mdc` resolves to `.claude/skills/bar.mdc`,
  // which is fine — but state is Keryx-written, so a literal `..` segment
  // anywhere in a RECORDED path means tampering and is refused regardless.
  const result = await resolveContainedPath(root, ".claude/skills/foo/../bar.mdc", [".claude/skills"]);
  expect(result.ok).toBe(false);
});

test("resolveContainedPath rejects a backslash in a recorded path", async () => {
  const result = await resolveContainedPath(root, ".claude\\skills\\..\\..\\package.json", [".claude/skills"]);
  expect(result.ok).toBe(false);
});

// R2-1: destination-root containment must compare whole path segments, not
// a raw string prefix — `.claude/skillsX/...` must never be confused with
// the root `.claude/skills`.
test("resolveContainedPath rejects a path under a same-prefixed sibling directory, not the actual destination root (R2-1)", async () => {
  const result = await resolveContainedPath(root, ".claude/skillsX/evil.mdc", [".claude/skills"]);
  expect(result.ok).toBe(false);
});

// R3-3 (flow 309 review round 3): a path exactly equal to a destination
// root is now REFUSED, not accepted — Keryx only ever records individual
// FILES in install-state, never a bare destination root directory itself.
// Before this fix, a recorded `writtenPaths: [".claude/skills"]` passed
// containment and then crashed `sha256OfFile` with a raw `EISDIR` (the root
// is always an existing directory once anything is installed under it).
test("resolveContainedPath rejects a path exactly equal to a destination root's own directory entry name (R3-3)", async () => {
  const result = await resolveContainedPath(root, ".claude/skills", [".claude/skills"]);
  expect(result.ok).toBe(false);
  // R4-3 (flow 309 review round 4): the generic "is not under any of this
  // target's known destination roots" message read as self-contradictory
  // here, since the rejected path IS one of the roots listed right there.
  // Named on its own terms instead.
  if (!result.ok) {
    expect(result.reason).toContain("is a destination root itself, not a file under it");
    expect(result.reason).not.toContain("is not under any of this target's known destination roots");
  }
});

// R2-2: round 1's symlink guard only realpath'd the nearest existing
// ANCESTOR directory of the destination — a destination FILE that is
// itself a symlink (the leaf) was never checked, so `apply --force` could
// write through it to wherever it pointed.
test("resolveContainedPath rejects a path whose LEAF is a symlink, even though its parent directory is real (R2-2)", async () => {
  const outside = await mkdtemp(path.join(tmpdir(), "keryx-outside-"));
  try {
    await mkdir(path.join(root, ".claude", "rules"), { recursive: true });
    const victim = path.join(outside, "victim.txt");
    await writeFile(victim, "original", "utf8");
    await symlink(victim, path.join(root, ".claude", "rules", "a.mdc"));
    const result = await resolveContainedPath(root, ".claude/rules/a.mdc", [".claude/rules"]);
    expect(result.ok).toBe(false);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("readSkillsInstallState rejects a hand-crafted file that violates the schema (bad sha256 hex) — F19 is a real schema check, not a shape check", async () => {
  const file = skillsInstallStatePath(root, "claude");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: "1.0.0",
      target: "claude",
      installedModules: [
        {
          moduleId: "rule-a",
          writtenPaths: [".claude/rules/a.mdc"],
          // Not a 64-char hex string — a hand-rolled "is it an object" shape
          // check would accept this; install-manifest.schema.json's
          // `$defs/installedModuleRecord.sha256` pattern rejects it.
          sha256: { ".claude/rules/a.mdc": "not-a-real-hash" },
          managedSentinel: true,
        },
      ],
      recordedAt: "2026-01-01T00:00:00.000Z",
    }),
    "utf8",
  );
  expect(await readSkillsInstallState(root, "claude")).toBeUndefined();
  expect(await skillsInstallStateIsUnreadable(root, "claude")).toBe(true);
});

test("readSkillsInstallState rejects an install-state document with an invalid moduleId (id pattern) — F19", async () => {
  const file = skillsInstallStatePath(root, "claude");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: "1.0.0",
      target: "claude",
      installedModules: [
        {
          moduleId: "Not Valid! id",
          writtenPaths: [".claude/rules/a.mdc"],
          sha256: {},
          managedSentinel: true,
        },
      ],
      recordedAt: "2026-01-01T00:00:00.000Z",
    }),
    "utf8",
  );
  expect(await readSkillsInstallState(root, "claude")).toBeUndefined();
  expect(await skillsInstallStateIsUnreadable(root, "claude")).toBe(true);
});

test("readSkillsInstallState accepts a schema-valid document, and skillsInstallStateIsUnreadable is false for it", async () => {
  const file = skillsInstallStatePath(root, "claude");
  await mkdir(path.dirname(file), { recursive: true });
  const sha = "a".repeat(64);
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: "1.0.0",
      target: "claude",
      installedModules: [
        {
          moduleId: "rule-a",
          writtenPaths: [".claude/rules/a.mdc"],
          sha256: { ".claude/rules/a.mdc": sha },
          managedSentinel: true,
        },
      ],
      recordedAt: "2026-01-01T00:00:00.000Z",
    }),
    "utf8",
  );
  const state = await readSkillsInstallState(root, "claude");
  expect(state).toBeDefined();
  expect(state!.installedModules[0]!.moduleId).toBe("rule-a");
  expect(await skillsInstallStateIsUnreadable(root, "claude")).toBe(false);
});

test("skillsInstallStateIsUnreadable is false when there is no file at all (absence is not corruption)", async () => {
  expect(await readSkillsInstallState(root, "claude")).toBeUndefined();
  expect(await skillsInstallStateIsUnreadable(root, "claude")).toBe(false);
});

test("skillsInstallStateIsUnreadable is true for unparseable JSON", async () => {
  const file = skillsInstallStatePath(root, "claude");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "{ not json", "utf8");
  expect(await readSkillsInstallState(root, "claude")).toBeUndefined();
  expect(await skillsInstallStateIsUnreadable(root, "claude")).toBe(true);
});
