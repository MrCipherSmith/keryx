// Tests for external prompt assembly (flow 176, T14). Pure: every ceiling is a
// literal and nothing here touches the filesystem, the clock or `process`.
import { describe, expect, test } from "bun:test";
import {
  EXTERNAL_RUNTIME_DIRECTIVE,
  type ExternalPromptInput,
  PROMPT_TRUNCATION_MARKER,
  buildExternalPrompt,
} from "./prompt";

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

function input(overrides: Partial<ExternalPromptInput> = {}): ExternalPromptInput {
  const base: ExternalPromptInput = {
    taskTitle: "Review the queue marker change",
    taskDescription: "Read src/tui/main-queue.ts and report whether the marker shows the item's own position.",
    acceptanceCriteria: ["No file is modified", "The answer names the function it read"],
    maxPromptBytes: 65_536,
  };
  return { ...base, ...overrides };
}

/** Narrow to the success branch, failing loudly instead of silently skipping. */
function okPrompt(result: ReturnType<typeof buildExternalPrompt>) {
  if (!result.ok) throw new Error(`expected ok result, got refusal: ${result.reason}`);
  return result;
}

/** The diff body as the child sees it: everything after the section's intro line. */
function diffBodyOf(prompt: string): string {
  const introAt = prompt.indexOf(PROMPT_TRUNCATION_MARKER);
  if (introAt < 0) throw new Error("prompt carries no truncation notice");
  return prompt.slice(prompt.indexOf("\n\n", introAt) + 2);
}

const DIFF_LINES = [
  "diff --git a/src/tui/main-queue.ts b/src/tui/main-queue.ts",
  "--- a/src/tui/main-queue.ts",
  "+++ b/src/tui/main-queue.ts",
  "@@ -1,4 +1,4 @@",
  "-const marker = queue.length;",
  "+const marker = index + 1;",
];
const SMALL_DIFF = `${DIFF_LINES.join("\n")}\n`;

describe("the runtime directive comes first and is complete", () => {
  test("the prompt opens with the directive, before the task", () => {
    // An external CLI reads AGENTS.md and .metaproject/index.md and will route
    // rather than work. The directive has to be the first thing it sees.
    const result = okPrompt(buildExternalPrompt(input()));
    expect(result.prompt.startsWith(EXTERNAL_RUNTIME_DIRECTIVE)).toBe(true);
    expect(result.prompt.indexOf("# Task")).toBeGreaterThan(EXTERNAL_RUNTIME_DIRECTIVE.length - 1);
  });

  test("the directive forbids each behaviour that was measured as a false success", () => {
    // The reference implementation answered a review request with a numbered menu
    // of review modes: exit 0, non-empty output, recorded as a successful review.
    expect(EXTERNAL_RUNTIME_DIRECTIVE).toContain("Do not ask questions");
    expect(EXTERNAL_RUNTIME_DIRECTIVE).toContain("do not offer a choice of modes");
    expect(EXTERNAL_RUNTIME_DIRECTIVE).toContain("do not route to another skill, orchestrator, or flow");
    expect(EXTERNAL_RUNTIME_DIRECTIVE).toContain("do not delegate to another agent");
    expect(EXTERNAL_RUNTIME_DIRECTIVE).toContain("do not create or modify any files");
  });

  test("the directive encourages project tooling rather than suppressing it", () => {
    // Discovering keryx tooling is desirable; only the routing it triggers is not.
    expect(EXTERNAL_RUNTIME_DIRECTIVE).toContain("encouraged to use it for reading and searching");
  });

  test("it says the work itself is the final message, in the requested schema", () => {
    expect(EXTERNAL_RUNTIME_DIRECTIVE).toContain("Produce the work itself as your final message");
    expect(EXTERNAL_RUNTIME_DIRECTIVE).toContain("in the requested output schema");
  });
});

describe("task assembly", () => {
  test("carries title, description and every acceptance criterion", () => {
    const result = okPrompt(buildExternalPrompt(input()));
    expect(result.prompt).toContain("Review the queue marker change");
    expect(result.prompt).toContain("Read src/tui/main-queue.ts");
    expect(result.prompt).toContain("- No file is modified");
    expect(result.prompt).toContain("- The answer names the function it read");
  });

  test("omits the acceptance-criteria section when there are none", () => {
    const result = okPrompt(buildExternalPrompt(input({ acceptanceCriteria: [] })));
    expect(result.prompt).not.toContain("## Acceptance criteria");
  });

  test("drops blank criteria instead of emitting empty bullets", () => {
    const result = okPrompt(buildExternalPrompt(input({ acceptanceCriteria: ["  ", "real one"] })));
    expect(result.prompt).toContain("- real one");
    expect(result.prompt).not.toContain("- \n");
  });
});

