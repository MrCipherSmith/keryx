import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { askAnswerNoteKey, findStoredAnswer, rememberAnswer, storedAnswerOptionId, type AnswerOption } from "./ask-answer-notes";
import {
  MAX_STORED_ANSWERS,
  NOTES_MAX_TOKENS,
  isReservedNoteKey,
  readArchivedWorkingMemory,
  readSlate,
  SlateNoteRefusedError,
  workingMemoryOf,
  writeAnswer,
  writeNote,
  writeSlate,
} from "./slate";

const TS = "2026-10-16T00:00:00.000Z";
const YES_NO: AnswerOption[] = [
  { id: "yes", label: "Yes" },
  { id: "no", label: "No" },
];

async function openSlate(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-ask-notes-"));
  await writeSlate(dir, () => ({ anchors: { root: dir, touched: [] }, course: {}, seeds: [] }));
  return dir;
}

test("the key ignores case, punctuation and option order, but not the option ids or labels", () => {
  const key = askAnswerNoteKey("Which branch?", YES_NO);
  expect(key).toMatch(/^answer\.[0-9a-f]{12}$/);
  expect(askAnswerNoteKey("  which BRANCH ", [{ id: "no", label: "no!" }, { id: " yes", label: "YES" }])).toBe(key);
  expect(askAnswerNoteKey("Which branch?", [{ id: "main", label: "Yes" }, { id: "dev", label: "No" }])).not.toBe(key);
  expect(askAnswerNoteKey("Which branch?", [...YES_NO, { id: "maybe", label: "Maybe" }])).not.toBe(key);
  // relabelled: the same ids now mean something else
  expect(askAnswerNoteKey("Which branch?", [{ id: "yes", label: "Delete it" }, { id: "no", label: "Keep it" }])).not.toBe(key);
});

test("an empty question has no key and is never stored", async () => {
  const dir = await openSlate();
  expect(askAnswerNoteKey(" ?! ", YES_NO)).toBeUndefined();
  expect(await rememberAnswer(dir, " ?! ", YES_NO, 'User selected id="yes"', TS)).toBe(false);
  expect(await findStoredAnswer(dir, " ?! ", YES_NO)).toBeUndefined();
});

test("a stored answer is replayed only for the same question with the same options", async () => {
  const dir = await openSlate();
  expect(await rememberAnswer(dir, "Which branch?", YES_NO, 'User selected id="yes" label="Yes"', TS)).toBe(true);
  expect(await findStoredAnswer(dir, "which branch", [...YES_NO].reverse())).toBe('User selected id="yes" label="Yes"');
  expect(await findStoredAnswer(dir, "Which branch?", [{ id: "yes", label: "Delete" }, { id: "no", label: "Keep" }])).toBeUndefined();
});

test("operator answers live outside the Notes: not shown as notes, not counted, not writable by slate_note", async () => {
  const dir = await openSlate();
  await rememberAnswer(dir, "Which branch?", YES_NO, 'User selected id="yes"', TS);
  const slate = await readSlate(dir);
  expect(slate?.notes).toBeUndefined();
  expect(Object.keys(slate?.answers ?? {})).toEqual([askAnswerNoteKey("Which branch?", YES_NO) as string]);
  expect(slate?.answers?.[askAnswerNoteKey("Which branch?", YES_NO) as string]?.source).toBe("operator");
  // a note filling the whole budget is still accepted: answers hold none of it
  await writeNote(dir, "big", "x".repeat(1900), TS);
  expect(NOTES_MAX_TOKENS).toBeGreaterThan(0);
});

test("a note without the answer marker is not an answer", async () => {
  const dir = await openSlate();
  const key = askAnswerNoteKey("Which branch?", YES_NO) as string;
  await writeAnswer(dir, key, 'User selected id="yes"', TS);
  expect(await findStoredAnswer(dir, "Which branch?", YES_NO)).toBeUndefined();
});

test("a stored pick whose (trimmed) id is not among the current options is dropped", async () => {
  const dir = await openSlate();
  const key = askAnswerNoteKey("Which branch?", YES_NO) as string;
  await writeAnswer(dir, key, 'Q: Which branch?\nA: User selected id="gone" label="Gone"', TS);
  expect(await findStoredAnswer(dir, "Which branch?", YES_NO)).toBeUndefined();
  await writeAnswer(dir, key, 'Q: Which branch?\nA: User selected id=" yes " label="Yes"', TS);
  expect(await findStoredAnswer(dir, "Which branch?", YES_NO)).toContain('id=" yes "');
  expect(storedAnswerOptionId('User selected id=" yes "')).toBe("yes");
});

