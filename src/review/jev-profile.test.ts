import { describe, expect, test } from "bun:test";
import { RECOMMENDED_JEV_PROFILE, currentJevProfile, mergeRecommendedJevProfile, renderJevProfileMarkdown } from "./jev-profile";

describe("RECOMMENDED_JEV_PROFILE", () => {
  test("ci_triage, select, and edit_guard are recommended; the rest are not", () => {
    const on = RECOMMENDED_JEV_PROFILE.filter((entry) => entry.recommended).map((entry) => entry.key);
    const off = RECOMMENDED_JEV_PROFILE.filter((entry) => !entry.recommended).map((entry) => entry.key);
    expect(on.sort()).toEqual(["ci_triage", "edit_guard", "select"]);
    expect(off.sort()).toEqual(["comments", "contract", "docs", "risk", "rules", "scenarios"]);
  });
});

describe("mergeRecommendedJevProfile", () => {
  test("writes the recommended booleans into an empty config", () => {
    const merged = mergeRecommendedJevProfile(undefined);
    const jev = currentJevProfile(merged);
    expect(jev.ci_triage).toBe(true);
    expect(jev.select).toBe(true);
    expect(jev.edit_guard).toBe(true);
    expect(jev.risk).toBe(false);
    expect(jev.contract).toBe(false);
    expect(jev.rules).toBe(false);
    expect(jev.scenarios).toBe(false);
    expect(jev.docs).toBe(false);
    expect(jev.comments).toBe(false);
  });

  test("preserves unrelated top-level keys", () => {
    const merged = mergeRecommendedJevProfile({ completion: { require_clean_round: true }, review: { severity_floor: "major" } });
    expect((merged as { completion: unknown }).completion).toEqual({ require_clean_round: true });
    expect((merged.review as { severity_floor: unknown }).severity_floor).toBe("major");
  });

  test("preserves unrelated review.jev.* keys, e.g. a custom select_skip_below", () => {
    const merged = mergeRecommendedJevProfile({ review: { jev: { select_skip_below: 0.3, ac_check: true } } });
    const jev = currentJevProfile(merged);
    expect(jev.select_skip_below).toBe(0.3);
    expect(jev.ac_check).toBe(true);
    expect(jev.select).toBe(true);
  });

  test("overrides a previously-set profile key, e.g. risk explicitly turned off", () => {
    const merged = mergeRecommendedJevProfile({ review: { jev: { risk: true } } });
    expect(currentJevProfile(merged).risk).toBe(false);
  });

  test("tolerates malformed existing content (not an object)", () => {
    const merged = mergeRecommendedJevProfile("not an object");
    expect(currentJevProfile(merged).select).toBe(true);
  });
});

describe("currentJevProfile", () => {
  test("empty object when review.jev is absent or malformed", () => {
    expect(currentJevProfile(undefined)).toEqual({});
    expect(currentJevProfile({})).toEqual({});
    expect(currentJevProfile({ review: "not an object" })).toEqual({});
    expect(currentJevProfile({ review: { jev: "not an object" } })).toEqual({});
  });
});

describe("renderJevProfileMarkdown", () => {
  test("shows current vs recommended and the measured verdict per key", () => {
    const md = renderJevProfileMarkdown({ ci_triage: true }, false);
    expect(md).toContain("ci_triage");
    expect(md).toContain("PROVEN");
    expect(md).toContain("risk");
    expect(md).toContain("largest diff first");
    expect(md).toContain("not modified");
  });

  test("says the profile was applied when applied is true", () => {
    const md = renderJevProfileMarkdown({}, true);
    expect(md).toContain("applied");
  });
});
