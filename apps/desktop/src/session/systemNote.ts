// keryx's own notes (gate, budget, recovery lines) arrive as `agent_message_chunk`s: ACP has no
// system-message update. They are shown apart from the model's reply, never run into its prose.

export type NoteLevel = "info" | "warn" | "error";

export interface SystemNote {
  /** The leading `[tag]` keryx gave the note (`review-gate`, `budget`, …); null when it has none. */
  tag: string | null;
  /** The note without its tag, trimmed. */
  body: string;
  level: NoteLevel;
}

/**
 * Tags keryx's `system()` notes start with. An older keryx sends them without `_meta.keryx.system`;
 * a chunk that is exactly one such note (`\n[tag] …\n`, the shape `system()` writes) is still split out.
 */
const LEGACY_TAGS = new Set([
  "review-gate",
  "budget",
  "error",
  "blocked",
  "warning",
  "plan",
  "recovering",
  "working memory",
  "stopped",
  "prune",
  "compact",
  "context",
  "hook",
  "recovery usage",
  "interrupted output",
]);

const TAGGED = /^\[([a-z][a-z -]{0,30})\][ \t]*/;

/** `_meta.keryx` of a chunk marks it as keryx's own note (`system`), or as auto mode's answer to a question. */
export function isSystemMeta(meta: unknown): boolean {
  const k = (meta as { keryx?: { system?: unknown; selfAnsweredQuestion?: unknown } } | null | undefined)?.keryx;
  return k?.system === true || k?.selfAnsweredQuestion === true;
}

/** A chunk with no marker that is one whole `system()` note from an older keryx. */
export function isLegacySystemText(text: string): boolean {
  if (!text.startsWith("\n[") || !text.endsWith("\n")) return false;
  const m = TAGGED.exec(text.slice(1));
  return m !== null && LEGACY_TAGS.has(m[1]!);
}

function levelOf(tag: string | null, body: string): NoteLevel {
  if (tag === "error") return "error";
  if (tag === "warning" || tag === "blocked" || tag === "stopped" || tag === "budget") return "warn";
  // The gate's "still refuses, continuing" is progress; its final report (it gave up) needs attention.
  if (tag === "review-gate") return /^Review not complete \(continue \d+\)/.test(body) ? "info" : "warn";
  return "info";
}

export function parseSystemNote(text: string): SystemNote {
  const t = text.trim();
  const m = TAGGED.exec(t);
  const tag = m ? m[1]! : null;
  const body = m ? t.slice(m[0].length).trim() : t;
  return { tag, body, level: levelOf(tag, body) };
}
