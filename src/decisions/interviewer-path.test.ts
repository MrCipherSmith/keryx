// Flow 400 (AC9): with a host the interviewer asks through ask_user; without one it asks no question
// and returns NEEDS_CONTEXT with its assumptions.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CANCEL_ANSWER, type AskRequest } from "./ask";
import { MAX_INTERVIEW_QUESTIONS, interviewPath, runInterview, type InterviewQuestion } from "./interviewer";

function question(id: string): InterviewQuestion {
  return {
    id,
    question: `Question ${id}?`,
    options: [
      { id: "a", label: "A", description: "first" },
      { id: "b", label: "B", description: "second" },
      { id: "c", label: "C", description: "third" },
      { id: "d", label: "D", description: "other" },
    ],
    assumption: `assume ${id}`,
  };
}

describe("a host is present", () => {
  test("every question goes through ask_user, one per call, and the answers are certain", async () => {
    const seen: AskRequest[] = [];
    const result = await runInterview([question("1"), question("2")], {
      askUser: async (request) => {
        seen.push(request);
        return "b";
      },
    });
    expect(interviewPath({ askUser: async () => "a" })).toBe("ask_user");
    expect(seen.map((r) => r.question)).toEqual(["Question 1?", "Question 2?"]);
    expect(result.status).toBe("READY");
    expect(result.asked).toBe(2);
    expect(result.answers.map((a) => [a.id, a.answer, a.confidence])).toEqual([
      ["1", "b", "certain"],
      ["2", "b", "certain"],
    ]);
    expect(result.assumptions).toEqual([]);
  });

  test("a cancelled answer is an assumption and ends the asking", async () => {
    let calls = 0;
    const result = await runInterview([question("1"), question("2"), question("3")], {
      askUser: async () => {
        calls += 1;
        return calls === 1 ? "a" : CANCEL_ANSWER;
      },
    });
    expect(calls).toBe(2);
    expect(result.status).toBe("NEEDS_CONTEXT");
    expect(result.answers.map((a) => a.id)).toEqual(["1"]);
    expect(result.assumptions.map((a) => a.id)).toEqual(["2", "3"]);
  });

  test("a failing host is not an answer either", async () => {
    const result = await runInterview([question("1")], {
      askUser: async () => {
        throw new Error("no dock");
      },
    });
    expect(result.status).toBe("NEEDS_CONTEXT");
    expect(result.assumptions).toHaveLength(1);
  });

  test(`no more than ${MAX_INTERVIEW_QUESTIONS} questions are asked`, async () => {
    let calls = 0;
    const questions = Array.from({ length: MAX_INTERVIEW_QUESTIONS + 2 }, (_, i) => question(String(i)));
    const result = await runInterview(questions, {
      askUser: async () => {
        calls += 1;
        return "a";
      },
    });
    expect(calls).toBe(MAX_INTERVIEW_QUESTIONS);
    expect(result.status).toBe("NEEDS_CONTEXT");
    expect(result.assumptions).toHaveLength(2);
  });
});

describe("no host", () => {
  test("no question is asked and NEEDS_CONTEXT carries every assumption", async () => {
    expect(interviewPath(undefined)).toBe("needs_context");
    const result = await runInterview([question("1"), question("2")], undefined);
    expect(result.status).toBe("NEEDS_CONTEXT");
    expect(result.asked).toBe(0);
    expect(result.answers).toEqual([]);
    expect(result.assumptions).toEqual([
      { id: "1", question: "Question 1?", assumption: "assume 1", confidence: "assumption" },
      { id: "2", question: "Question 2?", assumption: "assume 2", confidence: "assumption" },
    ]);
  });
});

describe("the skill states the same rule, in every copy the repo keeps", () => {
  const COPIES = ["src/gdskills/bundled/skills/planning/interviewer/SKILL.md", ".metaproject/skills/gdskills/planning/interviewer/SKILL.md"];
  const root = path.join(import.meta.dir, "..", "..");

  test("each copy names ask_user for a host, NEEDS_CONTEXT with assumptions and no question without one", async () => {
    for (const copy of COPIES) {
      const text = await readFile(path.join(root, copy), "utf8");
      const section = text.slice(text.indexOf("## Host or no host"), text.indexOf("## Question Bank"));
      expect(section, copy).toContain("Host present");
      expect(section, copy).toContain("`ask_user`");
      expect(section, copy).toContain("No host");
      expect(section, copy).toContain("ask NO question");
      expect(section, copy).toContain('status: "NEEDS_CONTEXT"');
      expect(section, copy).toContain("assumptions");
      expect(section, copy).toContain("src/decisions/interviewer.ts");
    }
  });

  test("the copies are identical", async () => {
    const [bundled, project] = await Promise.all(COPIES.map((copy) => readFile(path.join(root, copy), "utf8")));
    expect(project).toBe(bundled);
  });
});
