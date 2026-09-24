import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseAgentFrontmatter } from "../agents/frontmatter";
import { buildAgentDefinition, validateAgentFrontmatter } from "../agents/schema";
import { createAcceptCapability } from "./accept-capability";
import { applyGraduation, LearningGraduateError, runGraduate } from "./graduate";
import { REVIEWER_COMMENT_TRIGGER_PREFIX } from "./reviewer-id";
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

/** Like `makeAccepted`, but with `provenance.extractor: "reviewer-comment"` and a trigger wrapped in the signal's own fixed wording. */
function makeAcceptedReviewerComment(id: string, hint: string, action: string, domain: LearningDomain, confidence: number): LearnedPattern {
  const record = makeAccepted(id, `${REVIEWER_COMMENT_TRIGGER_PREFIX}${hint})`, action, domain, confidence);
  return { ...record, provenance: { extractor: "reviewer-comment", extractorKind: "deterministic" } };
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

// Three `reviewer-comment` records sharing enough trigger keywords to cluster
// (size >= 3, avg confidence >= 0.75) -> agent, domain "review-conventions".
// Every trigger carries `REVIEWER_COMMENT_TRIGGER_PREFIX`'s fixed wording
// ("When preparing a change for review in this project (...)") — R5-F1/R5-F2's
// probe cluster.
const REVIEWER_COMMENT_CLUSTER: readonly [string, string, string][] = [
  ["review-conventions.early-returns-aaaaaaaa", "prefer early returns", "Prefer early returns over nested conditionals"],
  ["review-conventions.early-returns-bbbbbbbb", "prefer early returns always", "Prefer early returns to reduce nesting"],
  ["review-conventions.early-returns-cccccccc", "use early returns", "Use early returns instead of nested if blocks"],
];

async function seedReviewerCommentCluster(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  const capability = createAcceptCapability();
  for (const [id, hint, action] of REVIEWER_COMMENT_CLUSTER) {
    await writePattern(root, makeAcceptedReviewerComment(id, hint, action, "review-conventions", 0.8), { env, capability });
  }
}

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

// R3-F3 (review round 3, PR #691, minor): `applyGraduation`'s login gate
// used to call `loadReviewLearningConfig` directly, so a malformed
// `.metaproject/review-learning.config.json` threw an un-reasoned error
// straight out of `applyGraduation`. It now goes through the guarded
// loader (`configuredReviewLogins`) and refuses with the named reason
// `review-learning-config-invalid` — simplest consistent rule: graduate
// apply needs the login gate to be trustworthy before it can write an
// agent candidate, so an unreadable config is a refusal, not a silent "no
// configured logins".
describe("applyGraduation: malformed review-learning config (R3-F3)", () => {
  test("refuses with review-learning-config-invalid, writing no agent candidate", async () => {
    await withProjectRoot(async (root, env) => {
      await seedClusters(root, env);
      const report = await runGraduate(root, { now: NOW, env });
      const agentProposal = report.proposals.find((p) => p.target === "agent");
      expect(agentProposal).toBeDefined();

      // schemaVersion 99 fails loadReviewLearningConfig's own validation (must be 1).
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(path.join(root, ".metaproject", "review-learning.config.json"), JSON.stringify({ schemaVersion: 99 }));

      await expect(
        applyGraduation(root, agentProposal!.proposalId, { isTerminal: true, confirm: async () => true, env, now: NOW }),
      ).rejects.toMatchObject({ reason: "review-learning-config-invalid" });

      expect(existsSync(path.join(root, ".metaproject", "agents", `${agentProposal!.suggestedName}.md`))).toBe(false);
    });
  });

  // R3-F4 (review round 3, PR #691, minor): the login gate itself (R2-F6
  // defense-in-depth) had no test exercising a REAL configured login
  // present in a member record's trigger/action text, which the built
  // agent candidate body concatenates verbatim.
  test("refuses learning-text-refused when a member record's trigger names a configured reviewer login, writing no agent candidate", async () => {
    await withProjectRoot(async (root, env) => {
      const capability = createAcceptCapability();
      for (const [id, trigger, action] of AGENT_CLUSTER) {
        const withLogin =
          id === AGENT_CLUSTER[0]?.[0] ? `octocat says: ${trigger}` : trigger;
        await writePattern(root, makeAccepted(id, withLogin, action, "code-style", 0.8), { env, capability });
      }
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["octocat"] }),
      );

      const report = await runGraduate(root, { now: NOW, env });
      const agentProposal = report.proposals.find((p) => p.target === "agent");
      expect(agentProposal).toBeDefined();

      await expect(
        applyGraduation(root, agentProposal!.proposalId, { isTerminal: true, confirm: async () => true, env, now: NOW }),
      ).rejects.toMatchObject({ reason: "learning-text-refused" });

      expect(existsSync(path.join(root, ".metaproject", "agents", `${agentProposal!.suggestedName}.md`))).toBe(false);
    });
  });
});

