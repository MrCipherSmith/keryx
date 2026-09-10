import { describe, expect, test } from "bun:test";
import { loadSchema, validateJson } from "./contracts";

/**
 * `mode: "analyze"` may not carry a populated `fix`, whichever construct says so.
 *
 * This file exists because of a mistake worth keeping. The rule is stated in
 * the `fix` property's DESCRIPTION — "Present in fix mode only. Null in analyze
 * mode" — and a description is not a constraint. Reading only that, I concluded
 * no validator applied the rule and added an `allOf` conditional to "close the
 * gap", then wrote in the commit that it did.
 *
 * It did not. Twenty lines above the property sits a top-level `if/then/else`:
 * `if mode === "fix"` requires `fix` to be an object, and the `else` branch —
 * which covers analyze — already required it to be null. The rule had been
 * enforced all along. The added conditional changed no behaviour, and the tests
 * shipped with it could not tell: removing it left all sixteen green.
 *
 * So the guard belongs on the RULE, not on the construct that expresses it.
 * This test does not care whether the answer comes from the top-level `else`,
 * from an `allOf` branch, or from something later. It cares that a self-
 * contradictory result is refused, and it fails if whatever currently refuses
 * it is removed — which is the property the redundant conditional's own tests
 * lacked.
 */
const CONFORMING = {
  status: "DONE",
  mode: "analyze",
  pr: "o/r#1",
  head_sha: "0123abcdef0123abcdef0123abcdef0123abcdef",
  collected: 0,
  verdicts: {},
  plan_items: 0,
  summary: "s",
  screen_status: "ran",
  screened: 0,
  excluded_for_injection: [],
  filtered: [],
  fix: null,
} as const;

describe("an analyze-mode result may not report work it did not do", () => {
  test("a populated fix in analyze mode is refused, naming the field", async () => {
    const schema = await loadSchema("review-pr-feedback-output");
    const errors = await validateJson(
      {
        ...CONFORMING,
        fix: {
          flow_id: "244",
          flow_status: "done",
          merged_into: "main",
          operator_confirmed: {
            confirmed_by: "someone",
            confirmed_at: "2026-09-10T00:00:00Z",
            plan_digest: "abc",
          },
        },
      },
      schema,
    );

    // Named, not counted: the point of the rule is which field lied.
    expect(errors.map((error) => error.path)).toContain("$.fix");
  });

  test("`replies` is held to the same rule, which the redundant conditional never covered", async () => {
    // The top-level `else` constrains BOTH `fix` and `replies` to null. The
    // conditional that was added and removed only ever mentioned `fix`, so it
    // could not have replaced this even if it had been load-bearing.
    //
    // The payload is an OBJECT, deliberately. An array would be refused by
    // `replies`' own `type: ["object","null"]` whatever the mode is, and this
    // assertion would then pass with the `else` deleted — which is how the
    // first draft of it was written, and it did exactly that.
    const schema = await loadSchema("review-pr-feedback-output");
    const errors = await validateJson({ ...CONFORMING, replies: { posted: 1 } }, schema);

    expect(errors.map((error) => error.path)).toContain("$.replies");
  });

  test("fix mode still requires the fix object, so the rule is not one-directional", async () => {
    const schema = await loadSchema("review-pr-feedback-output");
    const errors = await validateJson({ ...CONFORMING, mode: "fix", fix: null }, schema);

    expect(errors.length).toBeGreaterThan(0);
  });

  // Anti-vacuity. Every assertion above is a rejection, and a validator broken
  // shut would satisfy all three.
  test("a conforming analyze-mode result is accepted", async () => {
    const schema = await loadSchema("review-pr-feedback-output");
    expect(await validateJson(CONFORMING, schema)).toEqual([]);
  });
});
