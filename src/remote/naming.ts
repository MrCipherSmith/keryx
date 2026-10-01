// Topic names for remote sessions (flow 376, AC2).
//
// The default name is `<project>-<short session id>`: a pure function of the
// project and the session id, so the same session always gets the same name and
// two sessions only share one if their ids share a prefix. For that rare case
// `defaultNameCandidates` yields progressively longer ids, still deterministic,
// and the hub takes the first one no live session holds.

import path from "node:path";

export const MAX_TOPIC_NAME_LENGTH = 128;
const MAX_PROJECT_SLUG = 40;
const SHORT_ID_START = 8;

/** The key two names are compared by: case and surrounding space do not make a name different. */
export function nameKey(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

export type NameCheck = { ok: true; name: string } | { ok: false; reason: string };

/** Validate an operator-chosen name. Returns the cleaned name. */
export function checkName(raw: string): NameCheck {
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (name.length === 0) {
    return { ok: false, reason: "the topic name is empty" };
  }
  if (name.length > MAX_TOPIC_NAME_LENGTH) {
    return { ok: false, reason: `the topic name is longer than ${MAX_TOPIC_NAME_LENGTH} characters` };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return { ok: false, reason: "the topic name contains control characters" };
  }
  return { ok: true, name };
}

function projectSlug(project: string): string {
  const base = path.basename(project.replace(/[\\/]+$/, "")) || project;
  const slug = base
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, MAX_PROJECT_SLUG);
  return slug.length > 0 ? slug : "project";
}

function idChars(sessionId: string): string {
  const chars = sessionId.replace(/[^A-Za-z0-9]/g, "");
  return chars.length > 0 ? chars : "session";
}

/** `<project>-<short session id>` with `length` characters of the id. */
export function defaultName(project: string, sessionId: string, length: number = SHORT_ID_START): string {
  return `${projectSlug(project)}-${idChars(sessionId).slice(0, length)}`;
}

/** The default name with 8, 12, 16 ... characters of the id, ending at the whole id. */
export function* defaultNameCandidates(project: string, sessionId: string): Generator<string> {
  const total = idChars(sessionId).length;
  const seen = new Set<string>();
  for (let length = SHORT_ID_START; ; length += 4) {
    const bounded = Math.min(length, total);
    const name = defaultName(project, sessionId, bounded);
    if (!seen.has(name)) {
      seen.add(name);
      yield name;
    }
    if (bounded >= total) {
      return;
    }
  }
}
