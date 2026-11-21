import type { DeskRevision, DeskRunKey } from "../../../../src/review/desk-run-types";
import { prInfo } from "../platform/commands";
import { fetchReviewBoard } from "../platform/review";
import type { FlowCard } from "../platform/commands";

export interface SessionReviewLink {
  id: string;
  sessionId: string;
  prompt?: string;
  key: DeskRunKey;
  revision: DeskRevision;
}

export function parseReviewTarget(raw: string): { repo?: string; number: number } | undefined {
  const value = raw.trim();
  if (!value) return;
  const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?(?:#[\w-]+)?$/i.exec(value);
  const number = Number(url?.[2] ?? /^#?([1-9]\d*)$/.exec(value)?.[1]);
  if (!Number.isSafeInteger(number) || number > 0xffffffff) throw new Error("Enter a pull request number or a GitHub pull request URL.");
  return { repo: url?.[1], number };
}

export async function loadSessionReviewTargets(cwd: string, viewer: string | undefined, hint?: string, signal?: AbortSignal) {
  const target = hint?.trim() ? parseReviewTarget(hint) : parseReviewTarget((await prInfo(cwd).catch(() => null))?.url ?? "");
  const snapshot = await fetchReviewBoard(cwd, "open", target?.repo, signal, viewer);
  const selectedNumber = snapshot.cards.find(card => card.number === target?.number)?.number;
  if (hint?.trim() && selectedNumber === undefined) {
    throw new Error("This pull request could not be found among the project's open pull requests.");
  }
  return { snapshot, selectedNumber };
}

export function reviewFlowId(flows: readonly FlowCard[], linked?: string, requested?: string) {
  const match = (ref?: string) => {
    if (!ref) return;
    const id = /^\d+$/.test(ref) ? ref.padStart(3, "0") : ref;
    return flows.find(flow => flow.idValid && (flow.dir === ref || flow.id === id));
  };
  return (match(requested) || match(linked))?.id;
}

function storageKey(cwd: string) { return "keryx.session-reviews.v1:" + cwd; }

export function readSessionReviewLinks(cwd: string): SessionReviewLink[] {
  try {
    const links: unknown = JSON.parse(localStorage.getItem(storageKey(cwd)) ?? "[]");
    if (Array.isArray(links)) return links.filter((entry): entry is SessionReviewLink =>
      typeof entry?.id === "string" && typeof entry?.sessionId === "string"
      && typeof entry?.key?.repo === "string" && typeof entry?.key?.viewer === "string"
      && typeof entry?.key?.repositoryId === "string" && Number.isSafeInteger(entry?.key?.number)
      && typeof entry?.revision?.baseSha === "string" && typeof entry?.revision?.headSha === "string");
  } catch { /* The run is still available from Review when local storage is unavailable. */ }
  return [];
}

export function rememberSessionReview(cwd: string, link: SessionReviewLink): SessionReviewLink[] {
  const links = [link, ...readSessionReviewLinks(cwd).filter(item => item.id !== link.id || item.sessionId !== link.sessionId)]
    .slice(0, 100);
  try { localStorage.setItem(storageKey(cwd), JSON.stringify(links)); } catch { /* The caller still keeps this link in memory. */ }
  return links;
}

export function reviewSessionTitle(title: string | null | undefined, link?: SessionReviewLink) {
  return link && (!title || title === "New session") ? "Review #" + link.key.number : title;
}

export interface ReviewComposerTarget {
  sessionId: string;
  placeholder: string;
  draftKey: string;
  disabledReason?: string;
  send: (text: string) => Promise<boolean>;
}