// R4-F1 (review round 4, PR #691, minor): `applyGraduation`'s login gate
// used to check the ASSEMBLED `candidate.role`/`candidate.body`, both built
// from this function's own FIXED template wording ("Applies guidance
// graduated from...", "...without making **chang**es yourself", "##
// **Guida**nce graduated from learned patterns") around the member text.
// `containsConfiguredLogin`'s 5+-char substring fallback cannot tell that
// constant prose from a member's actual content, so a configured login that
// happens to be a substring of it (`chang` inside "changes", `guida` inside
// "guidance") refused EVERY agent candidate outright, regardless of what
// any member record said. Fixed by checking only the proposal's own summary
// (`candidate.description`), `suggestedName`, and every member's raw
// `trigger`/`action` — never the assembled `role`/`body`.
describe("applyGraduation: a configured login that is a substring of the fixed agent-candidate template wording (R4-F1)", () => {
  test("login 'chang' (substring of 'changes' in the fixed role text) does not false-refuse a clean agent candidate", async () => {
    await withProjectRoot(async (root, env) => {
      await seedClusters(root, env);
      const report = await runGraduate(root, { now: NOW, env });
      const agentProposal = report.proposals.find((p) => p.target === "agent");
      expect(agentProposal).toBeDefined();

      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["chang"] }),
      );

      const result = await applyGraduation(root, agentProposal!.proposalId, { isTerminal: true, confirm: async () => true, env, now: NOW });
      expect(existsSync(result.path)).toBe(true);
    });
  });

  test("login 'guida' (substring of 'guidance' in the fixed role/body text) does not false-refuse a clean agent candidate", async () => {
    await withProjectRoot(async (root, env) => {
      await seedClusters(root, env);
      const report = await runGraduate(root, { now: NOW, env });
      const agentProposal = report.proposals.find((p) => p.target === "agent");
      expect(agentProposal).toBeDefined();

      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["guida"] }),
      );

      const result = await applyGraduation(root, agentProposal!.proposalId, { isTerminal: true, confirm: async () => true, env, now: NOW });
      expect(existsSync(result.path)).toBe(true);
    });
  });

  test("a member record that genuinely names the login 'chang' is still refused", async () => {
    await withProjectRoot(async (root, env) => {
      const capability = createAcceptCapability();
      for (const [id, trigger, action] of AGENT_CLUSTER) {
        const withLogin = id === AGENT_CLUSTER[0]?.[0] ? `chang says: ${trigger}` : trigger;
        await writePattern(root, makeAccepted(id, withLogin, action, "code-style", 0.8), { env, capability });
      }
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["chang"] }),
      );

      const report = await runGraduate(root, { now: NOW, env });
      const agentProposal = report.proposals.find((p) => p.target === "agent");
      expect(agentProposal).toBeDefined();

      await expect(
        applyGraduation(root, agentProposal!.proposalId, { isTerminal: true, confirm: async () => true, env, now: NOW }),
      ).rejects.toMatchObject({ reason: "learning-text-refused" });

      expect(existsSync(path.join(root, ".metaproject", "agents", `${agentProposal!.suggestedName}.md`))).toBe(false);
    });
  });
});

