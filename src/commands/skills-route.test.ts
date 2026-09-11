import { describe, expect, test } from "bun:test";
import { BUNDLED_GDSKILLS, renderBundledSkill } from "../gdskills/catalog";
import { normalizeRouteText, scoreBundledSkillRoute } from "./skills";

function topBundled(query: string): { name: string; score: number } | undefined {
  const ranked = BUNDLED_GDSKILLS.map((entry) => scoreBundledSkillRoute(entry, query))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  const best = ranked[0];
  return best ? { name: best.entry.name, score: best.score } : undefined;
}

describe("normalizeRouteText", () => {
  test("preserves Cyrillic instead of erasing it", () => {
    expect(normalizeRouteText("Пакет Документации")).toBe("пакет документации");
  });

  test("splits camelCase and drops punctuation", () => {
    expect(normalizeRouteText("PipelineStepStore.ts")).toBe("pipeline step store ts");
  });

  test("a symbol-only query normalizes to empty (no false matches)", () => {
    expect(normalizeRouteText("!!! --- ???")).toBe("");
  });
});

describe("scoreBundledSkillRoute", () => {
  test("Russian 'пакет документации' routes to docpack-orchestrator", () => {
    const top = topBundled("подготовь пакет документации для реализации");
    expect(top?.name).toBe("docpack-orchestrator");
  });

  test("English 'requirements documentation package' routes to docpack-orchestrator", () => {
    const top = topBundled("prepare requirements documentation package");
    expect(top?.name).toBe("docpack-orchestrator");
  });

  test("an empty/symbol-only query matches nothing (no .includes(\"\") trap)", () => {
    const ranked = BUNDLED_GDSKILLS.map((entry) => scoreBundledSkillRoute(entry, "?!?"))
      .filter((match) => match.score > 0);
    expect(ranked).toHaveLength(0);
  });

  test("stopwords alone do not produce a match", () => {
    const ranked = BUNDLED_GDSKILLS.map((entry) => scoreBundledSkillRoute(entry, "для the и with"))
      .filter((match) => match.score > 0);
    expect(ranked).toHaveLength(0);
  });

  test("Russian intents reach English-only skills via synonym expansion", () => {
    // These skills carry English-only triggers/descriptions; the query is Russian.
    const cases: Array<[string, string]> = [
      ["реализуй задачу по тикету", "task-implementer"],
      ["оформи пакет документации модуля", "docpack-orchestrator"],
    ];
    for (const [query, expected] of cases) {
      const names = BUNDLED_GDSKILLS.map((entry) => ({
        name: entry.name,
        ...scoreBundledSkillRoute(entry, query),
      }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((match) => match.name);
      expect(names).toContain(expected);
    }
  });

  test("a Russian review intent surfaces a review skill", () => {
    const top = BUNDLED_GDSKILLS.map((entry) => {
      const scored = scoreBundledSkillRoute(entry, "проведи ревью пулл реквеста");
      return { category: entry.category, score: scored.score };
    })
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score)[0];
    expect(top?.category).toBe("review");
  });

  test("every bundled skill is reachable by its own name", () => {
    for (const entry of BUNDLED_GDSKILLS) {
      const result = scoreBundledSkillRoute(entry, entry.name);
      expect(result.score).toBeGreaterThan(0);
    }
  });
});

describe("rendered description reads as a trigger, not an echoed imperative", () => {
  // catalog.ts's `skill()` helper defaults `description` to a lowercased echo
  // of `purpose` — "Use when choose between gdgraph..." — which restates what
  // the skill does rather than saying when an agent should reach for it.
  //
  // AC9 (flow 252, D7) is scoped to exactly these 11 core/platform skills —
  // the ones a routing agent reaches for before any other skill has narrowed
  // the request, where an echoed imperative gives it nothing to route on.
  // Other categories (orchestration/review/quality/planning) and two more
  // platform skills (agent-entrypoint-distiller, claude-md-management) still
  // carry the same pattern; that is a real, broader instance of D7 but sits
  // outside this frozen criterion's named set, so it is left untouched here.
  const AC9_SCOPED_SKILLS = [
    "metaproject-router",
    "context-router",
    "entity-skill-router",
    "entity-skill-creator",
    "entity-skill-verifier",
    "entity-skill-learner",
    "agent-entrypoint-manager",
    "hook-manager",
    "skill-catalog-manager",
    "skill-runtime-exporter",
    "skill-sync",
  ];
  const echoedImperative = /^Use when (choose|create|update|select|verify|split|maintain|generate|export|sync|run|build)\b/i;

  test("the AC9 scope still names exactly 11 skills, all present in the catalog", () => {
    expect(AC9_SCOPED_SKILLS.length).toBe(11);
    for (const name of AC9_SCOPED_SKILLS) {
      expect(BUNDLED_GDSKILLS.some((entry) => entry.name === name), name).toBe(true);
    }
  });

  test("none of the 11 rendered core/platform skills echoes its purpose as a bare imperative", () => {
    const offenders = BUNDLED_GDSKILLS.filter(
      (entry) => AC9_SCOPED_SKILLS.includes(entry.name) && echoedImperative.test(entry.description),
    ).map((entry) => entry.name);
    expect(offenders).toEqual([]);
  });
});

describe("AC14: entity-skill-verifier describes only what `keryx skills verify` checks", () => {
  // `keryx skills verify` (src/gdskills/verify.ts) checks required files,
  // SKILL.md metadata, manifest registration, target-path existence, and the
  // presence/validity of gdgraph/gdctx/gdwiki/health/memory evidence — it
  // never reads the skill's prose and diffs it against the code it describes.
  // A "compares"+"claims" sentence in the rendered skill is only honest when
  // it marks that comparison as the agent's manual step, not the command's.
  test("a 'compares' + 'claims' sentence, if present, marks the comparison as a manual agent step", () => {
    const entry = BUNDLED_GDSKILLS.find((skillEntry) => skillEntry.name === "entity-skill-verifier");
    expect(entry).toBeTruthy();
    const rendered = renderBundledSkill(entry!);
    const sentences = rendered.split(/(?<=[.!?])\s+/);
    const claimSentences = sentences.filter((sentence) => /compar\w*/i.test(sentence) && /claims?/i.test(sentence));
    expect(claimSentences.length).toBeGreaterThan(0);
    for (const sentence of claimSentences) {
      expect(sentence, sentence).toMatch(/manual|does not|the command does not do this/i);
    }
  });
});
