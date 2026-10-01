// Topic names for remote sessions (flow 376, AC2).
//
// The default name is `<project>-<short session id>`: a pure function of the
// project and the session id, so the same session always gets the same name and
// two sessions only share one if their ids share a prefix. For that rare case
// `defaultNameCandidates` yields progressively longer ids, still deterministic,
// and the hub takes the first one no live session holds.

import { createHash } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";

export const MAX_TOPIC_NAME_LENGTH = 128;
const MAX_PROJECT_SLUG = 40;
const MAX_MACHINE_SLUG = 24;
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

/** A hostname reduced to a short, safe label: the machine a topic belongs to. */
export function machineSlug(machine: string): string {
  const slug = machine
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, MAX_MACHINE_SLUG);
  // Nothing ASCII survived (a hostname in another script): a short id of the name keeps two such machines apart, and is the same every time.
  return slug.length > 0 ? slug : `host-${createHash("sha256").update(machine.normalize("NFC")).digest("hex").slice(0, 6)}`;
}

/** This machine's name, from its hostname: the only thing that tells two machines apart, so nothing is configured per machine. */
export function localMachineName(read: () => string = hostname): string {
  let name = "";
  try {
    name = read().trim();
  } catch {
    // An unreadable hostname still gets a usable label below.
  }
  return name.length > 0 ? name : "this-machine";
}

/** `<project>-<short session id>`, or `<machine>-<project>-<short session id>` when a machine is named. */
export function defaultName(project: string, sessionId: string, length: number = SHORT_ID_START, machine?: string): string {
  const base = `${projectSlug(project)}-${idChars(sessionId).slice(0, length)}`;
  return machine === undefined ? base : `${machineSlug(machine)}-${base}`;
}

/** The default name with 8, 12, 16 ... characters of the id, ending at the whole id. */
export function* defaultNameCandidates(project: string, sessionId: string, machine?: string): Generator<string> {
  const total = idChars(sessionId).length;
  const seen = new Set<string>();
  for (let length = SHORT_ID_START; ; length += 4) {
    const bounded = Math.min(length, total);
    const name = defaultName(project, sessionId, bounded, machine);
    if (!seen.has(name)) {
      seen.add(name);
      yield name;
    }
    if (bounded >= total) {
      return;
    }
  }
}
