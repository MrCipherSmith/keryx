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
  //
  // R7-F2/R7-F3: this must use a `mayCarryReviewerText`-scoped member
  // (reviewer-comment here) — a plain `repeated-correction` member naming a
  // login is coincidence, not attribution (see the R6-F4 test in
  // `apply.test.ts`), and is no longer gated at all. The login is configured
  // only AFTER `runGraduate` (so the proposal-time gate — itself also scoped
  // to `mayCarryReviewerText` — does not refuse the cluster before this test
  // gets to exercise `applyGraduation`'s own defense-in-depth gate).
  test("refuses learning-text-refused when a reviewer-comment member's action names a configured reviewer login, writing no agent candidate", async () => {
    await withProjectRoot(async (root, env) => {
      const capability = createAcceptCapability();
      for (const [id, hint, action] of REVIEWER_COMMENT_CLUSTER) {
        const withLogin = id === REVIEWER_COMMENT_CLUSTER[0]?.[0] ? `octocat says: ${action}` : action;
        await writePattern(root, makeAcceptedReviewerComment(id, hint, withLogin, "review-conventions", 0.8), { env, capability });
      }

      const report = await runGraduate(root, { now: NOW, env });
      const agentProposal = report.proposals.find((p) => p.target === "agent");
      expect(agentProposal).toBeDefined();

      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["octocat"] }),
      );

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

  // R7-F2/R7-F3: same conversion as the R3-F4 test above — a plain
  // `repeated-correction` member (this test's original `AGENT_CLUSTER`) is
  // no longer gated at all, so a genuine occurrence there is no longer
  // refused (correctly: that signal never reads review text, so its member
  // naming "chang" is coincidence, not attribution — R6-F4). Use a
  // reviewer-comment cluster instead, and configure the login only AFTER
  // `runGraduate` so its own proposal-time gate does not refuse the cluster
  // before `applyGraduation`'s defense-in-depth gate gets exercised.
  test("a reviewer-comment member record that genuinely names the login 'chang' is still refused", async () => {
    await withProjectRoot(async (root, env) => {
      const capability = createAcceptCapability();
      for (const [id, hint, action] of REVIEWER_COMMENT_CLUSTER) {
        const withAction = id === REVIEWER_COMMENT_CLUSTER[0]?.[0] ? `chang says: ${action}` : action;
        await writePattern(root, makeAcceptedReviewerComment(id, hint, withAction, "review-conventions", 0.8), { env, capability });
      }

      const report = await runGraduate(root, { now: NOW, env });
      const agentProposal = report.proposals.find((p) => p.target === "agent");
      expect(agentProposal).toBeDefined();

      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["chang"] }),
      );

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

  // R6-F2 (review round 6, PR #691, minor): `runGraduate` now carries its own
  // reviewer-comment member-text login gate (see the dedicated R6-F2 describe
  // block below), so a genuine `@chang` mention already configured at
  // graduation time is refused at `runGraduate` itself — no proposal is ever
  // written, and `applyGraduation`'s own member-text gate (still exercised
  // above, and by the R6-F2 "configured after the fact" scenario) never gets
  // a proposal to apply in this case.
  test("a member action that genuinely names the login '@chang' is refused at runGraduate, before any proposal is written", async () => {
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
      expect(report.proposals.find((p) => p.target === "agent")).toBeUndefined();
      expect(report.refused.some((r) => r.categories.includes("attribution"))).toBe(true);

      const proposalDir = path.join(root, ".metaproject", "data", "learning", "graduation");
      expect(existsSync(proposalDir) ? readdirSync(proposalDir) : []).toEqual([]);
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

// R6-F1 (review round 6, PR #691, minor): `keywordsOf` splits on any
// non-`[a-z0-9]` character, including `-`, so member text `alice-style`
// (which passes `containsConfiguredLogin`'s boundary check clean — `-` is a
// login-class character, not a boundary) still splits into standalone
// keyword tokens `alice` and `style`. The bare token `alice` is then a
// top keyword like any other, and `suggestedNameFor`/the summary template
// happily wrote it into `.metaproject/agents/<name>.md`'s own name and
// description. `keywordsOf`/`topKeywords` now drop any keyword token equal
// (case-insensitively) to a configured login or a hyphen/underscore-split
// piece of one.
describe("runGraduate/applyGraduation: a login glued to member text via a hyphen never surfaces as a standalone keyword token (R6-F1)", () => {
  test("authors ['alice'] with member text 'alice-style': 'alice' never appears in the suggested name, summary, proposal files, or the applied agent's name/description", async () => {
    await withProjectRoot(async (root, env) => {
      const capability = createAcceptCapability();
      const rows: readonly [string, string, string][] = [
        ["review-conventions.early-returns-aaaaaaaa", "prefer early returns alice-style", "Prefer early returns alice-style over nested conditionals"],
        ["review-conventions.early-returns-bbbbbbbb", "prefer early returns alice-style always", "Prefer early returns alice-style to reduce nesting"],
        ["review-conventions.early-returns-cccccccc", "use early returns alice-style", "Use early returns alice-style instead of nested if blocks"],
      ];
      for (const [id, hint, action] of rows) {
        await writePattern(root, makeAcceptedReviewerComment(id, hint, action, "review-conventions", 0.8), { env, capability });
      }
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["alice"] }),
      );

      const report = await runGraduate(root, { now: NOW, env });
      const agentProposal = report.proposals.find((p) => p.target === "agent");
      expect(agentProposal).toBeDefined();
      expect(agentProposal!.suggestedName.toLowerCase()).not.toContain("alice");
      expect(agentProposal!.summary.toLowerCase()).not.toContain("alice");

      const proposalJson = readFileSync(
        path.join(root, ".metaproject", "data", "learning", "graduation", `${agentProposal!.proposalId}.json`),
        "utf8",
      );
      const proposalMd = readFileSync(
        path.join(root, ".metaproject", "data", "learning", "graduation", `${agentProposal!.proposalId}.md`),
        "utf8",
      );
      expect(proposalJson.toLowerCase()).not.toContain("alice");
      expect(proposalMd.toLowerCase()).not.toContain("alice");

      const result = await applyGraduation(root, agentProposal!.proposalId, { isTerminal: true, confirm: async () => true, env, now: NOW });
      const agentMd = readFileSync(result.path, "utf8");
      const nameLine = agentMd.split("\n").find((line) => line.startsWith("name:"));
      const descriptionLine = agentMd.split("\n").find((line) => line.startsWith("description:"));
      expect(nameLine?.toLowerCase()).not.toContain("alice");
      expect(descriptionLine?.toLowerCase()).not.toContain("alice");
    });
  });
});

// R9-F1/R9-F2 (review round 9, PR #691, minor, probe r14/p.ts, r14/q.ts):
// R8-F1's fix (below, superseded) re-checked the PROPOSAL's own persisted
// `suggestedName`/summary tokens against the current configured-login list
// at apply time — but that inspected STORED, already-derived tokens, not the
// member records, so it could not tell a genuinely leaked login apart from
// (R9-F1) the fixed `learned-<domain>` fallback name (whose split-on-`-`
// pieces can coincidentally equal a login piece, e.g. `learned-review-
// conventions` split includes the bare word "review") or (R9-F2) an
// ordinary keyword that only happens to equal a login piece, INCLUDING one
// from a member whose signal never reads review text at all (a `code-style`
// cluster's genuine word "code" refused outright by a login `code-bot`).
// Both false-refused a clean graduation regardless of what any member
// record said. The orchestrator decision: `applyGraduation` never re-checks
// stored derived tokens — it RECOMPUTES the candidate's name/summary from
// the member records and the CURRENT configured logins
// (`topKeywords`/`suggestedNameFor`, scoped per member by
// `mayCarryReviewerText` — R9-F1/R9-F2's other half: filtering is applied
// only to members whose signal could actually carry review text; every
// other member's keywords are never login-filtered at all). When the
// recomputed name differs from the proposal's stale `suggestedName`, the
// agent is written under the recomputed name.
describe("applyGraduation: a login glued to member text and configured AFTER runGraduate: name/description are recomputed without it, not refused (R9-F1/R9-F2)", () => {
  test("authors ['alice'] configured only after runGraduate: applyGraduation recomputes the name/description without 'alice' and still writes the agent", async () => {
    await withProjectRoot(async (root, env) => {
      const capability = createAcceptCapability();
      const rows: readonly [string, string, string][] = [
        ["review-conventions.early-returns-aaaaaaaa", "prefer early returns alice-style", "Prefer early returns alice-style over nested conditionals"],
        ["review-conventions.early-returns-bbbbbbbb", "prefer early returns alice-style always", "Prefer early returns alice-style to reduce nesting"],
        ["review-conventions.early-returns-cccccccc", "use early returns alice-style", "Use early returns alice-style instead of nested if blocks"],
      ];
      for (const [id, hint, action] of rows) {
        await writePattern(root, makeAcceptedReviewerComment(id, hint, action, "review-conventions", 0.8), { env, capability });
      }

      // No config at all when runGraduate runs: the glued 'alice' keyword is
      // not filtered out of suggestedName/summary — same setup as R6-F1's
      // test, but WITHOUT the config in place yet.
      const report = await runGraduate(root, { now: NOW, env });
      const agentProposal = report.proposals.find((p) => p.target === "agent");
      expect(agentProposal).toBeDefined();
      expect(agentProposal!.suggestedName.toLowerCase()).toContain("alice");
      expect(agentProposal!.summary.toLowerCase()).toContain("alice");

      // The login is configured only AFTER runGraduate — before apply.
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["alice"] }),
      );

      const result = await applyGraduation(root, agentProposal!.proposalId, { isTerminal: true, confirm: async () => true, env, now: NOW });
      expect(existsSync(result.path)).toBe(true);

      const agentMd = readFileSync(result.path, "utf8");
      const nameLine = agentMd.split("\n").find((line) => line.startsWith("name:"));
      const descriptionLine = agentMd.split("\n").find((line) => line.startsWith("description:"));
      expect(nameLine?.toLowerCase()).not.toContain("alice");
      expect(descriptionLine?.toLowerCase()).not.toContain("alice");

      // Recomputed at apply time — differs from the stale proposal.suggestedName
      // (which still carries the glued 'alice' token), so the agent is written
      // under the recomputed name, not the stale one.
      expect(result.path).not.toBe(path.join(root, ".metaproject", "agents", `${agentProposal!.suggestedName}.md`));
    });
  });
});

