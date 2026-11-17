import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AGENT_CONDUCT_CONSTRAINTS,
  AGENT_CONDUCT_DISPATCH_CONSTRAINT,
  AGENT_CONDUCT_PROMPT_BLOCK,
  containsAgentConduct,
  renderAgentConductMarkdown,
} from "./agent-conduct";
import { renderProjectMetaprojectReferenceBlock } from "./agent-entrypoint-blocks";
import { buildAgentSystemInstruction } from "../commands/agent";
import { EXTERNAL_RUNTIME_DIRECTIVE, EXTERNAL_WRITE_RUNTIME_DIRECTIVE } from "../harness/external/prompt";
import { REVIEWER_SYSTEM_PROMPT, VERIFIER_SYSTEM_PROMPT } from "../review/bot/run";
import { HERDR_TEMPLATE_MD } from "../commands/herdr";
import { loadSchema, validateJson } from "../gdskills/contracts";
import { validateAgainstSchemaObject } from "../contracts/validator";

describe("agent conduct block (ADR-0001 D2)", () => {
  test("holds exactly the five constraints", () => {
    expect(AGENT_CONDUCT_CONSTRAINTS).toHaveLength(5);
    expect(AGENT_CONDUCT_CONSTRAINTS[0]).toContain("Co-Authored-By:");
    expect(AGENT_CONDUCT_CONSTRAINTS[0]).toContain("technical provenance");
    expect(AGENT_CONDUCT_CONSTRAINTS[0]).toContain("human co-author");
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
    ]) {
      expect(containsAgentConduct(rendered)).toBe(true);
    }
    expect(AGENT_CONDUCT_DISPATCH_CONSTRAINT.startsWith("Agent conduct (mandatory):")).toBe(true);
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

  test("both validators refuse a dispatch whose constraints lack the conduct entry", async () => {
    const schema = await loadSchema("subagent-dispatch");
    const dispatch = (constraints: string[]) => ({
      contract_version: "1.1.0",
      run_id: "r1",
      dispatch_id: "d1",
      orchestrator: "flow-orchestrator",
      target_skill: "task-implementer",
      task: { title: "t", description: "d" },
      acceptance_criteria: ["AC1"],
      context_refs: [],
      files_to_read: [],
      constraints,
      allowed_actions: ["read"],
      output_contract: { schema: "subagent-result", artifact_path: "a.json" },
      budget: {},
      provenance: { created_at: "2026-11-17T00:00:00Z", created_by: "test" },
    });
    const placeholder = 'Agent conduct (mandatory): <the "Dispatch form" line of .metaproject/rules/process/agent-conduct.mdc, verbatim>';
    for (const constraints of [[], ["Never edit flow.json."], [placeholder]]) {
      expect((await validateJson(dispatch(constraints), schema)).length, JSON.stringify(constraints)).toBeGreaterThan(0);
      expect(validateAgainstSchemaObject(schema as Record<string, unknown>, dispatch(constraints)).valid).toBe(false);
    }
    const ok = dispatch(["Never edit flow.json.", AGENT_CONDUCT_DISPATCH_CONSTRAINT]);
    expect(await validateJson(ok, schema)).toEqual([]);
    expect(validateAgainstSchemaObject(schema as Record<string, unknown>, ok).valid).toBe(true);
  });

  test("the herdr template text is pinned, so a conduct wording change cannot strand installed copies", () => {
    // The herdr template embeds AGENT_CONDUCT_PROMPT_BLOCK. `keryx herdr install`
    // recognises keryx's own older copies only through HERDR_TEMPLATE_PREVIOUS
    // (src/commands/herdr.ts). When this hash changes, append the PREVIOUS text of
    // HERDR_TEMPLATE_MD to that list (never edit an entry), then update the hash.
    const digest = new Bun.CryptoHasher("sha256").update(HERDR_TEMPLATE_MD).digest("hex");
    expect(digest).toBe("d55d396f14fc3359923e20526c0a8daa43a946a72cc3fce2f7ac5599f9fd1897");
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
      // A use, not just the import line.
      const uses = source.split("\n").filter((line) => line.includes("AGENT_CONDUCT_PROMPT_BLOCK") && !/^\s*import\b/.test(line));
      expect(uses.length, file).toBeGreaterThan(0);
    }
  });
});
