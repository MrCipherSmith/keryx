import path from "node:path";
import { parseProjectPr } from "./pr-context";

export const DESK_RELATED_PRS = "KERYX_DESK_RELATED_PRS";

type PullLink = { repo: string; number: number };
export type RelatedReviewPull = PullLink & ({ head: string } | { unavailable: true });

export function linkedReviewPulls(body: string, subject: PullLink): PullLink[] {
  const owner = subject.repo.split("/")[0]?.toLowerCase();
  const found = new Map<string, PullLink>();
  // Read explicit pull request links from the description only. Do not follow a
  // link to another organization, or recursively follow a dependency's links.
  const links = /https:\/\/github\.com\/([\w-]+\/[\w.-]+)\/pull\/([1-9]\d*)(?=$|[\s).#?\]>,;\x60])|(?<![\w./-])([\w-]+\/[\w.-]+)#([1-9]\d*)\b/gi;
  for (const link of body.matchAll(links)) {
    const repo = link[1] ?? link[3];
    const number = link[2] ?? link[4];
    const parsed = parseProjectPr(`https://github.com/${repo}/pull/${number}`);
    if (!parsed || parsed.repo.split("/")[0] !== owner || [".", ".."].includes(parsed.repo.split("/")[1]!) ||
        (parsed.repo === subject.repo.toLowerCase() && parsed.number === subject.number)) continue;
    found.set(relatedPullKey(parsed), parsed);
    if (found.size === 6) break;
  }
  return [...found.values()];
}

export function relatedPullKey(pull: PullLink): string {
  return `${pull.repo.toLowerCase()}#${pull.number}`;
}

export function relatedPullGitDir(checkout: string, pull: PullLink): string {
  return path.join(checkout, ".git", "keryx-related", ...pull.repo.split("/"), String(pull.number));
}

export function deskRelatedPulls(env: NodeJS.ProcessEnv = process.env): RelatedReviewPull[] {
  try {
    const values = JSON.parse(env[DESK_RELATED_PRS] ?? "[]") as RelatedReviewPull[];
    return values.filter(value =>
      value && /^[\w-]+\/[\w.-]+$/.test(value.repo) && ![".", ".."].includes(value.repo.split("/")[1]!) &&
      Number.isSafeInteger(value.number) && value.number > 0 &&
      ("head" in value ? /^[0-9a-f]{40}$/.test(value.head) : value.unavailable === true),
    ).slice(0, 6);
  } catch {
    return [];
  }
}