// R9-F1 (probe r14/p.ts, RC_NOKW): a no-keyword reviewer-comment cluster's
// `suggestedName` is the FIXED fallback `learned-<domain>` — unaffected by
// login filtering (it never came from `topKeywords` at all). The old
// `extraTokens` re-check split that fallback on `-` regardless
// (`["learned", "review", "conventions"]`) and refused it whenever a
// configured login happened to equal one of those literal domain-name
// pieces (`alice-review` -> "review"), whether the login was configured
// before or after `runGraduate` — the re-check ran unconditionally at apply
// time either way. Recomputing instead of re-checking never has this
// problem: the fallback name is domain-derived, not filtered, either way.
describe("runGraduate/applyGraduation: the fixed learned-<domain> fallback name is never refused by a login that is a substring of the domain name (R9-F1)", () => {
  const NO_KEYWORD_CLUSTER: readonly [string, string, string][] = [
    ["review-conventions.nk-aaaaaaaa", "use map", "Use map."],
    ["review-conventions.nk-bbbbbbbb", "use map now", "Use map, not for."],
    ["review-conventions.nk-cccccccc", "use map too", "Use a map."],
  ];

  test.each(["before", "after"] as const)(
    "login 'alice-review' configured %s runGraduate still graduates a no-keyword review-conventions cluster under the fallback name",
    async (when) => {
      await withProjectRoot(async (root, env) => {
        const capability = createAcceptCapability();
        for (const [id, hint, action] of NO_KEYWORD_CLUSTER) {
          await writePattern(root, makeAcceptedReviewerComment(id, hint, action, "review-conventions", 0.9), { env, capability });
        }

        const { mkdirSync, writeFileSync } = await import("node:fs");
        const writeConfig = (): void => {
          mkdirSync(path.join(root, ".metaproject"), { recursive: true });
          writeFileSync(
            path.join(root, ".metaproject", "review-learning.config.json"),
            JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["alice-review"] }),
          );
        };
        if (when === "before") writeConfig();

        const report = await runGraduate(root, { now: NOW, env });
        const agentProposal = report.proposals.find((p) => p.target === "agent");
        expect(agentProposal).toBeDefined();
        expect(agentProposal!.suggestedName).toBe("learned-review-conventions");

        if (when === "after") writeConfig();

        const result = await applyGraduation(root, agentProposal!.proposalId, { isTerminal: true, confirm: async () => true, env, now: NOW });
        expect(result.path).toBe(path.join(root, ".metaproject", "agents", "learned-review-conventions.md"));
        expect(existsSync(result.path)).toBe(true);
      });
    },
  );
});