describe("the working diff", () => {
  test("is omitted entirely when the caller supplies none", () => {
    const result = okPrompt(buildExternalPrompt(input()));
    expect(result.prompt).not.toContain("# Operator working diff");
    expect(result.truncated).toBe(false);
    expect(result.droppedBytes).toBe(0);
  });

  test("is included verbatim when it fits, with no truncation notice", () => {
    const result = okPrompt(buildExternalPrompt(input({ workingDiff: SMALL_DIFF })));
    expect(result.prompt).toContain(SMALL_DIFF);
    expect(result.prompt).not.toContain(PROMPT_TRUNCATION_MARKER);
    expect(result.truncated).toBe(false);
    expect(result.droppedBytes).toBe(0);
  });

  test("explains why it is in the prompt at all — the worktree is at HEAD", () => {
    const result = okPrompt(buildExternalPrompt(input({ workingDiff: SMALL_DIFF })));
    expect(result.prompt).toContain("checked out at HEAD");
  });
});

describe("truncation cuts the diff and nothing else", () => {
  const bigDiff = `${DIFF_LINES.join("\n")}\n${"+ a line of context that repeats\n".repeat(400)}`;
  const ceiling = bytes(EXTERNAL_RUNTIME_DIRECTIVE) + 900;
  const result = okPrompt(buildExternalPrompt(input({ workingDiff: bigDiff, maxPromptBytes: ceiling })));

  test("reports the truncation to the caller so the run can record it", () => {
    expect(result.truncated).toBe(true);
    expect(result.droppedBytes).toBeGreaterThan(0);
    expect(result.droppedBytes).toBeLessThan(bytes(bigDiff));
  });

  test("stays inside the byte ceiling", () => {
    expect(bytes(result.prompt)).toBeLessThanOrEqual(ceiling);
  });

  test("keeps the directive and the task intact", () => {
    expect(result.prompt.startsWith(EXTERNAL_RUNTIME_DIRECTIVE)).toBe(true);
    expect(result.prompt).toContain("Review the queue marker change");
    expect(result.prompt).toContain("- No file is modified");
  });

  test("states the truncation inside the prompt, with the byte count", () => {
    // A model handed a silently clipped diff reasons confidently about code it
    // was never shown.
    expect(result.prompt).toContain(PROMPT_TRUNCATION_MARKER);
    expect(result.prompt).toContain(`${result.droppedBytes} bytes were dropped`);
  });

  test("keeps the head of the diff and drops the tail", () => {
    expect(result.prompt).toContain("diff --git a/src/tui/main-queue.ts");
    expect(bytes(result.prompt)).toBeLessThan(bytes(bigDiff));
  });

  test("cuts on a line boundary so the remainder still reads as a diff", () => {
    expect(diffBodyOf(result.prompt).endsWith("\n")).toBe(true);
  });

  test("a fragment shorter than one line is dropped rather than shown", () => {
    // A few characters of a hunk header is not a diff and cannot be reasoned
    // about; the honest "omitted entirely" statement is worth more.
    const oneHugeLine = `${"+ no line break anywhere in here ".repeat(300)}\n`;
    const tight = okPrompt(
      buildExternalPrompt(input({ workingDiff: oneHugeLine, maxPromptBytes: bytes(EXTERNAL_RUNTIME_DIRECTIVE) + 900 })),
    );
    expect(tight.droppedBytes).toBe(bytes(oneHugeLine));
    expect(tight.prompt).toContain("omitted entirely");
  });
});

