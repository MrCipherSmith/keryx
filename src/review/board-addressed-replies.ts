import type { ReviewBoardSnapshot } from "./board-types";

// The notification feed narrows work to unread PRs. A notification alone does not imply a direct reply.
interface Notice { repository: { node_id: string }; subject: { type: string; url: string }; last_read_at: string | null }
interface Comment { node_id: string; id: number; user: { login: string } | null; body: string; created_at: string; in_reply_to_id?: number }
type Read = <T>(endpoint: string, timeoutMs: number) => Promise<T>;

export function mentionsViewer(body: string, viewer: string): boolean {
  return [...body.matchAll(/(?:^|[^\w@/])@([a-z\d-]+)(?![a-z\d/-])/gi)]
    .some(match => match[1]?.toLowerCase() === viewer.toLowerCase());
}

export async function attachAddressedReplies(snapshot: ReviewBoardSnapshot, read: Read, includeLaterPages = false): Promise<void> {
  const cards = new Map(snapshot.cards.filter(c => c.state === "open").map(c => [c.number, c]));
  if (!cards.size && !includeLaterPages) return;
  const repo = "repos/" + snapshot.repo;
  const viewer = snapshot.viewer.toLowerCase();
  const signals = new Map<number, Set<string>>();
  const seen = new Set<number>();
  const parentAuthors = new Map<number, string | undefined>();
  // Keep this optional source within the interactive refresh time budget. Discussion remains accessible on demand.
  const deadline = Date.now() + 6000;
  let remaining = 20;
  async function request<T>(endpoint: string): Promise<T> {
    const timeoutMs = deadline - Date.now();
    if (remaining-- <= 0 || timeoutMs <= 0) throw new Error("budget");
    return read<T>(endpoint, timeoutMs);
  }
  async function pages<T>(endpoint: string, visit: (row: T) => Promise<void>) {
    for (let page = 1; ; page++) {
      const rows = await request<T[]>(endpoint + (endpoint.includes("?") ? "&" : "?") + "per_page=100&page=" + page);
      for (const row of rows) await visit(row);
      if (rows.length < 100) return;
    }
  }

  try {
    await pages<Notice>(repo + "/notifications", async notice => {
      if (notice.repository?.node_id !== snapshot.repositoryId || notice.subject?.type !== "PullRequest") return;
      const number = Number(notice.subject.url.match(/\/pulls\/(\d+)$/)?.[1]);
      if (!Number.isSafeInteger(number) || number <= 0 || (!includeLaterPages && !cards.has(number)) || seen.has(number)) return;
      seen.add(number);
      const since = notice.last_read_at;
      const query = since ? "?since=" + encodeURIComponent(since) : "";
      for (const kind of ["issues", "pulls"]) {
        await pages<Comment>(repo + "/" + kind + "/" + number + "/comments" + query, async comment => {
          const author = comment.user?.login.toLowerCase();
          if (kind === "pulls") parentAuthors.set(comment.id, author);
          if (author === viewer || (since && comment.created_at <= since)) return;
          let addressed = mentionsViewer(comment.body, viewer);
          const parent = comment.in_reply_to_id;
          if (!addressed && kind === "pulls" && parent && Number.isSafeInteger(parent)) {
            if (!parentAuthors.has(parent)) {
              const original = await request<Comment>(repo + "/pulls/comments/" + parent);
              parentAuthors.set(parent, original.user?.login.toLowerCase());
            }
            addressed = parentAuthors.get(parent) === viewer;
          }
          if (addressed && comment.node_id) {
            if (!signals.has(number)) signals.set(number, new Set());
            signals.get(number)!.add(comment.node_id);
          }
        });
      }
    });
  } catch {
    snapshot.warnings.push("New replies to you could only be checked in part. Open a PR to see its discussion.");
  }

  if (!signals.size) return;
  // gh's active account can change between the board query and the optional notification reads.
  let current: { login: string };
  try {
    current = await read<{ login: string }>("user", 1500);
  } catch {
    snapshot.warnings.push("New replies could not be verified for this account.");
    return;
  }
  if (current.login?.toLowerCase() !== viewer) throw new Error("access: GitHub account changed. Refresh the board.");
  for (const [number, ids] of signals) {
    const card = cards.get(number);
    if (card) card.addressedReplyIds = [...ids];
    else if (includeLaterPages) (snapshot.replyHints ??= []).push({ number, ids: [...ids] });
  }
}