// R9-F2 (probe r14/p.ts, RC_REVIEW and CS_CODE): an ORDINARY keyword that
// merely happens to equal a login piece is still the member's genuine
// content, not an attribution leak — refusing it regardless of provenance
// false-refused both a reviewer-comment cluster that legitimately uses the
// word "review" (login `alice-review`) and a `repeated-correction`
// code-style cluster that legitimately uses the word "code" (login
// `code-bot`, whose signal never reads review text at all — R7-F2's own
// `mayCarryReviewerText` scoping, which the old `extraTokens` re-check
// ignored entirely).
describe("runGraduate/applyGraduation: an ordinary keyword equal to a login piece does not refuse graduation (R9-F2)", () => {
  test("login 'alice-review' configured after runGraduate on a cluster whose genuine keyword is 'review' still graduates", async () => {
    await withProjectRoot(async (root, env) => {
      const capability = createAcceptCapability();
      const rows: readonly [string, string, string][] = [
        ["review-conventions.rq-aaaaaaaa", "request review early", "Request a second review before merging risky changes"],
        ["review-conventions.rq-bbbbbbbb", "request review early always", "Request review from an owner before merging risky changes"],
        ["review-conventions.rq-cccccccc", "request review sooner", "Request review early for risky changes"],
      ];
      for (const [id, hint, action] of rows) {
        await writePattern(root, makeAcceptedReviewerComment(id, hint, action, "review-conventions", 0.8), { env, capability });
      }

      const report = await runGraduate(root, { now: NOW, env });
      const agentProposal = report.proposals.find((p) => p.target === "agent");
      expect(agentProposal).toBeDefined();

      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["alice-review"] }),
      );

      const result = await applyGraduation(root, agentProposal!.proposalId, { isTerminal: true, confirm: async () => true, env, now: NOW });
      expect(existsSync(result.path)).toBe(true);
    });
  });

  test("login 'code-bot' configured after runGraduate on a repeated-correction code-style cluster whose genuine keyword is 'code' still graduates", async () => {
    await withProjectRoot(async (root, env) => {
      const capability = createAcceptCapability();
      const rows: readonly [string, string, string][] = [
        ["code-style.cd-aaaaaaaa", "When editing code under src/api in this project", "Keep code comments short in api handlers"],
        ["code-style.cd-bbbbbbbb", "When editing code under src/web in this project", "Keep code comments short in web handlers"],
        ["code-style.cd-cccccccc", "When editing code under src/cli in this project", "Keep code comments short in cli handlers"],
      ];
      for (const [id, trigger, action] of rows) {
        await writePattern(root, makeAccepted(id, trigger, action, "code-style", 0.8), { env, capability });
      }

      const report = await runGraduate(root, { now: NOW, env });
      const agentProposal = report.proposals.find((p) => p.target === "agent");
      expect(agentProposal).toBeDefined();

      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["code-bot"] }),
      );

      const result = await applyGraduation(root, agentProposal!.proposalId, { isTerminal: true, confirm: async () => true, env, now: NOW });
      expect(existsSync(result.path)).toBe(true);
    });
  });
});

