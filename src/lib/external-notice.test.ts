// Flow 346, design §5 — the one-time default-on consent notice's tracking
// store. Every test injects its own config dir (temp directories) — no real
// `~/.local/share/keryx` and no network are ever touched.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EXTERNAL_DEFAULT_NOTICE_TEXT,
  externalNoticeFile,
  hasShownExternalDefaultNotice,
  recordExternalDefaultNoticeShown,
  shouldShowExternalDefaultNotice,
} from "./external-notice";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

test("the notice text names the switch, so a reader knows how to turn it off", () => {
  expect(EXTERNAL_DEFAULT_NOTICE_TEXT).toContain("/external off");
});

test("shouldShowExternalDefaultNotice: true the first time for a project, false every time after", async () => {
  const cwd = await tempDir("keryx-external-notice-cwd-");
  const dir = await tempDir("keryx-external-notice-cfg-");
  expect(hasShownExternalDefaultNotice(cwd, dir)).toBe(false);
  expect(shouldShowExternalDefaultNotice(cwd, dir)).toBe(true);
  expect(hasShownExternalDefaultNotice(cwd, dir)).toBe(true);
  expect(shouldShowExternalDefaultNotice(cwd, dir)).toBe(false);
  expect(shouldShowExternalDefaultNotice(cwd, dir)).toBe(false);
});

test("recorded per project — a different project's notice is independent", async () => {
  const cwdA = await tempDir("keryx-external-notice-a-");
  const cwdB = await tempDir("keryx-external-notice-b-");
  const dir = await tempDir("keryx-external-notice-shared-cfg-");
  expect(shouldShowExternalDefaultNotice(cwdA, dir)).toBe(true);
  expect(shouldShowExternalDefaultNotice(cwdA, dir)).toBe(false);
  // Project B has never been recorded — still shows once, independently.
  expect(shouldShowExternalDefaultNotice(cwdB, dir)).toBe(true);
  expect(shouldShowExternalDefaultNotice(cwdB, dir)).toBe(false);
});

test("recordExternalDefaultNoticeShown: persists across a fresh read of the store (not just in-memory)", async () => {
  const cwd = await tempDir("keryx-external-notice-persist-");
  const dir = await tempDir("keryx-external-notice-persist-cfg-");
  recordExternalDefaultNoticeShown(cwd, dir);
  // A brand-new call, no shared state other than the file on disk.
  expect(hasShownExternalDefaultNotice(cwd, dir)).toBe(true);
});

test("a malformed store reads as \"not shown yet\" rather than throwing", async () => {
  const cwd = await tempDir("keryx-external-notice-malformed-cwd-");
  const dir = await tempDir("keryx-external-notice-malformed-cfg-");
  await Bun.write(externalNoticeFile(dir), "{not json");
  expect(hasShownExternalDefaultNotice(cwd, dir)).toBe(false);
  expect(shouldShowExternalDefaultNotice(cwd, dir)).toBe(true);
});
