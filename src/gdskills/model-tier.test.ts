// Flow 204, T19-T22 / AC14-AC17.
//
// Five things are under test, and the order below is the order they matter in:
//
//   1. AC15 — the fallback. When the models discovered at runtime cannot be
//      ranked, EVERY tier keeps the session's provider and model, the dispatch
//      succeeds, and nothing is downgraded. Tested twice: directly against the
//      resolver, and end-to-end through `resolveChildModel`, which is the thing
//      that would actually have denied the dispatch.
//   2. Discovery and ranking — the candidate set comes from an INJECTED
//      detection result, never from a table in the module. A source-text guard
//      asserts no model id can creep back into the resolution code.
//   3. AC16 — tier assignment is deterministic from signals and carries its own
//      audit trail. Every row of specification §4.4 has a case, plus the
//      interactions between rows, plus a determinism check.
//   4. AC14 — no skill names a concrete model. Derived from the filesystem, so a
//      skill added later is in the denominator without anyone updating a list.
//   5. AC17 — the rewritten rule, in both trees, describes discovery.
//
// Every catalogue below is a literal in THIS file. Nothing here probes a machine,
// opens a socket, or reads a provider's environment: `rankDiscoveredModels` takes
// the catalogue as an argument precisely so the tests can be offline and exact.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadSchema, validateJson } from "./contracts";
import {
  assignTier,
  buildTierMap,
  concreteModelDeclarations,
  decideDispatchModel,
  DEFAULT_MODEL_TIER,
  isModelTier,
  MODEL_RANK_HINTS,
  MODEL_TIERS,
  parseModelTier,
  parseSkillModelTier,
  rankDiscoveredModels,
  rankModelId,
  resolveTierFromRanking,
  resolveTierModel,
  SKILL_TIER_KEY,
  type DiscoveredProvider,
  type SessionModelContext,
} from "./model-tier";
import { resolveChildModel } from "../harness/child/model";
import type { PolicyProfile } from "../harness/policy/types";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const BUNDLED_SKILLS = path.join(import.meta.dir, "bundled", "skills");
const INSTALLED_SKILLS = path.join(REPO_ROOT, ".metaproject", "skills", "gdskills");

/**
 * A detection result shaped exactly like `detectProviders()`'s: the anthropic
 * entry mirrors `ANTHROPIC_MODELS` in src/commands/select.ts, `fake` is always
 * offered. Reproduced here rather than imported, because the point of the design
 * is that the resolver knows none of these ids — a test that imported them would
 * be testing the wrong thing.
 */
