import { expect, test } from "bun:test";
import { reviewBoardArgs } from "../../dev/reviewBoard";
import type { ReviewBoardSnapshot, ReviewCard } from "../review/types";
import { collectBoardPages } from "./review";

const card: ReviewCard = { number: 1, title: "PR", url: "", author: "", assignees: [], reviewers: [], decision: null,
  state: "open", draft: false, ci: "none", baseSha: "a", headSha: "b", updatedAt: "now" };
function page(nextCursor: string | null): ReviewBoardSnapshot {
  return { version: 1, repo: "org/repo", repositories: ["org/repo"], repositoryId: "R", viewer: "me", fetchedAt: "now", cards: [card], warnings: [], nextCursor };
}

test("browser host sends scoped badges, page cursors and untouched legacy board calls to the shared CLI", () => {
  const r = "1:"+"a".repeat(40)+":"+"b".repeat(40);
  expect(reviewBoardArgs({repo:"org/repo",badgeTarget:{viewer:"me",repositoryId:"R",revisions:r}}))
    .toEqual(["review","board","--json","--repo","org/repo","--viewer","me","--repository-id","R","--badge-revisions",r]);
  expect(reviewBoardArgs({prState:"open",paged:true,cursor:"-abc"}).slice(-2)).toEqual(["--page","--cursor=-abc"]);
  expect(reviewBoardArgs({prState:"open"})).toEqual(["review","board","--json","--state","open"]);
  expect(() => reviewBoardArgs({repo:"org/repo",number:1,paged:true})).toThrow();
});

test("a board larger than the transport limit combines bounded pages without missing the final PR", async () => {
  const text = "x".repeat(65536);
  let calls = 0;
  const result = await collectBoardPages(async (cursor, repository) => {
    expect(cursor).toBe(calls ? String(calls) : null);
    if (calls) expect(repository).toBe("org/repo");
    const start = calls++ * 100;
    return { ...page(calls < 6 ? String(calls) : null), cards: Array.from({length:100}, (_, n) => ({ ...card, number: start+n+1, title: text })) };
  });
  expect(calls).toBe(6); expect(result.cards.length*text.length).toBeGreaterThan(32*1024*1024);
  expect(result.cards.at(-1)?.number).toBe(600); expect(result.warnings).toEqual([]);
});

test("later page access loss invalidates earlier private cards; a temporary failure or repeated cursor is visibly partial", async () => {
  for (const changed of [{viewer:"other"}, {repositoryId:"another"}]) {
    expect(await collectBoardPages(async cursor => cursor ? {...page(null), ...changed} : page("next")).catch((e: Error) => e.message)).toContain("access:");
  }
  expect(await collectBoardPages(async cursor => { if (cursor) throw Error("access: denied"); return page("next"); }).catch((e: Error) => e.message)).toBe("access: denied");
  const partial = await collectBoardPages(async cursor => { if (cursor) throw Error("unavailable: offline"); return page("next"); });
  expect(partial.cards).toEqual([card]); expect(partial.warnings.length).toBe(1);
  const repeated = await collectBoardPages(async () => page("next"));
  expect(repeated.cards.length).toBe(1); expect(repeated.warnings.length).toBe(1);
});

test("reply hints from the first page apply only to visible open PRs after identity-checked assembly", async () => {
  const result = await collectBoardPages(async cursor => cursor ? { ...page(null), cards: [{...card,number:2}, {...card,number:3,state:"closed"}] } :
    { ...page("next"), replyHints:[{number:2,ids:["reply"]},{number:3,ids:["closed"]},{number:4,ids:["outside"]}] });
  expect(result.cards.map(c => c.addressedReplyIds)).toEqual([undefined,["reply"],undefined]);
  expect(result.replyHints).toBeUndefined();
});

test("one oversized PR reassembles from pinned, escaping-safe frames and a changed revision remains visibly incomplete", async () => {
  const { splitBoardCard, decodeBoardCursor } = await import("../../../../src/review/board-transport");
  const data = {...page(null), cards:[{...card, title:'Big "PR" 😀'.repeat(20), addressedReplyIds:["reply"], localReview:{active:true,ready:false}}]};
  const load = async (cursor: string | null) => splitBoardCard(data, decodeBoardCursor(cursor ?? undefined), 64);
  const all = await collectBoardPages(load);
  expect(all.cards).toEqual(data.cards);
  expect(all.warnings).toEqual([]);
  const changed = await collectBoardPages(async cursor => cursor
    ? splitBoardCard({...data,cards:[{...card, headSha:"new"}]}, decodeBoardCursor(cursor), 64) : load(null));
  expect(changed.cards).toEqual([]); expect(changed.warnings.length).toBeGreaterThan(0);
});
