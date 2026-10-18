import { describe, expect, test } from "bun:test";
import { detectEgress } from "./detect/egress";
import { filterSourceMatches } from "./source-context";

describe("source scan property context", () => {
  test.each([
    "fetch(url, process.env);",
    "fetch(url, options.env ?? process.env);",
    "fetch(url, options?.env);",
    "fetch(url, options /* comment */ .env);",
  ])("distinguishes property syntax: %s", async (content) => {
    const matches = detectEgress(content);
    expect(matches.some((m) => m.policyId === "egress.private-file-publish")).toBe(true);
    expect((await filterSourceMatches(content, "src/example.ts", matches)).matches).toEqual([]);
  });

  test.each([
    'upload(".env");',
    'fetch(url, { body: readFile(".env") });',
    'const text = "upload process.env";',
    '// upload process.env\nconst x = 1;',
    'const text = `upload process.env`;',
    'const r = /upload process.env/;',
    'fetch(url, process[".env"]);',
    'const x = <div>upload process.env</div>;',
  ])("retains non-property mentions: %s", async (content) => {
    const matches = detectEgress(content);
    expect(matches.length).toBeGreaterThan(0);
    expect((await filterSourceMatches(content, "src/example.tsx", matches)).matches).toEqual(matches);
  });

  test("preserves real publication beside properties", async () => {
    const content = 'fetch(url, process.env); upload(".env");';
    const result = await filterSourceMatches(content, "src/example.ts", detectEgress(content));
    expect(result.matches).toHaveLength(1);
    expect(content.slice(result.matches[0]!.start, result.matches[0]!.end)).toBe(".env");
  });

  test("leaves text files unchanged", async () => {
    const content = "upload process.env";
    const matches = detectEgress(content);
    expect((await filterSourceMatches(content, "notes.md", matches)).matches).toEqual(matches);
  });

  test("parser failures retain original matches with warnings", async () => {
    const content = "fetch(url, process.env);";
    const matches = detectEgress(content);
    for (const getParser of [async () => undefined, async () => { throw new Error("unavailable"); }]) {
      const result = await filterSourceMatches(content, "example.ts", matches, getParser);
      expect(result.matches).toEqual(matches);
      expect(result.warning).toBeDefined();
    }
    const invalid = "fetch(url, process.env); const = ;";
    const original = detectEgress(invalid);
    const result = await filterSourceMatches(invalid, "example.ts", original);
    expect(result.matches).toEqual(original);
    expect(result.warning).toBeDefined();
  });
});
