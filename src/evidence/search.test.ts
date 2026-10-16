import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chunkEvidence, searchLexical } from "./search";
const doc = (text: string, sourceId = "f1") => ({ sourceId, sourcePath: "src/a.ts", versionHash: "a".repeat(64), text });
describe("lexical evidence retrieval", () => {
  test("chunks deterministically and records hashes and locators", () => {
    const chunks = chunkEvidence(doc("alpha one\nbeta two\ngamma three"), 64);
    expect(chunks).toEqual(chunkEvidence(doc("alpha one\nbeta two\ngamma three"), 64));
    expect(chunks.map(chunk => chunk.contentHash)).toEqual(chunks.map(chunk => createHash("sha256").update(chunk.text).digest("hex")));
    expect(chunks.every(chunk => chunk.trustedAsPolicy === false && chunk.endByte >= chunk.startByte && chunk.endLine >= chunk.startLine)).toBe(true);
  });
  test("ranks matches deterministically and supports no-match", () => {
    const chunks = [...chunkEvidence(doc("evidence retrieval lexical search")), ...chunkEvidence(doc("unrelated weather report", "f2"))];
    expect(searchLexical(chunks, "retrieval").map(chunk => chunk.sourceId)).toEqual(["f1"]);
    expect(searchLexical(chunks, "no such phrase")).toEqual([]);
    expect(() => searchLexical(chunks, " ")).toThrow();
  });
  test("splits oversized lines without losing UTF-8 bytes or duplicating chunk identities", () => {
    const text = "я😀".repeat(40);
    const chunks = chunkEvidence(doc(text), 64);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(c => c.text).join("")).toBe(text);
    expect(new Set(chunks.map(c => c.chunkId)).size).toBe(chunks.length);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(64);
      expect(Buffer.from(text).subarray(chunk.startByte, chunk.endByte).toString()).toBe(chunk.text);
      expect([chunk.startLine, chunk.endLine]).toEqual([1, 1]);
    }
  });
  test("binds repeated same-line chunks to distinct byte ranges", () => {
    const chunks = chunkEvidence(doc("x".repeat(192)), 64);
    expect(chunks.map(c => [c.startByte, c.endByte])).toEqual([[0, 64], [64, 128], [128, 192]]);
    expect(new Set(chunks.map(c => c.chunkId)).size).toBe(3);
  });
  test("pins a conservative UTF-8-byte token estimate with a 400-token target", () => {
    const chunks = chunkEvidence(doc("x".repeat(1400)), 16384);
    expect(chunks.map(c => [...c.text].length)).toEqual([400, 400, 400, 200]);
    expect(chunks.map(c => c.text).join("")).toBe("x".repeat(1400));
  });
  test("preserves line positions after splitting a long line", () => {
    const text = `first\n${"я".repeat(80)}\nlast`;
    for (const chunk of chunkEvidence(doc(text), 64)) {
      expect(Buffer.from(text).subarray(chunk.startByte, chunk.endByte).toString()).toBe(chunk.text);
      expect(chunk.startLine).toBe(text.slice(0, Buffer.from(text).subarray(0, chunk.startByte).toString().length).split("\n").length);
    }
  });
  test("byte locators match original UTF-8 slices across chunk boundaries", () => {
    const text = `${"я".repeat(20)}\n${"b".repeat(40)}\nlast`;
    const chunks = chunkEvidence(doc(text), 64);
    expect(chunks).toHaveLength(2);
    expect(chunks.map(c => [c.startByte, c.endByte])).toEqual([[0, 40], [41, 86]]);
    for (const chunk of chunks) {
      expect(Buffer.from(text).subarray(chunk.startByte, chunk.endByte).toString()).toBe(chunk.text);
      expect(text.split("\n").slice(chunk.startLine - 1, chunk.endLine).join("\n")).toBe(chunk.text);
    }
  });
  test("accepts a line exactly at the bound after another chunk", () => {
    const chunks = chunkEvidence(doc(`first\n${"x".repeat(64)}`), 64);
    expect(chunks.map(c => [c.startByte, c.endByte])).toEqual([[0, 5], [6, 70]]);
  });
});


describe("lexical runtime query bounds", () => {
  test("accepts up to 8192 UTF-8 bytes, refuses above the limit", () => {
    expect(searchLexical([], "я".repeat(4096))).toEqual([]);
    expect(() => searchLexical([], "я".repeat(4096) + "x")).toThrow();
  });
  test("counts document frequency once per document and preserves BM25 order", () => {
    const chunks = [
      ...chunkEvidence(doc("alpha alpha alpha beta", "repeat")),
      ...chunkEvidence(doc("alpha beta", "short")),
      ...chunkEvidence(doc("beta weather weather weather", "other")),
    ];
    expect(searchLexical(chunks, "alpha").map(c => c.sourceId)).toEqual(["repeat", "short"]);
    expect(searchLexical(chunks, "alpha alpha")).toEqual(searchLexical(chunks, "alpha"));
    expect(searchLexical([...chunks].reverse(), "alpha")).toEqual(searchLexical(chunks, "alpha"));
  });
  test("refuses oversized corpus before ranking even with a small result limit", () => {
    const chunk = chunkEvidence(doc("alpha"))[0]!;
    expect(() => searchLexical(Array(100001).fill(chunk), "alpha", 1)).toThrow("corpus budget");
  });
});

test("keeps a fitting paragraph whole after another paragraph", () => {
  const text = "a".repeat(250) + "\n\n" + "b".repeat(100) + "\n" + "c".repeat(100);
  const chunks = chunkEvidence(doc(text));
  expect(chunks).toHaveLength(2);
  expect(chunks[1]!.text).toBe("b".repeat(100) + "\n" + "c".repeat(100));
  for (const c of chunks) expect(Buffer.from(text).subarray(c.startByte, c.endByte).toString()).toBe(c.text);
});
test("bounds source bytes and stops chunk construction at the remaining budget", () => {
  expect(() => chunkEvidence(doc("\n".repeat(8 * 1024 * 1024 + 1)))).toThrow("source budget");
  expect(() => chunkEvidence(doc("x".repeat(1200)), 2048, 1)).toThrow("chunk budget");
});
test("paragraph locators remain exact for CRLF, blank lines and oversized Unicode", () => {
  const text = "\n\nfirst\r\n\r\n" + "я😀".repeat(140) + "\n\n\nlast\n";
  for (const c of chunkEvidence(doc(text))) {
    expect(Buffer.from(text).subarray(c.startByte, c.endByte).toString()).toBe(c.text);
    expect(c.startLine).toBe(Buffer.from(text).subarray(0, c.startByte).toString().split("\n").length);
    expect(c.endLine - c.startLine + 1).toBe(c.text.split("\n").length);
    expect(Buffer.byteLength(c.text)).toBeLessThanOrEqual(400);
  }
});
