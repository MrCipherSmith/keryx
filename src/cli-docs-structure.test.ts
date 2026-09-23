import { readFile } from "node:fs/promises";
import { expect, test } from "bun:test";
import { CLI_ROUTES } from "./cli";

// Flow 302 (AC1/AC2): README used to carry two quick starts — an unheaded
// install snippet near the top, and a full "## Quick start" section far
// below, AFTER the deep-dive "The agent harness" and "Core capabilities"
// sections. A newcomer reading top to bottom hit provider-neutral internals
// before ever learning how to install the thing or connect a provider. This
// pins the merged structure so it cannot regress: exactly one "## Quick
// start" heading, placed before both deep dives, walking install -> init ->
// provider -> first session -> where next, in that order.

const README = new URL("../README.md", import.meta.url);

function headingLines(source: string): string[] {
  return source.split("\n").filter((line) => /^#{1,2} /.test(line));
}

function quickStartSection(source: string): string {
  const start = source.indexOf("\n## Quick start\n");
  const end = source.indexOf("\n## Why keryx\n");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("README's Quick start / Why keryx headings were not found where expected");
  }
  return source.slice(start, end);
}

test("README has exactly one Quick start section, before both deep dives", async () => {
  const source = await readFile(README, "utf8");
  const headings = headingLines(source);

  // Guards against silently matching zero headings (a heading-syntax change).
  expect(headings.length).toBeGreaterThan(10);

  expect(headings.filter((h) => h === "## Quick start")).toEqual(["## Quick start"]);

  const quickStartIdx = headings.indexOf("## Quick start");
  const harnessIdx = headings.indexOf("## The agent harness");
  const coreCapabilitiesIdx = headings.indexOf("## Core capabilities");

  expect(quickStartIdx).toBeGreaterThanOrEqual(0);
  expect(harnessIdx).toBeGreaterThan(quickStartIdx);
  expect(coreCapabilitiesIdx).toBeGreaterThan(quickStartIdx);
});

test("README's Quick start walks install, init, provider and first session in order", async () => {
  const source = await readFile(README, "utf8");
  const section = quickStartSection(source);

  const order = [
    "npm install -g @mrciphersmith/keryx",
    "keryx init",
    "### Connect a model provider",
    "### Your first session",
    "keryx shell",
    "### Where to go next",
  ];

  let cursor = -1;
  for (const needle of order) {
    const at = section.indexOf(needle, cursor + 1);
    expect(at).toBeGreaterThan(cursor);
    cursor = at;
  }
});

test("every `keryx <verb>` command shown in README's Quick start is a real CLI verb", async () => {
  const source = await readFile(README, "utf8");
  const section = quickStartSection(source);

  const verbs = new Set(
    Array.from(section.matchAll(/\bkeryx ([a-z][a-z0-9-]*)\b/g), (m) => m[1]).filter(
      (v): v is string => v !== undefined,
    ),
  );

  // Guards the scrape: a formatting change that matched nothing would leave
  // this comparing an empty set and passing while checking nothing.
  expect(verbs.size).toBeGreaterThan(3);

  const unknown = [...verbs].filter((v) => !(v in CLI_ROUTES));
  expect(unknown).toEqual([]);
});
