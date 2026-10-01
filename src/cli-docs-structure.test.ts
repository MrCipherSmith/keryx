import { readFile } from "node:fs/promises";
import { expect, test } from "bun:test";

// Pins the README's invariants: the order of its top-level sections, the
// language switcher, parity of the Russian translation, and a prose budget so
// the page stays a front door rather than a manual.

const README = new URL("../README.md", import.meta.url);
const README_RU = new URL("../README.ru.md", import.meta.url);

const SECTIONS = [
  "What is Keryx",
  "Install",
  "Quickstart",
  "What you get",
  "How it works",
  "Where to go next",
  "Status",
  "Built with Keryx",
  "Community and contributing",
];

const PROSE_WORD_BUDGET = 1000;

function stripFences(source: string): string {
  return source.replace(/^```[\s\S]*?^```[^\n]*$/gm, "");
}

function sectionHeadings(source: string): string[] {
  return stripFences(source)
    .split("\n")
    .filter((line) => /^## /.test(line))
    .map((line) => line.slice(3).trim());
}

function proseWords(source: string): number {
  const prose = stripFences(source)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/\|/g, " ")
    .replace(/[#*>`\[\]]/g, " ");
  return prose.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

test("README keeps its top-level sections in order", async () => {
  const source = await readFile(README, "utf8");
  expect(sectionHeadings(source)).toEqual(SECTIONS);
});

test("README offers the English | Русский switcher and the install command above the demo", async () => {
  const source = await readFile(README, "utf8");
  expect(source).toContain('English | <a href="README.ru.md">Русский</a>');
  const install = source.indexOf("npm install -g @mrciphersmith/keryx");
  const demo = source.indexOf("docs/assets/demo.gif");
  expect(install).toBeGreaterThan(0);
  expect(install).toBeLessThan(demo);
});

test("README.ru.md mirrors the section count and both stay within the prose budget", async () => {
  const en = await readFile(README, "utf8");
  const ru = await readFile(README_RU, "utf8");
  expect(sectionHeadings(ru).length).toBe(SECTIONS.length);
  expect(proseWords(en)).toBeLessThanOrEqual(PROSE_WORD_BUDGET);
  expect(proseWords(ru)).toBeLessThanOrEqual(PROSE_WORD_BUDGET);
});
