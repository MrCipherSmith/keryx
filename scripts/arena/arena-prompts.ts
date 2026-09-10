// What the agent is actually asked, per task type.
//
// The pilot hardwires one prompt into `runArm` (`retrieval-run.ts:76-87`, called
// at `:180`) because it has one task type. The arena has two whose instructions
// cannot be shared: a retrieval task must not be told how to search, and an
// implementation task must be told what "done" means.
//
// Two rules hold for both, and both are asserted in tests rather than trusted:
//
//  1. **The prompt is byte-identical between arms.** It is the one thing a
//     two-arm comparison must never vary. A prompt that mentioned the workspace
//     would make the context arm's advantage partly an instruction.
//  2. **No tool, mechanism or vocabulary of the system under test appears.**
//     Naming `keryx`, `.metaproject`, a graph or a wiki would measure obedience
//     rather than whether having the workspace helped. This is why the pilot's
//     own prompt deliberately says nothing about how to search, and that
//     reasoning carries over unchanged.

import type { ArenaTask } from "./arena-tasks";

/**
 * Retrieval: name the files, nothing about how to find them.
 *
 * The reply format is requested but not enforced, and `extractPaths` pulls paths
 * out of prose. A mandated format would score formatting compliance alongside
 * retrieval, and an agent that found the right files but answered in a sentence
 * would be marked wrong for the wrong reason.
 */
function researchPrompt(task: ArenaTask): string {
  return [
    "You are in a TypeScript repository you have not seen before.",
    "",
    "A change was made to this codebase. Here is what it was for:",
    "",
    task.query,
    "",
    "Identify which source files that change touched.",
    "Answer with repository-relative paths, one per line, and nothing else.",
  ].join("\n");
}

/**
 * Implementation: the ticket text, and what counts as finished.
 *
 * "Done" has to be stated or the arms are scored against different standards —
 * one agent stopping at a sketch and another at a working change is a difference
 * in what they were asked, not in what the workspace gave them. The wording names
 * no file, no symbol and no mechanism: locating the code is the task.
 */
function implementPrompt(task: ArenaTask): string {
  return [
    "You are working in a TypeScript repository. Implement the following change.",
    "",
    task.query,
    "",
    "Finish the work: edit the source so the described behaviour holds.",
    "Do not commit, do not push, and do not create a branch.",
    "When you are done, say which files you changed and why.",
  ].join("\n");
}

/** Substrings that must never appear in a prompt. Checked, not hoped for. */
export const FORBIDDEN_PROMPT_MARKERS: readonly string[] = [
  "keryx",
  "metaproject",
  "gdgraph",
  "gdwiki",
  "gdctx",
  "knowledge graph",
  "code graph",
  "routing index",
  "wiki",
];

/**
 * Refuse a prompt that tells the agent about the thing being measured.
 *
 * Runs on every prompt before it is handed over, not only in tests. A prompt is
 * the cheapest place for the measurement to leak, and the leak would be invisible
 * in the results — it would simply look like the context arm doing better.
 */
export function assertPromptNeutral(prompt: string): void {
  const lowered = prompt.toLowerCase();
  const found = FORBIDDEN_PROMPT_MARKERS.filter((marker) => lowered.includes(marker));
  if (found.length > 0) {
    throw new Error(
      `the prompt names ${found.join(", ")} — that instructs the agent about the system under test, ` +
        "so the context arm's advantage would be partly the instruction rather than the workspace",
    );
  }
}

export function buildArenaPrompt(task: ArenaTask): string {
  const prompt = task.type === "implement" ? implementPrompt(task) : researchPrompt(task);
  assertPromptNeutral(prompt);
  return prompt;
}
