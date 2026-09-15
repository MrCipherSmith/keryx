// The readline ask_user prompt: does it return what the human actually said?
//
// Shape follows `src/mcp-servers/approval-decision.test.ts`, whose header records
// why: inverting `if (!approved)` in a prompt so `y` DENIES left 9 158 tests green.
// A verdict welded to a terminal is a verdict no suite can drive, so `promptAskUser`
// takes its IO and this file asserts the returned id.
import { describe, expect, test } from "bun:test";
import {
  ASK_USER_CANCEL,
  ASK_USER_UNANSWERABLE,
} from "../harness/tool/builtin/ask-user-tool";
import { promptAskUser, type AskUserPromptIo, type AskUserPromptRequest } from "./ask-user-readline";

function fakeIo(...answers: (string | undefined)[]): AskUserPromptIo & { written: () => string; asked: () => number } {
  const chunks: string[] = [];
  const queue = [...answers];
  let reads = 0;
  return {
    out: (text) => chunks.push(text),
    readLine: async () => {
      reads += 1;
      return queue.shift();
    },
    written: () => chunks.join(""),
    asked: () => reads,
  };
}

const REQUEST: AskUserPromptRequest = {
  question: "Ship the MVP or the full build?",
  options: [
    { id: "mvp", label: "MVP", description: "Smallest ship", recommended: true },
    { id: "full", label: "Full", description: "Everything" },
  ],
};

describe("a numbered answer resolves to that option's id", () => {
  test("1 selects the first option, 2 the second", async () => {
    expect(await promptAskUser(fakeIo("1"), REQUEST)).toBe("mvp");
    expect(await promptAskUser(fakeIo("2"), REQUEST)).toBe("full");
  });

  test("surrounding whitespace is tolerated", async () => {
    expect(await promptAskUser(fakeIo("  2  "), REQUEST)).toBe("full");
  });

  test("an exact option id also selects it (scripted/piped sessions)", async () => {
    expect(await promptAskUser(fakeIo("full"), REQUEST)).toBe("full");
  });

  test("every option must be reachable — no off-by-one at either end", async () => {
    const many: AskUserPromptRequest = {
      question: "q",
      options: [0, 1, 2, 3, 4].map((n) => ({ id: `o${n}`, label: `L${n}`, description: "" })),
    };
    for (const [index, answer] of ["1", "2", "3", "4", "5"].entries()) {
      expect(await promptAskUser(fakeIo(answer), many)).toBe(`o${index}`);
    }
  });
});

describe("nobody answering is never an answer", () => {
  test("an empty line is a cancel, not the recommended option", async () => {
    const io = fakeIo("");
    const chosen = await promptAskUser(io, REQUEST);
    expect(chosen).toBe(ASK_USER_CANCEL);
    // The trap this pins: a default-to-recommended picker would return "mvp".
    expect(chosen).not.toBe("mvp");
  });

  test("EOF is UNANSWERABLE, which is a different fact from a cancel", async () => {
    const io = fakeIo(undefined);
    expect(await promptAskUser(io, REQUEST)).toBe(ASK_USER_UNANSWERABLE);
    expect(io.written()).toMatch(/no input/i);
  });

  test("an unparseable answer is retried, then cancels — it never picks", async () => {
    const io = fakeIo("9", "banana", "still-not-an-option");
    expect(await promptAskUser(io, REQUEST)).toBe(ASK_USER_CANCEL);
    expect(io.written()).toMatch(/not a valid choice/i);
  });

  test("a typo followed by a real choice keeps the real choice", async () => {
    const io = fakeIo("99", "2");
    expect(await promptAskUser(io, REQUEST)).toBe("full");
    expect(io.asked()).toBe(2);
  });
});

describe("freeform accepts the human's own words only when offered", () => {
  test("allowFreeform turns unparseable text into the answer", async () => {
    const io = fakeIo("rewrite the parser first");
    expect(await promptAskUser({ ...io }, { ...REQUEST, allowFreeform: true })).toBe("rewrite the parser first");
  });

  test("without allowFreeform the same text is NOT an answer", async () => {
    const answers = ["rewrite the parser first", "nope", "nope again"];
    expect(await promptAskUser(fakeIo(...answers), REQUEST)).toBe(ASK_USER_CANCEL);
  });
});

describe("the human sees the whole question before answering", () => {
  test("question, every label, and the recommendation are all printed", async () => {
    const io = fakeIo("1");
    await promptAskUser(io, REQUEST);
    const shown = io.written();
    expect(shown).toContain("Ship the MVP or the full build?");
    expect(shown).toContain("MVP");
    expect(shown).toContain("Full");
    expect(shown).toContain("Smallest ship");
    expect(shown).toContain("recommended");
  });

  test("the accepted vocabulary is named, so a guess is not required", async () => {
    const io = fakeIo("1");
    await promptAskUser(io, REQUEST);
    expect(io.written()).toMatch(/1-2/);
  });
});
