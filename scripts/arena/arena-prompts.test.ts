import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertPromptNeutral, buildArenaPrompt, FORBIDDEN_PROMPT_MARKERS } from "./arena-prompts";
import { loadFrozenT1, parseTaskFile, type ArenaTask } from "./arena-tasks";

const research: ArenaTask = {
  id: "t1-abc",
  type: "research",
  base: "p1",
  answerSha: "s1",
  query: "fix(pipelines): a step cannot leave its iterator (#1)\n\nDragging it out snaps it back.",
  gold: ["src/pipelines/iterator-dnd-utils.ts"],
  answerNeedles: [],
};

const implement: ArenaTask = {
  id: "t2-4490",
  type: "implement",
  base: "441526a25",
  query: "It shall be possible to move a step out of the iterator area by drag-and-drop.",
  gold: [],
  answerNeedles: ["clampInnerStepPosition"],
};

describe("buildArenaPrompt", () => {
  test("a research prompt carries the query and asks for paths", () => {
    const prompt = buildArenaPrompt(research);
    expect(prompt).toContain("a step cannot leave its iterator");
    expect(prompt).toContain("repository-relative paths");
  });

  test("a research prompt says nothing about HOW to search", () => {
    // The pilot's prompt makes the same choice for the same reason: telling the
    // agent where to look would measure obedience to the instruction rather than
    // whether the workspace helped it orient.
    const prompt = buildArenaPrompt(research).toLowerCase();
    for (const word of ["grep", "search tool", "index", "graph"]) expect(prompt).not.toContain(word);
  });

  test("an implement prompt states what finished means, and forbids committing", () => {
    // Unstated, one agent stops at a sketch and another at a working change, and
    // the difference is in what they were asked rather than in what they had.
    const prompt = buildArenaPrompt(implement);
    expect(prompt).toContain("Finish the work");
    expect(prompt).toContain("Do not commit");
  });

  test("an implement prompt names no file, symbol or mechanism — locating the code IS the task", () => {
    const prompt = buildArenaPrompt(implement);
    expect(prompt).not.toContain("clampInnerStepPosition");
    expect(prompt).not.toContain("PipelineFlow");
    expect(prompt).not.toContain("resolveIteratorDropAction");
  });

  test("the prompt depends only on the task, so both arms get the same bytes", () => {
    // The one thing a two-arm comparison must never vary. Nothing in the builder
    // takes an arm, which is the structural guarantee; this pins it anyway, because
    // the cost of getting it wrong is that every number in the run is meaningless.
    expect(buildArenaPrompt(research)).toBe(buildArenaPrompt(research));
    expect(buildArenaPrompt(implement)).toBe(buildArenaPrompt(implement));
  });
});

describe("assertPromptNeutral", () => {
  test("a clean prompt passes, so the refusals below are not vacuous", () => {
    expect(() => assertPromptNeutral("Identify which source files that change touched.")).not.toThrow();
  });

  test.each(FORBIDDEN_PROMPT_MARKERS.map((marker) => [marker]))("refuses a prompt naming %s", (marker) => {
    expect(() => assertPromptNeutral(`Use the ${marker} to find it.`)).toThrow(new RegExp(marker));
  });

  test("matching is case-insensitive, because a capitalised leak is still a leak", () => {
    expect(() => assertPromptNeutral("Consult the Knowledge Graph first.")).toThrow();
  });

  test("runs on every real prompt, not only in tests", () => {
    // The builder calls it, so a future prompt edit that mentions the mechanism
    // fails at run time rather than producing a quietly better context arm.
    const leaking: ArenaTask = { ...research, query: "the keryx graph is stale" };
    expect(() => buildArenaPrompt(leaking)).toThrow(/keryx/);
  });
});

describe("the real task files produce neutral prompts", () => {
  test("all 13 frozen T1 queries survive the neutrality check", () => {
    // A task is derived from a commit subject, and a subject could mention anything.
    // If one ever names the mechanism, this fails before a sweep spends money.
    const tasks = loadFrozenT1(path.join(import.meta.dir, "..", "..", "arena", "tasks", "t1-tasks.json"));
    for (const task of tasks) expect(() => buildArenaPrompt(task)).not.toThrow();
  });

  test("the T2 file produces a neutral prompt", () => {
    const file = path.join(import.meta.dir, "..", "..", "arena", "tasks", "t2-4490.md");
    const task = parseTaskFile(readFileSync(file, "utf8"), file);
    expect(() => buildArenaPrompt(task)).not.toThrow();
  });
});
