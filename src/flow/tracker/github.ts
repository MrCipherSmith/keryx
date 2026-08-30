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
  }> {
    try {
      // `headRefOid` is the head COMMIT of the PR branch, which is what the
      // review gate compares a round's SHA against — not `headRefName`, which is
      // a branch name and moves under the round.
      const view = await gh(["pr", "view", url, "--json", "isDraft,state,headRefOid"]);
      if (view.exitCode !== 0) {
        return { exists: false, isDraft: false, checksGreen: null, headSha: null };
      }
      const parsed = JSON.parse(view.stdout) as { isDraft?: boolean; headRefOid?: string };
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
      };
    } catch {
      return { exists: false, isDraft: false, checksGreen: null, headSha: null };
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