// R5-F1/R5-F2 (review round 5, PR #691): `containsConfiguredLogin`'s removed
// 5+-char substring fallback used to match a configured login that was
// merely a substring of `graduate.ts`'s OWN fixed wording never checked
// before — not the assembled `role`/`body` (already excluded per R4-F1), but
// `candidate.description` (== `proposal.summary`, built from the fixed
// "N accepted "<domain>" pattern(s) sharing: ..." template plus the literal
// `domain` string) and `proposal.suggestedName` (built from `topKeywords`,
// which — before this fix — included `REVIEWER_COMMENT_TRIGGER_PREFIX`'s own
// fixed words). A login like `chang`/`prepa` (fragments of "change"/
// "preparing" in the fixed trigger prefix) or `accep`/`shari` (fragments of
// "accepted"/"sharing" in the fixed summary template) or `revie`/`conve`
// (fragments of the literal domain string "review-conventions") false-
// refused a graduation that never actually named the login, no matter what
// any member record said. Fixed two ways: (1) the login gate now checks
// ONLY member `trigger`/`action` text (prefix-stripped for reviewer-comment
// members), never `candidate.description`/`proposal.suggestedName`; (2)
// `topKeywords`/`suggestedNameFor` now strip the fixed reviewer-comment
// prefix before computing keywords, so proposal names/summaries are no
// longer built out of Keryx's own template prose either.
describe("applyGraduation/runGraduate: a configured login that is a substring of graduate's own fixed summary/domain/prefix wording (R5-F1, R5-F2)", () => {
  test.each(["chang", "prepa", "accep", "shari", "revie", "conve"])(
    "login '%s' (fragment of graduate's own fixed wording, never named by any member) does not false-refuse a clean reviewer-comment graduation",
    async (login) => {
      await withProjectRoot(async (root, env) => {
        await seedReviewerCommentCluster(root, env);
        const report = await runGraduate(root, { now: NOW, env });
        const agentProposal = report.proposals.find((p) => p.target === "agent");
        expect(agentProposal).toBeDefined();

        const { mkdirSync, writeFileSync } = await import("node:fs");
        mkdirSync(path.join(root, ".metaproject"), { recursive: true });
        writeFileSync(
          path.join(root, ".metaproject", "review-learning.config.json"),
          JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: [login] }),
        );

        const result = await applyGraduation(root, agentProposal!.proposalId, { isTerminal: true, confirm: async () => true, env, now: NOW });
        expect(existsSync(result.path)).toBe(true);
      });
    },
  );

  test("a member action that genuinely names the login '@chang' is still refused", async () => {
    await withProjectRoot(async (root, env) => {
      const capability = createAcceptCapability();
      for (const [id, hint, action] of REVIEWER_COMMENT_CLUSTER) {
        const withLogin = id === REVIEWER_COMMENT_CLUSTER[0]?.[0] ? `${action}, as @chang noted` : action;
        await writePattern(root, makeAcceptedReviewerComment(id, hint, withLogin, "review-conventions", 0.8), { env, capability });
      }
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["chang"] }),
      );

      const report = await runGraduate(root, { now: NOW, env });
      const agentProposal = report.proposals.find((p) => p.target === "agent");
      expect(agentProposal).toBeDefined();

      await expect(
        applyGraduation(root, agentProposal!.proposalId, { isTerminal: true, confirm: async () => true, env, now: NOW }),
      ).rejects.toMatchObject({ reason: "learning-text-refused" });

      expect(existsSync(path.join(root, ".metaproject", "agents", `${agentProposal!.suggestedName}.md`))).toBe(false);
    });
  });

  test("suggestedName for a reviewer-comment cluster is built from member content, not from the fixed prefix's own words ('preparing'/'change')", async () => {
    await withProjectRoot(async (root, env) => {
      await seedReviewerCommentCluster(root, env);
      const report = await runGraduate(root, { now: NOW, env });
      const agentProposal = report.proposals.find((p) => p.target === "agent");
      expect(agentProposal).toBeDefined();
      expect(agentProposal!.suggestedName).not.toContain("preparing");
      expect(agentProposal!.suggestedName).not.toContain("change");
      expect(agentProposal!.summary).not.toContain("preparing");
      expect(agentProposal!.summary).not.toContain("change");
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

// ---------------------------------------------------------------------------
// R1-F2 (review round 1, PR #691, major): a pattern accepted at BOTH project
// and user scope is one conceptual pattern with two on-disk copies, not two
// independently accepted patterns. `clusterRecords` used to key strictly by
// `id`, so this pair formed its own `[id, id]` cluster and could trigger a
// skill/agent proposal off a SINGLE accepted pattern — probe p1.ts's P2.
// ---------------------------------------------------------------------------

describe("runGraduate: a pattern accepted at both project and user scope does not form a 2-member cluster from itself (R1-F2)", () => {
  test("the dup id alone (nothing else to cluster with) yields NO proposal, not a 2-member skill proposal", async () => {
    await withProjectRoot(async (root, env) => {
      const capability = createAcceptCapability();
      const trigger = "when editing generated protobuf bindings manually here";
      const action = "regenerate bindings from the proto sources instead";
      await writePattern(root, makeAccepted("code-style.dup-11111111", trigger, action, "code-style", 0.6, "project"), {
        env,
        capability,
      });
      await writePattern(root, makeAccepted("code-style.dup-11111111", trigger, action, "code-style", 0.6, "user"), {
        env,
        capability,
      });

      const report = await runGraduate(root, { now: NOW, env, domain: "code-style" });

      expect(report.proposals).toEqual([]);
      expect(report.refused).toEqual([]);
    });
  });

  test("the dup id counts once toward a real cluster with a genuinely different pattern (agent cluster still needs 3 DISTINCT ids)", async () => {
    await withProjectRoot(async (root, env) => {
      const capability = createAcceptCapability();
      // Same id at both scopes (the "one member, two copies" case) plus two
      // more DISTINCT ids that would otherwise cluster with it: 3 total
      // distinct ids required for an agent proposal (cluster.length >= 3),
      // and the dup pair must not let 2 distinct ids masquerade as 3.
      const [idA, triggerA, actionA] = AGENT_CLUSTER[0]!;
      const [idB, triggerB, actionB] = AGENT_CLUSTER[1]!;
      await writePattern(root, makeAccepted(idA, triggerA, actionA, "code-style", 0.8, "project"), { env, capability });
      await writePattern(root, makeAccepted(idA, triggerA, actionA, "code-style", 0.8, "user"), { env, capability });
      await writePattern(root, makeAccepted(idB, triggerB, actionB, "code-style", 0.8, "project"), { env, capability });

      const report = await runGraduate(root, { now: NOW, env, domain: "code-style" });

      // 2 distinct ids (idA once, deduped, + idB) is a skill-sized cluster
      // (>= 2), never an agent-sized one (>= 3) — the dup copy of idA must
      // not count twice.
      const byTarget = Object.fromEntries(report.proposals.map((p) => [p.target, p]));
      expect(Object.keys(byTarget)).toEqual(["skill"]);
      expect([...(byTarget.skill?.members ?? [])].sort()).toEqual([idA, idB].sort());
    });
  });
});
