// Flow 399 review T-2 (AC6): which entries into a session count as "resumed". The mapping used to sit
// inline in the full-screen shell, so every other test ran against a fake host that was told the
// answer. These tests take the answer from the real `openSession`, the function the flags and
// `/resume` end up in, and push it through the mapping the shell now shares with them.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HISTORY_COMMAND, isHistoryCommand, readlineHistoryText } from "../tui/remote-control-surface";
import { openSession, persistHistory } from "../session";
import { historyArgsOf, NEW_SESSION_ENTRY, sessionEntryOf } from "./history-host";
import { parseHistoryArgs } from "./history";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project that already has one session with a message in it, as a user returning to it would. */
function projectWithPast(): { cwd: string; dataDir: string; pastId: string } {
  const dataDir = mkdtempSync(path.join(tmpdir(), "keryx-host-data-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "keryx-host-proj-"));
  dirs.push(dataDir, cwd);
  const past = openSession({ cwd, dataDir, provider: "p", model: "m" });
  persistHistory(past.handle, [{ role: "user", content: "an earlier question", provenance: "project" }], { provider: "p", model: "m" });
  return { cwd, dataDir, pastId: past.handle.summary.id };
}

describe("sessionEntryOf: the entry the shell makes into an opened session", () => {
  test("a resumed session is entered as resumed, with the restore enabled", () => {
    expect(sessionEntryOf(true)).toEqual({ resumed: true, kind: "resumed" });
  });

  test("a session that was just created is entered as new", () => {
    expect(sessionEntryOf(false)).toEqual({ resumed: false, kind: "new" });
  });

  test("/new and /clear always enter a new session", () => {
    expect(NEW_SESSION_ENTRY).toEqual({ resumed: false, kind: "new" });
  });
});

describe("the flags and /resume, taken from the real openSession", () => {
  test("-r <id> resumes: resumed true", () => {
    const { cwd, dataDir, pastId } = projectWithPast();
    const opened = openSession({ cwd, dataDir, resumeId: pastId });
    expect(opened.handle.summary.id).toBe(pastId);
    expect(sessionEntryOf(opened.resumed)).toEqual({ resumed: true, kind: "resumed" });
  });

  test("/resume <id> resumes: resumed true (the same open as -r)", () => {
    const { cwd, dataDir, pastId } = projectWithPast();
    const opened = openSession({ cwd, dataDir, resumeId: pastId.slice(0, 8) });
    expect(opened.handle.summary.id).toBe(pastId);
    expect(sessionEntryOf(opened.resumed).resumed).toBe(true);
  });

  test("-c continues the last session: resumed true", () => {
    const { cwd, dataDir, pastId } = projectWithPast();
    const opened = openSession({ cwd, dataDir, continueLast: true });
    expect(opened.handle.summary.id).toBe(pastId);
    expect(sessionEntryOf(opened.resumed)).toEqual({ resumed: true, kind: "resumed" });
  });

  test("-c with nothing to continue starts a new session: resumed false", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "keryx-host-data-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "keryx-host-proj-"));
    dirs.push(dataDir, cwd);
    const opened = openSession({ cwd, dataDir, continueLast: true });
    expect(sessionEntryOf(opened.resumed)).toEqual({ resumed: false, kind: "new" });
  });

  test("a plain start in a project with a past is a new session: resumed false", () => {
    const { cwd, dataDir, pastId } = projectWithPast();
    const opened = openSession({ cwd, dataDir });
    expect(opened.handle.summary.id).not.toBe(pastId);
    expect(sessionEntryOf(opened.resumed)).toEqual({ resumed: false, kind: "new" });
  });
});

describe("historyArgsOf: the one reading of a /history line", () => {
  test("the command word is dropped, the rest is trimmed and single-spaced", () => {
    expect(historyArgsOf("/history")).toBe("");
    expect(historyArgsOf("  /history   5  ")).toBe("5");
    expect(historyArgsOf("/history 5 extra")).toBe("5 extra");
  });

  test("what the readline shell and the full-screen shell read is the same", () => {
    expect(isHistoryCommand(HISTORY_COMMAND)).toBe(true);
    expect(parseHistoryArgs(historyArgsOf("/history 5")).ok).toBe(true);
    expect(parseHistoryArgs(historyArgsOf("/history lots")).ok).toBe(false);
    expect(readlineHistoryText("/history lots")).toContain("Usage: /history");
    expect(readlineHistoryText("/history 5")).toContain("full-screen shell");
  });
});
