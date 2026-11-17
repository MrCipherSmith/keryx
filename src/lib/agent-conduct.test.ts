import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AGENT_CONDUCT_CONSTRAINTS,
  AGENT_CONDUCT_DISPATCH_CONSTRAINT,
  AGENT_CONDUCT_PROMPT_BLOCK,
  containsAgentConduct,
  renderAgentConductMarkdown,
  withAgentConduct,
} from "./agent-conduct";
import { renderProjectMetaprojectReferenceBlock } from "./agent-entrypoint-blocks";
import { buildAgentSystemInstruction } from "../commands/agent";
import { EXTERNAL_RUNTIME_DIRECTIVE, EXTERNAL_WRITE_RUNTIME_DIRECTIVE } from "../harness/external/prompt";
import { REVIEWER_SYSTEM_PROMPT, VERIFIER_SYSTEM_PROMPT } from "../review/bot/run";
import { HERDR_TEMPLATE_MD } from "../commands/herdr";

describe("agent conduct block (ADR-0001 D2)", () => {
  test("holds exactly the five constraints", () => {
    expect(AGENT_CONDUCT_CONSTRAINTS).toHaveLength(5);
    expect(AGENT_CONDUCT_CONSTRAINTS[0]).toContain("Co-Authored-By:");
    expect(AGENT_CONDUCT_CONSTRAINTS[0]).toContain("technical provenance");
    expect(AGENT_CONDUCT_CONSTRAINTS[1]).toContain("explicit ask");
    expect(AGENT_CONDUCT_CONSTRAINTS[2]).toContain("git stash");
    expect(AGENT_CONDUCT_CONSTRAINTS[3]).toContain("secrets");
    expect(AGENT_CONDUCT_CONSTRAINTS[4]).toContain("not verified");
  });

  test("every rendered form carries every constraint", () => {
    for (const rendered of [
      renderAgentConductMarkdown(),
      AGENT_CONDUCT_PROMPT_BLOCK,
      AGENT_CONDUCT_DISPATCH_CONSTRAINT,
      withAgentConduct("task"),
    ]) {
      expect(containsAgentConduct(rendered)).toBe(true);
    }
    expect(AGENT_CONDUCT_DISPATCH_CONSTRAINT.startsWith("Agent conduct (mandatory):")).toBe(true);
  });

  test("withAgentConduct appends after a blank line and handles an empty prompt", () => {
    expect(withAgentConduct("do X\n\n")).toBe(`do X\n\n${AGENT_CONDUCT_PROMPT_BLOCK}`);
    expect(withAgentConduct("")).toBe(AGENT_CONDUCT_PROMPT_BLOCK);
  });

  test("reaches every delivery path", () => {
    const paths: Record<string, string> = {
      "CLAUDE.md/AGENTS.md managed block": renderProjectMetaprojectReferenceBlock({ enableTasks: true }),
      "shell system instruction (no orientation)": buildAgentSystemInstruction(),
      "shell system instruction (old orientation)": buildAgentSystemInstruction("# Metaproject Index\n"),
      "external read-only directive": EXTERNAL_RUNTIME_DIRECTIVE,
      "external write directive": EXTERNAL_WRITE_RUNTIME_DIRECTIVE,
      "review bot reviewer": REVIEWER_SYSTEM_PROMPT,
      "review bot verifier": VERIFIER_SYSTEM_PROMPT,
      "herdr template": HERDR_TEMPLATE_MD,
    };
    for (const [name, text] of Object.entries(paths)) {
      expect(containsAgentConduct(text), name).toBe(true);
    }
  });

  test("an orientation that already embeds the block is not sent twice", () => {
    const instruction = buildAgentSystemInstruction(`# Metaproject Index\n\n${renderAgentConductMarkdown()}`);
    expect(instruction.split(AGENT_CONDUCT_CONSTRAINTS[0]!).length - 1).toBe(1);
  });

  test("the full rule carries the dispatch form verbatim, and the installed copy matches the bundled one", () => {
    const bundled = readFileSync(new URL("../gdskills/bundled/rules/process/agent-conduct.mdc", import.meta.url), "utf8");
    const installed = readFileSync(new URL("../../.metaproject/rules/process/agent-conduct.mdc", import.meta.url), "utf8");
    expect(bundled).toContain(AGENT_CONDUCT_DISPATCH_CONSTRAINT);
    expect(installed).toBe(bundled);
  });

  test("dispatch contracts require the conduct entry", () => {
    const dispatch = JSON.parse(
      readFileSync(new URL("../gdskills/contracts/subagent-dispatch.schema.json", import.meta.url), "utf8"),
    ) as { required: string[]; properties: { constraints: { contains: { pattern: string } } } };
    expect(dispatch.required).toContain("constraints");
    expect(new RegExp(dispatch.properties.constraints.contains.pattern).test(AGENT_CONDUCT_DISPATCH_CONSTRAINT)).toBe(true);
    const reviewer = JSON.parse(
      readFileSync(
        new URL("../gdskills/bundled/skills/review/review-orchestrator/reviewer-input.schema.json", import.meta.url),
        "utf8",
      ),
    ) as { required: string[]; properties: { conduct: { pattern: string } } };
    expect(reviewer.required).toContain("conduct");
    expect(new RegExp(reviewer.properties.conduct.pattern).test(AGENT_CONDUCT_DISPATCH_CONSTRAINT)).toBe(true);
  });

  test("prompt builders without an exported surface append the shared block", () => {
    // spawn_subagent, native review agents and the general worker build their
    // instruction inside a closure; pin the source so the append cannot drift away.
    for (const file of [
      "../harness/tool/builtin/spawn-subagent-tool.ts",
      "../commands/review-agents-runtime/native-adapter.ts",
      "../commands/review-agents-runtime/keryx-general-worker.ts",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).toContain("AGENT_CONDUCT_PROMPT_BLOCK");
    }
  });
});
