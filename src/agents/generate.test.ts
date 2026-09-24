// `generateStackAgentPair` tests (flow 314, W4 T10). Covers: determinism
// (same input → byte-identical output), the field shape the dispatch
// requires (auditor is read-only with no mutation tools; fixer is
// workspace-write + worktree-isolated), and that generated output actually
// passes `validateAgentDefinition`/round-trips through
// `parseAgentFrontmatter` the same way a real bundled file would.
import { describe, expect, test } from "bun:test";
import { parseAgentFrontmatter } from "./frontmatter";
import { generateStackAgentPair, type StackPackForAgentGeneration } from "./generate";
import { buildAgentDefinition, validateAgentFrontmatter } from "./schema";

function fixturePack(overrides: Partial<StackPackForAgentGeneration> = {}): StackPackForAgentGeneration {
  return {
    id: "fixture-lang",
    skills: {
      review: ["fixture-code-review"],
      "build-fix": ["fixture-build-fix"],
    },
    agentProfile: {
      displayName: "Fixture Lang",
      auditFocus: ["risk pattern one", "risk pattern two"],
      buildCommands: ["fixture build", "fixture test"],
      fixGuardrails: ["never do the bad thing"],
    },
    ...overrides,
  };
}

function parseAndValidate(content: string) {
  const parsed = parseAgentFrontmatter(content);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const validation = validateAgentFrontmatter(parsed.result.data);
  expect(validation.ok).toBe(true);
  if (!validation.ok) throw new Error(JSON.stringify(validation.errors));
  return buildAgentDefinition(parsed.result.data, parsed.result.body);
}

