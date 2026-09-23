// Flow 299, AC8: the limits of the confirmation token are stated, not implied.
// The decision record and the CLI reference each name every known bypass. The
// record states that SAC's review token has the same limits. TM-02 points to
// TM-03. `flow complete` repeats the one-line caveat, which is also checked
// in confirm-token.test.ts.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CONFIRMATION_CAVEAT } from "./confirm-token";

const REPO = path.resolve(import.meta.dir, "..", "..");
const read = (relative: string): Promise<string> => readFile(path.join(REPO, relative), "utf8");

/** Each known bypass, as a pattern the text must match. Order is the TM-03 §5 order. */
const LIMITS: ReadonlyArray<[string, RegExp]> = [
  ["what it proves (a step, not a person)", /not that a human ran it|does \*\*not\*\* say who ran the step/i],
  ["faked pseudo-terminal", /script -qc/],
  ["forged hash store", /forge/i],
  ["obfuscated command text", /(bun -e|a variable, a script file)/],
  ["agents outside keryx supervision", /outside keryx supervision/i],
  ["hand-edited opt-in flag", /hand-edit/i],
  ["pasting the token delegates", /delegat/i],
];

test("AC8: TM-03 names every known bypass, what the token proves, and SAC's same limits", async () => {
  const record = await read("docs/decisions/keryx-harness/TM-03-terminal-confirmation-token.md");
  for (const [name, pattern] of LIMITS) {
    expect({ name, found: pattern.test(record) }).toEqual({ name, found: true });
  }
  expect(record).toContain("## 6. SAC's review-confirmation token has the same limits");
  expect(record).toMatch(/confirm-review[\s\S]*forge/);
  expect(record).toMatch(/approval floor is matched by text/);
});

test("AC8: the CLI reference names the same limits and links TM-03", async () => {
  const reference = await read("docs/docs/cli-reference.md");
  const section = reference.slice(reference.indexOf("### The confirmation token"), reference.indexOf("### Completion attempts"));
  expect(section.length).toBeGreaterThan(0);
  for (const [name, pattern] of LIMITS) {
    expect({ name, found: pattern.test(section) }).toEqual({ name, found: true });
  }
  expect(section).toContain("TM-03-terminal-confirmation-token.md");
  expect(section).toContain("confirm-review");
});

test("AC8: TM-02 §7 links TM-03, and the SAC guide no longer implies the token is proof", async () => {
  const tm02 = await read("docs/decisions/keryx-harness/TM-02-flow-owner-and-signed-completion.md");
  expect(tm02).toContain("TM-03-terminal-confirmation-token.md");
  const guide = await read("docs/docs/guides/shared-agent-context.md");
  expect(guide).not.toContain("no tool call, MCP or\n`keryx-shell`, can mint one on its own");
  expect(guide).toContain("That is friction, not proof.");
});

test("AC8: the caveat `flow complete` prints says a step, not a person", () => {
  expect(CONFIRMATION_CAVEAT).toContain("not that a human ran it");
});
