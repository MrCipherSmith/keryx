import { describe, expect, test } from "bun:test";
import {
  ASK_USER_CANCEL,
  ASK_USER_NO_HOST,
  ASK_USER_UNANSWERABLE,
  createAskUserTool,
  chooseSelfAnswer,
  SELF_ANSWERED_MARKER,
  MIN_ASK_USER_OPTIONS,
} from "./ask-user-tool";

test("ask_user returns chosen option from host callback", async () => {
  const tool = createAskUserTool(async (req) => {
    expect(req.question).toContain("scope");
    expect(req.options.length).toBe(2);
    return req.options[0]!.id;
  });
  const result = await tool.invoke({
    question: "What is the scope?",
    options: [
      { id: "a", label: "MVP", description: "Smallest ship", recommended: true },
      { id: "b", label: "Full", description: "Everything" },
    ],
  });
  expect(result.isError).toBe(false);
  expect(result.output).toContain('id="a"');
  expect(result.output).toContain("recommended");
});

test("ask_user rejects bad input", async () => {
  const tool = createAskUserTool(async () => "x");
  expect((await tool.invoke({ question: "", options: [] })).isError).toBe(true);
  expect(
    (
      await tool.invoke({
        question: "q",
        options: [{ id: "only", label: "One" }],
      })
    ).isError,
  ).toBe(true);
});

const twoOptions = [
  { id: "y", label: "Yes", description: "" },
  { id: "n", label: "No", description: "" },
];

test("ask_user surfaces a real Esc dismissal as a cancel, with no invented choice", async () => {
  const tool = createAskUserTool(async () => ASK_USER_CANCEL);
  const result = await tool.invoke({ question: "Continue?", options: twoOptions });
  expect(result.isError).toBe(true);
  expect(result.output).toMatch(/without an answer/i);
  // No branch may hand the model an option it was never given.
  expect(result.output).not.toContain('id="y"');
  expect(result.output).not.toContain('id="n"');
});

// The bug these two tests pin: a surface with no question host (`--no-tui`, a
// non-TTY, any TUI init fallback — `setAskUserHost` is called only from
// `tui-shell.ts`) used to answer `__cancel__`, so the model read "the user
// declined" about a question no human ever saw and chose on their behalf.
test("ASK_USER_NO_HOST names the real cause and forbids choosing for the user", async () => {
  const tool = createAskUserTool(async () => ASK_USER_NO_HOST);
  const result = await tool.invoke({ question: "Continue?", options: twoOptions });
  expect(result.isError).toBe(true);
  expect(result.output).toContain("NOT shown to anyone");
  expect(result.output).toMatch(/NO answer exists/);
  expect(result.output).toMatch(/do NOT infer/i);
});

test("ASK_USER_UNANSWERABLE is distinct from a user's Esc", async () => {
  const tool = createAskUserTool(async () => ASK_USER_UNANSWERABLE);
  const shown = await tool.invoke({ question: "Continue?", options: twoOptions });
  const cancelled = await createAskUserTool(async () => ASK_USER_CANCEL).invoke({
    question: "Continue?",
    options: twoOptions,
  });
  expect(shown.isError).toBe(true);
  expect(shown.output).not.toBe(cancelled.output);
  expect(shown.output).toMatch(/could not be displayed/i);
});

// `auto`-mode self-answer selection. Pure, so the rule is testable without a
// terminal or a session — a reviewer once inverted an equivalent comparison
// elsewhere in this repository (`return id === "allow"` making "Deny" approve)
// and the full suite stayed green.
describe("chooseSelfAnswer — which option auto mode picks", () => {
  const options = [
    { id: "a", label: "First", description: "" },
    { id: "b", label: "Recommended", description: "", recommended: true },
    { id: "c", label: "Third", description: "" },
  ];

  test("prefers the option the model itself marked recommended", () => {
    expect(chooseSelfAnswer(options)?.id).toBe("b");
  });

  test("falls back to the FIRST option, deterministically", () => {
    const noRecommendation = options.map(({ recommended: _drop, ...rest }) => rest);
    expect(chooseSelfAnswer(noRecommendation)?.id).toBe("a");
  });

  test("never invents an option", () => {
    const chosen = chooseSelfAnswer(options);
    // Non-null asserted deliberately: "it returned nothing" is the NEXT
    // test's subject, so this one must fail loudly rather than pass
    // vacuously on `undefined` if the chooser ever stops choosing.
    expect(options.map((o) => o.id)).toContain(chosen!.id);
  });

  test("no options at all is undefined — NOT a fabricated answer", () => {
    expect(chooseSelfAnswer([])).toBeUndefined();
  });

  test("only the FIRST recommended option wins, so the choice is stable", () => {
    const twoRecommended = [
      { id: "x", label: "X", description: "", recommended: true },
      { id: "y", label: "Y", description: "", recommended: true },
    ];
    expect(chooseSelfAnswer(twoRecommended)?.id).toBe("x");
  });

  test("the self-answer marker says a human was NOT asked", () => {
    // The marker travels into the tool result the MODEL reads. Attributing a
    // choice to a user who never made it is the bug this axis closes.
    expect(SELF_ANSWERED_MARKER).toMatch(/auto mode/);
    expect(SELF_ANSWERED_MARKER).toMatch(/without asking the user/i);
  });
});

// F-558-02: the auto path must apply the tool's OWN minimum, or the two paths
// disagree about what a valid question is — the permissive one being the one
// that speaks for the user.
describe("chooseSelfAnswer refuses what the tool refuses", () => {
  test("a single usable option is NOT an answer — the tool would have refused it", async () => {
    const one = [{ id: "a", label: "Only", description: "" }];
    expect(chooseSelfAnswer(one)).toBeUndefined();
    // The rule the refusal mirrors, asserted against the real tool so the two
    // cannot drift apart again.
    const result = await createAskUserTool(async () => "a").invoke({ question: "q", options: one });
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/at least 2/i);
  });

  test("exactly two usable options IS an answer — the boundary, from below and at it", async () => {
    const two = [
      { id: "a", label: "A", description: "" },
      { id: "b", label: "B", description: "", recommended: true },
    ];
    expect(chooseSelfAnswer(two)?.id).toBe("b");
    expect(MIN_ASK_USER_OPTIONS).toBe(2);
  });
});
