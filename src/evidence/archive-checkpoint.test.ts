import { expect, test } from "bun:test";
import { canAppendArchive, createArchiveCheckpoint, isArchiveCheckpoint } from "./archive-checkpoint";

const identity = { dev: 1, ino: 42 };
test("cursor covers only newline-terminated raw records, including ignored records", () => {
  const bytes = Buffer.from(' {"role":"user","content":"π"}\nignored\n{"torn":');
  const state = createArchiveCheckpoint(bytes, identity);
  expect(state.completeBytes).toBe(bytes.lastIndexOf(10) + 1);
  expect(isArchiveCheckpoint(state)).toBe(true);
  expect(createArchiveCheckpoint(Buffer.from("torn"), identity).completeBytes).toBe(0);
});

test("append verifies full complete prefix and file identity before reuse", () => {
  const bytes = Buffer.from('first\n{"unfinished":');
  const state = createArchiveCheckpoint(bytes, identity);
  expect(canAppendArchive(Buffer.from('first\n{"unfinished":true}\n'), identity, state)).toBe(true);
  expect(canAppendArchive(bytes, identity, state)).toBe(true);
  expect(canAppendArchive(Buffer.from('other\n{"unfinished":'), identity, state)).toBe(false);
  expect(canAppendArchive(Buffer.from('first'), identity, state)).toBe(false);
  expect(canAppendArchive(bytes, { ...identity, ino: 43 }, state)).toBe(false);
  expect(canAppendArchive(bytes, { ...identity, dev: 2 }, state)).toBe(false);
});

test("untrusted, incompatible and out-of-range checkpoints cannot authorize reuse", () => {
  const bytes = Buffer.from("first\n"), state = createArchiveCheckpoint(bytes, identity);
  for (const invalid of [null, {}, { ...state, schemaVersion: 2 }, { ...state, completeBytes: -1 },
    { ...state, completeBytes: 1.5 }, { ...state, completeBytes: 8 * 1024 * 1024 + 1 },
    { ...state, prefixHash: "wrong" }, { ...state, dev: "01" }, { ...state, policy: true }]) {
    expect(isArchiveCheckpoint(invalid)).toBe(false);
    expect(canAppendArchive(bytes, identity, invalid)).toBe(false);
  }
  expect(canAppendArchive(bytes, identity, { ...state, completeBytes: 3 })).toBe(false);
  expect(() => createArchiveCheckpoint(bytes, { ...identity, ino: NaN })).toThrow();
});

test("empty prefix is not confused with full-file version and cannot skip a new tail", () => {
  const first = createArchiveCheckpoint(Buffer.from("torn"), identity);
  const second = createArchiveCheckpoint(Buffer.from("torn completed\nnext"), identity);
  expect(first.completeBytes).toBe(0);
  expect(second.completeBytes).toBe(15);
  expect(second.prefixHash).not.toBe(first.prefixHash);
  expect(canAppendArchive(Buffer.from("torn completed\nnext"), identity, first)).toBe(true);
});
