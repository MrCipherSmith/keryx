// Flow 400 (AC3, AC7): what the human is shown, and what the transcript says afterwards,
// in each arm. The arm is pinned through the `arm` seam and the shuffle through `random`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { journalAsk, scrubRecommendWords, type AskRequest } from "./ask";
import { assignArm, seedFile, type Arm } from "./arms";
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
  // every kind of mark `stripRecommendedMarks` knows: words (English, Russian, preferred, suggested), a star, an emoji
  const SYMBOLS = /[\u2B50\u2605\u2606\u2728\u{1F44D}]/u;
  const MARKED: AskRequest = {
    question: "Which approach is the recommended one? (preferred) \u2B50",
    recommendationReason: "Recommended: it is the preferred, suggested route \u2605",
    options: [
      { id: "a", label: "Keep the table (Recommended)", description: "Recommended: the safe one \u2728", recommended: true },
      { id: "b", label: "\u2B50 Split the table - recommended", description: "the suggested quick one \u{1F44D}" },
      { id: "c", label: "\u2606 Рекомендуемый вариант: both", description: "the preferred odd one [рекомендуется]" },
    ],
  };

  test("no question, label, description or reason carries a mark: a word, a star or an emoji", async () => {
    const shown: AskRequest[] = [];
    await journalAsk(async (r) => {
      shown.push(r);
      return "a";
    }, { cwd: root, arm: "D", random: () => 0 })(MARKED);
    const first = shown[0];
    expect(first).toBeDefined();
    expect(first?.options).toHaveLength(3);
    for (const option of first?.options ?? []) {
      expect(option.recommended).toBeUndefined();
      expect(option.preselected).toBe(false);
      for (const text of [option.label, option.description]) {
        expect(text).not.toMatch(FORBIDDEN);
        expect(text).not.toMatch(SYMBOLS);
      }
      expect(option.label.length).toBeGreaterThan(0);
    }
    for (const text of [first?.question ?? "", first?.recommendationReason ?? ""]) {
      expect(text).not.toMatch(FORBIDDEN);
      expect(text).not.toMatch(SYMBOLS);
    }
    expect(first?.question.length).toBeGreaterThan(0);
  });

  test("the question keeps its meaning once the mark is gone", async () => {
    const shown: AskRequest[] = [];
    await journalAsk(host("a", shown), { cwd: root, arm: "D", random: () => 0 })({ ...MARKED, question: "Which approach? (recommended)" });
    expect(shown[0]?.question).toBe("Which approach?");
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

describe("AC3: what the host is told to preselect, per arm, through the journal", () => {
  /** A salt for which `assignArm(salt, 1)` is `arm` under the default weights: the first question of an empty journal gets it. */
  function saltFor(arm: Arm): string {
    for (let i = 0; i < 10_000; i += 1) {
      const salt = `pinned-salt-for-arm-${arm}-${i}`;
      if (assignArm(salt, 1).arm === arm) return salt;
    }
    throw new Error(`no salt found for arm ${arm}`);
  }

  async function pinSalt(salt: string): Promise<void> {
    const file = seedFile(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${salt}\n`, { encoding: "utf8", mode: 0o600 });
  }

  for (const arm of ["A", "B", "C", "D"] as Arm[]) {
    test(`arm ${arm}, reached through the repo seed (no arm seam): ${arm === "A" ? "only the recommended option starts highlighted" : "no option starts highlighted"}`, async () => {
      await pinSalt(saltFor(arm));
      const shown: AskRequest[] = [];
      await journalAsk(host("b", shown), { cwd: root, random: () => 0 })(request());
      expect((await readRecords(root)).find((r) => r.kind === "open")).toMatchObject({ arm, seq: 1 });
      const options = shown[0]?.options ?? [];
      expect(options).toHaveLength(3);
      expect(options.filter((o) => o.preselected === true).map((o) => o.id)).toEqual(arm === "A" ? ["b"] : []);
      // every option says so explicitly: a host must not fall back to preselecting the recommended one
      expect(options.every((o) => typeof o.preselected === "boolean")).toBe(true);
      expect(options.find((o) => o.id === "b")?.recommended === true).toBe(arm !== "D");
    });
  }

  test("a question without a recommendation preselects nothing and sets no flag", async () => {
    const shown: AskRequest[] = [];
    const { recommendationReason: _reason, ...rest } = request();
    await journalAsk(host("a", shown), { cwd: root, arm: "A" })({ ...rest, options: rest.options.map(({ recommended: _drop, ...o }) => o) });
    expect((shown[0]?.options ?? []).some((o) => o.preselected === true)).toBe(false);
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
