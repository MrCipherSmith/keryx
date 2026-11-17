/** Composer drafts, one per session id, so a message typed for one session is never sent to another. */
export type Drafts = Readonly<Record<string, string>>;

/** The key a draft is stored under; a window with no session yet has one shared slot. */
export function draftKey(sessionId: string | null): string {
  return sessionId ?? "";
}

export function draftOf(drafts: Drafts, sessionId: string | null): string {
  return drafts[draftKey(sessionId)] ?? "";
}

/** A new drafts record with `text` stored for the session; an empty draft is removed. */
export function withDraft(drafts: Drafts, sessionId: string | null, text: string): Drafts {
  const key = draftKey(sessionId);
  if ((drafts[key] ?? "") === text) return drafts;
  const next = { ...drafts };
  if (text === "") delete next[key];
  else next[key] = text;
  return next;
}

/**
 * The drafts once a session id appears: a draft made before any session existed (a prefill from
 * Flows or the palette) moves to the new session when that session has none of its own.
 */
export function adoptNoSessionDraft(drafts: Drafts, sessionId: string | null): Drafts {
  if (sessionId === null) return drafts;
  const pending = drafts[draftKey(null)] ?? "";
  if (pending === "") return drafts;
  const next = { ...drafts };
  delete next[draftKey(null)];
  if ((next[sessionId] ?? "") === "") next[sessionId] = pending;
  return next;
}
