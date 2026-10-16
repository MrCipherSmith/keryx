import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { askAnswerNoteKey, findStoredAnswer, rememberAnswer, storedAnswerOptionId } from "./ask-answer-notes";
import { isReservedNoteKey, readSlate, SlateNoteRefusedError, writeNote, writeSlate } from "./slate";

const TS = "2026-10-16T00:00:00.000Z";

async function openSlate(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-ask-notes-"));
  await writeSlate(dir, () => ({ anchors: { root: dir, touched: [] }, course: {}, seeds: [] }));
  return dir;
}

test("the key ignores case, punctuation and option order, but not the option set", () => {
  const key = askAnswerNoteKey("Which branch?", ["yes", "no"]);
  expect(key).toMatch(/^answer\.[0-9a-f]{12}$/);
  expect(askAnswerNoteKey("  which BRANCH ", ["no", "yes"])).toBe(key);
  expect(askAnswerNoteKey("Which branch?", ["main", "dev"])).not.toBe(key);
  expect(askAnswerNoteKey("Which branch?", ["yes", "no", "maybe"])).not.toBe(key);
});

test("an empty question has no key and is never stored", async () => {
  const dir = await openSlate();
  expect(askAnswerNoteKey(" ?! ", ["yes", "no"])).toBeUndefined();
  expect(await rememberAnswer(dir, " ?! ", ["yes", "no"], 'User selected id="yes"', TS)).toBe(false);
  expect(await findStoredAnswer(dir, " ?! ", ["yes", "no"])).toBeUndefined();
});

test("a stored answer is replayed only for the same question with the same options", async () => {
  const dir = await openSlate();
  expect(await rememberAnswer(dir, "Which branch?", ["yes", "no"], 'User selected id="yes" label="Yes"', TS)).toBe(true);
  expect(await findStoredAnswer(dir, "which branch", ["no", "yes"])).toBe('User selected id="yes" label="Yes"');
  expect(await findStoredAnswer(dir, "Which branch?", ["main", "dev"])).toBeUndefined();
});

test("a note without the answer marker is not an answer", async () => {
  const dir = await openSlate();
  const key = askAnswerNoteKey("Which branch?", ["yes", "no"]) as string;
  await writeNote(dir, key, 'User selected id="yes"', TS, { harness: true });
  expect(await findStoredAnswer(dir, "Which branch?", ["yes", "no"])).toBeUndefined();
});

test("a stored pick whose id is not among the current options is dropped", async () => {
  const dir = await openSlate();
  const key = askAnswerNoteKey("Which branch?", ["yes", "no"]) as string;
  await writeNote(dir, key, 'Q: Which branch?\nA: User selected id="gone" label="Gone"', TS, { harness: true });
  expect(await findStoredAnswer(dir, "Which branch?", ["yes", "no"])).toBeUndefined();
});

test("an own answer names no option and is replayed as given", async () => {
  const dir = await openSlate();
  const own = "User gave their OWN answer (none of the offered options): feature/x";
  expect(storedAnswerOptionId(own)).toBeUndefined();
  expect(storedAnswerOptionId('User selected id="yes" label="Yes"')).toBe("yes");
  await rememberAnswer(dir, "Which branch?", ["yes", "no"], own, TS);
  expect(await findStoredAnswer(dir, "Which branch?", ["yes", "no"])).toBe(own);
});

test("the answer namespace is reserved: a non-harness write or delete is refused in any case", async () => {
  const dir = await openSlate();
  const key = askAnswerNoteKey("Which branch?", ["yes", "no"]) as string;
  expect(isReservedNoteKey(key)).toBe(true);
  expect(isReservedNoteKey("ANSWER.abc")).toBe(true);
  expect(isReservedNoteKey("answers")).toBe(false);
  await expect(writeNote(dir, key, 'Q: x\nA: User selected id="yes"', TS)).rejects.toBeInstanceOf(SlateNoteRefusedError);
  await expect(writeNote(dir, "Answer.x", "forged", TS)).rejects.toBeInstanceOf(SlateNoteRefusedError);
  await rememberAnswer(dir, "Which branch?", ["yes", "no"], 'User selected id="no"', TS);
  await expect(writeNote(dir, key, undefined, TS)).rejects.toBeInstanceOf(SlateNoteRefusedError);
  expect((await readSlate(dir))?.notes?.[key]?.text).toContain('id="no"');
});
