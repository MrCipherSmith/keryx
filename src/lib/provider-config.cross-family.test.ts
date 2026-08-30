// Flow 207, AC9-AC11 — cross-family review.
//
// The three criteria are three different failure modes, and each has its own
// block below:
//
//   AC9  — the decision reads the EXISTING provider configuration. A second
//          registry would be a second truth, and the two would disagree the
//          first time somebody edited one.
//   AC10 — opt-in and recorded. The dangerous default is not "wrong answer", it
//          is "correct answer nobody chose": tokens spent and the operator's
//          code sent to a second vendor because a flag defaulted to true.
//   AC11 — one configured vendor is a NORMAL state. It degrades to
//          single-family with a stated reason, and it exits 0.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MODEL_FAMILY_HINTS,
  crossFamilyCandidates,
  decideCrossFamilyReview,
  familyOf,
  llmProvidersConfigPath,
} from "./provider-config";
import { configuredProviders, renderCrossFamilyDecision } from "../commands/providers";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "keryx-cross-family-"));
}

const ANTHROPIC_SESSION = { providerId: "anthropic", modelId: "claude-opus-5" };

describe("family classification names vendors, never models", () => {
  test("a provider id carrying a vendor word is classified", () => {
    expect(familyOf("anthropic")).toBe("anthropic");
    expect(familyOf("openai")).toBe("openai");
    expect(familyOf("deepseek")).toBe("deepseek");
    expect(familyOf("zai-coding")).toBe("zhipu");
    expect(familyOf("grok")).toBe("xai");
  });

  test("a model id carrying a vendor word is classified", () => {
    expect(familyOf("claude-opus-5")).toBe("anthropic");
    expect(familyOf("openai/gpt-4o-mini")).toBe("openai");
    expect(familyOf("google/gemini-2.0-flash-001")).toBe("google");
    expect(familyOf("meta-llama/llama-3.1-8b-instruct")).toBe("meta");
  });

  test("a gateway or local runner is NOT a family", () => {
    // The refusal that makes the record trustworthy. Calling `openrouter` a
    // family would let a round be recorded as cross-family while both sides ran
    // the same vendor, which corrupts exactly the comparison this exists for.
    for (const id of ["openrouter", "groq", "cerebras", "ollama", "rapid-mlx"]) {
      expect(familyOf(id)).toBeNull();
    }
  });

  test("an ambiguous id is refused rather than guessed", () => {
    // Two vendor words, no answer. Picking one would be folklore.
    expect(familyOf("claude-via-openai-proxy")).toBeNull();
    expect(familyOf("")).toBeNull();
    expect(familyOf("   ")).toBeNull();
  });

  test("every hint states which vendor word it is and why", () => {
    // `note` is written for whoever edits the list next, and a field nothing
    // reads is a field that rots. Asserted rather than trusted.
    expect(MODEL_FAMILY_HINTS.length).toBeGreaterThan(0);
    for (const hint of MODEL_FAMILY_HINTS) {
      expect(() => new RegExp(hint.pattern, "i")).not.toThrow();
      expect(hint.family).toMatch(/^[a-z]+$/);
      expect(hint.note.trim().length).toBeGreaterThan(0);
    }
  });

  test("a malformed hint degrades to less knowledge, never to a throw", () => {
    const broken = [...MODEL_FAMILY_HINTS, { pattern: "([", family: "nonsense", note: "unparseable" }];
    expect(familyOf("claude-opus-5", broken)).toBe("anthropic");
  });
});

describe("AC9: the decision reads the existing provider configuration", () => {
  test("a custom provider written to llm-providers.json becomes a candidate", () => {
    const dir = tempDir();
    writeFileSync(
      llmProvidersConfigPath(dir),
      JSON.stringify({
        schemaVersion: 1,
        providers: {
          "internal-gpt": {
            name: "internal-gpt",
            baseUrl: "http://10.0.0.5:8080",
            models: ["gpt-oss-120b"],
          },
        },
      }),
    );

    // `configuredProviders` is the only assembler, and it filters
    // `allOpenAiCompatProviders()` — built-ins plus this same file's loader.
    // Nothing else in the tree enumerates providers for this decision.
    const configured = configuredProviders({}, dir);
    expect(configured.map((provider) => provider.name)).toContain("internal-gpt");

    const decision = decideCrossFamilyReview({
      optIn: true,
      session: ANTHROPIC_SESSION,
      configured,
    });
    expect(decision.mode).toBe("cross-family");
    expect(decision.reviewer_provider).toBe("internal-gpt");
    expect(decision.reviewer_family).toBe("openai");
  });

  test("a built-in with no credential is an offer, not a configuration", () => {
    // `OPENAI_COMPAT_PROVIDERS` is a picker menu. Counting an unkeyed entry
    // would report a second family that cannot actually be reached.
    const dir = tempDir();
    const withoutKeys = configuredProviders({}, dir).map((provider) => provider.name);
    expect(withoutKeys).not.toContain("deepseek");

    const withKey = configuredProviders({ DEEPSEEK_API_KEY: "sk-test" }, dir).map((p) => p.name);
    expect(withKey).toContain("deepseek");
  });
});

