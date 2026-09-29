import { expect, test } from "bun:test";
import type { NormalizedMessage } from "../harness/provider/types";
import { applyRewind } from "./apply";
import { createRewindRecorder } from "./recorder";
import { exists, makeProject, read, write } from "./rewind.test-helpers";

const msg = (role: "user" | "assistant", content: string): NormalizedMessage => ({ role, content }) as NormalizedMessage;

async function setup() {
  const project = makeProject();
  const recorder = createRewindRecorder({ workTree: project.root, dir: () => project.rewindDir, enabled: () => true });
  const history = [msg("user", "one"), msg("assistant", "done one"), msg("user", "two"), msg("assistant", "done two")];
  const archive = [...history];
  recorder.beginTurn({ archiveIndex: 2, prompt: "two" });
  await recorder.beforeMutation();
  write(project.root, "a.txt", "changed\n");
  write(project.root, "new.txt", "new\n");
  const persisted: number[] = [];
  return { project, recorder, history, archive, persisted, seq: recorder.entries()[0]!.seq };
}

test("both: files and conversation go back to the start of the turn", async () => {
  const s = await setup();
  const outcome = await applyRewind({
    recorder: s.recorder,
    seq: s.seq,
    mode: "both",
    history: s.history,
    archive: s.archive,
    canPersist: () => true,
    persist: (history) => void s.persisted.push(history.length),
  });
  expect(outcome).toMatchObject({ ok: true, historyRewound: true, filesRestored: true });
  expect(read(s.project.root, "a.txt")).toBe("alpha\n");
  expect(exists(s.project.root, "new.txt")).toBe(false);
  expect(s.history.map((m) => m.content)).toEqual(["one", "done one"]);
  expect(s.persisted).toEqual([2]);
  expect(outcome.lines.join("\n")).toContain("Undo point");
});

test("files only leaves the conversation alone; history only leaves the files alone", async () => {
  const filesOnly = await setup();
  await applyRewind({ recorder: filesOnly.recorder, seq: filesOnly.seq, mode: "files", history: filesOnly.history, archive: filesOnly.archive, canPersist: () => true, persist: () => {} });
  expect(filesOnly.history).toHaveLength(4);
  expect(read(filesOnly.project.root, "a.txt")).toBe("alpha\n");

  const historyOnly = await setup();
  await applyRewind({ recorder: historyOnly.recorder, seq: historyOnly.seq, mode: "history", history: historyOnly.history, archive: historyOnly.archive, canPersist: () => true, persist: () => {} });
  expect(historyOnly.history).toHaveLength(2);
  expect(read(historyOnly.project.root, "a.txt")).toBe("changed\n");
});

test("a lost session lease refuses everything and touches nothing", async () => {
  const s = await setup();
  const outcome = await applyRewind({ recorder: s.recorder, seq: s.seq, mode: "both", history: s.history, archive: s.archive, canPersist: () => false, persist: () => {} });
  expect(outcome.ok).toBe(false);
  expect(read(s.project.root, "a.txt")).toBe("changed\n");
  expect(s.history).toHaveLength(4);
  expect(s.recorder.entries()).toHaveLength(1);
});

test("a failed persist keeps the conversation, and the files stay recoverable through the undo point", async () => {
  const s = await setup();
  const outcome = await applyRewind({
    recorder: s.recorder,
    seq: s.seq,
    mode: "both",
    history: s.history,
    archive: s.archive,
    canPersist: () => true,
    persist: () => {
      throw new Error("disk full");
    },
  });
  expect(outcome).toMatchObject({ ok: false, historyRewound: false, filesRestored: true });
  expect(s.history).toHaveLength(4);
  expect(outcome.lines.join("\n")).toContain("disk full");
});

test("an unknown snapshot is refused", async () => {
  const s = await setup();
  const outcome = await applyRewind({ recorder: s.recorder, seq: 999, mode: "files", history: s.history, archive: s.archive, canPersist: () => true, persist: () => {} });
  expect(outcome.ok).toBe(false);
});
