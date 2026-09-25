// flow 332 (AC3/AC4/AC8): pure-function tests for `jev-scenarios.ts` —
// scenario extraction (wiki/PRD/README), fact gathering (touched links,
// nearby test), budget selection, the manual-check list and finding
// synthesis. Hermetic: no I/O, no network, no client import (core module).

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_JEV_SCENARIOS_THRESHOLD,
  DEFAULT_MAX_JEV_SCENARIO_CALLS,
  batchScenarioQuestions,
  buildScenarioChecklist,
  computeScenarioFacts,
  scenarioFromWikiPage,
  scenariosFromPrd,
  scenariosFromReadmeLike,
  scoreScenario,
  selectScenarios,
  synthesizeScenarioFindings,
  type ScenarioFacts,
  type ScenarioSource,
  type ScoredScenario,
} from "./jev-scenarios";

describe("scenarioFromWikiPage", () => {
  test("title from frontmatter, links from markdown links and code spans", () => {
    const content = [
      "---",
      "title: Sign in with a saved credential",
      "---",
      "",
      "# Sign in",
      "",
      "See [the auth module](../../../src/harness/decision/jev-client.ts) and `src/commands/providers.ts`.",
    ].join("\n");
    const scenario = scenarioFromWikiPage(".metaproject/wiki/user-scenarios/sign-in.md", content);
    expect(scenario.kind).toBe("wiki");
    expect(scenario.title).toBe("Sign in with a saved credential");
    expect(scenario.links).toContain("src/harness/decision/jev-client.ts");
    expect(scenario.links).toContain("src/commands/providers.ts");
  });

  test("no frontmatter title: falls back to the first heading", () => {
    const scenario = scenarioFromWikiPage(".metaproject/wiki/user-scenarios/x.md", "# A Scenario\n\nSome text.");
    expect(scenario.title).toBe("A Scenario");
  });
});

describe("scenariosFromPrd", () => {
  test("splits sections whose heading names scenario/requirement/user story/use case", () => {
    const content = [
      "# PRD",
      "",
      "## Background",
      "",
      "Not a scenario section.",
      "",
      "## Scenario: reconnect a provider",
      "",
      "Touches `src/commands/providers.ts`.",
      "",
      "## Requirement 3",
      "",
      "Touches `src/harness/decision/jev-client.ts`.",
    ].join("\n");
    const scenarios = scenariosFromPrd("docs/requirements/x/prd.md", content);
    expect(scenarios).toHaveLength(2);
    expect(scenarios[0]!.title).toBe("Scenario: reconnect a provider");
    expect(scenarios[0]!.links).toEqual(["src/commands/providers.ts"]);
    expect(scenarios[1]!.title).toBe("Requirement 3");
  });

  test("no matching heading: no scenarios", () => {
    expect(scenariosFromPrd("docs/requirements/x/prd.md", "# PRD\n\n## Background\n\ntext")).toEqual([]);
  });
});

describe("scenariosFromReadmeLike", () => {
  test("splits how-to-shaped sections", () => {
    const content = ["# README", "", "## How to connect a provider", "", "Run `src/commands/providers.ts`.", "", "## License", "", "MIT."].join("\n");
    const scenarios = scenariosFromReadmeLike("README.md", content);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]!.title).toBe("How to connect a provider");
    expect(scenarios[0]!.links).toEqual(["src/commands/providers.ts"]);
  });
});

function scenario(overrides: Partial<ScenarioSource> = {}): ScenarioSource {
  return {
    id: ".metaproject/wiki/user-scenarios/sign-in.md",
    kind: "wiki",
    path: ".metaproject/wiki/user-scenarios/sign-in.md",
    title: "Sign in",
    text: "A user signs in with a saved credential.",
    links: ["src/harness/decision/jev-client.ts", "src/commands/providers.ts"],
    ...overrides,
  };
}

