// Desktop Review v3 (docs/requirements/keryx-desktop-review-v3/specification.md, «Хранение»): where a pull request's
// review.json lives and what its id is. Portable: the Desktop webview imports this module, so it uses no Node API.

/** The project-relative directory that holds every PR review's own directory. It has no manifest.json, so package scanners skip it. */
export const REVIEW_STATE_DIR = ".metaproject/reviews/pr";
export const REVIEW_STATE_FILE = "review.json";
export const REVIEW_STATE_JOURNAL = "journal.md";

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/**
 * The id of one pull request's review: `<owner>-<name>-<number>`, then the reviewing account when it is known (D3 of
 * Review v2: two accounts are two reviews). Lower case, `[a-z0-9-]` only.
 */
export function reviewStateId(repo: string, number: number, viewer?: string | null): string {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error(`invalid repository "${repo}": expected owner/name`);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`invalid pull request number ${number}`);
  const account = viewer ? slug(viewer) : "";
  return [slug(repo.replace("/", "-")), String(number), ...(account ? [account] : [])].join("-");
}

/** `.metaproject/reviews/pr/<id>`, relative to the project root. */
export function reviewStateRelativeDir(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`invalid review id "${id}"`);
  return `${REVIEW_STATE_DIR}/${id}`;
}

/** The owner/name and number of a github.com pull request URL, or undefined. */
export function parsePullRequestUrl(url: string): { repo: string; number: number } | undefined {
  const match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\/?$/.exec(url.trim());
  if (!match) return undefined;
  const number = Number(match[3]);
  return Number.isSafeInteger(number) && number > 0 ? { repo: `${match[1]}/${match[2]}`, number } : undefined;
}
