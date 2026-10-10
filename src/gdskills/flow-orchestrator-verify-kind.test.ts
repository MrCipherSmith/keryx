// Flow 422 (AC2): flow-orchestrator tells the agent to put a verification-kind marker on every criterion.
// Pins the shipped bundled skill and its .metaproject copy, which must stay identical.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const BUNDLED = path.join(import.meta.dir, "bundled", "skills", "orchestration", "flow-orchestrator", "SKILL.md");
const COPY = path.join(import.meta.dir, "..", "..", ".metaproject", "skills", "gdskills", "orchestration", "flow-orchestrator", "SKILL.md");
const SKILL = readFileSync(BUNDLED, "utf8");
const flat = (text: string): string => text.replace(/\s+/g, " ");

describe("flow-orchestrator: the verification kind of every criterion", () => {
  test.each([
    "each ending in one marker",
    "[verify: exec `<command>`] or [verify: invariant `<command>`] (a backticked command)",
    "[verify: judged] (a human checks: live run, operator decision, text quality)",
    "[verify: none — <reason>]",
    "ask the operator ONE question listing the criteria with proposed kinds, before `flow freeze`",
  ])("the criteria step says: %s", (phrase) => {
    expect(flat(SKILL)).toContain(phrase);
  });

  test("a Red Flags row refuses to set the kind later", () => {
    const rows = SKILL.slice(SKILL.indexOf("## Red Flags")).split("\n");
    const row = rows.find((line) => line.startsWith('| "I\'ll set the verification kind later."')) ?? "";
    expect(row).toContain("An `unclassified` criterion cannot become data afterwards without a recorded rewrite");
    expect(row).toContain("keryx flow ac update");
  });

  test("the .metaproject copy is byte-identical to the bundled skill", () => {
    expect(readFileSync(COPY, "utf8")).toBe(SKILL);
  });
});