// R9-F2 continued (probe r14/q.ts): the R7-F2 test above configures 'edit'
// BEFORE runGraduate; this covers the same reverted-edit cluster with the
// login configured AFTER runGraduate (so `applyGraduation`'s recompute, not
// `runGraduate`'s own gate, is what is exercised), plus a second login
// ('nested', a genuine word in every member's action text) that a
// substring/stored-token re-check would have refused outright.
describe("runGraduate/applyGraduation: a reverted-edit member is never login-gated when the login is configured after runGraduate (R9-F2)", () => {
  test.each(["edit", "nested"])("login '%s' configured after runGraduate does not refuse applying a reverted-edit cluster", async (login) => {
    await withProjectRoot(async (root, env) => {
      const capability = createAcceptCapability();
      const rows: readonly [string, string, string][] = [
        ["code-style.revert-aaaaaaaa", "When an edit to foo.ts is immediately reverted in this project", "Avoid nested ternaries in foo helpers"],
        ["code-style.revert-bbbbbbbb", "When an edit to bar.ts is immediately reverted in this project", "Avoid nested ternaries in bar helpers"],
        ["code-style.revert-cccccccc", "When an edit to baz.ts is immediately reverted in this project", "Avoid nested ternaries in baz helpers"],
      ];
      for (const [id, trigger, action] of rows) {
        const record = makeAccepted(id, trigger, action, "code-style", 0.8);
        await writePattern(root, { ...record, provenance: { extractor: "reverted-edit", extractorKind: "deterministic" } }, { env, capability });
      }

      const report = await runGraduate(root, { now: NOW, env });
      expect(report.refused).toEqual([]);
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
  });
});

// R6-F2 (review round 6, PR #691, minor): `runGraduate` wrote a proposal
// file (and set `graduation` on every member) with no login gate at all —
// only `applyGraduation` (a later, separate, human-confirmed step) checked
// member text for a configured login. A login configured AFTER the source
// records were already stored — the same "configured after the fact" risk
// the member-text gate exists for elsewhere — still reached
// `grad-*.json`/`.md` on disk. `runGraduate` now loads configured logins
// (via the safe, non-throwing loader) and refuses (`refused`, category
// `attribution`) any cluster whose reviewer-comment member variable text
// contains a boundary login, before writing anything.
describe("runGraduate: a login configured after records were stored refuses the cluster before any proposal file is written (R6-F2)", () => {
  test("a reviewer-comment member's genuine @mention of a later-configured login refuses the whole cluster; no proposal file is written", async () => {
    await withProjectRoot(async (root, env) => {
      const capability = createAcceptCapability();
      const rows: readonly [string, string, string][] = [
        ["review-conventions.early-returns-aaaaaaaa", "prefer early returns", "@alice prefers early returns over nesting"],
        ["review-conventions.early-returns-bbbbbbbb", "prefer early returns always", "Prefer early returns to reduce nesting"],
        ["review-conventions.early-returns-cccccccc", "use early returns", "Use early returns instead of nested if blocks"],
      ];
      for (const [id, hint, action] of rows) {
        await writePattern(root, makeAcceptedReviewerComment(id, hint, action, "review-conventions", 0.8), { env, capability });
      }
      // The login is configured only AFTER the records above were stored.
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["alice"] }),
      );

      const report = await runGraduate(root, { now: NOW, env });
      expect(report.proposals.find((p) => p.target === "agent")).toBeUndefined();
      expect(report.refused.some((r) => r.categories.includes("attribution"))).toBe(true);

      const proposalDir = path.join(root, ".metaproject", "data", "learning", "graduation");
      expect(existsSync(proposalDir) ? readdirSync(proposalDir) : []).toEqual([]);
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

// ---------------------------------------------------------------------------
// R7-F1 (review round 7, PR #691, minor): `applyGraduation` used to run a
// SECOND, separate token gate over the already-keyword-filtered
// `proposal.suggestedName`/`proposal.summary` (`containsLoginToken`). Those
// two strings still mix `runGraduate`'s own fixed template prose ("N
// accepted", "pattern(s)", "sharing", the fallback "learned-<domain>" name,
// the literal domain string) with keyword-derived content, so a configured
// login equal to one of THOSE fixed words (`tom-s` -> "s" is too short to
// matter, but a login like the domain name itself, or one that happens to
// equal a template word) refused every graduation for that project outright.
// The fix removes that second gate entirely: `runGraduate`'s own
// `keywordsOf`/`topKeywords` filtering already keeps a configured login out
// of `suggestedName`/`summary` by construction, and `memberTexts` already
// gates every member's actual variable content.
// ---------------------------------------------------------------------------

describe("applyGraduation: R7-F1 removed final summary/suggestedName token gate", () => {
  test.each(["tom-s", "alice-review", "carol-accepted", "dan-sharing"])(
    "login '%s' does not false-refuse a clean reviewer-comment graduation (no member names it)",
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

  test("login 'code-bot' does not false-refuse a clean, non-reviewer-comment (repeated-correction) code-style graduation", async () => {
    await withProjectRoot(async (root, env) => {
      await seedClusters(root, env);
      const report = await runGraduate(root, { now: NOW, env });
      const agentProposal = report.proposals.find((p) => p.target === "agent");
      expect(agentProposal).toBeDefined();

      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["code-bot"] }),
      );

      const result = await applyGraduation(root, agentProposal!.proposalId, { isTerminal: true, confirm: async () => true, env, now: NOW });
      expect(existsSync(result.path)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// R7-F2 (review round 7, PR #691, minor): `buildAgentCandidate` used to push
// EVERY found member's `trigger`/`action` into `memberTexts` regardless of
// `provenance.extractor` — disagreeing with `runGraduate`'s own cluster gate,
// which was already scoped to `mayCarryReviewerText`. A `reverted-edit`
// cluster (whose fixed trigger template contains the word "edit" twice over)
// with a configured login of `edit` was proposed by `runGraduate` (correctly
// unscoped) but then unconditionally refused at `applyGraduation` (the
// unscoped `memberTexts` gate), even though a `reverted-edit` record never
// reads review text and cannot carry an attribution fragment. Both sides of
// the pipeline now use the same `mayCarryReviewerText` predicate.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// R10-F1 (review round 10, PR #691, minor): an already-proposed (idempotent)
// cluster used to be skipped BEFORE any login gate ran at all, so a proposal
// written while no login was configured kept a login-derived
// suggestedName/summary/nextSteps sitting on disk (and printed verbatim by
// applyGraduation for a skill/rule target) even after that login was
// configured. Fixed two ways: `runGraduate` now re-gates and recomputes an
// already-proposed cluster's stored proposal on every rerun once a login is
// configured, and `applyGraduation`'s skill/rule refusal message now
// recomputes `nextSteps` from the member records + current logins instead of
// echoing `proposal.nextSteps` from disk.
// ---------------------------------------------------------------------------

describe("runGraduate: a login configured AFTER an already-written proposal is scrubbed from it on rerun (R10-F1)", () => {
  test("rerunning graduate after configuring the login rewrites the proposal file without it", async () => {
    await withProjectRoot(async (root, env) => {
      const capability = createAcceptCapability();
      const rows: readonly [string, string, string][] = [
        ["review-conventions.early-returns-aaaaaaaa", "prefer early returns alice-style", "Prefer early returns alice-style over nested conditionals"],
        ["review-conventions.early-returns-bbbbbbbb", "prefer early returns alice-style always", "Prefer early returns alice-style to reduce nesting"],
        ["review-conventions.early-returns-cccccccc", "use early returns alice-style", "Use early returns alice-style instead of nested if blocks"],
      ];
      for (const [id, hint, action] of rows) {
        await writePattern(root, makeAcceptedReviewerComment(id, hint, action, "review-conventions", 0.8), { env, capability });
      }

      // First run: no login configured yet — the glued 'alice' keyword
      // survives into the proposal's suggestedName/summary, same as R6-F1's
      // "before" setup.
      const first = await runGraduate(root, { now: NOW, env });
      const firstProposal = first.proposals.find((p) => p.target === "agent");
      expect(firstProposal).toBeDefined();
      expect(firstProposal!.suggestedName.toLowerCase()).toContain("alice");

      // The login is configured only AFTER the first run.
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["alice"] }),
      );

      const second = await runGraduate(root, { now: NOW, env });
      expect(second.proposals).toEqual([]);
      expect(second.alreadyProposed).toEqual([firstProposal!.proposalId]);

      const proposalJsonPath = path.join(root, ".metaproject", "data", "learning", "graduation", `${firstProposal!.proposalId}.json`);
      const proposalMdPath = path.join(root, ".metaproject", "data", "learning", "graduation", `${firstProposal!.proposalId}.md`);
      const rewrittenJson = readFileSync(proposalJsonPath, "utf8");
      const rewrittenMd = readFileSync(proposalMdPath, "utf8");
      expect(rewrittenJson.toLowerCase()).not.toContain("alice");
      expect(rewrittenMd.toLowerCase()).not.toContain("alice");

      const rewrittenProposal = JSON.parse(rewrittenJson) as { suggestedName: string; summary: string };
      expect(rewrittenProposal.suggestedName.toLowerCase()).not.toContain("alice");
      expect(rewrittenProposal.summary.toLowerCase()).not.toContain("alice");

      // Applying the rewritten proposal writes an agent whose name/description
      // never carry the login either (the raw member body text is a
      // separate, documented concern — R4-F1/R6-F1 already cover it via the
      // per-member `gateReviewerText` refusal, not scrubbing).
      const result = await applyGraduation(root, firstProposal!.proposalId, { isTerminal: true, confirm: async () => true, env, now: NOW });
      const agentMd = readFileSync(result.path, "utf8");
      const nameLine = agentMd.split("\n").find((line) => line.startsWith("name:"));
      const descriptionLine = agentMd.split("\n").find((line) => line.startsWith("description:"));
      expect(nameLine?.toLowerCase()).not.toContain("alice");
      expect(descriptionLine?.toLowerCase()).not.toContain("alice");
    });
  });

  test("a login glued to a member's raw trigger/action (not just a keyword) refuses the already-proposed cluster instead of rewriting it", async () => {
    await withProjectRoot(async (root, env) => {
      const capability = createAcceptCapability();
      const memberId = REVIEWER_COMMENT_CLUSTER[0]![0];
      const rows: readonly [string, string, string][] = [
        [memberId, REVIEWER_COMMENT_CLUSTER[0]![1], `@bob prefers ${REVIEWER_COMMENT_CLUSTER[0]![2]}`],
        [REVIEWER_COMMENT_CLUSTER[1]![0], REVIEWER_COMMENT_CLUSTER[1]![1], REVIEWER_COMMENT_CLUSTER[1]![2]],
        [REVIEWER_COMMENT_CLUSTER[2]![0], REVIEWER_COMMENT_CLUSTER[2]![1], REVIEWER_COMMENT_CLUSTER[2]![2]],
      ];
      for (const [id, hint, action] of rows) {
        await writePattern(root, makeAcceptedReviewerComment(id, hint, action, "review-conventions", 0.8), { env, capability });
      }

      // No login configured yet: the genuine "@bob" mention is not gated at
      // all, so the first run succeeds and writes a proposal normally.
      const first = await runGraduate(root, { now: NOW, env });
      const firstProposal = first.proposals.find((p) => p.target === "agent");
      expect(firstProposal).toBeDefined();

      // The login is configured only AFTER the first run — the same
      // "configured after the fact" shape R6-F2's test uses, but here
      // against an ALREADY-PROPOSED cluster rather than a brand-new one.
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["bob"] }),
      );

      const second = await runGraduate(root, { now: NOW, env });
      expect(second.proposals).toEqual([]);
      expect(second.alreadyProposed).toEqual([]);
      expect(second.refused.some((r) => r.categories.includes("attribution") && r.memberIds.includes(memberId))).toBe(true);

      // R1-F4: the re-gate above refuses rather than rewriting — the stale
      // proposal `.json`/`.md` pair (written by the first, unfiltered run,
      // and still carrying the raw "@bob" mention) must not be left sitting
      // on disk once that member is known to gate against a configured
      // login. Both files are deleted, not just the `.json`.
      const proposalJsonPath = path.join(root, ".metaproject", "data", "learning", "graduation", `${firstProposal!.proposalId}.json`);
      const proposalMdPath = path.join(root, ".metaproject", "data", "learning", "graduation", `${firstProposal!.proposalId}.md`);
      expect(existsSync(proposalJsonPath)).toBe(false);
      expect(existsSync(proposalMdPath)).toBe(false);
    });
  });
});

describe("runGraduate: a proposal orphaned by a change in cluster membership is swept once a login is configured (R1-F4)", () => {
  test("cluster membership changes (proposal id changes); the old proposal, carrying a later-configured login, is deleted on rerun", async () => {
    await withProjectRoot(async (root, env) => {
      const capability = createAcceptCapability();
      const rows: readonly [string, string, string][] = [
        ["review-conventions.early-returns-aaaaaaaa", "prefer early returns alice-style", "Prefer early returns alice-style over nested conditionals"],
        ["review-conventions.early-returns-bbbbbbbb", "prefer early returns alice-style always", "Prefer early returns alice-style to reduce nesting"],
        ["review-conventions.early-returns-cccccccc", "use early returns alice-style", "Use early returns alice-style instead of nested if blocks"],
      ];
      for (const [id, hint, action] of rows) {
        await writePattern(root, makeAcceptedReviewerComment(id, hint, action, "review-conventions", 0.8), { env, capability });
      }

      // No login configured yet: the glued "alice" keyword survives into
      // the first proposal's suggestedName/summary (same R6-F1 shape).
      const first = await runGraduate(root, { now: NOW, env });
      const firstProposal = first.proposals.find((p) => p.target === "agent");
      expect(firstProposal).toBeDefined();
      expect(firstProposal!.suggestedName.toLowerCase()).toContain("alice");
      const orphanedJsonPath = path.join(root, ".metaproject", "data", "learning", "graduation", `${firstProposal!.proposalId}.json`);
      const orphanedMdPath = path.join(root, ".metaproject", "data", "learning", "graduation", `${firstProposal!.proposalId}.md`);
      expect(existsSync(orphanedJsonPath)).toBe(true);

      // A 4th similar member joins the cluster: `proposalIdFor` hashes the
      // new (larger) sorted member-id set, so the NEW proposal gets a
      // DIFFERENT id — the old one is now orphaned, not "already proposed".
      await writePattern(
        root,
        makeAcceptedReviewerComment(
          "review-conventions.early-returns-dddddddd",
          "prefer early returns alice-style here",
          "Prefer early returns alice-style in handlers",
          "review-conventions",
          0.8,
        ),
        { env, capability },
      );

      // The login is configured only now, after the membership change.
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["alice"] }),
      );

      const second = await runGraduate(root, { now: NOW, env });
      const secondProposal = second.proposals.find((p) => p.target === "agent");
      expect(secondProposal).toBeDefined();
      expect(secondProposal!.proposalId).not.toBe(firstProposal!.proposalId);
      // The new cluster's own proposal is clean (the main-loop gate already
      // covered this — R6-F2) — the point under test is the ORPHAN below.
      expect(secondProposal!.suggestedName.toLowerCase()).not.toContain("alice");

      // The orphaned proposal — never visited by the main loop, since its id
      // no longer matches any current cluster — is deleted by the sweep
      // rather than left on disk carrying "alice" forever.
      expect(existsSync(orphanedJsonPath)).toBe(false);
      expect(existsSync(orphanedMdPath)).toBe(false);
    });
  });
});

describe("runGraduate: the orphan sweep does not over-delete on a --domain run (R2-F1)", () => {
  test("a --domain X run leaves a LIVE (non-orphaned) proposal of an unrelated domain Y intact, even though its text carries a later-configured login", async () => {
    await withProjectRoot(async (root, env) => {
      const capability = createAcceptCapability();
      // A `review-conventions` cluster whose trigger carries a glued token
      // ("alice-style") that will later equal a configured login. Provenance
      // is `reviewer-comment` (`mayCarryReviewerText` true), matching the
      // existing R1-F4 orphan shape, so the token IS a genuine leak once the
      // login is configured.
      const rows: readonly [string, string, string][] = [
        ["review-conventions.early-returns-aaaaaaaa", "prefer early returns alice-style", "Prefer early returns alice-style over nested conditionals"],
        ["review-conventions.early-returns-bbbbbbbb", "prefer early returns alice-style always", "Prefer early returns alice-style to reduce nesting"],
        ["review-conventions.early-returns-cccccccc", "use early returns alice-style", "Use early returns alice-style instead of nested if blocks"],
      ];
      for (const [id, hint, action] of rows) {
        await writePattern(root, makeAcceptedReviewerComment(id, hint, action, "review-conventions", 0.8), { env, capability });
      }

      // Unrelated members in a DIFFERENT domain, so a `--domain testing` run
      // below has something of its own to cluster/report on.
      for (const [id, trigger, action, scope] of SKILL_CLUSTER) {
        await writePattern(root, makeAccepted(id, trigger, action, "testing", 0.5, scope), { env, capability });
      }

      // Full run (no domain filter): writes the review-conventions proposal
      // while no login is configured yet, so "alice" survives into its
      // suggestedName.
      const first = await runGraduate(root, { now: NOW, env });
      const liveProposal = first.proposals.find((p) => p.domain === "review-conventions");
      expect(liveProposal).toBeDefined();
      expect(liveProposal!.suggestedName.toLowerCase()).toContain("alice");
      const liveJsonPath = path.join(root, ".metaproject", "data", "learning", "graduation", `${liveProposal!.proposalId}.json`);
      const liveMdPath = path.join(root, ".metaproject", "data", "learning", "graduation", `${liveProposal!.proposalId}.md`);
      expect(existsSync(liveJsonPath)).toBe(true);

      // The login is configured only now.
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["alice"] }),
      );

      // A `--domain testing` run: `listPatterns` returns only "testing"
      // records, so the review-conventions cluster above is NOT among this
      // run's current clusters at all. The proposal is still LIVE (its
      // cluster is unchanged and still exists), so the sweep must leave it
      // alone rather than treating "not in this domain-filtered run" as
      // "orphaned".
      const domainRun = await runGraduate(root, { now: NOW, env, domain: "testing" });
      expect(domainRun.proposals.every((p) => p.domain === "testing")).toBe(true);

      expect(existsSync(liveJsonPath)).toBe(true);
      expect(existsSync(liveMdPath)).toBe(true);

      // A subsequent FULL run still re-gates/rewrites it normally (unrelated
      // to this finding, just confirming nothing else broke).
      const full = await runGraduate(root, { now: NOW, env });
      const rewritten = full.alreadyProposed.includes(liveProposal!.proposalId);
      expect(rewritten).toBe(true);
    });
  });

  test("scoping: an orphaned proposal whose members cannot carry reviewer text is kept even though its stored text matches a later-configured login token", async () => {
    await withProjectRoot(async (root, env) => {
      const capability = createAcceptCapability();
      // `repeated-correction` provenance -> `mayCarryReviewerText` is false,
      // so `topKeywords` never filters logins for these entries at ANY time
      // (see `topKeywords`'s per-entry scoping) — "bobby-style" is this
      // cluster's own genuine content, not an attribution fragment, even
      // though "bobby" later becomes a configured login.
      const rows: readonly [string, string, string][] = [
        ["code-style.bobby-return-aaaaaaaa", "prefer early returns bobby-style", "Prefer early returns bobby-style over nested conditionals"],
        ["code-style.bobby-return-bbbbbbbb", "prefer early returns bobby-style always", "Prefer early returns bobby-style to reduce nesting"],
        ["code-style.bobby-return-cccccccc", "use early returns bobby-style", "Use early returns bobby-style instead of nested if blocks"],
      ];
      for (const [id, trigger, action] of rows) {
        await writePattern(root, makeAccepted(id, trigger, action, "code-style", 0.8), { env, capability });
      }

      const first = await runGraduate(root, { now: NOW, env });
      const firstProposal = first.proposals.find((p) => p.target === "agent");
      expect(firstProposal).toBeDefined();
      expect(firstProposal!.suggestedName.toLowerCase()).toContain("bobby");
      const orphanedJsonPath = path.join(root, ".metaproject", "data", "learning", "graduation", `${firstProposal!.proposalId}.json`);
      const orphanedMdPath = path.join(root, ".metaproject", "data", "learning", "graduation", `${firstProposal!.proposalId}.md`);
      expect(existsSync(orphanedJsonPath)).toBe(true);

      // A 4th similar member joins the cluster: the proposal id changes, so
      // the old one is orphaned (never revisited by the main loop).
      await writePattern(
        root,
        makeAccepted(
          "code-style.bobby-return-dddddddd",
          "prefer early returns bobby-style here",
          "Prefer early returns bobby-style in handlers",
          "code-style",
          0.8,
        ),
        { env, capability },
      );

      // The login is configured only now, after the membership change.
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["bobby"] }),
      );

      const second = await runGraduate(root, { now: NOW, env });
      const secondProposal = second.proposals.find((p) => p.target === "agent");
      expect(secondProposal).toBeDefined();
      expect(secondProposal!.proposalId).not.toBe(firstProposal!.proposalId);

      // The orphan's own members cannot carry reviewer text (provenance is
      // `repeated-correction`), so "bobby-style" is genuine content for
      // them, not a leaked login — the sweep must keep the orphan rather
      // than deleting it on a bare token match.
      expect(existsSync(orphanedJsonPath)).toBe(true);
      expect(existsSync(orphanedMdPath)).toBe(true);
    });
  });
});

