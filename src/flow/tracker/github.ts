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
  }> {
    try {
      const view = await gh(["pr", "view", url, "--json", "isDraft,state"]);
      if (view.exitCode !== 0) {
        return { exists: false, isDraft: false, checksGreen: null };
      }
      const parsed = JSON.parse(view.stdout) as { isDraft?: boolean };
      // `gh pr checks` exits 0 when all checks pass, non-zero otherwise.
      const checks = await gh(["pr", "checks", url]);
      return {
        exists: true,
        isDraft: parsed.isDraft === true,
        checksGreen: checks.exitCode === 0,
      };
    } catch {
      return { exists: false, isDraft: false, checksGreen: null };
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
