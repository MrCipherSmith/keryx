import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseAgentFrontmatter } from "../agents/frontmatter";
import { buildAgentDefinition, validateAgentFrontmatter } from "../agents/schema";
import { createAcceptCapability } from "./accept-capability";
import { applyGraduation, LearningGraduateError, runGraduate } from "./graduate";
import { readPattern, writePattern } from "./store";
import type { LearnedPattern, LearningDomain, LearningScope } from "./types";

const SHA_A = "a".repeat(64);
const NOW = new Date("2026-09-24T00:00:00.000Z");

let counter = 0;
function makeAccepted(
  id: string,
  trigger: string,
  action: string,
  domain: LearningDomain,
  confidence: number,
  scope: LearningScope = "project",
): LearnedPattern {
  counter += 1;
  return {
    schemaVersion: 1,
    id,
    trigger,
    action,
    domain,
    scope,
    project: { identity: SHA_A, identityKind: "remote-hash" },
    confidence,
    confidenceLevel: confidence >= 0.8 ? "high" : confidence >= 0.5 ? "medium" : "low",
    status: "accepted",
    supersededBy: null,
    evidence: [
      {
        kind: "reinforcement",
        sourceType: "observation",
        sourceRef: `.metaproject/data/learning/observations/2026-09-2${counter}.jsonl`,
        observedAt: NOW.toISOString(),
        weight: 1,
      },
    ],
    reviewerProfile: null,
    redaction: { scanned: true, findings: [] },
    graduation: null,
    provenance: { extractor: "repeated-correction", extractorKind: "deterministic" },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function withProjectRoot<T>(fn: (root: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-learning-graduate-root-"));
  const home = mkdtempSync(path.join(tmpdir(), "keryx-learning-graduate-home-"));
  const env = { KERYX_HOME: home };
  return fn(root, env).finally(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
}

// Three code-style records sharing enough trigger keywords to cluster
// (Jaccard >= 0.5, >= 2 shared keywords), size >= 3, avg confidence >= 0.75 -> agent.
const AGENT_CLUSTER: readonly [string, string, string][] = [
  ["code-style.extract-helper-aaaaaaaa", "extract shared logic into a helper function before duplicating code again", "pull the repeated block into one named helper"],
  ["code-style.extract-helper-bbbbbbbb", "extract shared logic into a small helper function when duplicating logic", "name the helper after what it does, not where it is called from"],
  ["code-style.extract-helper-cccccccc", "extract the shared helper logic instead of duplicating code blocks", "prefer one helper over three near-identical blocks"],
];

// Two testing records overlapping enough to cluster (size 2, non-review-conventions) -> skill.
// One project-scope, one user-scope, to prove clustering/graduation cross scope.
const SKILL_CLUSTER: readonly [string, string, string, LearningScope][] = [
  ["testing.rerun-failing-dddddddd", "run the failing test again before merging the change", "confirm the fix locally before pushing", "project"],
  ["testing.rerun-failing-eeeeeeee", "rerun the failing test once more before merging the change", "watch the same test go green twice", "user"],
];

// One workflow record, alone (no other workflow record to cluster with), confidence >= 0.7 -> rule.
const RULE_RECORD: [string, string, string] = [
  "workflow.commit-increments-ffffffff",
  "commit work in small increments throughout the day",
  "avoid one giant end-of-day commit",
];

async function seedClusters(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  const capability = createAcceptCapability();
  for (const [id, trigger, action] of AGENT_CLUSTER) {
    await writePattern(root, makeAccepted(id, trigger, action, "code-style", 0.8), { env, capability });
  }
  for (const [id, trigger, action, scope] of SKILL_CLUSTER) {
    await writePattern(root, makeAccepted(id, trigger, action, "testing", 0.5, scope), { env, capability });
  }
  const [id, trigger, action] = RULE_RECORD;
  await writePattern(root, makeAccepted(id, trigger, action, "workflow", 0.75), { env, capability });
}

function listOrEmpty(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe("runGraduate: clustering to skill/agent/rule", () => {
  test("produces one proposal per qualifying cluster, with the documented target rule", async () => {
    await withProjectRoot(async (root, env) => {
      await seedClusters(root, env);

      const report = await runGraduate(root, { now: NOW, env });

      const byTarget = Object.fromEntries(report.proposals.map((p) => [p.target, p]));
      expect(Object.keys(byTarget).sort()).toEqual(["agent", "rule", "skill"]);

      expect([...(byTarget.agent?.members ?? [])].sort()).toEqual(AGENT_CLUSTER.map(([id]) => id).sort());
      expect([...(byTarget.skill?.members ?? [])].sort()).toEqual(SKILL_CLUSTER.map(([id]) => id).sort());
      expect(byTarget.rule?.members).toEqual([RULE_RECORD[0]]);

      expect(byTarget.agent?.proposalId).toMatch(/^grad-agent-[0-9a-f]{12}$/);
      expect(byTarget.skill?.proposalId).toMatch(/^grad-skill-[0-9a-f]{12}$/);
      expect(byTarget.rule?.proposalId).toMatch(/^grad-rule-[0-9a-f]{12}$/);

      expect(byTarget.skill?.nextSteps[0]).toContain("keryx skills scout");
      expect(byTarget.skill?.nextSteps[0]).toContain("--origin learned");
      expect(byTarget.skill?.nextSteps[0]).toContain(`--source-ref ${byTarget.skill?.proposalId}`);
      expect(byTarget.agent?.nextSteps[0]).toBe(`keryx learn graduate apply ${byTarget.agent?.proposalId}`);
      expect(byTarget.rule?.nextSteps[0]).toContain(".metaproject/rules/");
    });
  });

  test("writes only a JSON proposal + its .md summary, never a SKILL.md/agent/rule file", async () => {
    await withProjectRoot(async (root, env) => {
      const before = {
        projectSkills: listOrEmpty(path.join(root, ".metaproject", "project-skills")),
        skills: listOrEmpty(path.join(root, ".metaproject", "skills")),
        rules: listOrEmpty(path.join(root, ".metaproject", "rules")),
        agents: listOrEmpty(path.join(root, ".metaproject", "agents")),
        claude: listOrEmpty(path.join(root, ".claude")),
      };

      await seedClusters(root, env);
      const report = await runGraduate(root, { now: NOW, env });
      expect(report.proposals.length).toBeGreaterThan(0);

      const after = {
        projectSkills: listOrEmpty(path.join(root, ".metaproject", "project-skills")),
        skills: listOrEmpty(path.join(root, ".metaproject", "skills")),
        rules: listOrEmpty(path.join(root, ".metaproject", "rules")),
        agents: listOrEmpty(path.join(root, ".metaproject", "agents")),
        claude: listOrEmpty(path.join(root, ".claude")),
      };
      expect(after).toEqual(before);

      const graduationDir = path.join(root, ".metaproject", "data", "learning", "graduation");
      for (const proposal of report.proposals) {
        expect(existsSync(path.join(graduationDir, `${proposal.proposalId}.json`))).toBe(true);
        expect(existsSync(path.join(graduationDir, `${proposal.proposalId}.md`))).toBe(true);
      }
    });
  });

  test("sets graduation on every source record (both project and user scope), with a project-relative proposalPath", async () => {
    await withProjectRoot(async (root, env) => {
      await seedClusters(root, env);
      const report = await runGraduate(root, { now: NOW, env });
      const skillProposal = report.proposals.find((p) => p.target === "skill");
      expect(skillProposal).toBeDefined();

      for (const [id, , , scope] of SKILL_CLUSTER) {
        const stored = await readPattern(root, id, scope, { env });
        expect(stored?.graduation).toEqual({
          target: "skill",
          proposalPath: path.join(".metaproject", "data", "learning", "graduation", `${skillProposal?.proposalId}.json`),
        });
      }
    });
  });

  test("is idempotent: a second run does not rewrite an existing proposal", async () => {
    await withProjectRoot(async (root, env) => {
      await seedClusters(root, env);
      const first = await runGraduate(root, { now: NOW, env });
      const second = await runGraduate(root, { now: NOW, env });

      expect(second.proposals).toEqual([]);
      expect([...second.alreadyProposed].sort()).toEqual(first.proposals.map((p) => p.proposalId).sort());
    });
  });

  test("--domain filters which accepted records are considered", async () => {
    await withProjectRoot(async (root, env) => {
      await seedClusters(root, env);
      const report = await runGraduate(root, { now: NOW, env, domain: "workflow" });
      expect(report.proposals).toHaveLength(1);
      expect(report.proposals[0]?.target).toBe("rule");
    });
  });
});

describe("applyGraduation: non-TTY refusal", () => {
  test("refuses graduate-apply-requires-terminal", async () => {
    await withProjectRoot(async (root, env) => {
      await seedClusters(root, env);
      const report = await runGraduate(root, { now: NOW, env });
      const agentProposal = report.proposals.find((p) => p.target === "agent");
      expect(agentProposal).toBeDefined();

      await expect(
        applyGraduation(root, agentProposal!.proposalId, { isTerminal: false, confirm: async () => true, env, now: NOW }),
      ).rejects.toMatchObject({ reason: "graduate-apply-requires-terminal" });
    });
  });
});

describe("applyGraduation: agent target", () => {
  test("writes a valid .metaproject/agents/<name>.md with origin.kind learned and a member sourceRef", async () => {
    await withProjectRoot(async (root, env) => {
      await seedClusters(root, env);
      const report = await runGraduate(root, { now: NOW, env });
      const agentProposal = report.proposals.find((p) => p.target === "agent");
      expect(agentProposal).toBeDefined();

      const result = await applyGraduation(root, agentProposal!.proposalId, {
        isTerminal: true,
        confirm: async () => true,
        env,
        now: NOW,
      });

      expect(result.path).toBe(path.join(root, ".metaproject", "agents", `${agentProposal!.suggestedName}.md`));
      expect(existsSync(result.path)).toBe(true);

      const raw = readFileSync(result.path, "utf8");
      const parsed = parseAgentFrontmatter(raw);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const validation = validateAgentFrontmatter(parsed.result.data);
      expect(validation.ok).toBe(true);
      const definition = buildAgentDefinition(parsed.result.data, parsed.result.body);
      expect(definition.origin?.kind).toBe("learned");
      expect(definition.origin?.sourceRef).toBe(AGENT_CLUSTER[0]?.[0]);
      expect(definition.policy_profile).toBe("read-only");
      expect(definition.tools).not.toContain("apply_patch");
      expect(definition.tools).not.toContain("shell_exec");
    });
  });

  test("refuses agent-candidate-exists on a second apply", async () => {
    await withProjectRoot(async (root, env) => {
      await seedClusters(root, env);
      const report = await runGraduate(root, { now: NOW, env });
      const agentProposal = report.proposals.find((p) => p.target === "agent");

      await applyGraduation(root, agentProposal!.proposalId, { isTerminal: true, confirm: async () => true, env, now: NOW });
      await expect(
        applyGraduation(root, agentProposal!.proposalId, { isTerminal: true, confirm: async () => true, env, now: NOW }),
      ).rejects.toMatchObject({ reason: "agent-candidate-exists" });
    });
  });

  test("cancelled confirmation writes nothing", async () => {
    await withProjectRoot(async (root, env) => {
      await seedClusters(root, env);
      const report = await runGraduate(root, { now: NOW, env });
      const agentProposal = report.proposals.find((p) => p.target === "agent");

      await expect(
        applyGraduation(root, agentProposal!.proposalId, { isTerminal: true, confirm: async () => false, env, now: NOW }),
      ).rejects.toMatchObject({ reason: "graduate-apply-cancelled" });

      expect(existsSync(path.join(root, ".metaproject", "agents", `${agentProposal!.suggestedName}.md`))).toBe(false);
    });
  });
});

describe("applyGraduation: skill/rule targets refuse", () => {
  test("skill target refuses graduate-apply-agent-only with the proposal's own next step", async () => {
    await withProjectRoot(async (root, env) => {
      await seedClusters(root, env);
      const report = await runGraduate(root, { now: NOW, env });
      const skillProposal = report.proposals.find((p) => p.target === "skill");
      expect(skillProposal).toBeDefined();

      try {
        await applyGraduation(root, skillProposal!.proposalId, { isTerminal: true, confirm: async () => true, env, now: NOW });
        throw new Error("expected applyGraduation to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(LearningGraduateError);
        expect((error as LearningGraduateError).reason).toBe("graduate-apply-agent-only");
        expect((error as LearningGraduateError).message).toContain("keryx skills scout");
      }
      expect(existsSync(path.join(root, ".metaproject", "agents"))).toBe(false);
    });
  });

  test("unknown proposal id refuses graduate-proposal-not-found", async () => {
    await withProjectRoot(async (root, env) => {
      await expect(
        applyGraduation(root, "grad-agent-000000000000", { isTerminal: true, confirm: async () => true, env, now: NOW }),
      ).rejects.toMatchObject({ reason: "graduate-proposal-not-found" });
    });
  });

  test("malformed proposal id refuses invalid-proposal-id", async () => {
    await withProjectRoot(async (root, env) => {
      await expect(
        applyGraduation(root, "not-a-proposal-id", { isTerminal: true, confirm: async () => true, env, now: NOW }),
      ).rejects.toMatchObject({ reason: "invalid-proposal-id" });
    });
  });
});
