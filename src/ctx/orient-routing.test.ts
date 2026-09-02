// `keryx orient` is a `UserPromptSubmit` hook whose stdout is added to context,
// and it never read the payload: its output was byte-identical for
// "сделай полное ревью" and "what is 2+2". What reached the agent was the static
// Intent Router table — the same prose that failed to route the session which
// reported this. These tests hold the two properties that change is worth
// having: it says something specific when it knows, and nothing at all when it
// does not.

import { describe, expect, test } from "bun:test";
import { formatRoutingBlock, routePrompt, ROUTING_FLOOR } from "./orient-routing";

describe("routePrompt", () => {
  test("a full-review request routes to the orchestrator", async () => {
    const [top] = await routePrompt("сделай мне полное ревью без исправления");
    expect(top?.name).toBe("review-orchestrator");
    expect(top?.path).toBe(".metaproject/skills/gdskills/review/review-orchestrator/SKILL.md");
  });

  test("a request naming a specialist routes to the specialist", async () => {
    expect((await routePrompt("frontend review"))[0]?.name).toBe("review-frontend");
  });

  test("an ordinary question routes nowhere — the floor is the point", async () => {
    // A router that answers every prompt is one the agent learns to ignore, and
    // a confident wrong name costs more than silence.
    expect(await routePrompt("what is 2+2")).toEqual([]);
    expect(await routePrompt("hi")).toEqual([]);
  });

  test("bare token overlap does not clear the floor", async () => {
    // 10 points per overlapping token and no trigger: on-topic words alone must
    // not produce a recommendation.
    expect(ROUTING_FLOOR).toBeGreaterThan(10 * 4);
    for (const match of await routePrompt("сделай мне полное ревью без исправления")) {
      expect(match.score).toBeGreaterThanOrEqual(ROUTING_FLOOR);
    }
  });

  test("at most two candidates are returned", async () => {
    expect((await routePrompt("review the code changes")).length).toBeLessThanOrEqual(2);
  });
});

describe("formatRoutingBlock", () => {
  const prompt = "сделай мне полное ревью без исправления";

  test("no match produces no block at all", async () => {
    expect(formatRoutingBlock(prompt, [])).toBe("");
  });

  test("the block names the skill, its path, and stays advisory", async () => {
    const block = formatRoutingBlock(prompt, await routePrompt(prompt));
    expect(block).toContain("Routing for THIS request");
    expect(block).toContain("review-orchestrator");
    expect(block).toContain(".metaproject/skills/gdskills/review/review-orchestrator/SKILL.md");
    // Advisory by construction: "the agent did not invoke a skill" is the
    // absence of an action, and PreToolUse intercepts actions — there is
    // nothing here that could block even if the wording pretended otherwise.
    expect(block).toContain("suggestion, not a gate");
    expect(block).not.toContain("blocked");
  });

  test("the runner-up is named when there is one", async () => {
    const block = formatRoutingBlock("review code", [
      { name: "review-orchestrator", category: "review", score: 90, path: "a" },
      { name: "code-ai-review", category: "review", score: 75, path: "b" },
    ]);
    expect(block).toContain("Runner-up: code-ai-review");
  });

  test("a long prompt is truncated rather than pasted whole into every turn", async () => {
    const long = "проведи полное ревью ".repeat(40);
    const block = formatRoutingBlock(long, await routePrompt(long));
    const requestLine = block.split("\n").find((l) => l.startsWith("Request:")) ?? "";
    expect(requestLine.length).toBeLessThan(200);
    expect(requestLine).toContain("…");
  });

  test("a prompt with newlines stays on one line", async () => {
    const block = formatRoutingBlock("сделай полное ревью\n\nи ничего не чини", await routePrompt("сделай полное ревью"));
    const requestLine = block.split("\n").filter((l) => l.startsWith("Request:"));
    expect(requestLine).toHaveLength(1);
  });
});
