// Review S-1: `open` is idempotent per question while the question is unanswered, so
// repeating it cannot re-roll the arm; once answered, the same text is a new decision.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assignArm, loadRepoSalt } from "./arms";
import { answerDecision, openDecision } from "./journal";
import { readRecords } from "./store";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-idem-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  // every arm is possible, none is forced: the shuffled ones make a re-roll visible in the order too
  await writeFile(path.join(root, ".metaproject", "decisions.config.json"), JSON.stringify({ arms: { A: 1, B: 1, C: 1, D: 1 } }), "utf8");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const OPTIONS = [
  { id: "a", label: "Option A", description: "the safe one" },
  { id: "b", label: "Option B", description: "the quick one" },
  { id: "c", label: "Option C", description: "the odd one" },
  { id: "d", label: "Option D", description: "the fourth one" },
];
const REC = { optionId: "a", reason: "least risk" };

describe("idempotent open", () => {
  test("repeating an open of an unanswered question returns the same id, arm, seed and order, and writes nothing new", async () => {
    const first = await openDecision({ cwd: root, question: "Which colour?", options: OPTIONS, recommendation: REC, random: () => 0 });
    for (let i = 0; i < 12; i += 1) {
      // a different random source, and a call that tags the action, still get the record already drawn
      const again = await openDecision({ cwd: root, question: "Which colour?", options: OPTIONS, recommendation: REC, random: () => (i + 1) / 13, ...(i % 2 === 0 ? { action: "release" } : {}) });
      expect(again).toEqual(first);
    }
    expect((await readRecords(root)).filter((r) => r.kind === "open")).toHaveLength(1);
  });

  test("the question is matched on normalised text and the set of option ids", async () => {
    const first = await openDecision({ cwd: root, question: "Which colour?", options: OPTIONS, recommendation: REC });
    const same = await openDecision({ cwd: root, question: "  which   COLOUR?\n", options: [...OPTIONS].reverse(), recommendation: REC });
    expect(same.id).toBe(first.id);
    const differentText = await openDecision({ cwd: root, question: "Which colour now?", options: OPTIONS, recommendation: REC });
    expect(differentText.id).not.toBe(first.id);
    const differentOptions = await openDecision({ cwd: root, question: "Which colour?", options: OPTIONS.slice(0, 3), recommendation: REC });
    expect(differentOptions.id).not.toBe(first.id);
  });

  test("a repeated open does not consume a position: the next new question gets the next seq", async () => {
    const salt = await loadRepoSalt(root);
    await openDecision({ cwd: root, question: "First?", options: OPTIONS, recommendation: REC });
    await openDecision({ cwd: root, question: "First?", options: OPTIONS, recommendation: REC });
    await openDecision({ cwd: root, question: "First?", options: OPTIONS, recommendation: REC });
    const second = await openDecision({ cwd: root, question: "Second?", options: OPTIONS, recommendation: REC });
    expect(second.seed).toBe(assignArm(salt, 2).seed);
    expect((await readRecords(root)).filter((r) => r.kind === "open").map((r) => (r as { seq: number }).seq)).toEqual([1, 2]);
  });

  test("after the decision is answered, the same question is a new decision", async () => {
    const first = await openDecision({ cwd: root, question: "Which colour?", options: OPTIONS, recommendation: REC });
    await answerDecision({ cwd: root, id: first.id, choice: "b" });
    const next = await openDecision({ cwd: root, question: "Which colour?", options: OPTIONS, recommendation: REC });
    expect(next.id).not.toBe(first.id);
    // and that one is open again: a repeat returns it, not a third
    expect((await openDecision({ cwd: root, question: "Which colour?", options: OPTIONS, recommendation: REC })).id).toBe(next.id);
    expect((await readRecords(root)).filter((r) => r.kind === "open")).toHaveLength(2);
  });
});
