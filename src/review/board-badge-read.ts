import type { BadgeCard, BadgeSnapshot } from "./board-badges";
import { boardGraphql } from "./board-github";
import type { WatcherKey } from "./watcher-types";

type Query = <T>(query: string, variables: Record<string, string | number>) => Promise<T>;

/** Resolve repository, account, and access to all requested PRs in the same GitHub read.
 * A caller cannot use guessed numbers or an old private board to read local history. */
export async function readBoardBadges(cwd: string, key: WatcherKey, requested: BadgeCard[],
  attach: (snapshot: BadgeSnapshot) => void, read: Query = (q, vars) => boardGraphql(cwd, q, vars)): Promise<BadgeSnapshot> {
  if (new Set(requested.map(c => c.number)).size !== requested.length || !requested.length || requested.length > 500 || requested.some(c => !Number.isSafeInteger(c.number) || c.number <= 0 || c.number > 2147483647
      || !/^[a-f0-9]{40}$/.test(c.baseSha) || !/^[a-f0-9]{40}$/.test(c.headSha))) {
    throw new Error("configuration: Invalid badge revisions.");
  }
  const [owner, name] = key.repo.split("/") as [string, string];
  const cards = requested.map(({ number, baseSha, headSha }) => ({ number, baseSha, headSha }));
  for (let i = 0; i < cards.length; i += 100) {
    const batch = cards.slice(i, i + 100).map(c => c.number);
    const selection = batch.map(n => `p${n}:pullRequest(number:${n}) { number }`).join("\n");
    type PR = { number: number };
    const data = await read<{viewer?: {login?: string}; repository?: {id: string} & Record<`p${number}`, PR | null>}>(
      `query ReviewBadges($owner:String!, $name:String!) { viewer { login } repository(owner:$owner,name:$name) { id ${selection} } }`, {owner, name});
    if (data.viewer?.login?.toLowerCase() !== key.viewer.toLowerCase() || data.repository?.id !== key.repositoryId)
      throw new Error("access: GitHub account or repository changed. Refresh Review.");
    for (const n of batch) {
      const pr = data.repository[`p${n}`];
      if (pr?.number !== n) throw new Error("access: Pull request access changed. Refresh Review.");
    }
  }
  const snapshot: BadgeSnapshot = { version: 1, viewer: key.viewer, repositoryId: key.repositoryId, cards };
  attach(snapshot);
  return snapshot;
}
