import { describe, expect, test } from "bun:test";
import { HARNESSES, harnessById, modelFor, modelPeers, HARD_TASK_GOLD_THRESHOLD } from "./retrieval-harnesses";
import type { RetrievalTask } from "./retrieval-tasks";

function task(goldCount: number): RetrievalTask {
  return {
    id: "t",
    sha: "s",
    parent: "p",
    query: "q",
    gold: Array.from({ length: goldCount }, (_, i) => `src/f${i}.ts`),
  };
}

describe("the harness table", () => {
  test("every harness has a distinct id", () => {
    const ids = HARNESSES.map((harness) => harness.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("an unknown harness names the ones that exist rather than failing blankly", () => {
    expect(() => harnessById("opencode")).toThrow(/unknown harness opencode/);
    // The list is derived, so a harness added later appears here without an edit.
    expect(() => harnessById("opencode")).toThrow(new RegExp(HARNESSES[0]!.id));
  });
});

describe("modelFor", () => {
  test("the rule is gold-set size and nothing else", () => {
    for (const harness of HARNESSES) {
      expect(modelFor(harness, task(HARD_TASK_GOLD_THRESHOLD))).toBe(harness.hardModel);
      expect(modelFor(harness, task(HARD_TASK_GOLD_THRESHOLD - 1))).toBe(harness.easyModel);
    }
  });

  test("the same task under one harness always resolves the same model", () => {
    // Both arms call this. If it were not a function of the task alone, the two
    // arms of a task could run on different models and the comparison would be
    // meaningless while still producing numbers.
    const harness = HARNESSES[0]!;
    const t = task(2);
    expect(modelFor(harness, t)).toBe(modelFor(harness, t));
  });
});

describe("harnesses that must agree on the model", () => {
  test("there is at least one such pair, and it agrees on every task size", () => {
    // The keryx leg's whole purpose: against the grok leg, the shell is the only
    // variable. If the two resolved different models the comparison would
    // silently become a model comparison — and it would still produce numbers.
    const peers = modelPeers();
    expect(peers.length).toBeGreaterThan(0);
    for (const group of peers) {
      for (let gold = 1; gold <= 8; gold += 1) {
        const models = group.map((harness) => modelFor(harness, task(gold)));
        expect(new Set(models).size).toBe(1);
      }
    }
  });

  test("the pairing is derived from the table, not asserted about named harnesses", () => {
    // Written this way on purpose: a test that hardcodes "grok and keryx" keeps
    // passing after someone changes one of their model lists.
    const peers = modelPeers();
    const grouped = peers.flat().map((harness) => harness.id);
    expect(grouped).toContain("keryx");
    expect(grouped.length).toBeGreaterThan(1);
  });
});