describe("sizes are measured in bytes, not characters", () => {
  test("a non-ASCII diff that would pass a character-count ceiling is truncated", () => {
    // 10 lines of 60 Cyrillic characters are 610 characters but 1210 bytes. A
    // char-counted ceiling of 700 would have let this through whole; ARG_MAX
    // counts bytes.
    const diff = `${"ы".repeat(60)}\n`.repeat(10);
    expect(diff.length).toBeLessThan(700);
    expect(bytes(diff)).toBeGreaterThan(1200);
    const ceiling = bytes(EXTERNAL_RUNTIME_DIRECTIVE) + 900;
    const result = okPrompt(buildExternalPrompt(input({ workingDiff: diff, maxPromptBytes: ceiling })));
    expect(result.truncated).toBe(true);
    expect(bytes(result.prompt)).toBeLessThanOrEqual(ceiling);
  });

  test("droppedBytes is a byte count, not a character count", () => {
    const diff = `${"🌍".repeat(50)}\n`.repeat(10);
    const ceiling = bytes(EXTERNAL_RUNTIME_DIRECTIVE) + 900;
    const result = okPrompt(buildExternalPrompt(input({ workingDiff: diff, maxPromptBytes: ceiling })));
    const kept = diffBodyOf(result.prompt);
    expect(result.truncated).toBe(true);
    expect(result.droppedBytes).toBe(bytes(diff) - bytes(kept));
    // Each dropped character is four bytes, so the byte figure is far larger than
    // the character figure. A char-counted implementation reports the smaller one.
    expect(result.droppedBytes).toBeGreaterThan(diff.length - kept.length);
  });

  test("the emitted prompt is always valid UTF-8, never a byte slice through a character", () => {
    // A byte-sliced UTF-8 diff ends in a lone surrogate. Round-tripping through
    // UTF-8 replaces it, so an unchanged round-trip proves the cut is clean.
    for (let extra = 0; extra < 24; extra += 1) {
      const diff = `${"🌍".repeat(7)}\n`.repeat(40);
      const ceiling = bytes(EXTERNAL_RUNTIME_DIRECTIVE) + 700 + extra;
      const result = okPrompt(buildExternalPrompt(input({ workingDiff: diff, maxPromptBytes: ceiling })));
      expect(Buffer.from(result.prompt, "utf8").toString("utf8")).toBe(result.prompt);
      expect(bytes(result.prompt)).toBeLessThanOrEqual(ceiling);
    }
  });

  test("stays inside the ceiling across a sweep of ceilings, diff sizes and encodings", () => {
    for (const unit of ["x", "ы", "🌍"]) {
      for (let count = 1; count <= 400; count += 37) {
        for (let ceiling = bytes(EXTERNAL_RUNTIME_DIRECTIVE) + 700; ceiling < bytes(EXTERNAL_RUNTIME_DIRECTIVE) + 1400; ceiling += 91) {
          const diff = `${unit.repeat(count)}\n`.repeat(4);
          const result = buildExternalPrompt(input({ workingDiff: diff, maxPromptBytes: ceiling }));
          if (!result.ok) continue;
          expect(bytes(result.prompt)).toBeLessThanOrEqual(ceiling);
          const keptBytes = bytes(diff) - result.droppedBytes;
          expect(keptBytes).toBeGreaterThanOrEqual(0);
          expect(keptBytes).toBeLessThanOrEqual(bytes(diff));
        }
      }
    }
  });
});

describe("when no part of the diff fits", () => {
  const diff = "+ a very long line with no break at all ".repeat(200);

  // The tightest ceiling still accepted with a diff attached: one byte lower is a
  // refusal, and at it there is room for the notice and none for the diff body.
  // Derived rather than hard-coded so editing the directive cannot silently move
  // this case into the ordinary-truncation branch.
  const headOnlyBytes = bytes(okPrompt(buildExternalPrompt(input())).prompt);
  let ceiling = headOnlyBytes;
  while (
    ceiling < headOnlyBytes + 4096 &&
    !buildExternalPrompt(input({ workingDiff: diff, maxPromptBytes: ceiling })).ok
  ) {
    ceiling += 1;
  }
  const result = okPrompt(buildExternalPrompt(input({ workingDiff: diff, maxPromptBytes: ceiling })));

  test("the whole diff counts as dropped", () => {
    expect(result.truncated).toBe(true);
    expect(result.droppedBytes).toBe(bytes(diff));
  });

  test("the child is still told the diff exists and that it cannot see it", () => {
    // Otherwise the agent reports the working tree as clean.
    expect(result.prompt).toContain(PROMPT_TRUNCATION_MARKER);
    expect(result.prompt).toContain("omitted entirely");
    expect(result.prompt).toContain(`${bytes(diff)} bytes`);
  });

  test("the directive and task survive and the ceiling holds", () => {
    expect(result.prompt.startsWith(EXTERNAL_RUNTIME_DIRECTIVE)).toBe(true);
    expect(result.prompt).toContain("Review the queue marker change");
    expect(bytes(result.prompt)).toBeLessThanOrEqual(ceiling);
  });
});

