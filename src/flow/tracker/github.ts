import type { TrackerAdapter, TrackerRef } from "../types";

// GitHub tracker adapter backed by the `gh` CLI (spec section 10).

async function gh(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { stdout, exitCode };
}

export const githubAdapter: TrackerAdapter = {
  id: "github",

  async detect(): Promise<boolean> {
    if (!Bun.which("gh")) {
      return false;
    }
    try {
      const result = await gh(["auth", "status"]);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  },

  parseRef(input: string): TrackerRef | null {
    const match = input.match(
      /github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/,
    );
    if (!match?.[1] || !match[2]) {
      return null;
    }
    return { repo: match[1], number: Number(match[2]) };
  },

  async fetchIssue(ref: TrackerRef): Promise<{ title: string; body: string } | null> {
    try {
      const result = await gh([
        "issue",
        "view",
        String(ref.number),
        "--repo",
        ref.repo,
        "--json",
        "title,body",
      ]);
      if (result.exitCode !== 0) {
        return null;
      }
      const parsed = JSON.parse(result.stdout) as { title?: string; body?: string };
      return { title: parsed.title ?? "", body: parsed.body ?? "" };
    } catch {
      return null;
    }
  },

  async prStatus(url: string): Promise<{
    exists: boolean;
    isDraft: boolean;
    checksGreen: boolean | null;
    headSha: string | null;
    baseRefName: string | null;
    state: string | null;
  }> {
    try {
      // `headRefOid` is the head COMMIT of the PR branch, which is what the
      // review gate compares a round's SHA against — not `headRefName`, which is
      // a branch name and moves under the round.
      //
      // `baseRefName` IS a branch name, and that is what it is for: the
      // completion gate compares where the merge landed against the base the
      // flow recorded, and both sides of that comparison are names.
      const view = await gh(["pr", "view", url, "--json", "isDraft,state,headRefOid,baseRefName"]);
      if (view.exitCode !== 0) {
        return { exists: false, isDraft: false, checksGreen: null, headSha: null, baseRefName: null, state: null };
      }
      const parsed = JSON.parse(view.stdout) as {
        isDraft?: boolean;
        headRefOid?: string;
        baseRefName?: string;
        state?: string;
      };
      // `gh pr checks` exits 0 when all checks pass, non-zero otherwise.
      const checks = await gh(["pr", "checks", url]);
      return {
        exists: true,
        isDraft: parsed.isDraft === true,
        checksGreen: checks.exitCode === 0,
        // `null`, never `""`: an older `gh` that does not know the field leaves
        // the head UNKNOWN, and the gate must report that rather than compare
        // against an empty string and call it a mismatch.
        headSha: typeof parsed.headRefOid === "string" && parsed.headRefOid !== "" ? parsed.headRefOid : null,
        // `null`, never `""`, for the reason above: an unread base must stay
        // distinguishable from a base that is genuinely empty, because the gate
        // fails differently for the two.
        baseRefName:
          typeof parsed.baseRefName === "string" && parsed.baseRefName !== "" ? parsed.baseRefName : null,
        // Flow 364: `OPEN`, `MERGED` or `CLOSED`; `null` when `gh` did not say, read as unknown.
        state: typeof parsed.state === "string" && parsed.state !== "" ? parsed.state : null,
      };
    } catch {
      return { exists: false, isDraft: false, checksGreen: null, headSha: null, baseRefName: null, state: null };
    }
  },

  async comment(ref: TrackerRef, body: string): Promise<boolean> {
    try {
      const result = await gh([
        "issue",
        "comment",
        String(ref.number),
        "--repo",
        ref.repo,
        "--body",
        body,
      ]);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  },
};

/** The PR's own file list, from GitHub; null when `gh` cannot say. Read by the review readiness checklist. */
export async function githubPrFiles(url: string): Promise<string[] | null> {
  try {
    if (!Bun.which("gh")) return null;
    const result = await gh(["pr", "view", url, "--json", "files", "--jq", ".files[].path"]);
    if (result.exitCode !== 0) return null;
    return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  } catch {
    return null;
  }
}

/** Posts a pull-request review through `gh`; the body travels on stdin, never on the command line. */
export async function githubPostReview(url: string, event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE", body: string): Promise<{ ok: boolean; detail: string }> {
  try {
    if (!Bun.which("gh")) return { ok: false, detail: "gh is not installed" };
    const flag = event === "APPROVE" ? "--approve" : event === "REQUEST_CHANGES" ? "--request-changes" : "--comment";
    const proc = Bun.spawn(["gh", "pr", "review", url, flag, "--body-file", "-"], { stdin: new Blob([body]), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { ok: exitCode === 0, detail: (stderr.trim() || stdout.trim() || `gh exited ${exitCode}`).split("\n")[0]! };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