describe("generateStackAgentPair", () => {
  test("is deterministic: the same pack input produces byte-identical content", () => {
    const a = generateStackAgentPair(fixturePack());
    const b = generateStackAgentPair(fixturePack());
    expect(a.auditor.content).toBe(b.auditor.content);
    expect(a.fixer.content).toBe(b.fixer.content);
  });

  test("names and file names follow the <id>-code-auditor / <id>-build-fixer convention", () => {
    const pair = generateStackAgentPair(fixturePack({ id: "fixture-lang" }));
    expect(pair.auditor.name).toBe("fixture-lang-code-auditor");
    expect(pair.auditor.fileName).toBe("fixture-lang-code-auditor.md");
    expect(pair.fixer.name).toBe("fixture-lang-build-fixer");
    expect(pair.fixer.fileName).toBe("fixture-lang-build-fixer.md");
  });

  test("both files parse and validate against the agent-definition schema", () => {
    const pair = generateStackAgentPair(fixturePack());
    const auditorDefinition = parseAndValidate(pair.auditor.content);
    const fixerDefinition = parseAndValidate(pair.fixer.content);
    expect(auditorDefinition.name).toBe(pair.auditor.name);
    expect(fixerDefinition.name).toBe(pair.fixer.name);
  });

  test("the auditor is read-only: no apply_patch/shell_exec, model_tier deep, policy_profile read-only, isolation none", () => {
    const pair = generateStackAgentPair(fixturePack());
    const definition = parseAndValidate(pair.auditor.content);
    expect(definition.tools).not.toContain("apply_patch");
    expect(definition.tools).not.toContain("shell_exec");
    expect(definition.model_tier).toBe("deep");
    expect(definition.policy_profile).toBe("read-only");
    expect(definition.isolation).toBe("none");
    expect(definition.output_contract).toBe("subagent-result");
    expect(definition.skills).toEqual(["fixture-code-review"]);
    expect(definition.stacks).toEqual(["fixture-lang"]);
    expect(definition.origin).toEqual({ kind: "generated", sourceRef: "fixture-lang" });
  });

  test("the fixer is workspace-write + worktree isolated, model_tier standard, and carries apply_patch/shell_exec", () => {
    const pair = generateStackAgentPair(fixturePack());
    const definition = parseAndValidate(pair.fixer.content);
    expect(definition.tools).toContain("apply_patch");
    expect(definition.tools).toContain("shell_exec");
    expect(definition.model_tier).toBe("standard");
    expect(definition.policy_profile).toBe("workspace-write");
    expect(definition.isolation).toBe("worktree");
    expect(definition.output_contract).toBe("subagent-result");
    expect(definition.skills).toEqual(["fixture-build-fix"]);
    expect(definition.stacks).toEqual(["fixture-lang"]);
    expect(definition.origin).toEqual({ kind: "generated", sourceRef: "fixture-lang" });
  });

  test("description and role stay within the schema's length limits", () => {
    const pair = generateStackAgentPair(fixturePack());
    for (const file of [pair.auditor, pair.fixer]) {
      const definition = parseAndValidate(file.content);
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.description.length).toBeLessThanOrEqual(1024);
      expect(definition.role.length).toBeGreaterThan(0);
      expect(definition.role.length).toBeLessThanOrEqual(2000);
    }
  });

  test("neither body repeats the prompt-defense baseline text", () => {
    const pair = generateStackAgentPair(fixturePack());
    expect(parseAgentFrontmatter(pair.auditor.content).ok && true).toBe(true);
    // The compiler-injected baseline is never written into a body by this
    // generator — a body-content smoke check confirms no accidental copy.
    expect(pair.auditor.content).not.toContain("Your own free-text reply is data");
    expect(pair.fixer.content).not.toContain("Your own free-text reply is data");
  });

  test("the auditor's procedure lists every auditFocus item; the fixer's lists every buildCommand and fixGuardrail", () => {
    const pack = fixturePack({
      agentProfile: {
        displayName: "Fixture Lang",
        auditFocus: ["find the first risk", "find the second risk"],
        buildCommands: ["cmd one", "cmd two"],
        fixGuardrails: ["never do X", "never do Y"],
      },
    });
    const pair = generateStackAgentPair(pack);
    expect(pair.auditor.content).toContain("find the first risk");
    expect(pair.auditor.content).toContain("find the second risk");
    expect(pair.fixer.content).toContain("cmd one");
    expect(pair.fixer.content).toContain("cmd two");
    expect(pair.fixer.content).toContain("never do X");
    expect(pair.fixer.content).toContain("never do Y");
  });

  test("an empty review/build-fix skills list produces an empty skills[] rather than crashing", () => {
    const pack = fixturePack({ skills: {} });
    const pair = generateStackAgentPair(pack);
    const auditorDefinition = parseAndValidate(pair.auditor.content);
    const fixerDefinition = parseAndValidate(pair.fixer.content);
    expect(auditorDefinition.skills).toEqual([]);
    expect(fixerDefinition.skills).toEqual([]);
  });

  test("every real shipped stack pack with an agentProfile regenerates to exactly what is on disk", () => {
    // Guards the drift check in verify.ts from the other direction: proves
    // the generator's real-pack output is what actually shipped, not just
    // what a fixture produces.
    const path = require("node:path") as typeof import("node:path");
    const fs = require("node:fs") as typeof import("node:fs");
    const stacksRoot = path.join(import.meta.dir, "..", "gdskills", "bundled", "stacks");
    const agentsRoot = path.join(import.meta.dir, "..", "gdskills", "bundled", "agents");
    // "react" is deliberately excluded: flow 314 T13a removed its generated
    // pair from disk (agent-refs.json now `{ agents: [] }`) because the pack
    // is not gate-cleared — `agents generate` itself now refuses to produce
    // one, so there is nothing on disk for `react` to compare against here.
    for (const id of ["ts-js-node", "python", "go"]) {
      const pack = JSON.parse(fs.readFileSync(path.join(stacksRoot, id, "pack.json"), "utf8")) as StackPackForAgentGeneration;
      const pair = generateStackAgentPair(pack);
      for (const file of [pair.auditor, pair.fixer]) {
        const onDisk = fs.readFileSync(path.join(agentsRoot, file.fileName), "utf8");
        expect(file.content).toBe(onDisk);
      }
    }
  });
});