describe("AC10: cross-family review is opt-in and recorded", () => {
  test("without opt-in the answer is single-family, whatever is configured", () => {
    const decision = decideCrossFamilyReview({
      optIn: false,
      session: ANTHROPIC_SESSION,
      configured: [{ name: "openai", models: ["gpt-5.2"] }, { name: "deepseek", models: ["deepseek-chat"] }],
    });
    expect(decision.mode).toBe("single-family");
    expect(decision.requested).toBe(false);
    expect(decision.reviewer_provider).toBeNull();
    expect(decision.reason).toContain("was not requested");
    expect(decision.reason).toContain("sends the change to a second vendor");
    // The options are still recorded: "we did not do this, and here is what we
    // declined" is a different fact from "there was nothing to do".
    expect(decision.candidates.map((candidate) => candidate.family).sort()).toEqual(["deepseek", "openai"]);
  });

  test("the round's record names both families, so a recall comparison is possible later", () => {
    const decision = decideCrossFamilyReview({
      optIn: true,
      session: ANTHROPIC_SESSION,
      configured: [{ name: "openai", models: ["gpt-5.2"] }],
    });
    expect(decision).toMatchObject({
      schemaVersion: 1,
      mode: "cross-family",
      requested: true,
      author_family: "anthropic",
      reviewer_family: "openai",
      reviewer_provider: "openai",
    });
    // Serialisable verbatim — the pipeline embeds this, it does not re-derive it.
    expect(JSON.parse(JSON.stringify(decision))).toEqual(decision as unknown as never);
    expect(decision.reason).toContain("authored on anthropic");
    expect(decision.reason).toContain("reviewed on openai");
  });

  test("a gateway contributes its models, never itself, as the reviewing family", () => {
    const decision = decideCrossFamilyReview({
      optIn: true,
      session: ANTHROPIC_SESSION,
      configured: [{ name: "openrouter", models: ["anthropic/claude-haiku-5", "openai/gpt-4o-mini"] }],
    });
    expect(decision.mode).toBe("cross-family");
    expect(decision.reviewer_provider).toBe("openrouter");
    expect(decision.reviewer_family).toBe("openai");
    expect(decision.reviewer_model).toBe("openai/gpt-4o-mini");
    // The same-family model the gateway also offers is never a candidate.
    expect(decision.candidates.map((candidate) => candidate.model)).toEqual(["openai/gpt-4o-mini"]);
  });

  test("the author's own family is never proposed as the reviewer", () => {
    const candidates = crossFamilyCandidates(
      [{ name: "anthropic", models: ["claude-opus-5"] }, { name: "openai", models: [] }],
      "anthropic",
    );
    expect(candidates.map((candidate) => candidate.family)).toEqual(["openai"]);
  });
});

describe("AC11: no second provider is a normal state", () => {
  test("nothing configured degrades to single-family with a stated reason", () => {
    const decision = decideCrossFamilyReview({
      optIn: true,
      session: ANTHROPIC_SESSION,
      configured: [],
    });
    expect(decision.mode).toBe("single-family");
    expect(decision.requested).toBe(true);
    expect(decision.reason).toContain("no provider is configured beyond the anthropic session");
    expect(decision.reason).toContain("normal state, not a failure");
  });

  test("only same-family providers configured degrades with a different, specific reason", () => {
    const decision = decideCrossFamilyReview({
      optIn: true,
      session: ANTHROPIC_SESSION,
      configured: [{ name: "anthropic", models: ["claude-haiku-5"] }],
    });
    expect(decision.mode).toBe("single-family");
    expect(decision.reason).toContain("none of the 1 configured provider(s) resolves to a family other than anthropic");
  });

  test("an unclassifiable session refuses to claim a difference", () => {
    // Not the same as "no second provider", and the reason says so. Without an
    // author family, no candidate can be called DIFFERENT from it.
    const decision = decideCrossFamilyReview({
      optIn: true,
      session: { providerId: "ollama", modelId: "internal-build-42" },
      configured: [{ name: "openai", models: ["gpt-5.2"] }],
    });
    expect(decision.mode).toBe("single-family");
    expect(decision.author_family).toBeNull();
    expect(decision.reason).toContain("carry no vendor marker the hints recognise");
  });

  test("every path states a reason and none throws", () => {
    const inputs = [
      { optIn: false, session: ANTHROPIC_SESSION, configured: [] },
      { optIn: true, session: { providerId: "", modelId: "" }, configured: [] },
      { optIn: true, session: ANTHROPIC_SESSION, configured: [{ name: "openrouter" }] },
      { optIn: true, session: ANTHROPIC_SESSION, configured: [{ name: "openai", models: ["gpt-5.2"] }] },
    ];
    for (const input of inputs) {
      const decision = decideCrossFamilyReview(input);
      expect(decision.reason.trim().length).toBeGreaterThan(0);
      expect(renderCrossFamilyDecision(decision)).toContain("reason: ");
    }
  });
});
