// Flow 400 (AC3, AC7): what the human is shown, and what the transcript says afterwards,
// in each arm. The arm is pinned through the `arm` seam and the shuffle through `random`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { journalAsk, scrubRecommendWords, type AskRequest } from "./ask";
import type { Arm } from "./arms";
import { readRecords } from "./store";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-ask-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const REASON = "it keeps the migration reversible";
const FORBIDDEN = /recommend|рекоменд|preferred|suggested/iu;

function request(extra: Partial<AskRequest> = {}): AskRequest {
  return {
    question: "Which approach?",
    recommendationReason: REASON,
    options: [
      { id: "a", label: "Keep the table", description: "the safe one", recommended: false },
      { id: "b", label: "Split the table", description: "the quick one", recommended: true },
      { id: "c", label: "Keep both tables", description: "the odd one" },
    ],
    ...extra,
  };
}

/** A host that answers `choice` to the question and "skip" to the reason prompt that follows a deviation. */
function host(choice: string, shown: AskRequest[] = []): (r: AskRequest) => Promise<string> {
  return async (r) => {
    shown.push(r);
    return r.question === "Which approach?" ? choice : "skip";
  };
}

describe("AC3: arm D strips every mark from what the host shows", () => {
  const MARKED: AskRequest = {
    question: "Which approach?",
    recommendationReason: "Recommended: it is the preferred, suggested route",
    options: [
      { id: "a", label: "Keep the table (Recommended)", description: "Recommended: the safe one", recommended: true },
      { id: "b", label: "Split the table - recommended", description: "the suggested quick one" },
      { id: "c", label: "Рекомендуемый вариант: both", description: "the preferred odd one" },
    ],
  };

  test("no label, description or reason carries a recommend, рекоменд, preferred or suggested word", async () => {
    const shown: AskRequest[] = [];
    await journalAsk(host("a", shown), { cwd: root, arm: "D", random: () => 0 })(MARKED);
    const first = shown[0];
    expect(first).toBeDefined();
    for (const option of first?.options ?? []) {
      expect(option.recommended).toBeUndefined();
      expect(option.preselected).toBe(false);
      expect(option.label).not.toMatch(FORBIDDEN);
      expect(option.description).not.toMatch(FORBIDDEN);
      expect(option.label.length).toBeGreaterThan(0);
    }
    expect(first?.recommendationReason ?? "").not.toMatch(FORBIDDEN);
    expect(first?.question ?? "").not.toMatch(FORBIDDEN);
  });

  test("the options are a permutation and the arm is on the record", async () => {
    const shown: AskRequest[] = [];
    await journalAsk(host("a", shown), { cwd: root, arm: "D", random: () => 0 })(MARKED);
    expect(shown[0]?.options.map((o) => o.id).sort()).toEqual(["a", "b", "c"]);
    expect((await readRecords(root)).find((r) => r.kind === "open")).toMatchObject({ arm: "D", mode: "blind", preselected: false });
  });

  test("scrubRecommendWords removes the words wherever they sit", () => {
    expect(scrubRecommendWords("the recommended way")).not.toMatch(FORBIDDEN);
    expect(scrubRecommendWords("Strongly Suggested, preferred")).not.toMatch(FORBIDDEN);
    expect(scrubRecommendWords("plain text")).toBe("plain text");
  });

  test("the other arms keep the mark and the reason", async () => {
    for (const arm of ["A", "B", "C"] as const) {
      const shown: AskRequest[] = [];
      await journalAsk(host("a", shown), { cwd: root, arm, random: () => 0 })(request());
      expect(shown[0]?.options.find((o) => o.recommended === true)?.id).toBe("b");
      expect(shown[0]?.recommendationReason).toBe(REASON);
    }
  });
});

describe("AC7: after a deviation the transcript names the recommended option and its reason", () => {
  for (const arm of ["A", "B", "C"] as Arm[]) {
    test(`arm ${arm}: a different answer names the option and the reason`, async () => {
      const notes: string[] = [];
      await journalAsk(host("a"), { cwd: root, arm, random: () => 0, notify: (t) => notes.push(t) })(request());
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("Split the table");
      expect(notes[0]).toContain(REASON);
      expect(notes[0]).toContain("differently");
    });

    test(`arm ${arm}: the recommended answer says nothing`, async () => {
      const notes: string[] = [];
      await journalAsk(host("b"), { cwd: root, arm, random: () => 0, notify: (t) => notes.push(t) })(request());
      expect(notes).toEqual([]);
    });
  }

  test("arm D: the reveal comes after any answer, matching or not, with the option and the reason", async () => {
    for (const choice of ["a", "b"]) {
      const notes: string[] = [];
      await journalAsk(host(choice), { cwd: root, arm: "D", random: () => 0, notify: (t) => notes.push(t) })(request());
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("Split the table");
      expect(notes[0]).toContain(REASON);
      expect(notes[0]).toContain(choice === "b" ? "You chose the recommended option." : "You chose differently.");
    }
  });

  test("a question with no recommendation says nothing in any arm", async () => {
    for (const arm of ["A", "B", "C", "D"] as Arm[]) {
      const notes: string[] = [];
      const { recommendationReason: _reason, ...rest } = request();
      const plain: AskRequest = { ...rest, options: rest.options.map(({ recommended: _drop, ...o }) => o) };
      await journalAsk(host("a"), { cwd: root, arm, random: () => 0, notify: (t) => notes.push(t) })(plain);
      expect(notes).toEqual([]);
    }
  });

  test("the reason lands on the record next to the recommendation", async () => {
    await journalAsk(host("a"), { cwd: root, arm: "B", random: () => 0 })(request());
    expect((await readRecords(root)).find((r) => r.kind === "open")).toMatchObject({
      arm: "B",
      recommendation: { optionId: "b", reason: REASON },
    });
  });
});