const CATALOG: readonly DiscoveredProvider[] = [
  { name: "anthropic", models: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"] },
  { name: "fake", models: ["fake-echo"] },
];

/** Session on the middle model of a catalogue with one above and one below it. */
const CLAUDE_SESSION: SessionModelContext = { providerId: "anthropic", modelId: "claude-sonnet-5" };

/**
 * A provider whose model ids are CODENAMES. Nothing in a codename says how
 * capable the model is, so this is the case the design refuses to guess at — and
 * the case the previous, table-driven version answered with an ordering taken
 * from one conversation.
 */
const CODENAME_CATALOG: readonly DiscoveredProvider[] = [
  { name: "openai", models: ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"] },
];
const CODENAME_SESSION: SessionModelContext = { providerId: "openai", modelId: "gpt-5.6-terra" };

/**
 * A provider that is real, credentialed and absent from the catalogue entirely.
 * Not a fake id: `zai` is in `OPENAI_COMPAT_PROVIDERS`, so it passes the harness
 * gates and the ONLY reason a dispatch on it could fail is this feature.
 */
const UNKNOWN_SESSION: SessionModelContext = { providerId: "zai", modelId: "glm-5.2" };

describe("tier vocabulary", () => {
  test("the three tiers are the vocabulary, ascending", () => {
    expect(MODEL_TIERS).toEqual(["light", "standard", "deep"]);
    expect(DEFAULT_MODEL_TIER).toBe("standard");
  });

  test("parseModelTier normalises case and whitespace and reads the frozen `cheap` spelling", () => {
    expect(parseModelTier(" Deep ")).toBe("deep");
    expect(parseModelTier("LIGHT")).toBe("light");
    // docs/requirements/keryx-multi-agent-engine/schemas/child-model-selection.schema.json
    // froze cheap/standard/deep before this package named the light tier.
    expect(parseModelTier("cheap")).toBe("light");
  });

  test("a model name is not a tier", () => {
    for (const notATier of ["claude-opus-5", "sonnet", "gpt-5.2-codex", "terra", "", undefined, null]) {
      expect(parseModelTier(notATier as string | undefined)).toBeUndefined();
    }
    expect(isModelTier("opus")).toBe(false);
  });

  test("an inherited Object.prototype key is not a tier either", () => {
    // Read through a bare object literal, `aliases["constructor"]` returns the
    // Object constructor and `aliases["toString"]` a method — neither is
    // `undefined`, the only value the callers treat as "not a tier". That cost
    // two real failures at once: `concreteModelDeclarations` accepted a SKILL.md
    // declaring `model_tier: constructor` as compliant, bypassing the AC14 build
    // guard, and `resolveTierFromRanking` — seeing a value that is neither
    // undefined nor `standard` nor `deep` — took the `light` branch and silently
    // DOWNGRADED the dispatch, the one outcome this module exists to prevent.
    for (const inherited of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", "prototype"]) {
      expect(parseModelTier(inherited)).toBeUndefined();
      expect(parseModelTier(inherited.toUpperCase())).toBeUndefined();
      // The AC14 guard has to fail such a declaration, not wave it through.
      expect(concreteModelDeclarations(`---\n${SKILL_TIER_KEY}: ${inherited}\n---\n`)).toHaveLength(1);
    }
    // …and the resolver must not read it as a downgrade.
    const resolved = resolveTierModel(CLAUDE_SESSION, "constructor", CATALOG);
    expect(resolved.modelId).toBe(CLAUDE_SESSION.modelId);
    expect(resolved.source).toBe("session-fallback");
  });
});

describe("the module holds no model ids — the candidate set is discovered", () => {
  test("no model-id-shaped literal survives in the resolution code", () => {
    // The regression this exists to catch is the previous design coming back: a
    // literal table of model names, correct on the day it was written and stale
    // the day a provider ships anything. Comments are stripped, because the
    // header MUST be free to explain what was removed.
    const source = readFileSync(path.join(import.meta.dir, "model-tier.ts"), "utf8");
    const code = source
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    for (const shape of [
      /claude-[a-z0-9]/i,
      /\bgpt-\d/i,
      /gemini-\d/i,
      /\bglm-\d/i,
      /\bllama\d/i,
      // The three ids the rejected table asserted, named so their return is loud.
      /\bfable\b/i,
      /\bterra\b/i,
      /\bsol\b/i,
    ]) {
      expect(code).not.toMatch(shape);
    }
  });

  test("every hint is a word pattern, not a model id", () => {
    // A hint that named a model would defeat the whole design while looking like
    // configuration. `\b…\b` around a bare alphabetic word is the shape that
    // cannot name one.
    expect(MODEL_RANK_HINTS.length).toBeGreaterThan(0);
    for (const hint of MODEL_RANK_HINTS) {
      expect(hint.pattern).toMatch(/^\\b[a-z]+\\b$/);
      expect(hint.note.length).toBeGreaterThan(0);
      expect(Number.isInteger(hint.weight)).toBe(true);
    }
  });
});

describe("ranking: size words applied to whatever was discovered", () => {
  test("a size word ranks; a codename does not, and unranked is not zero", () => {
    expect(rankModelId("claude-haiku-4-5")).toBeLessThan(0);
    expect(rankModelId("claude-opus-4-8")).toBeGreaterThan(0);
    // Ranked AND middling — distinct from "cannot be placed", which is the
    // distinction the whole fallback rests on.
    expect(rankModelId("claude-sonnet-5")).toBe(0);
    expect(rankModelId("gpt-5.6-terra")).toBeUndefined();
    expect(rankModelId("")).toBeUndefined();
  });

  test("a vendor the hints have never seen is still ranked when its names carry size words", () => {
    expect(rankModelId("qwen-3-max")).toBeGreaterThan(rankModelId("qwen-3-mini")!);
  });

  test("opposing size words land between them rather than picking a side", () => {
    expect(rankModelId("some-mini-pro")).toBe(0);
  });

  test("a malformed hint is skipped, not thrown", () => {
    const hints = [{ pattern: "(", weight: 5, note: "broken" }, ...MODEL_RANK_HINTS];
    expect(() => rankModelId("claude-opus-4-8", hints)).not.toThrow();
    expect(rankModelId("claude-opus-4-8", hints)).toBe(rankModelId("claude-opus-4-8"));
  });

  test("candidates keep discovery order, de-duplicate, and unrankable ones are omitted from the order", () => {
    const ranking = rankDiscoveredModels(
      { providerId: "p", modelId: "p-medium" },
      [{ name: "p", models: ["p-mini", "p-mini", " ", "p-codename", "p-max"] }],
    );
    expect(ranking.usable).toBe(true);
    expect(ranking.candidates).toEqual(["p-mini", "p-codename", "p-max"]);
    expect(ranking.ranked.map((m) => m.modelId)).toEqual(["p-max", "p-mini"]);
    expect(ranking.sessionRank).toBe(0);
    expect(ranking.fallbackReason).toBeNull();
  });

  test("equal ranks keep discovery order, so the choice is deterministic", () => {
    const catalog = [{ name: "p", models: ["alpha-pro", "beta-pro", "gamma-mini"] }];
    const session = { providerId: "p", modelId: "delta-medium" };
    expect(resolveTierModel(session, "deep", catalog).modelId).toBe("alpha-pro");
    expect(resolveTierModel(session, "light", catalog).modelId).toBe("gamma-mini");
  });

  test("provider matching is case- and whitespace-insensitive", () => {
    const ranking = rankDiscoveredModels(
      { providerId: " Anthropic ", modelId: "claude-sonnet-5" },
      CATALOG,
    );
    expect(ranking.usable).toBe(true);
    expect(ranking.candidates).toHaveLength(3);
  });
});

describe("AC15: resolution against a ranked catalogue, and the three outcomes", () => {
  test("deep and light take DISCOVERED models; standard is the session's own", () => {
    const deep = resolveTierModel(CLAUDE_SESSION, "deep", CATALOG);
    expect(deep.modelId).toBe("claude-opus-4-8");
    expect(deep.source).toBe("discovered");

    const light = resolveTierModel(CLAUDE_SESSION, "light", CATALOG);
    expect(light.modelId).toBe("claude-haiku-4-5");
    expect(light.source).toBe("discovered");

    const standard = resolveTierModel(CLAUDE_SESSION, "standard", CATALOG);
    expect(standard.modelId).toBe(CLAUDE_SESSION.modelId);
    expect(standard.source).toBe("session-ranked");

    // Candidates come from the session provider's OWN catalogue, so the provider
    // is never changed and the result is one `resolveChildModel` gate G1 admits.
    for (const r of [deep, light, standard]) expect(r.providerId).toBe(CLAUDE_SESSION.providerId);
  });

  test("a tier with nothing discovered in its direction is session-RANKED, not a fallback", () => {
    // Session already at the top of the catalogue: `deep` cannot improve on it,
    // and saying so is a different fact from "we could not work it out".
    const top: SessionModelContext = { providerId: "anthropic", modelId: "claude-opus-4-8" };
    const deep = resolveTierModel(top, "deep", CATALOG);
    expect(deep.modelId).toBe(top.modelId);
    expect(deep.source).toBe("session-ranked");
    expect(deep.ranking.usable).toBe(true);
    expect(deep.ranking.fallbackReason).toBeNull();

    const bottom: SessionModelContext = { providerId: "anthropic", modelId: "claude-haiku-4-5" };
    const light = resolveTierModel(bottom, "light", CATALOG);
    expect(light.modelId).toBe(bottom.modelId);
    expect(light.source).toBe("session-ranked");
  });

  test("a model at the SESSION's own rank is never taken — no lateral moves", () => {
    // Two equally-ranked models and a session on one of them: `deep` must not
    // swap to the sibling, because nothing says it is better.
    const catalog = [{ name: "p", models: ["p-pro", "p-large"] }];
    const resolved = resolveTierModel({ providerId: "p", modelId: "p-pro" }, "deep", catalog);
    expect(resolved.modelId).toBe("p-pro");
    expect(resolved.source).toBe("session-ranked");
  });

  test("nothing discovered: EVERY tier keeps the session model — no downgrade", () => {
    for (const tier of MODEL_TIERS) {
      const resolved = resolveTierModel(UNKNOWN_SESSION, tier, CATALOG);
      expect(resolved.providerId).toBe(UNKNOWN_SESSION.providerId);
      expect(resolved.modelId).toBe(UNKNOWN_SESSION.modelId);
      expect(resolved.source).toBe("session-fallback");
      expect(resolved.tier).toBe(tier);
      expect(resolved.ranking.fallbackReason).toContain(UNKNOWN_SESSION.providerId);
    }
    // The failure mode this guards: `light` quietly becoming something cheaper
    // than the session model because discovery failed.
    const map = buildTierMap(UNKNOWN_SESSION, CATALOG);
    expect(new Set(Object.values(map).map((s) => s.modelId))).toEqual(new Set([UNKNOWN_SESSION.modelId]));
  });

  test("codenames cannot be ordered, so a codename session falls back rather than guessing", () => {
    const map = buildTierMap(CODENAME_SESSION, CODENAME_CATALOG);
    expect(new Set(Object.values(map).map((s) => s.modelId))).toEqual(new Set([CODENAME_SESSION.modelId]));
    const light = resolveTierModel(CODENAME_SESSION, "light", CODENAME_CATALOG);
    expect(light.source).toBe("session-fallback");
    // The candidates WERE discovered — the record must show what was on the table
    // when the ordering was refused, not an empty list.
    expect(light.ranking.candidates).toEqual(["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(light.ranking.ranked).toEqual([]);
    expect(light.ranking.sessionRank).toBeNull();
    expect(light.ranking.fallbackReason).toContain("size marker");
  });

  test("an unrankable SESSION model falls back even when the candidates rank fine", () => {
    // The anchor is the point: without knowing where the session sits, `light`
    // could pick something larger and `deep` something smaller.
    const session: SessionModelContext = { providerId: "anthropic", modelId: "claude-codename-9" };
    const ranking = rankDiscoveredModels(session, CATALOG);
    expect(ranking.usable).toBe(false);
    expect(ranking.ranked.length).toBeGreaterThan(0);
    expect(resolveTierFromRanking(session, "deep", ranking).modelId).toBe(session.modelId);
    expect(resolveTierFromRanking(session, "deep", ranking).source).toBe("session-fallback");
  });

  test("an empty catalogue, a blank session model, and a model-less provider each refuse", () => {
    expect(rankDiscoveredModels(CLAUDE_SESSION, []).fallbackReason).toContain("no discovered provider");
    expect(rankDiscoveredModels({ providerId: "anthropic", modelId: "  " }, CATALOG).fallbackReason).toContain(
      "no model",
    );
    expect(
      rankDiscoveredModels(CLAUDE_SESSION, [{ name: "anthropic", models: [] }]).fallbackReason,
    ).toContain("reported no models");
    // The default catalogue is EMPTY: a caller that discovers nothing gets the
    // safe direction rather than a built-in list.
    expect(resolveTierModel(CLAUDE_SESSION, "deep").source).toBe("session-fallback");
  });

  test("a tier string that is not a tier falls back instead of guessing", () => {
    const resolved = resolveTierModel(CLAUDE_SESSION, "claude-opus-4-8", CATALOG);
    expect(resolved.source).toBe("session-fallback");
    expect(resolved.modelId).toBe(CLAUDE_SESSION.modelId);
    expect(resolved.tier).toBe("standard");
  });

  test("a ranking with no session rank is a fallback, never an anchor at rank 0", () => {
    // `resolveTierFromRanking` is EXPORTED and takes an arbitrary `ModelRanking`.
    // The previous `sessionRank ?? 0` invented rank 0 for this input, which places
    // `light` below zero and `deep` above it rather than below and above the
    // SESSION — so `light` could pick a model larger than the session's, which is
    // exactly the downgrade-by-accident the anchoring exists to prevent.
    const anchorless = {
      providerId: "p",
      candidates: ["p-mini", "p-max"],
      ranked: [
        { modelId: "p-max", rank: 1 },
        { modelId: "p-mini", rank: -1 },
      ],
      sessionRank: null,
      usable: true,
      fallbackReason: null,
    };
    const session: SessionModelContext = { providerId: "p", modelId: "p-codename" };
    for (const tier of MODEL_TIERS) {
      const resolved = resolveTierFromRanking(session, tier, anchorless);
      expect(resolved.modelId).toBe(session.modelId);
      expect(resolved.providerId).toBe(session.providerId);
      expect(resolved.source).toBe("session-fallback");
      expect(resolved.tier).toBe(tier);
    }
    // The specific wrong answer: `light` must not reach for the ranked-below
    // candidate, since "below rank 0" says nothing about "below the session".
    expect(resolveTierFromRanking(session, "light", anchorless).modelId).not.toBe("p-mini");
  });

  test("buildTierMap is total over the tier vocabulary, rankable or not", () => {
    for (const [session, catalog] of [
      [CLAUDE_SESSION, CATALOG],
      [CODENAME_SESSION, CODENAME_CATALOG],
      [UNKNOWN_SESSION, CATALOG],
    ] as const) {
      const map = buildTierMap(session, catalog);
      for (const tier of [...MODEL_TIERS, "cheap"]) {
        expect(map[tier]).toBeDefined();
      }
    }
  });

  test("resolution is deterministic — same session and catalogue, same answer", () => {
    const first = buildTierMap(CLAUDE_SESSION, CATALOG);
    for (let i = 0; i < 5; i += 1) expect(buildTierMap(CLAUDE_SESSION, CATALOG)).toEqual(first);
  });
});

describe("AC15: an unrankable environment does not fail the dispatch that runs it", () => {
  // The claim is about `resolveChildModel`, not about this module: that is the
  // function which denies `unknown model tier` and which every child dispatch goes
  // through. Feeding it a `buildTierMap` for an undiscoverable provider is the
  // whole mechanism, end to end.
  const policy: PolicyProfile = {
    trustMode: "trusted-local",
    defaults: { read: "allow", write: "allow", shell: "allow", network: "allow", delegate: "allow" },
  } as unknown as PolicyProfile;

  const deps = (session: SessionModelContext, catalog: readonly DiscoveredProvider[]) => ({
    allowedProviders: new Set([session.providerId]),
    tiers: buildTierMap(session, catalog),
    policy,
    providerClass: () => "network" as const,
  });

  test("every tier resolves, and resolves to the session model", () => {
    for (const tier of MODEL_TIERS) {
      const result = resolveChildModel(
        { providerId: UNKNOWN_SESSION.providerId, modelId: UNKNOWN_SESSION.modelId },
        { kind: "tier", tier },
        deps(UNKNOWN_SESSION, CATALOG),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.selection).toEqual({
          providerId: UNKNOWN_SESSION.providerId,
          modelId: UNKNOWN_SESSION.modelId,
        });
      }
    }
  });

  test("without buildTierMap the same dispatch is denied — the mechanism is load-bearing", () => {
    const { tiers: _omitted, ...withoutMap } = deps(UNKNOWN_SESSION, CATALOG);
    const result = resolveChildModel(
      { providerId: UNKNOWN_SESSION.providerId, modelId: UNKNOWN_SESSION.modelId },
      { kind: "tier", tier: "deep" },
      withoutMap,
    );
    expect(result.ok).toBe(false);
  });

  test("a discovered model still resolves through the same seam", () => {
    const result = resolveChildModel(
      { providerId: CLAUDE_SESSION.providerId, modelId: CLAUDE_SESSION.modelId },
      { kind: "tier", tier: "deep" },
      deps(CLAUDE_SESSION, CATALOG),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.selection.modelId).toBe("claude-opus-4-8");
  });
});

describe("AC16: tier assignment is deterministic from signals the orchestrator holds", () => {
  test("no signals means the documented default, not a guess", () => {
    expect(assignTier({})).toEqual({ tier: "standard", reasons: ["base:standard"] });
  });

  test("blast-radius scope floors at deep", () => {
    const out = assignTier({ scope: "blast-radius" });
    expect(out.tier).toBe("deep");
    expect(out.reasons).toContain("floor:blast-radius");
  });

  test("a second attempt at the same finding raises one tier", () => {
    expect(assignTier({ fixAttempt: 1 }).tier).toBe("standard");
    expect(assignTier({ fixAttempt: 2 }).tier).toBe("deep");
    expect(assignTier({ fixAttempt: 2 }).reasons).toContain("raise:fix-attempt");
    // Already at the top: recorded as capped rather than silently dropped.
    expect(assignTier({ scope: "blast-radius", fixAttempt: 3 }).reasons).toContain("raise:fix-attempt-capped");
  });

  test("a forced strategy change after the loop cap is deep", () => {
    expect(assignTier({ forcedStrategyChange: true }).tier).toBe("deep");
  });

  test("few findings and a small diff allow light", () => {
    expect(assignTier({ findingCount: 3, diffLines: 50 }).tier).toBe("light");
    expect(assignTier({ findingCount: 4, diffLines: 50 }).tier).toBe("standard");
    expect(assignTier({ findingCount: 3, diffLines: 51 }).tier).toBe("standard");
    // One half of the condition is not the condition.
    expect(assignTier({ findingCount: 1 }).tier).toBe("standard");
  });

  test("verification that runs something is light; verification that only reasons is not", () => {
    expect(assignTier({ verifierMethod: "execution" }).tier).toBe("light");
    expect(assignTier({ verifierMethod: "site-check" }).tier).toBe("light");
    expect(assignTier({ verifierMethod: "reasoning" }).tier).toBe("standard");
  });

  test("a security finding never runs below standard", () => {
    const out = assignTier({ verifierMethod: "execution", hasSecurityFinding: true });
    expect(out.tier).toBe("standard");
    expect(out.reasons).toContain("floor:security");
    // …and it is a floor, not a ceiling.
    expect(assignTier({ scope: "blast-radius", hasSecurityFinding: true }).tier).toBe("deep");
  });

  test("a floor beats a downgrade: a blast-radius round over a tiny diff is still deep", () => {
    const out = assignTier({ scope: "blast-radius", findingCount: 1, diffLines: 10, verifierMethod: "execution" });
    expect(out.tier).toBe("deep");
    expect(out.reasons).toEqual(["base:standard", "light:verifier-execution", "floor:blast-radius"]);
  });

  test("the same signals always produce the same tier and the same audit trail", () => {
    const signals = {
      scope: "diff",
      fixAttempt: 2,
      findingCount: 2,
      diffLines: 20,
      verifierMethod: "reasoning",
      hasSecurityFinding: false,
    };
    const first = assignTier(signals);
    for (let i = 0; i < 5; i += 1) expect(assignTier(signals)).toEqual(first);
    expect(first).toEqual({
      tier: "standard",
      reasons: ["base:standard", "light:small-scope", "raise:fix-attempt"],
    });
    // The two light rules are exclusive by construction: the verifier method is
    // the stronger statement (it says where the evidence comes from), so it is
    // read first and the size heuristic is not also recorded.
    expect(assignTier({ ...signals, verifierMethod: "execution" }).reasons).toEqual([
      "base:standard",
      "light:verifier-execution",
      "raise:fix-attempt",
    ]);
  });

  test("the decision is recorded on the dispatch and validates against the contract", async () => {
    const decision = decideDispatchModel(CLAUDE_SESSION, { scope: "blast-radius" }, CATALOG);
    expect(decision).toEqual({
      tier: "deep",
      tier_reasons: ["base:standard", "floor:blast-radius"],
      provider: "anthropic",
      model: "claude-opus-4-8",
      tier_resolution: "discovered",
      model_discovery: {
        provider: "anthropic",
        candidates: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"],
        ranked: [
          { model: "claude-opus-4-8", rank: 1 },
          { model: "claude-sonnet-5", rank: 0 },
          { model: "claude-haiku-4-5", rank: -1 },
        ],
        session_rank: 0,
        fallback_reason: null,
      },
    });

    const schema = await loadSchema("subagent-dispatch");
    const dispatch = {
      contract_version: "1.0.0",
      run_id: "r1",
      dispatch_id: "d1",
      orchestrator: "review-orchestrator",
      target_skill: "review-logic",
      task: { title: "t", description: "d" },
      acceptance_criteria: ["AC16"],
      context_refs: [],
      files_to_read: [],
      constraints: [],
      allowed_actions: ["read"],
      output_contract: { schema: "subagent-result", artifact_path: "a.json" },
      budget: {},
      model: decision,
      provenance: { created_at: "2026-08-30T00:00:00Z", created_by: "test" },
    };
    expect(await validateJson(dispatch, schema)).toEqual([]);
  });

  test("the record distinguishes a fallback from an assignment that landed on the same model", () => {
    // Three outcomes, three records. `model` alone is identical in the last two,
    // which is exactly why `tier_resolution` and `model_discovery` exist.
    const assigned = decideDispatchModel(CLAUDE_SESSION, { scope: "blast-radius" }, CATALOG);
    expect(assigned.tier_resolution).toBe("discovered");

    const rankedToSession = decideDispatchModel(
      { providerId: "anthropic", modelId: "claude-opus-4-8" },
      { scope: "blast-radius" },
      CATALOG,
    );
    expect(rankedToSession.tier_resolution).toBe("session-ranked");
    expect(rankedToSession.model).toBe("claude-opus-4-8");
    expect(rankedToSession.model_discovery.fallback_reason).toBeNull();
    expect(rankedToSession.model_discovery.session_rank).toBe(1);

    const fellBack = decideDispatchModel(CODENAME_SESSION, { scope: "blast-radius" }, CODENAME_CATALOG);
    expect(fellBack.tier_resolution).toBe("session-fallback");
    expect(fellBack.model).toBe(CODENAME_SESSION.modelId);
    expect(fellBack.model_discovery.fallback_reason).toContain("size marker");
    // Same model, different fact — the pair that would be indistinguishable if
    // the two session outcomes were collapsed into one.
    expect(fellBack.model_discovery.candidates).toEqual(["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"]);
  });

  test("a fallback record also validates against the contract", async () => {
    const schema = await loadSchema("subagent-dispatch");
    const dispatch = {
      contract_version: "1.0.0",
      run_id: "r1",
      dispatch_id: "d2",
      orchestrator: "review-orchestrator",
      target_skill: "review-logic",
      task: { title: "t", description: "d" },
      acceptance_criteria: ["AC15"],
      context_refs: [],
      files_to_read: [],
      constraints: [],
      allowed_actions: ["read"],
      output_contract: { schema: "subagent-result", artifact_path: "a.json" },
      budget: {},
      model: decideDispatchModel(UNKNOWN_SESSION, {}, CATALOG),
      provenance: { created_at: "2026-08-30T00:00:00Z", created_by: "test" },
    };
    expect(await validateJson(dispatch, schema)).toEqual([]);
  });

  test("the contract refuses a model name in the tier field", async () => {
    const schema = await loadSchema("subagent-dispatch");
    const base = {
      contract_version: "1.0.0",
      run_id: "r1",
      dispatch_id: "d1",
      orchestrator: "o",
      target_skill: "s",
      task: { title: "t", description: "d" },
      acceptance_criteria: ["AC14"],
      context_refs: [],
      files_to_read: [],
      constraints: [],
      allowed_actions: ["read"],
      output_contract: { schema: "subagent-result", artifact_path: "a.json" },
      budget: {},
      provenance: { created_at: "2026-08-30T00:00:00Z", created_by: "test" },
    };
    expect(await validateJson({ ...base, model: { tier: "claude-opus-5" } }, schema)).not.toEqual([]);
    expect(await validateJson({ ...base, model: { tier: "deep" } }, schema)).toEqual([]);
  });
});

describe("AC14: skills declare a tier, never a model name", () => {
  function skillFiles(root: string): string[] {
    if (!existsSync(root)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name === "SKILL.md") out.push(path.join(entry.parentPath ?? root, entry.name));
    }
    return out;
  }

  test("the bundled skill tree exists and is the denominator", () => {
    // Guards the guard: an empty sweep would pass every assertion below.
    expect(skillFiles(BUNDLED_SKILLS).length).toBeGreaterThan(20);
  });

  test("no bundled skill declares a concrete model", () => {
    const offenders: string[] = [];
    for (const file of skillFiles(BUNDLED_SKILLS)) {
      for (const line of concreteModelDeclarations(readFileSync(file, "utf8"))) {
        offenders.push(`${path.relative(BUNDLED_SKILLS, file)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no installed skill declares a concrete model either", () => {
    // The same guard the bundled sweep gets, for the same reason. `skillFiles`
    // returns `[]` for a root that is not there, so without this the sweep would
    // report "no offenders" for a tree that does not exist — a guard passing
    // vacuously is the shape this flow found five times over.
    expect(skillFiles(INSTALLED_SKILLS).length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of skillFiles(INSTALLED_SKILLS)) {
      for (const line of concreteModelDeclarations(readFileSync(file, "utf8"))) {
        offenders.push(`${path.relative(INSTALLED_SKILLS, file)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the detector fails a skill that names a model, in frontmatter or in a dispatch block", () => {
    // The negative case, so the sweeps above cannot pass by matching nothing.
    expect(concreteModelDeclarations(`---\nname: x\nmodel: claude-opus-5\n---\n`)).toHaveLength(1);
    expect(concreteModelDeclarations(`  "model": "gpt-5.2-codex",`)).toHaveLength(1);
    expect(concreteModelDeclarations(`---\n${SKILL_TIER_KEY}: opus\n---\n`)).toHaveLength(1);
    // …and passes the forms that name nothing concrete.
    expect(concreteModelDeclarations(`---\n${SKILL_TIER_KEY}: deep\n---\n`)).toEqual([]);
    expect(concreteModelDeclarations(`  "model": null,`)).toEqual([]);
    expect(concreteModelDeclarations(`  model: <model-id>`)).toEqual([]);
    // Prose that MENTIONS a model is not a declaration; a guard that could not
    // tell them apart would be routed around on its first false positive.
    expect(concreteModelDeclarations("so `review-logic (sonnet)` still parses")).toEqual([]);
  });

  test("skills that declare a tier declare one of the three, and it round-trips", () => {
    const declared: Record<string, string> = {};
    for (const file of skillFiles(BUNDLED_SKILLS)) {
      const tier = parseSkillModelTier(readFileSync(file, "utf8"));
      if (tier !== undefined) declared[path.basename(path.dirname(file))] = tier;
    }
    expect(Object.keys(declared).length).toBeGreaterThan(0);
    for (const tier of Object.values(declared)) expect(MODEL_TIERS).toContain(tier as never);
  });
});

describe("AC17: the model-selection rule permits adaptive selection", () => {
  const RULE = path.join("rules", "core", "model-selection.mdc");
  const trees = [
    path.join(import.meta.dir, "bundled", RULE),
    path.join(REPO_ROOT, ".metaproject", RULE),
  ];

  test("both trees carry the rule and are byte-identical", () => {
    const texts = trees.map((file) => readFileSync(file, "utf8"));
    expect(texts[0]).toBe(texts[1]!);
  });

  test("it no longer requires asking the user per dispatch, and no longer names stale models", () => {
    for (const file of trees) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/Always ask user before changing model/i);
      // The Codex ids that no longer match the environment.
      expect(text).not.toMatch(/gpt-5\.\d(?:-codex)?(?:-max|-mini)?/);
      expect(text).toContain(SKILL_TIER_KEY);
      for (const tier of MODEL_TIERS) expect(text).toContain(`\`${tier}\``);
    }
  });

  test("it describes discovery, not a table, and names the three outcomes", () => {
    for (const file of trees) {
      const text = readFileSync(file, "utf8");
      // The rejected design, and the sentence that replaced it.
      expect(text).not.toMatch(/PROVIDER_FAMILIES|provider family|family table/i);
      expect(text).toMatch(/\*\*no table of models\*\*/i);
      expect(text).toContain("MODEL_RANK_HINTS");
      expect(text).toContain("DetectedProvider");
      for (const outcome of ["discovered", "session-ranked", "session-fallback"]) {
        expect(text).toContain(outcome);
      }
      // Model ids in the rule are the same mistake as model ids in the code.
      expect(text).not.toMatch(/\bfable\b|\bterra\b|\bsol\b|claude-[a-z0-9]/i);
    }
  });
});

test("a catalogue nothing can rank is a fallback, not a ranking that found nothing above", () => {
  // Observed live: the session ran a model whose id carries a size word while
  // every candidate the provider reported carried none. `ranked` was empty, yet
  // each tier resolved through the "no model ranks above/below" branch and
  // recorded `session-ranked` — a claim that the ranking worked. The model chosen
  // was right either way; the RECORD was wrong, and the record is the entire
  // point of `tier_resolution`.
  const catalog = [{ name: "acme", models: ["acme-reasoner", "acme-chat"] }];
  const session = { providerId: "acme", modelId: "acme-v4-flash" };
  const ranking = rankDiscoveredModels(session, catalog);

  expect(ranking.ranked).toHaveLength(0);
  expect(ranking.usable).toBe(false);
  expect(ranking.fallbackReason).toContain("size marker");

  for (const tier of MODEL_TIERS) {
    const resolved = resolveTierModel(session, tier, catalog);
    expect(resolved.source).toBe("session-fallback");
    // The safe outcome was never in doubt — only whether the record said why.
    expect(resolved.modelId).toBe("acme-v4-flash");
  }

  // Non-vacuity: one rankable candidate and the ranking is usable again.
  const withOne = rankDiscoveredModels(session, [{ name: "acme", models: ["acme-chat", "acme-opus"] }]);
  expect(withOne.usable).toBe(true);
  expect(withOne.ranked).toHaveLength(1);
});
