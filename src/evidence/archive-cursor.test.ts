import { expect, test } from "bun:test";
import { ArchiveCursor } from "./archive-cursor";

const identity = { dev: 1, ino: 2 }, check = () => {};
const row = (content: string) => Buffer.from(JSON.stringify({ role: "user", content }) + "\n");
test("cursor reuses only complete verified records and completes torn UTF8 tails", () => {
  const cursor = new ArchiveCursor(), first = row("first"), next = row("π");
  try {
    const initial = cursor.prepare("s", first, identity, 10, check);
    expect(initial.records[0]?.text).toBe("first"); initial.commit(check);
    const torn = cursor.prepare("s", Buffer.concat([first, next.subarray(0, next.indexOf(Buffer.from("π")) + 1)]), identity, 10, check);
    expect(torn.parsedRows).toBe(0); expect(torn.reusedRows).toBe(1); torn.commit(check);
    const complete = cursor.prepare("s", Buffer.concat([first, next]), identity, 10, check);
    expect(complete.parsedRows).toBe(1); expect(complete.records.map(r => r.text)).toEqual(["first", "π"]);
    expect(cursor.prepare("s", row("other"), identity, 10, check).reusedRows).toBe(0);
    expect(cursor.prepare("s", first, { dev: 1, ino: 3 }, 10, check).reusedRows).toBe(0);
    expect(cursor.prepare("other", first, identity, 10, check).reusedRows).toBe(0);
    cursor.clear(); expect(complete.commit(check)).toBe(false);
  } finally { cursor.clear(); }
});
test("cursor guards retention, record budgets, invalidation and concurrent preparations", () => {
  const cursor = new ArchiveCursor(2048, 1), bytes = Buffer.concat([Buffer.from("bad-json\n{}\n"), row("text")]);
  try {
    const initial = cursor.prepare("s", bytes, identity, 3, check);
    expect(initial.parsedRows).toBe(3); expect(initial.records).toHaveLength(1);
    expect(() => initial.commit(() => { throw Error("revoked"); })).toThrow("revoked");
    initial.commit(check);
    expect(() => cursor.prepare("s", bytes, identity, 2, check)).toThrow("budget");
    const old = cursor.prepare("s", bytes, identity, 3, check);
    cursor.prepare("other", bytes, identity, 3, check).commit(check);
    expect(old.commit(check)).toBe(false);
    expect(cursor.prepare("s", bytes, identity, 3, check).reusedRows).toBe(0);
    expect(cursor.prepare("other", row("x".repeat(4096)), identity, 3, check).commit(check)).toBe(false);
    expect(cursor.prepare("other", bytes, identity, 3, check).reusedRows).toBe(0);
  } finally { cursor.clear(); }
});


test("cursor use cannot extend the fixed raw-text retention timer", async () => {
  const { spyOn } = await import("bun:test");
  const timer = spyOn(globalThis, "setTimeout");
  const cursor = new ArchiveCursor();
  try {
    cursor.prepare("s", row("first"), identity, 10, check).commit(check);
    cursor.prepare("s", Buffer.concat([row("first"), row("next")]), identity, 10, check).commit(check);
    expect(timer.mock.calls).toHaveLength(1);
    expect(timer.mock.calls[0]?.[1]).toBe(30000);
    cursor.clear();
    cursor.prepare("s", row("fresh"), identity, 10, check).commit(check);
    expect(timer.mock.calls).toHaveLength(2);
  } finally { cursor.clear(); timer.mockRestore(); }
});
