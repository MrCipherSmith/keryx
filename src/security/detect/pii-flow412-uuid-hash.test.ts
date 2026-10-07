import { describe, expect, test } from "bun:test";
import { detectPii, isValidSsn } from "./pii";

// Flow 412 AC5: the extra card and SSN scanners must not turn UUIDs, hashes and base64 into findings. The generator is
// seeded, so every run sees the same corpus.

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

const random = rng(0xf412);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const hex = (length: number) => Array.from({ length }, () => "0123456789abcdef"[Math.floor(random() * 16)]).join("");
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(["8", "9", "a", "b"])}${hex(3)}-${hex(12)}`;
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const base64 = (length: number) => Array.from({ length }, () => BASE64[Math.floor(random() * 64)]).join("");

const countOf = (content: string, policyId: string) => detectPii(content).filter((match) => match.policyId === policyId).length;

// What the SSN rule reported before flow 412: three groups of 3-2-4 digits with a plain dash, validated.
const referenceSsn = (content: string) =>
  [...content.matchAll(/(?<![0-9])\d{3}-\d{2}-\d{4}(?![0-9])/g)].filter((match) => isValidSsn(match[0])).length;

describe("UUIDs are not credit cards (flow 412 AC5)", () => {
  test("200,000 random UUIDs produce no card match", () => {
    let cards = 0;
    for (let chunk = 0; chunk < 100; chunk += 1) {
      cards += countOf(Array.from({ length: 2000 }, uuid).join("\n"), "pii.credit-card");
    }
    expect(cards).toBe(0);
  });

  // Each of these was reported as a card before flow 412 (the digit-only groups of a UUID happen to pass Luhn).
  for (const token of ["83390529-2305-4486-8428-6482da6207f4", "8c53665e-5125-4804-8413-634978082675", "1c666d2a-9500-4308-8622-147903530566"]) {
    test(`${token} is not a card`, () => {
      expect(countOf(token, "pii.credit-card")).toBe(0);
    });
  }

  test("a real card next to a UUID is still reported", () => {
    const content = `card 4111 1111 1111 1111 order ${"00000000-0000-4000-8000-000000000000"}`;
    expect(countOf(content, "pii.credit-card")).toBe(1);
  });
});

describe("hashes and base64 add no SSN (flow 412 AC5)", () => {
  const generators: ReadonlyArray<() => string> = [uuid, () => hex(40), () => hex(64), () => hex(32), () => base64(44), () => base64(88)];

  for (const joiner of ["\n", " ", ","]) {
    test(`200,000 mixed samples joined by ${JSON.stringify(joiner)}`, () => {
      let extra = 0;
      for (let chunk = 0; chunk < 40; chunk += 1) {
        const content = Array.from({ length: 5000 }, () => pick(generators)()).join(joiner);
        extra += Math.max(0, countOf(content, "pii.ssn") - referenceSsn(content));
      }
      expect(extra).toBe(0);
    });
  }
});
