import { expect, test } from "bun:test";
import type { NormalizedMessage } from "../harness/provider/types";
import { createRewindReadlineCommand } from "./readline-command";
import { createRewindRecorder } from "./recorder";
import { exists, makeProject, read, write } from "./rewind.test-helpers";

const msg = (role: "user" | "assistant", content: string): NormalizedMessage => ({ role, content }) as NormalizedMessage;

async function setup(overrides: { canPersist?: () => boolean; hasSession?: () => boolean } = {}) {
  const project = makeProject();
  const recorder = createRewindRecorder({ workTree: project.root, dir: () => project.rewindDir, enabled: () => true });
  const history = [msg("user", "one"), msg("assistant", "done one"), msg("user", "two"), msg("assistant", "done two")];
  const archive = [...history];
  recorder.beginTurn({ archiveIndex: 2, prompt: "add a file" });
  await recorder.beforeMutation();
  write(project.root, "a.txt", "changed\n");
  write(project.root, "made.txt", "made\n");
  let cursorResets = 0;
  const command = createRewindReadlineCommand({
    recorder,
    hasSession: overrides.hasSession ?? (() => true),
    history: () => history,
    archive: () => archive,
    syncArchive: () => {},
    canPersist: overrides.canPersist ?? (() => true),
    persist: () => {},
    afterHistoryRewind: () => {
      cursorResets += 1;
    },
  });
  return { project, history, command, resets: () => cursorResets };
}

test("/rewind lists numbered snapshots with prompt and file count", async () => {
  const s = await setup();
  const text = await s.command.run("");
  expect(text).toContain("add a file");
  expect(text).toContain("2 files");
  expect(text).toContain("  1  ");
  expect(text).toContain("/rewind N");
});

test("/rewind N previews and changes nothing; /rewind confirm applies it", async () => {
  const s = await setup();
  const preview = await s.command.run("1 both");
  expect(preview).toContain("/rewind confirm");
  expect(preview).toContain("made.txt");
  expect(read(s.project.root, "a.txt")).toBe("changed\n");
  expect(s.history).toHaveLength(4);

  const applied = await s.command.run("confirm");
  expect(applied).toContain("Undo point");
  expect(read(s.project.root, "a.txt")).toBe("alpha\n");
  expect(exists(s.project.root, "made.txt")).toBe(false);
  expect(s.history).toHaveLength(2);
  expect(s.resets()).toBe(1);
});

test("any other input cancels the pending rewind", async () => {
  const s = await setup();
  await s.command.run("1");
  s.command.cancelPending();
  expect(await s.command.run("confirm")).toContain("Nothing to confirm");
  expect(read(s.project.root, "a.txt")).toBe("changed\n");
});

test("default mode is files only", async () => {
  const s = await setup();
  await s.command.run("1");
  await s.command.run("confirm");
  expect(read(s.project.root, "a.txt")).toBe("alpha\n");
  expect(s.history).toHaveLength(4);
  expect(s.resets()).toBe(0);
});

test("bad arguments print the usage; unknown snapshots are named", async () => {
  const s = await setup();
  expect(await s.command.run("banana")).toContain("Usage: /rewind");
  expect(await s.command.run("1 sideways")).toContain("Usage: /rewind");
  expect(await s.command.run("42")).toContain("No snapshot 42");
});

test("a lost lease and a missing session refuse before anything else", async () => {
  const lost = await setup({ canPersist: () => false });
  expect(await lost.command.run("")).toContain("held by another process");
  const none = await setup({ hasSession: () => false });
  expect(await none.command.run("")).toContain("No persistent session");
});