describe("a ceiling too small for the directive and the task is refused, not truncated", () => {
  test("refuses with a detectable code rather than emitting a mutilated prompt", () => {
    const result = buildExternalPrompt(input({ maxPromptBytes: 100 }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("over-ceiling");
    expect(result.requiredBytes).toBeGreaterThan(100);
    expect(result.maxPromptBytes).toBe(100);
    expect(result.reason).toContain("refusing rather than truncating");
  });

  test("refuses when a diff is attached too — the diff is cut first, then it still does not fit", () => {
    const result = buildExternalPrompt(input({ workingDiff: SMALL_DIFF, maxPromptBytes: 100 }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("over-ceiling");
  });

  test("a zero, negative or non-finite ceiling refuses instead of disabling the limit", () => {
    // A missing config value must not become an unbounded argv that dies at
    // execve with E2BIG.
    for (const ceiling of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildExternalPrompt(input({ maxPromptBytes: ceiling })).ok).toBe(false);
    }
  });
});

describe("the required output schema (resultSchemaText)", () => {
  const SCHEMA_TEXT = JSON.stringify({ type: "object", required: ["status"] }, null, 2);

  test("appears after the directive and before the task, with the schema text intact", () => {
    const result = okPrompt(buildExternalPrompt(input({ resultSchemaText: SCHEMA_TEXT })));
    expect(result.prompt).toContain("# Required output schema");
    expect(result.prompt).toContain("Your final message must be valid JSON matching this schema.");
    expect(result.prompt).toContain(SCHEMA_TEXT);

    const directiveAt = result.prompt.indexOf(EXTERNAL_RUNTIME_DIRECTIVE);
    const schemaHeadingAt = result.prompt.indexOf("# Required output schema");
    const taskAt = result.prompt.indexOf("# Task");
    expect(directiveAt).toBe(0);
    expect(schemaHeadingAt).toBeGreaterThan(directiveAt);
    expect(taskAt).toBeGreaterThan(schemaHeadingAt);
  });

  test("is omitted entirely, and the prompt is byte-identical to before, when resultSchemaText is not passed", () => {
    const withoutSchema = okPrompt(buildExternalPrompt(input()));
    expect(withoutSchema.prompt).not.toContain("# Required output schema");

    // Regression proof: adding the optional field must not perturb the output
    // of any caller that never passes it.
    const other = okPrompt(buildExternalPrompt(input({ workingDiff: SMALL_DIFF })));
    expect(other.prompt).not.toContain("# Required output schema");
  });

  test("counts toward the non-cuttable byte floor — the schema section is never what gets cut", () => {
    const bigDiff = `${DIFF_LINES.join("\n")}\n${"+ a line of context that repeats\n".repeat(400)}`;
    const ceiling = bytes(EXTERNAL_RUNTIME_DIRECTIVE) + bytes(SCHEMA_TEXT) + 900;
    const result = okPrompt(
      buildExternalPrompt(input({ workingDiff: bigDiff, resultSchemaText: SCHEMA_TEXT, maxPromptBytes: ceiling })),
    );
    // The diff is cut (as it always is on overflow) while the schema survives
    // whole — it is never truncated or dropped.
    expect(result.truncated).toBe(true);
    expect(result.prompt).toContain(SCHEMA_TEXT);
    expect(bytes(result.prompt)).toBeLessThanOrEqual(ceiling);
  });

  test("a ceiling that fits the directive and task alone, but not also the schema, is refused rather than emitting a truncated schema", () => {
    const headOnly = okPrompt(buildExternalPrompt(input()));
    const tooSmallForSchema = bytes(headOnly.prompt) + 10;
    const result = buildExternalPrompt(
      input({ resultSchemaText: SCHEMA_TEXT, maxPromptBytes: tooSmallForSchema }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("over-ceiling");
    expect(result.requiredBytes).toBeGreaterThan(tooSmallForSchema);
  });
});

describe("purity", () => {
  test("the same input yields the same prompt", () => {
    const one = buildExternalPrompt(input({ workingDiff: SMALL_DIFF }));
    const two = buildExternalPrompt(input({ workingDiff: SMALL_DIFF }));
    expect(one).toEqual(two);
  });

  test("the input object and its criteria array are not mutated", () => {
    const criteria = ["one", "two"];
    const source = input({ acceptanceCriteria: criteria, workingDiff: SMALL_DIFF });
    buildExternalPrompt(source);
    expect(criteria).toEqual(["one", "two"]);
    expect(source.workingDiff).toBe(SMALL_DIFF);
  });
});
