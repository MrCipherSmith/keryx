// Flow 521 T7: the session publish path's GitHub port, driven through a fake `gh`.
import { describe, expect, test } from "bun:test";
import { githubFindPublished, githubPostPullReview, githubReviewedHeadInPull, pullRequestPath } from "./session-publish-github";

const PR = "https://github.com/org/repo/pull/12";
type Call = { args: string[]; stdin?: string | undefined };

function fakeGh(answers: Array<{ stdout?: string; stderr?: string; exitCode?: number } | Error>) {
  const calls: Call[] = [];
  let index = 0;
  const gh = async (args: string[], stdin?: string) => {
    calls.push({ args, stdin });
    const answer = answers[Math.min(index++, answers.length - 1)]!;
    if (answer instanceof Error) throw answer;
    return { stdout: answer.stdout ?? "", stderr: answer.stderr ?? "", exitCode: answer.exitCode ?? 0 };
  };
  return { calls, gh };
}

describe("session publish GitHub port", () => {
  test("a pull request URL gives its repository and number; anything else gives nothing", () => {
    expect(pullRequestPath(PR)).toEqual({ repo: "org/repo", number: 12 });
    expect(pullRequestPath(`${PR}/files`)).toEqual({ repo: "org/repo", number: 12 });
    expect(pullRequestPath("https://example.com/org/repo/pull/12")).toBeUndefined();
  });

  test("the review is posted through the reviews API, pinned to commit_id, and its URL comes back", async () => {
    const { calls, gh } = fakeGh([{ stdout: JSON.stringify({ id: 5, html_url: `${PR}#pullrequestreview-5` }) }]);
    const result = await githubPostPullReview(PR, "COMMENT", "body", "a".repeat(40), gh);
    expect(result).toEqual({ ok: true, detail: "posted", url: `${PR}#pullrequestreview-5` });
    expect(calls[0]!.args).toEqual(["api", "--hostname", "github.com", "-X", "POST", "repos/org/repo/pulls/12/reviews", "--input", "-"]);
    expect(JSON.parse(calls[0]!.stdin!)).toEqual({ event: "COMMENT", body: "body", commit_id: "a".repeat(40) });
  });

  test("a 4xx answer is a certain refusal; any other failure may have landed", async () => {
    expect(await githubPostPullReview(PR, "APPROVE", "b", undefined, fakeGh([{ exitCode: 1, stderr: "gh: Unprocessable (HTTP 422)" }]).gh))
      .toEqual({ ok: false, detail: "HTTP 422" });
    expect(await githubPostPullReview(PR, "APPROVE", "b", undefined, fakeGh([{ exitCode: 1, stderr: "connection reset" }]).gh))
      .toEqual({ ok: false, detail: "gh exited 1", uncertain: true });
    expect((await githubPostPullReview(PR, "APPROVE", "b", undefined, fakeGh([new Error("spawn failed")]).gh)).uncertain).toBeUndefined();
  });

  test("the marker is found only in a review by the same viewer; an unreadable list says it cannot tell", async () => {
    const marker = "<!-- keryx-desktop-review r#r1 -->";
    const reviews = [
      { user: { login: "someone" }, body: `x ${marker}`, html_url: `${PR}#pullrequestreview-1` },
      { user: { login: "Me" }, body: `y ${marker}`, html_url: `${PR}#pullrequestreview-2` },
    ];
    expect(await githubFindPublished(PR, marker, fakeGh([{ stdout: "me\n" }, { stdout: JSON.stringify(reviews) }]).gh)).toBe(`${PR}#pullrequestreview-2`);
    expect(await githubFindPublished(PR, marker, fakeGh([{ stdout: "other\n" }, { stdout: JSON.stringify(reviews.slice(1)) }]).gh)).toBeUndefined();
    expect(await githubFindPublished(PR, marker, fakeGh([{ stdout: "me\n" }, { exitCode: 1 }]).gh)).toBeNull();
  });

  test("without html_url the review's URL is built from its id; without either there is none", async () => {
    expect(await githubPostPullReview(PR, "COMMENT", "b", undefined, fakeGh([{ stdout: JSON.stringify({ id: 9 }) }]).gh))
      .toEqual({ ok: true, detail: "posted", url: `${PR}#pullrequestreview-9` });
    expect(await githubPostPullReview(PR, "COMMENT", "b", undefined, fakeGh([{ stdout: "{}" }]).gh)).toEqual({ ok: true, detail: "posted" });
  });

  test("the reviewed commit is in the pull request only when GitHub reports the current head ahead of it", async () => {
    const a = "a".repeat(40), c = "c".repeat(40);
    const ahead = fakeGh([{ stdout: "ahead\n" }]);
    expect(await githubReviewedHeadInPull(PR, a, c, ahead.gh)).toBe("yes");
    expect(ahead.calls[0]!.args).toEqual(["api", "--hostname", "github.com", `repos/org/repo/compare/${a}...${c}?per_page=1`, "--jq", ".status"]);
    for (const answer of [{ stdout: "diverged\n" }, { stdout: "behind\n" }]) {
      expect(await githubReviewedHeadInPull(PR, a, c, fakeGh([answer]).gh)).toBe("no");
    }
    // A failed or unreadable answer is not evidence of a force-push.
    for (const answer of [{ exitCode: 1 }, { stdout: "something else\n" }]) {
      expect(await githubReviewedHeadInPull(PR, a, c, fakeGh([answer]).gh)).toBe("unknown");
    }
    expect(await githubReviewedHeadInPull(PR, a, c, fakeGh([new Error("spawn failed")]).gh)).toBe("unknown");
    expect(await githubReviewedHeadInPull(PR, "short", c, fakeGh([{ stdout: "ahead" }]).gh)).toBe("unknown");
    // A ref the compare API cannot address is left to GitHub's own commit_id check.
    expect(await githubReviewedHeadInPull("123", a, c, fakeGh([{ stdout: "ahead" }]).gh)).toBe("skip");
  });
});
