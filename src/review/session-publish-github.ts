// The session publish path's GitHub port (flow 521 T7). Like Desktop it posts through the reviews API, so the review is
// pinned to `commit_id` and GitHub's answer carries the review's URL for the receipt; a lost response is told apart from
// a certain refusal, and the duplicate marker is looked up among the viewer's reviews of the pull request.

import { parseGhJson } from "./pr-comments";
import type { PostResult, ReviewEvent } from "./publish";

const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/** `owner/name` and the number of a GitHub pull request URL, or undefined for anything else. */
export function pullRequestPath(url: string): { repo: string; number: number } | undefined {
  const match = PR_URL.exec(url.trim());
  return match ? { repo: match[1]!, number: Number(match[2]) } : undefined;
}

type GhRun = (args: string[], stdin?: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const runGh: GhRun = async (args, stdin) => {
  const proc = Bun.spawn(["gh", ...args], { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
};

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** POST one pull request review. `uncertain` is set when the request may have reached GitHub and its answer was lost. */
export async function githubPostPullReview(ref: string, event: ReviewEvent, body: string, commitId?: string, gh: GhRun = runGh): Promise<PostResult> {
  const pr = pullRequestPath(ref);
  if (pr === undefined) return { ok: false, detail: `not a GitHub pull request URL: ${ref}` };
  if (gh === runGh && !Bun.which("gh")) return { ok: false, detail: "gh is not installed" };
  const payload = JSON.stringify({ event, body, ...(commitId === undefined ? {} : { commit_id: commitId }) });
  let result: Awaited<ReturnType<GhRun>>;
  try {
    result = await gh(["api", "--hostname", "github.com", "-X", "POST", `repos/${pr.repo}/pulls/${pr.number}/reviews`, "--input", "-"], payload);
  } catch (error) {
    // gh did not start: nothing reached GitHub.
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  if (result.exitCode !== 0) {
    // GitHub answered with a refusal only when gh reports a 4xx status; anything else may have landed.
    const status = /\(HTTP (4\d\d)\)/.exec(result.stderr)?.[1];
    const detail = status === undefined ? `gh exited ${result.exitCode}` : `HTTP ${status}`;
    return status === undefined ? { ok: false, detail, uncertain: true } : { ok: false, detail };
  }
  let posted: Record<string, unknown> | undefined;
  try {
    posted = object(JSON.parse(result.stdout));
  } catch {
    posted = undefined;
  }
  const url = typeof posted?.html_url === "string" && posted.html_url.startsWith("https://github.com/") ? posted.html_url : undefined;
  return { ok: true, detail: "posted", ...(url === undefined ? {} : { url }) };
}

/**
 * The URL of the viewer's review of `ref` whose body carries `marker`; undefined when none does; null when GitHub could
 * not be read, so the caller cannot tell.
 */
export async function githubFindPublished(ref: string, marker: string, gh: GhRun = runGh): Promise<string | undefined | null> {
  const pr = pullRequestPath(ref);
  if (pr === undefined || (gh === runGh && !Bun.which("gh"))) return null;
  try {
    const viewer = await gh(["api", "--hostname", "github.com", "user", "--jq", ".login"]);
    const login = viewer.stdout.trim().toLowerCase();
    if (viewer.exitCode !== 0 || login === "") return null;
    const reviews = await gh(["api", "--hostname", "github.com", "--paginate", `repos/${pr.repo}/pulls/${pr.number}/reviews?per_page=100`]);
    if (reviews.exitCode !== 0) return null;
    const data = parseGhJson(reviews.stdout);
    if (!Array.isArray(data)) return null;
    for (const item of data) {
      const row = object(item);
      const author = object(row?.user)?.login;
      if (typeof author === "string" && author.toLowerCase() === login && typeof row?.body === "string" && row.body.includes(marker)) {
        return typeof row.html_url === "string" ? row.html_url : `https://github.com/${pr.repo}/pull/${pr.number}`;
      }
    }
    return undefined;
  } catch {
    return null;
  }
}
