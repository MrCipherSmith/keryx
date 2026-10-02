// Flow 389 (AC2): where the digest gets the flow board from.
//
// The board is the product index. The product module is derived, disposable data with a
// narrow door: only `keryx product`, the TUI surface and the shell that opens it import it,
// and only the product command reads its data directory (flow 362). The digest is none of
// those, so it does not import the module. It asks a reader the product command registers
// (`registerBoardReader`, called by the CLI registry), and it describes what it
// needs from the board in its own terms: items to diff, and the closed-but-unchecked chains.
// With no reader registered the board is simply unavailable, and the digest says so.

import type { DigestFailure } from "./digest-content";
import type { DigestItem } from "./digest-snapshot";

/** One "PR merged, flow closed, effect not checked" entry: the fields the digest prints. */
export interface DigestChain {
  readonly id: string;
  readonly title: string;
  readonly closedAt: string | null;
  /** The criterion, or the literal text saying none is stated. */
  readonly outcome: string;
  readonly hasCriterion: boolean;
}

/** What a board reader hands over: the board as the product index states it, in plain fields. */
export type BoardSource =
  | { readonly state: "absent" }
  | { readonly state: "malformed"; readonly reason: string }
  | {
      readonly state: "present";
      readonly entries: readonly { readonly id: string; readonly title: string; readonly status: string; readonly closedAt: string | null; readonly verdict: string }[];
      readonly chains: readonly DigestChain[];
      /** Why the index no longer matches the flows on disk, when it does not. */
      readonly staleReason?: string;
    };

export type BoardReader = (projectRoot: string) => Promise<BoardSource>;

export interface BoardRead {
  readonly items: readonly DigestItem[];
  readonly chains: readonly DigestChain[];
  readonly failure?: DigestFailure;
  readonly note?: string;
}

/** The diff identity of a board entry: its status, closing date and verdict. */
export function boardItems(entries: readonly { id: string; status: string; closedAt: string | null; verdict: string; title: string }[]): DigestItem[] {
  return entries.map((e) => ({ key: `board:${e.id}`, kind: "board" as const, id: e.id, title: e.title, stamp: `${e.status}|${e.closedAt ?? ""}|${e.verdict}` }));
}

let registered: BoardReader | undefined;

/** The CLI registry calls this once, with the product command's reader. */
export function registerBoardReader(reader: BoardReader | undefined): void {
  registered = reader;
}

export async function readBoard(projectRoot: string): Promise<BoardRead> {
  if (registered === undefined) {
    return { items: [], chains: [], failure: { source: "board", detail: "the flow board is not available in this process" } };
  }
  const read = await registered(projectRoot);
  if (read.state === "absent") {
    return { items: [], chains: [], failure: { source: "board", detail: "no product index — run `keryx product index` to build it" } };
  }
  if (read.state === "malformed") {
    return { items: [], chains: [], failure: { source: "board", detail: `the product index is unreadable: ${read.reason}` } };
  }
  return {
    items: boardItems(read.entries),
    chains: read.chains,
    ...(read.staleReason !== undefined ? { note: `the product index is stale (${read.staleReason})` } : {}),
  };
}
