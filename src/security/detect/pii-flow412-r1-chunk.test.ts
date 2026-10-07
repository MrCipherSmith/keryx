import { describe, expect, test } from "bun:test";
import { detectPii } from "./pii";

// Flow 412, review round 1, S10: a number that straddles the end of a normalisation chunk (2 MiB), padded with
// invisible characters, is still read whole. Memory is bounded: the window grows over the number only.

const CHUNK = 1 << 21;

const ssns = (content: string) => detectPii(content).filter((match) => match.policyId === "pii.ssn");

describe("a number that crosses a chunk boundary (S10)", () => {
  for (const pad of [100, 245, 300, 600]) {
    test(`an SSN with ${pad} zero-width characters near the boundary`, () => {
      const lead = "a ".repeat((CHUNK - 290) >> 1);
      const content = `${lead}078${"​".repeat(pad)}-05-1120 tail`;
      const found = ssns(content);
      expect(found).toHaveLength(1);
      expect(found[0]?.start).toBe(lead.length);
      expect(found[0]?.end).toBe(lead.length + 3 + pad + 8);
    });
  }

  test("offsets on both sides of the boundary", () => {
    for (const before of [0, 5, 60, 220, 255, 256, 400]) {
      const lead = "a".repeat(CHUNK - 512 + before - (before % 2));
      const content = `${lead} 078${"​".repeat(300)}-05-1120 tail`;
      const found = ssns(content);
      expect(found, `before ${before}`).toHaveLength(1);
    }
  });

  test("a long run of invisible characters is read in bounded memory", () => {
    const content = `${"a ".repeat(CHUNK >> 1)}078${"​".repeat(1 << 18)}-05-1120`;
    const start = performance.now();
    const found = ssns(content);
    expect(found).toHaveLength(1);
    expect(performance.now() - start).toBeLessThan(5000);
  });
});
