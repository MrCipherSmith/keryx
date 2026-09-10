// Where was this supposed to land?
//
// The completion gate's condition 3 already compares CONTENT — is the tree the
// reviewers read the tree that merged — so the canonical wrong-target merge is
// caught before this condition sees it: a branch cut from `feature/x` and
// merged to `main` produces a different tree and is refused.
//
// What content cannot separate is two targets that have CONVERGED. If
// `feature/x` is already in `main`, a squash onto either yields the same tree,
// and nothing recorded which one was meant. `review-pr-feedback --fix` makes
// exactly that shape: it cuts from another pull request's head and must land
// back inside it, or the reviewer's diff is unchanged while the run replies
// "acted-on, fixed in <sha>" to every one of them.
//
// So this condition asks the one question content cannot: not "does the merge
// look right" but "is this where we said it would go".

import { describe, expect, test } from "bun:test";
import { baseBranchCondition } from "./service";

/** A resolver that reports containment without touching git. */
const resolves =
  (contained: boolean) =>
  async (): Promise<boolean | null> =>
    contained;

/** A resolver that cannot see the ref at all — the unobserved case. */
const unresolvable = async (): Promise<boolean | null> => null;

describe("the three states are three", () => {
  // The whole point of AC5. `not recorded` collapsing into `pass` is how a
  // condition stops meaning anything: every flow that never named a base would
  // start reporting that its merge target was verified.
  test("no recorded base is `skipped`, and says it is not a pass", async () => {
    const outcome = await baseBranchCondition("/tmp", {}, "abc1234", undefined, resolves(true));

    expect(outcome.status).toBe("skipped");
    expect(outcome.detail).toContain("not recorded");
    expect(outcome.detail).toContain("Not a pass");
  });

  test("an empty recorded base is treated as not recorded, not as a base named \"\"", async () => {
    const outcome = await baseBranchCondition("/tmp", { baseBranch: "   " }, "abc1234", undefined, resolves(false));
    expect(outcome.status).toBe("skipped");
  });

  test("a recorded base the merge is contained in passes", async () => {
    const outcome = await baseBranchCondition(
      "/tmp",
      { baseBranch: "feature/x" },
      "abc1234",
      undefined,
      resolves(true),
    );

    expect(outcome.status).toBe("pass");
    expect(outcome.detail).toContain("origin/feature/x");
  });

  test("a recorded base the merge is NOT contained in fails, naming both", async () => {
    const outcome = await baseBranchCondition(
      "/tmp",
      { baseBranch: "feature/x" },
      "abc1234",
      undefined,
      resolves(false),
    );

    expect(outcome.status).toBe("fail");
    expect(outcome.detail).toContain("violated");
    // Both sides named: a refusal that says only "wrong branch" sends the
    // reader to find out which two branches it meant.
    expect(outcome.detail).toContain("feature/x");
    expect(outcome.detail).toContain("abc1234");
  });
});

describe("a base that cannot be resolved does not pass", () => {
  test("an unresolvable ref reports unobserved AND fails", async () => {
    const outcome = await baseBranchCondition(
      "/tmp",
      { baseBranch: "feature/x" },
      "abc1234",
      undefined,
      unresolvable,
    );

    // Both halves matter. A condition nobody could observe has not passed —
    // that is the module's rule — and reporting it as `skipped` would put it
    // in the same bucket as "no base recorded", which is a different fact.
    expect(outcome.status).toBe("fail");
    expect(outcome.detail).toContain("unobserved");
  });

  test("the unobserved message names the remedy, not the flow", async () => {
    const outcome = await baseBranchCondition(
      "/tmp",
      { baseBranch: "release/2" },
      "abc1234",
      undefined,
      unresolvable,
    );

    // The operator can act on "fetch the remote". They cannot act on "the gate
    // failed", which is what this message used to be worth avoiding.
    expect(outcome.detail).toContain("git fetch origin release/2");
  });
});

describe("without a merge commit, the pull request's base is the evidence", () => {
  test("a PR still targeting the recorded base passes", async () => {
    const outcome = await baseBranchCondition("/tmp", { baseBranch: "main" }, undefined, "main", resolves(true));
    expect(outcome.status).toBe("pass");
  });

  test("a retargeted PR fails, which is why the base is stored rather than read live", async () => {
    // Deriving the base from the PR at completion time would compare it with
    // itself and always pass. The recorded intent is the whole value.
    const outcome = await baseBranchCondition(
      "/tmp",
      { baseBranch: "feature/x" },
      undefined,
      "main",
      resolves(true),
    );

    expect(outcome.status).toBe("fail");
    expect(outcome.detail).toContain("retargeted");
    expect(outcome.detail).toContain("feature/x");
    expect(outcome.detail).toContain("main");
  });

  test("a tracker that reports no base at all is unobserved, not a match", async () => {
    const outcome = await baseBranchCondition("/tmp", { baseBranch: "main" }, undefined, null, resolves(true));

    expect(outcome.status).toBe("fail");
    expect(outcome.detail).toContain("unobserved");
  });
});
