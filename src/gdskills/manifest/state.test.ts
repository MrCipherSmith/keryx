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