describe("computeScenarioFacts", () => {
  test("touchedLinks is the intersection with allChangedFiles", () => {
    const facts = computeScenarioFacts(scenario(), ["src/commands/providers.ts", "src/unrelated.ts"]);
    expect(facts.touchedLinks).toEqual(["src/commands/providers.ts"]);
    expect(facts.hasTouchedLink).toBe(true);
  });

  test("no touched link: hasTouchedLink is false", () => {
    const facts = computeScenarioFacts(scenario(), ["src/unrelated.ts"]);
    expect(facts.hasTouchedLink).toBe(false);
    expect(facts.touchedLinks).toEqual([]);
  });

  test("hasNearbyTest true when a test file touches a touched link's module", () => {
    const facts = computeScenarioFacts(scenario(), ["src/commands/providers.ts", "src/commands/providers.test.ts"]);
    expect(facts.hasNearbyTest).toBe(true);
  });

  test("hasNearbyTest false when no test covers any touched link", () => {
    const facts = computeScenarioFacts(scenario(), ["src/commands/providers.ts"]);
    expect(facts.hasNearbyTest).toBe(false);
  });
});

describe("batchScenarioQuestions", () => {
  test("one question per scenario, keyed by scenario id", () => {
    const facts = computeScenarioFacts(scenario(), ["src/commands/providers.ts"]);
    const batches = batchScenarioQuestions([facts]);
    expect(batches).toHaveLength(1);
    expect(Object.keys(batches[0]!.questions)).toEqual([scenario().id]);
  });
});

describe("selectScenarios", () => {
  test("only scenarios with a touched link are candidates; the rest are notApplicable", () => {
    const withLink = computeScenarioFacts(scenario(), ["src/commands/providers.ts"]);
    const without = computeScenarioFacts(scenario({ id: "b", links: ["src/other.ts"] }), ["src/commands/providers.ts"]);
    const selection = selectScenarios([withLink, without]);
    expect(selection.selected).toEqual([withLink]);
    expect(selection.notApplicable).toEqual([without]);
  });

  test("caps at maxCalls, in id order, reporting the rest as skipped", () => {
    const facts = ["b", "a", "c"].map((id) => computeScenarioFacts(scenario({ id, links: ["src/commands/providers.ts"] }), ["src/commands/providers.ts"]));
    const selection = selectScenarios(facts, 2);
    expect(selection.selected.map((f) => f.scenario.id)).toEqual(["a", "b"]);
    expect(selection.skipped.map((f) => f.scenario.id)).toEqual(["c"]);
  });

  test("default budget", () => {
    expect(selectScenarios([]).maxCalls).toBe(DEFAULT_MAX_JEV_SCENARIO_CALLS);
  });
});

function scored(overrides: Partial<ScenarioFacts> = {}, probability = 0.9): ScoredScenario {
  const facts = computeScenarioFacts(scenario(), ["src/commands/providers.ts"]);
  return scoreScenario({ ...facts, ...overrides }, { noul: probability });
}

describe("buildScenarioChecklist / synthesizeScenarioFindings", () => {
  test("checklist lists every scenario at/above threshold, ranked", () => {
    const high = scored({}, 0.9);
    const low = scored({ scenario: scenario({ id: "low" }) }, 0.2);
    const checklist = buildScenarioChecklist([high, low], DEFAULT_JEV_SCENARIOS_THRESHOLD);
    expect(checklist).toHaveLength(1);
    expect(checklist[0]!.id).toBe(scenario().id);
    expect(checklist[0]!.touchedLinks).toEqual(["src/commands/providers.ts"]);
  });

  test("a finding fires only above threshold AND with no covering test", () => {
    const noTest = scored({ hasNearbyTest: false }, 0.9);
    const findings = synthesizeScenarioFindings([noTest], DEFAULT_JEV_SCENARIOS_THRESHOLD);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("minor");
    expect(findings[0]!.reviewer).toBe("review-jev-scenarios");
  });

  test("no finding when a covering test exists, even above threshold", () => {
    const withTest = scored({ hasNearbyTest: true }, 0.9);
    expect(synthesizeScenarioFindings([withTest], DEFAULT_JEV_SCENARIOS_THRESHOLD)).toEqual([]);
  });

  test("no finding below threshold", () => {
    const belowThreshold = scored({ hasNearbyTest: false }, 0.3);
    expect(synthesizeScenarioFindings([belowThreshold], DEFAULT_JEV_SCENARIOS_THRESHOLD)).toEqual([]);
  });
});