test("an own answer names no option and is replayed as given", async () => {
  const dir = await openSlate();
  const own = "User gave their OWN answer (none of the offered options): feature/x";
  expect(storedAnswerOptionId(own)).toBeUndefined();
  expect(storedAnswerOptionId('User selected id="yes" label="Yes"')).toBe("yes");
  await rememberAnswer(dir, "Which branch?", YES_NO, own, TS);
  expect(await findStoredAnswer(dir, "Which branch?", YES_NO)).toBe(own);
});

test("answers are capped and the oldest is evicted first", async () => {
  const dir = await openSlate();
  for (let i = 0; i < MAX_STORED_ANSWERS + 3; i += 1) {
    await rememberAnswer(dir, `Question ${i}?`, YES_NO, 'User selected id="yes"', `2026-10-16T00:00:${String(i).padStart(2, "0")}.000Z`);
  }
  const answers = (await readSlate(dir))?.answers ?? {};
  expect(Object.keys(answers)).toHaveLength(MAX_STORED_ANSWERS);
  expect(await findStoredAnswer(dir, "Question 0?", YES_NO)).toBeUndefined();
  expect(await findStoredAnswer(dir, "Question 2?", YES_NO)).toBeUndefined();
  expect(await findStoredAnswer(dir, "Question 3?", YES_NO)).toBe('User selected id="yes"');
  expect(await findStoredAnswer(dir, `Question ${MAX_STORED_ANSWERS + 2}?`, YES_NO)).toBe('User selected id="yes"');
});

test("the answer namespace is reserved in the Notes: a write or delete is refused in any case", async () => {
  const dir = await openSlate();
  const key = askAnswerNoteKey("Which branch?", YES_NO) as string;
  expect(isReservedNoteKey(key)).toBe(true);
  expect(isReservedNoteKey("ANSWER.abc")).toBe(true);
  expect(isReservedNoteKey("answers")).toBe(false);
  await expect(writeNote(dir, key, 'Q: x\nA: User selected id="yes"', TS)).rejects.toBeInstanceOf(SlateNoteRefusedError);
  await expect(writeNote(dir, "Answer.x", "forged", TS)).rejects.toBeInstanceOf(SlateNoteRefusedError);
  await expect(writeNote(dir, key, undefined, TS)).rejects.toBeInstanceOf(SlateNoteRefusedError);
});

test("legacy answer notes are dropped: on a note write, from the over-budget hint, and on carry to a reopened slate", async () => {
  const dir = await openSlate();
  const legacy = { "answer.0123456789ab": { text: `Q: old\nA: ${"y".repeat(1990)}`, ts: TS } };
  await writeSlate(dir, (prev) => ({ ...prev!, notes: { ...legacy, keep: { text: "k", ts: TS } } }));
  expect(Object.keys(workingMemoryOf(await readSlate(dir)).notes ?? {})).toEqual(["keep"]);
  // an over-budget refusal names only the model's own notes
  await writeSlate(dir, (prev) => ({ ...prev!, notes: { ...legacy, keep: { text: "k".repeat(1990), ts: TS } } }));
  const filler = Array.from({ length: 20 }, (_, i) => `n${i}`);
  let refusal = "";
  for (const name of filler) {
    try {
      await writeNote(dir, name, "z".repeat(1990), TS);
    } catch (error) {
      refusal = (error as Error).message;
      break;
    }
  }
  expect(refusal).toContain("Existing notes:");
  expect(refusal).not.toContain("answer.");
  expect(Object.keys((await readSlate(dir))?.notes ?? {}).some(isReservedNoteKey)).toBe(false);
  // archived slates hand on the model notes and the answers, never a legacy answer note
  const archive = path.join(dir, "slate-archive");
  await writeSlate(archive, () => ({
    anchors: { root: dir, touched: [] },
    course: {},
    seeds: [],
    notes: { ...legacy, keep: { text: "k", ts: TS } },
    answers: { "answer.aaaaaaaaaaaa": { text: "Q: q\nA: a", ts: TS, source: "operator" } },
  }));
  const { rename } = await import("node:fs/promises");
  await rename(path.join(archive, "slate.json"), path.join(archive, "a1.json"));
  const carry = await readArchivedWorkingMemory(dir);
  expect(Object.keys(carry.notes ?? {})).toEqual(["keep"]);
  expect(Object.keys(carry.answers ?? {})).toEqual(["answer.aaaaaaaaaaaa"]);
});
