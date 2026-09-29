import { expect, test } from "bun:test";
import type { NormalizedMessage } from "../harness/provider/types";
import { applyConversationRewind, rewindConversation } from "./history";

const u = (content: string): NormalizedMessage => ({ role: "user", content });
const a = (content: string): NormalizedMessage => ({ role: "assistant", content });

const conversation = (): NormalizedMessage[] => [u("one"), a("r1"), u("two"), a("r2"), u("three"), a("r3")];

test("uncompacted: history and archive are cut at the chosen user message", () => {
  const history = conversation();
  const archive = conversation();
  const result = rewindConversation({ history, archive, archiveIndex: 2 });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.history.map((m) => m.content)).toEqual(["one", "r1"]);
  expect(result.archive.map((m) => m.content)).toEqual(["one", "r1"]);
  expect(result.removed).toBe(4);
});

test("rewinding to the first turn empties both", () => {
  const result = rewindConversation({ history: conversation(), archive: conversation(), archiveIndex: 0 });
  expect(result).toMatchObject({ ok: true, history: [], archive: [] });
});

test("compacted: a turn still in the kept tail cuts the context at the same message, keeping the summary", () => {
  const archive = conversation();
  const history = [u("[Compacted summary of earlier turns]"), ...archive.slice(2)];
  const result = rewindConversation({ history, archive, archiveIndex: 4 });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.history.map((m) => m.content)).toEqual(["[Compacted summary of earlier turns]", "two", "r2"]);
  expect(result.archive.map((m) => m.content)).toEqual(["one", "r1", "two", "r2"]);
});

test("compacted: a turn compacted out of the context rebuilds the context from the archive", () => {
  const archive = conversation();
  const history = [u("[Compacted summary of earlier turns]"), ...archive.slice(4)];
  const result = rewindConversation({ history, archive, archiveIndex: 2 });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.history.map((m) => m.content)).toEqual(["one", "r1"]);
  expect(result.archive.map((m) => m.content)).toEqual(["one", "r1"]);
});

test("refuses an index that is out of range or not a user message", () => {
  const base = { history: conversation(), archive: conversation() };
  expect(rewindConversation({ ...base, archiveIndex: 1 }).ok).toBe(false);
  expect(rewindConversation({ ...base, archiveIndex: 99 }).ok).toBe(false);
  expect(rewindConversation({ ...base, archiveIndex: -1 }).ok).toBe(false);
});

test("applyConversationRewind persists the truncation and mutates both arrays in place", () => {
  const history = conversation();
  const archive = conversation();
  const persisted: Array<[number, number]> = [];
  const outcome = applyConversationRewind({
    history,
    archive,
    archiveIndex: 2,
    canPersist: () => true,
    persist: (h, ar) => persisted.push([h.length, ar.length]),
  });
  expect(outcome.ok).toBe(true);
  expect(persisted).toEqual([[2, 2]]);
  expect(history.map((m) => m.content)).toEqual(["one", "r1"]);
  expect(archive.map((m) => m.content)).toEqual(["one", "r1"]);
});

test("applyConversationRewind refuses without changing anything when the lease cannot persist", () => {
  const history = conversation();
  const archive = conversation();
  let persisted = 0;
  const outcome = applyConversationRewind({
    history,
    archive,
    archiveIndex: 2,
    canPersist: () => false,
    persist: () => {
      persisted += 1;
    },
  });
  expect(outcome.ok).toBe(false);
  expect(persisted).toBe(0);
  expect(history).toHaveLength(6);
  expect(archive).toHaveLength(6);
});

test("applyConversationRewind leaves the arrays alone when persisting throws", () => {
  const history = conversation();
  const archive = conversation();
  const outcome = applyConversationRewind({
    history,
    archive,
    archiveIndex: 2,
    canPersist: () => true,
    persist: () => {
      throw new Error("disk full");
    },
  });
  expect(outcome.ok).toBe(false);
  expect(history).toHaveLength(6);
  expect(archive).toHaveLength(6);
});
