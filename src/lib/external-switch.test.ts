// Flow 346 — the EXTERNAL switch's state resolver: per-user default,
// project override (which wins), and the built-in fallback. Every test here
// injects its own `cwd`/`dir` (temp directories) — no real
// `~/.local/share/keryx` and no network are ever touched, and this file
// runs green with `OPENROUTER_API_KEY` unset.

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_EXTERNAL_SETTING,
  ExternalBlockedError,
  readProjectExternalSetting,
  readUserExternalSetting,
  resolveExternalSetting,
  writeProjectExternalSetting,
  writeUserExternalSetting,
} from "./external-switch";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

test("DEFAULT_EXTERNAL_SETTING is \"on\" — pre-flow-346 behavior is unchanged when nothing is configured", () => {
  expect(DEFAULT_EXTERNAL_SETTING).toBe("on");
});

test("resolveExternalSetting: nothing configured -> default \"on\"", async () => {
  const cwd = await tempDir("keryx-external-switch-default-cwd-");
  const dir = await tempDir("keryx-external-switch-default-cfg-");
  const resolved = await resolveExternalSetting({ cwd, dir });
  expect(resolved).toEqual({ value: "on", source: "default" });
});

test("resolveExternalSetting: user-level setting alone is honoured", async () => {
  const cwd = await tempDir("keryx-external-switch-user-cwd-");
  const dir = await tempDir("keryx-external-switch-user-cfg-");
  writeUserExternalSetting("off", dir);
  expect(readUserExternalSetting(dir)).toBe("off");
  const resolved = await resolveExternalSetting({ cwd, dir });
  expect(resolved).toEqual({ value: "off", source: "user" });
});

test("resolveExternalSetting: a project override wins over the user setting, in both directions", async () => {
  const cwd = await tempDir("keryx-external-switch-project-cwd-");
  const dir = await tempDir("keryx-external-switch-project-cfg-");

  // user on, project off -> off (project wins)
  writeUserExternalSetting("on", dir);
  await writeProjectExternalSetting(cwd, "off");
  expect(await readProjectExternalSetting(cwd)).toBe("off");
  expect(await resolveExternalSetting({ cwd, dir })).toEqual({ value: "off", source: "project" });

  // user off, project on -> on (project still wins)
  writeUserExternalSetting("off", dir);
  await writeProjectExternalSetting(cwd, "on");
  expect(await resolveExternalSetting({ cwd, dir })).toEqual({ value: "on", source: "project" });
});

test("readProjectExternalSetting: absent/unparsable/malformed tasks.config.json reads undefined, never throws", async () => {
  const cwd = await tempDir("keryx-external-switch-project-absent-");
  expect(await readProjectExternalSetting(cwd)).toBeUndefined();

  const metaDir = path.join(cwd, ".metaproject");
  await mkdir(metaDir, { recursive: true });
  await writeFile(path.join(metaDir, "tasks.config.json"), "{not json", "utf8");
  expect(await readProjectExternalSetting(cwd)).toBeUndefined();

  await writeFile(path.join(metaDir, "tasks.config.json"), JSON.stringify({ external: "sideways" }), "utf8");
  expect(await readProjectExternalSetting(cwd)).toBeUndefined();
});

test("writeProjectExternalSetting: preserves every other key in tasks.config.json", async () => {
  const cwd = await tempDir("keryx-external-switch-preserve-");
  const metaDir = path.join(cwd, ".metaproject");
  await mkdir(metaDir, { recursive: true });
  const file = path.join(metaDir, "tasks.config.json");
  await writeFile(file, JSON.stringify({ review: { jev: { ci_triage: true } } }), "utf8");

  await writeProjectExternalSetting(cwd, "off");

  const onDisk = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  expect(onDisk.external).toBe("off");
  expect(onDisk.review).toEqual({ jev: { ci_triage: true } });
});

test("writeProjectExternalSetting: refuses to overwrite an existing file that is not valid JSON", async () => {
  const cwd = await tempDir("keryx-external-switch-refuse-");
  const metaDir = path.join(cwd, ".metaproject");
  await mkdir(metaDir, { recursive: true });
  await writeFile(path.join(metaDir, "tasks.config.json"), "{not json", "utf8");

  await expect(writeProjectExternalSetting(cwd, "off")).rejects.toThrow(/not valid JSON/);
});

test("ExternalBlockedError: names what was blocked and why, and points at the switch — never a bare stack trace's worth of noise", () => {
  const error = new ExternalBlockedError("Jev/TypeSafe System One", "receives code and CI logs");
  expect(error.name).toBe("ExternalBlockedError");
  expect(error.message).toContain("blocked by /external off");
  expect(error.message).toContain("Jev/TypeSafe System One");
  expect(error.message).toContain("receives code and CI logs");
  expect(error.message).toContain("/external on");
});

test("ExternalBlockedError: reads cleanly even with no reason given", () => {
  const error = new ExternalBlockedError("some-provider", undefined);
  expect(error.message).toContain("some-provider");
  expect(error.message).not.toContain("undefined");
});
