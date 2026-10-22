import { afterEach, expect, test } from "bun:test";
import { reviewCommand } from "./review";

afterEach(() => { process.exitCode = 0; });

async function errorsFor(extra: string[]): Promise<string> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => void lines.push(parts.join(" "));
  process.exitCode = 0;
  try {
    await reviewCommand(["complete", "flow469-no-such-review", ...extra], { isTerminal: () => false });
    expect(process.exitCode).toBe(1);
    return lines.join("\n");
  } finally { console.error = original; }
}

for (const equals of [false, true]) {
  test(`review complete parses host flags separately from dispositions (equals=${equals})`, async () => {
    const pairs = [
      ["--answered-by", "codex:review469"],
      ["--answer-text", "yes"],
      ["--question-text", "Complete review flow469-no-such-review?"],
    ];
    const message = await errorsFor(pairs.flatMap(([key, value]) => equals ? [`${key}=${value}`] : [key!, value!]));
    expect(message).not.toBe("");
    expect(message).not.toMatch(/unknown.*(?:flag|option)/i);
    expect(message).not.toContain("was given before any --finding");
  });
}
