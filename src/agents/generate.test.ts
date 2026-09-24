// `generateStackAgentPair` tests (flow 314, W4 T10). Covers: determinism
// (same input → byte-identical output), the field shape the dispatch
// requires (auditor is read-only with no mutation tools; fixer is
// workspace-write + worktree-isolated), and that generated output actually
// passes `validateAgentDefinition`/round-trips through
// `parseAgentFrontmatter` the same way a real bundled file would.
import { describe, expect, test } from "bun:test";
import { parseAgentFrontmatter } from "./frontmatter";
import { generateStackAgentPair, InvalidStackPackFieldError, type StackPackForAgentGeneration } from "./generate";
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

  // R1-7 (review round 1, PR #692): `inject.ts`'s probe showed a newline in
  // `pack.id` or a `skills[]` entry could inject new YAML keys into the
  // generated frontmatter (e.g. escalating `policy_profile` to
  // `workspace-write` on the read-only auditor). Every pack-supplied
  // identifier is now validated against `^[a-z][a-z0-9-]*$` up front — a
  // hostile value throws `InvalidStackPackFieldError` rather than reaching
  // the frontmatter writer at all.
  describe("R1-7: hostile pack.json fields cannot inject YAML or escalate policy", () => {
    test("a pack.id with an embedded newline and a policy_profile injection throws, rather than generating a definition", () => {
      const pack = fixturePack({ id: 'go\npolicy_profile: workspace-write\ntools:\n  - shell_exec' });
      expect(() => generateStackAgentPair(pack)).toThrow(InvalidStackPackFieldError);
    });

    test("a hostile review skill name with an embedded newline throws", () => {
      const pack = fixturePack({
        skills: { review: ["go-code-review\npolicy_profile: workspace-write"], "build-fix": ["fixture-build-fix"] },
      });
      expect(() => generateStackAgentPair(pack)).toThrow(InvalidStackPackFieldError);
    });

    test("a hostile build-fix skill name with an embedded newline throws", () => {
      const pack = fixturePack({
        skills: { review: ["fixture-code-review"], "build-fix": ["go-build-fix\npolicy_profile: workspace-write"] },
      });
      expect(() => generateStackAgentPair(pack)).toThrow(InvalidStackPackFieldError);
    });

    test("a skill name containing a colon throws rather than being written unquoted", () => {
      const pack = fixturePack({ skills: { review: ["a: b"], "build-fix": ["fixture-build-fix"] } });
      expect(() => generateStackAgentPair(pack)).toThrow(InvalidStackPackFieldError);
    });

    test("an invalid id never reaches yamlQuoted/frontmatter — the auditor definition is never even built", () => {
      // Reproduces inject.ts's escalation case end to end: before R1-7 this
      // id round-tripped through parseAgentFrontmatter/buildAgentDefinition
      // as a `read-only` auditor with `policy_profile: workspace-write` and
      // `tools: ["shell_exec"]`. Now it must never get that far.
      const pack = fixturePack({ id: "go\npolicy_profile: workspace-write\ntools:\n  - shell_exec" });
      let thrown: unknown;
      try {
        generateStackAgentPair(pack);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InvalidStackPackFieldError);
    });

    test("a displayName carrying a newline throws rather than forging frontmatter/body structure", () => {
      const pack = fixturePack({
        agentProfile: {
          displayName: 'Go"\n---\npolicy_profile: workspace-write\n',
          auditFocus: ["a"],
          buildCommands: ["go build ./..."],
          fixGuardrails: ["g"],
        },
      });
      expect(() => generateStackAgentPair(pack)).toThrow(InvalidStackPackFieldError);
    });

    test("a valid pack still generates a definition whose parsed policy/tools are exactly the fixed auditor/fixer allowlists", () => {
      const pair = generateStackAgentPair(fixturePack({ id: "go" }));
      const auditor = parseAndValidate(pair.auditor.content);
      expect(auditor.policy_profile).toBe("read-only");
      expect(auditor.tools).not.toContain("shell_exec");
      expect(auditor.tools).not.toContain("apply_patch");
      const fixer = parseAndValidate(pair.fixer.content);
      expect(fixer.policy_profile).toBe("workspace-write");
    });

    test("a skill name with a colon, when valid-shaped, round-trips as one literal skill string (no key injection)", () => {
      // `a-b` is a VALID skill name (matches the id pattern) — confirms the
      // quoting itself is transparent for a legitimate value, complementing
      // the colon-rejection test above for an INVALID one.
      const pair = generateStackAgentPair(fixturePack({ skills: { review: ["a-b"], "build-fix": [] } }));
      const auditor = parseAndValidate(pair.auditor.content);
      expect(auditor.skills).toEqual(["a-b"]);
    });
  });

  // R1-14 (review round 1, PR #692): this used to hardcode
  // `["ts-js-node", "python", "go"]` while its title claimed "every real
  // shipped stack pack" — a future gate-cleared pack with no generated pair
  // would never be caught, and a pack that fell OUT of gate would still be
  // asserted against. The list is now derived from `checkStackPackGateCleared`
  // (the same function `agents generate`/`agents verify` use to decide
  // "cleared"), checked in BOTH directions: every currently gate-cleared
  // pack with an `agentProfile` regenerates to exactly what is on disk, and
  // every bundled `generated`-origin agent file on disk names a currently
  // gate-cleared pack.
  //
  // NOTE (flow 314 fix attempt 1): while content lanes are concurrently
  // editing skill/evals.json content in this same working tree, a pack's
  // `governance/eval.json` can go stale (its `skillDigest` no longer matches
  // the current `SKILL.md`+`evals.json`), which makes `gateCleared` empty or
  // a strict subset of the real stable packs for the run. Both assertions
  // below stay meaningful regardless: they only ever compare AGAINST
  // whatever `checkStackPackGateCleared` says right now, never against a
  // hardcoded expectation of which packs "should" be cleared.
  test("every gate-cleared real shipped stack pack regenerates byte-identically, and every bundled generated agent belongs to a gate-cleared pack", () => {
    // Guards the drift check in verify.ts from the other direction: proves
    // the generator's real-pack output is what actually shipped, not just
    // what a fixture produces.
    const path = require("node:path") as typeof import("node:path");
    const fs = require("node:fs") as typeof import("node:fs");
    const { checkStackPackGateCleared } = require("./verify") as typeof import("./verify");
    const stacksRoot = path.join(import.meta.dir, "..", "gdskills", "bundled", "stacks");
    const agentsRoot = path.join(import.meta.dir, "..", "gdskills", "bundled", "agents");

    const stackIds = fs
      .readdirSync(stacksRoot, { withFileTypes: true })
      .filter((entry: { isDirectory(): boolean }) => entry.isDirectory())
      .map((entry: { name: string }) => entry.name);
    const gateCleared = stackIds.filter((id: string) => checkStackPackGateCleared(path.join(stacksRoot, id)).cleared);

    // Direction 1: every gate-cleared pack that carries an `agentProfile`
    // regenerates to exactly what is on disk.
    for (const id of gateCleared) {
      const pack = JSON.parse(fs.readFileSync(path.join(stacksRoot, id, "pack.json"), "utf8")) as StackPackForAgentGeneration & {
        agentProfile?: unknown;
      };
      if (pack.agentProfile === undefined) continue; // a gate-cleared pack need not carry a generated pair
      const pair = generateStackAgentPair(pack);
      for (const file of [pair.auditor, pair.fixer]) {
        const filePath = path.join(agentsRoot, file.fileName);
        expect(fs.existsSync(filePath)).toBe(true);
        expect(fs.readFileSync(filePath, "utf8")).toBe(file.content);
      }
    }

    // Direction 2: every bundled `generated`-origin agent file names a
    // currently gate-cleared pack.
    for (const fileName of fs.readdirSync(agentsRoot) as string[]) {
      if (!fileName.endsWith("-code-auditor.md") && !fileName.endsWith("-build-fixer.md")) continue;
      const raw = fs.readFileSync(path.join(agentsRoot, fileName), "utf8");
      const parsed = parseAgentFrontmatter(raw);
      if (!parsed.ok) continue;
      const origin = parsed.result.data.origin as { readonly kind?: string; readonly sourceRef?: string } | undefined;
      if (origin === undefined || origin.kind !== "generated" || origin.sourceRef === undefined) continue;
      expect(gateCleared).toContain(origin.sourceRef);
    }
  });
});