describe("applyGraduation: a login configured AFTER an already-written skill/rule proposal never appears in the printed next-step message (R10-F1)", () => {
  test("configuring the login after runGraduate: the graduate-apply-agent-only message's next step never contains it", async () => {
    await withProjectRoot(async (root, env) => {
      const capability = createAcceptCapability();
      // R10-F1's login-filtering recompute only applies to a member whose
      // signal `mayCarryReviewerText` (reviewer-comment or model-backed) —
      // an ordinary keyword from any other signal is genuine content, never
      // an attribution leak (R9-F2). Domain "testing" (not
      // "review-conventions") keeps `classify` at "skill" for this
      // 2-member cluster, while the `reviewer-comment` provenance is what
      // makes the login-derived keyword actually filterable.
      const rows: readonly [string, string, string][] = [
        ["testing.rerun-failing-alice-dddddddd", "run the failing test alice-style again before merging the change", "confirm the fix locally before pushing"],
        ["testing.rerun-failing-alice-eeeeeeee", "rerun the failing test alice-style once more before merging the change", "watch the same test go green twice"],
      ];
      for (const [id, hint, action] of rows) {
        await writePattern(root, makeAcceptedReviewerComment(id, hint, action, "testing", 0.5), { env, capability });
      }

      const report = await runGraduate(root, { now: NOW, env });
      const skillProposal = report.proposals.find((p) => p.target === "skill");
      expect(skillProposal).toBeDefined();
      expect(skillProposal!.suggestedName.toLowerCase()).toContain("alice");

      // The login is configured only AFTER runGraduate, so runGraduate's own
      // rewrite pass (exercised by the describe block above) never ran for
      // this proposal — applyGraduation's own recompute is what is exercised
      // here.
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["alice"] }),
      );

      try {
        await applyGraduation(root, skillProposal!.proposalId, { isTerminal: true, confirm: async () => true, env, now: NOW });
        throw new Error("expected applyGraduation to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(LearningGraduateError);
        expect((error as LearningGraduateError).reason).toBe("graduate-apply-agent-only");
        expect((error as LearningGraduateError).message.toLowerCase()).not.toContain("alice");
        expect((error as LearningGraduateError).message).toContain("keryx skills scout");
      }
    });
  });
});

