import { describe, expect, test } from "bun:test";
import { detectPii } from "./pii";

// Flow 412 AC6: the new scanners and views only add spans. A value that was reported on its own must still be covered
// when it is surrounded by other text, and the rules must stay linear on the shapes the new scanners look at.

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = rng(0xc0ffee);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const digits = (length: number) => Array.from({ length }, () => Math.floor(random() * 10)).join("");
const area = () => String(200 + Math.floor(random() * 700));

const fragments: ReadonlyArray<() => string> = [
  () => `${area()}-${digits(3)}-${digits(4)}`,
  () => `+1 ${area()} ${digits(3)} ${digits(4)}`,
  () => `(${area()}) ${digits(3)}-${digits(4)}`,
  () => `${area()}.${digits(3)}.${digits(4)}`,
  () => `${digits(3)}-${digits(2)}-${digits(4)}`,
  () => `user${digits(2)}@example.com`,
  () => `customer ${pick(["John", "Mary", "Alex"])} ${pick(["Smith", "Jones"])}`,
  () => "4111 1111 1111 1111",
  () => digits(16),
  () => `${digits(4)}-${digits(4)}-${digits(4)}-${digits(4)}`,
  () => `${digits(3)} ${digits(3)} ${digits(4)}`,
  () => "2026-10-07",
  () => `192.168.${digits(1)}.${digits(2)}`,
  () => pick(["call", "the", "name is", "see", "ref", "mail", "pay", "card"]),
];

type Span = { readonly policyId: string; readonly start: number; readonly end: number };

describe("surrounding text never uncovers a value (flow 412 AC6)", () => {
  test("every span found in a fragment is still covered inside a larger text", () => {
    let checked = 0;
    const lost: string[] = [];
    for (let round = 0; round < 3000; round += 1) {
      const parts = Array.from({ length: 1 + Math.floor(random() * 6) }, () => pick(fragments)());
      const joiner = pick([" | ", " ; ", ", "]);
      const text = parts.join(joiner);
      const merged = detectPii(text) as readonly Span[];
      let offset = 0;
      for (const part of parts) {
        for (const alone of detectPii(part) as readonly Span[]) {
          checked += 1;
          const start = offset + alone.start;
          const end = offset + alone.end;
          const covered = merged.some((span) => span.policyId === alone.policyId && span.start <= start && span.end >= end);
          if (!covered && lost.length < 5) lost.push(`${JSON.stringify(text)} ${alone.policyId} ${start}-${end}`);
        }
        offset += part.length + joiner.length;
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(lost).toEqual([]);
  });
});

describe("the new scanners stay linear (flow 412 AC6)", () => {
  const SIZE = 200_000;
  const shapes: ReadonlyArray<readonly [string, string]> = [
    ["dash-joined digit groups", "123-".repeat(SIZE / 4)],
    ["dot-joined digit groups", "1.".repeat(SIZE / 2)],
    ["letters glued to digits", "a1".repeat(SIZE / 2)],
    ["underscore-joined card groups", "4111_".repeat(SIZE / 5)],
    ["newline-joined digit groups", "4111\n".repeat(SIZE / 5)],
    ["tab and dash runs", "1\t-".repeat(SIZE / 3)],
    ["zero-width characters between digits", "1​".repeat(SIZE / 2)],
    ["fullwidth letters", "ＧＢ".repeat(SIZE / 2)],
    ["IBAN-like groups", "GB82 WEST ".repeat(SIZE / 10)],
  ];
  for (const [name, content] of shapes) {
    test(name, () => {
      const started = performance.now();
      detectPii(content);
      // A quadratic scan of 200,000 characters takes minutes; a linear one a fraction of a second.
      expect(performance.now() - started).toBeLessThan(8000);
    });
  }
});
