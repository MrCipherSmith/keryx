// Flow 393: `/trail` and `/notes` print the session's working memory for the operator.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NOTES_MAX_TOKENS, appendTrailEntry, writeSlate, type Slate } from "../session/slate";
import {
  isNotesCommand,
  isTrailCommand,
  parseTrailArgs,
  runNotesCommand,
  runTrailCommand,
} from "./working-memory-command";

const ts = "2026-10-02T10:00:00.000Z";
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keryx-wm-cmd-"));
  const slate: Slate = {
    anchors: { root: "/repo", touched: [] },
    course: {},
    seeds: [],
    notes: {
      plan: { text: "ship the\nbounded request", ts },
      long: { text: "word ".repeat(80), ts },
    },
  };
  await writeSlate(dir, () => slate);
  await appendTrailEntry(dir, { tool: "read_file", digest: "src/alpha.ts", outcome: "ok", ts });
  await appendTrailEntry(dir, { tool: "grep", digest: "needle in src", outcome: "ok", ts });
  await appendTrailEntry(dir, { tool: "read_file", digest: "src/beta.ts", outcome: "ok", ts });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("the commands are recognised by their first word only", () => {
  expect(isTrailCommand("/trail")).toBe(true);
  expect(isTrailCommand("  /trail 5 tool=grep")).toBe(true);
  expect(isTrailCommand("/trailing")).toBe(false);
  expect(isNotesCommand("/notes plan")).toBe(true);
  expect(isNotesCommand("/note")).toBe(false);
});

test("trail arguments map onto the slate_trail input and bad ones say what is wrong", () => {
  expect(parseTrailArgs("")).toEqual({ input: {} });
  expect(parseTrailArgs("5 tool=read_file file=alpha from=2 to=9")).toEqual({
    input: { limit: 5, tool: "read_file", file: "alpha", from_step: 2, to_step: 9 },
  });
  expect(parseTrailArgs("abc")).toMatchObject({ error: expect.stringContaining("not a count") });
  expect(parseTrailArgs("0")).toMatchObject({ error: expect.stringContaining("not a count") });
  expect(parseTrailArgs("colour=red")).toMatchObject({ error: expect.stringContaining("Unknown filter") });
  expect(parseTrailArgs("tool=")).toMatchObject({ error: expect.stringContaining("no value") });
  expect(parseTrailArgs("from=x")).toMatchObject({ error: expect.stringContaining("not a step number") });
});

test("/trail lists every recorded call with its step, and a filter narrows it", async () => {
  const all = await runTrailCommand("", dir);
  expect(all).toContain("Trail: 3 recorded tool calls");
  expect(all).toContain("src/alpha.ts");
  expect(all).toContain("needle in src");
  expect(all).toContain("src/beta.ts");
  const grep = await runTrailCommand("tool=grep", dir);
  expect(grep).toContain("needle in src");
  expect(grep).not.toContain("src/alpha.ts");
  const file = await runTrailCommand("file=beta", dir);
  expect(file).toContain("src/beta.ts");
  expect(file).not.toContain("needle in src");
});

test("/trail with nothing recorded, with a bad argument, or with no session never throws", async () => {
  const empty = await mkdtemp(path.join(tmpdir(), "keryx-wm-cmd-empty-"));
  try {
    await writeSlate(empty, () => ({ anchors: { root: "/r", touched: [] }, course: {}, seeds: [] }));
    expect(await runTrailCommand("", empty)).toContain("Trail: 0 recorded tool calls");
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
  expect(await runTrailCommand("nonsense", dir)).toContain("not a count");
  expect(await runTrailCommand("", undefined)).toContain("No session is open yet");
  expect(await runTrailCommand("", path.join(dir, "missing"))).toContain("Trail: 0 recorded tool calls");
});

test("/notes lists the notes with their size and the shelf budget, and /notes KEY prints one whole", async () => {
  const list = await runNotesCommand("", dir);
  expect(list).toContain("Notes: 2");
  expect(list).toContain(`of ${NOTES_MAX_TOKENS} tokens`);
  expect(list).toContain("plan (");
  expect(list).toContain("..."); // the long one is cut in the list
  const one = await runNotesCommand("plan", dir);
  expect(one).toContain("Note plan");
  expect(one).toContain("ship the\nbounded request");
  expect(await runNotesCommand("long", dir)).toContain("word ".repeat(80));
});

test("/notes with no notes, an unknown key, or no session says so", async () => {
  expect(await runNotesCommand("nope", dir)).toContain("no note named 'nope'");
  expect(await runNotesCommand("nope", dir)).toContain("plan, long");
  const empty = await mkdtemp(path.join(tmpdir(), "keryx-wm-cmd-empty-"));
  try {
    await writeSlate(empty, () => ({ anchors: { root: "/r", touched: [] }, course: {}, seeds: [] }));
    expect(await runNotesCommand("", empty)).toContain("Notes: none yet");
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
  expect(await runNotesCommand("", undefined)).toContain("No session is open yet");
});