describe("runGraduate/applyGraduation: a reverted-edit member is never login-gated, at either stage (R7-F2)", () => {
  test("login 'edit' does not refuse proposing OR applying a reverted-edit cluster", async () => {
    await withProjectRoot(async (root, env) => {
      const capability = createAcceptCapability();
      const rows: readonly [string, string, string][] = [
        ["code-style.revert-aaaaaaaa", "When an edit to foo.ts is immediately reverted in this project", "Avoid nested ternaries in foo helpers"],
        ["code-style.revert-bbbbbbbb", "When an edit to bar.ts is immediately reverted in this project", "Avoid nested ternaries in bar helpers"],
        ["code-style.revert-cccccccc", "When an edit to baz.ts is immediately reverted in this project", "Avoid nested ternaries in baz helpers"],
      ];
      for (const [id, trigger, action] of rows) {
        const record = makeAccepted(id, trigger, action, "code-style", 0.8);
        await writePattern(
          root,
          { ...record, provenance: { extractor: "reverted-edit", extractorKind: "deterministic" } },
          { env, capability },
        );
      }
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["edit"] }),
      );

      const report = await runGraduate(root, { now: NOW, env });
      expect(report.refused).toEqual([]);
      const agentProposal = report.proposals.find((p) => p.target === "agent");
      expect(agentProposal).toBeDefined();

      const result = await applyGraduation(root, agentProposal!.proposalId, { isTerminal: true, confirm: async () => true, env, now: NOW });
      expect(existsSync(result.path)).toBe(true);
    });
  });
});
