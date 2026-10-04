// Flow 403: the three stores of intake.
//
//   cards.json    what a card says (texts live ONLY here)
//   ledger.jsonl  what happened to a card, one appended line per state change, no texts
//   state.json    what the poll has seen
//
// All three sit under `.metaproject/data/intake/`, which ignores itself. The registry and the ledger share one
// lock (`ledger.lock`), the state has its own. No function here calls another locked function inside its lock.

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isNotFound, withFileLock, writeFileAtomic } from "../lib/fs";
import { intakeDataDir } from "./config";
import type { IntakeCardContent, IntakeCardState, IntakeCardView, IntakeLedgerCard, IntakeLedgerRecord, IntakeState } from "./types";
import { INTAKE_ACTIONS, INTAKE_CARD_STATES } from "./types";

export const INTAKE_SEEN_CAP = 5000;
/** A pending Telegram edit is dropped after this many refusals, or after this long, whichever comes first. */
export const INTAKE_PENDING_EDIT_MAX_ATTEMPTS = 5;
export const INTAKE_PENDING_EDIT_TTL_MS = 24 * 3_600_000;
const RECENT_CAP = 60;

export const intakeLedgerPath = (root: string): string => path.join(intakeDataDir(root), "ledger.jsonl");
export const intakeCardsPath = (root: string): string => path.join(intakeDataDir(root), "cards.json");
export const intakeStatePath = (root: string): string => path.join(intakeDataDir(root), "state.json");
const ledgerLockPath = (root: string): string => path.join(intakeDataDir(root), "ledger.lock");
const stateLockPath = (root: string): string => path.join(intakeDataDir(root), "state.lock");

export async function ensureIntakeDataIgnored(root: string): Promise<void> {
  const dir = intakeDataDir(root);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, ".gitignore");
  try {
    await readFile(file, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await writeFile(file, "# Work intake: the card registry, the ledger and the poll state. Never committed.\n*\n!.gitignore\n", "utf8");
  }
}

async function locked<T>(root: string, lock: string, fn: () => Promise<T>): Promise<T> {
  await ensureIntakeDataIgnored(root);
  return withFileLock(lock, fn, { timeoutMs: 5000 });
}

/** A card id is derived from the event key and its stamp, so the same event can never produce two cards. */
export function cardIdFor(eventKey: string, stamp: string): string {
  return `c${createHash("sha256").update(`${eventKey}\n${stamp}`).digest("hex").slice(0, 11)}`;
}

export function overflowCardId(seed: string): string {
  return `o${createHash("sha256").update(seed).digest("hex").slice(0, 11)}`;
}

// ---- state ---------------------------------------------------------------------------

export function emptyIntakeState(): IntakeState {
  return { version: 1, paused: false, seen: {}, baselined: [], delivery: {}, recent: [], pendingEdits: {}, pendingEditTries: {} };
}

function parseState(text: string): IntakeState {
  try {
    const raw = JSON.parse(text) as Record<string, unknown> | null;
    if (raw === null || typeof raw !== "object") return emptyIntakeState();
    const base = emptyIntakeState();
    const seen: Record<string, string> = {};
    if (typeof raw["seen"] === "object" && raw["seen"] !== null) {
      for (const [k, v] of Object.entries(raw["seen"] as Record<string, unknown>)) if (typeof v === "string") seen[k] = v;
    }
    const delivery: Record<string, { attempts: number; nextAt: string }> = {};
    if (typeof raw["delivery"] === "object" && raw["delivery"] !== null) {
      for (const [k, v] of Object.entries(raw["delivery"] as Record<string, unknown>)) {
        const d = v as Record<string, unknown> | null;
        if (d !== null && typeof d["attempts"] === "number" && typeof d["nextAt"] === "string") delivery[k] = { attempts: d["attempts"], nextAt: d["nextAt"] };
      }
    }
    const pendingEdits: Record<string, string> = {};
    if (typeof raw["pendingEdits"] === "object" && raw["pendingEdits"] !== null) {
      for (const [k, v] of Object.entries(raw["pendingEdits"] as Record<string, unknown>)) if (typeof v === "string") pendingEdits[k] = v;
    }
    const pendingEditTries: Record<string, { since: string; attempts: number }> = {};
    if (typeof raw["pendingEditTries"] === "object" && raw["pendingEditTries"] !== null) {
      for (const [k, v] of Object.entries(raw["pendingEditTries"] as Record<string, unknown>)) {
        const t = v as Record<string, unknown> | null;
        if (t !== null && typeof t["since"] === "string" && typeof t["attempts"] === "number") pendingEditTries[k] = { since: t["since"], attempts: t["attempts"] };
      }
    }
    const lastStatus = raw["lastStatus"] as Record<string, unknown> | undefined;
    return {
      ...base,
      paused: raw["paused"] === true,
      seen,
      baselined: Array.isArray(raw["baselined"]) ? raw["baselined"].filter((x): x is string => typeof x === "string") : [],
      ...(typeof raw["lastPollAt"] === "string" ? { lastPollAt: raw["lastPollAt"] } : {}),
      ...(typeof raw["lastRun"] === "object" && raw["lastRun"] !== null ? { lastRun: raw["lastRun"] as NonNullable<IntakeState["lastRun"]> } : {}),
      delivery,
      ...(lastStatus !== undefined && typeof lastStatus["text"] === "string" && typeof lastStatus["at"] === "string" ? { lastStatus: { text: lastStatus["text"], at: lastStatus["at"] } } : {}),
      recent: Array.isArray(raw["recent"]) ? (raw["recent"] as IntakeState["recent"]).slice(-RECENT_CAP) : [],
      pendingEdits,
      pendingEditTries,
    };
  } catch {
    return emptyIntakeState();
  }
}

export async function readIntakeState(root: string): Promise<IntakeState> {
  try {
    return parseState(await readFile(intakeStatePath(root), "utf8"));
  } catch {
    return emptyIntakeState();
  }
}

/**
 * Record items as seen NOW. A key already present is moved to the end, so the order of `seen` is the order of the last
 * time each item was seen and the cap evicts the item not seen for the longest, not the one that was added first.
 */
export function markIntakeSeen(seen: Readonly<Record<string, string>>, updates: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(seen)) if (!(k in updates)) out[k] = v;
  for (const [k, v] of Object.entries(updates)) out[k] = v;
  return out;
}

/** Read-modify-write the state under its lock. `fn` must be synchronous or await nothing that locks. */
export async function updateIntakeState(root: string, fn: (state: IntakeState) => IntakeState): Promise<IntakeState> {
  return locked(root, stateLockPath(root), async () => {
    const next = fn(await readIntakeState(root));
    const keys = Object.keys(next.seen);
    const seen = keys.length > INTAKE_SEEN_CAP ? Object.fromEntries(keys.slice(keys.length - INTAKE_SEEN_CAP).map((k) => [k, next.seen[k]!])) : next.seen;
    const out: IntakeState = { ...next, seen, recent: next.recent.slice(-RECENT_CAP) };
    await writeFileAtomic(intakeStatePath(root), `${JSON.stringify(out, null, 2)}\n`);
    return out;
  });
}

// ---- the card registry ------------------------------------------------------------------

export async function readIntakeCards(root: string): Promise<Record<string, IntakeCardContent>> {
  try {
    const raw = JSON.parse(await readFile(intakeCardsPath(root), "utf8")) as { cards?: Record<string, IntakeCardContent> } | null;
    return raw !== null && typeof raw === "object" && raw.cards !== undefined && typeof raw.cards === "object" ? raw.cards : {};
  } catch {
    return {};
  }
}

async function writeCards(root: string, cards: Record<string, IntakeCardContent>): Promise<void> {
  await writeFileAtomic(intakeCardsPath(root), `${JSON.stringify({ version: 1, cards }, null, 2)}\n`);
}

function line(record: IntakeLedgerRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Put a new card in the ledger and the registry. Returns false, and writes nothing, when the card is already complete
 * (in both): the same event can never produce a second card.
 *
 * The ledger line is written FIRST, because a card is visible only through the ledger. A crash between the two writes
 * leaves a ledger line with no registry entry (invisible, and the event is still unseen, so the next poll calls this
 * again), and a card in the registry with no ledger line (a card written by the older order) is completed here too.
 * Either half-card is healed on the next call, and no event is lost.
 */
export async function registerIntakeCard(root: string, content: IntakeCardContent): Promise<boolean> {
  return locked(root, ledgerLockPath(root), async () => {
    const cards = await readIntakeCards(root);
    const inLedger = (await readIntakeLedger(root)).some((r) => r.cardId === content.id);
    if (cards[content.id] !== undefined && inLedger) return false;
    if (!inLedger) {
      await appendFile(
        intakeLedgerPath(root),
        line({
          v: 1,
          at: content.createdAt,
          cardId: content.id,
          eventKey: content.eventKey,
          kind: content.kind,
          state: "queued",
          ...(content.suggestion !== undefined ? { suggestion: content.suggestion } : {}),
        }),
        "utf8",
      );
    }
    if (cards[content.id] === undefined) await writeCards(root, { ...cards, [content.id]: content });
    return true;
  });
}

/** Replace a registered card's content (an overflow card learns which cards joined it). */
export async function updateIntakeCard(root: string, id: string, fn: (card: IntakeCardContent) => IntakeCardContent): Promise<void> {
  await locked(root, ledgerLockPath(root), async () => {
    const cards = await readIntakeCards(root);
    const card = cards[id];
    if (card === undefined) return;
    await writeCards(root, { ...cards, [id]: fn(card) });
  });
}

// ---- the ledger ---------------------------------------------------------------------------

function parseRecord(text: string): IntakeLedgerRecord | undefined {
  try {
    const r = JSON.parse(text) as Record<string, unknown> | null;
    if (r === null || typeof r !== "object") return undefined;
    if (r["v"] !== 1 || typeof r["at"] !== "string" || typeof r["cardId"] !== "string" || typeof r["eventKey"] !== "string" || typeof r["kind"] !== "string") return undefined;
    if (typeof r["state"] !== "string" || !(INTAKE_CARD_STATES as readonly string[]).includes(r["state"])) return undefined;
    return r as unknown as IntakeLedgerRecord;
  } catch {
    return undefined;
  }
}

/** Every well-formed ledger line, oldest first. A torn or foreign line is skipped, never an error. */
export async function readIntakeLedger(root: string): Promise<IntakeLedgerRecord[]> {
  let text: string;
  try {
    text = await readFile(intakeLedgerPath(root), "utf8");
  } catch {
    return [];
  }
  const out: IntakeLedgerRecord[] = [];
  for (const l of text.split("\n")) {
    if (l.length === 0) continue;
    const rec = parseRecord(l);
    if (rec !== undefined) out.push(rec);
  }
  return out;
}

const DECISION_FIELDS = ["choice", "decidedBy", "decidedAt", "timeToAnswerMs", "remindAt"] as const;
/** The Telegram message a card was sent as: a card put back in `queued` or `sent` is a NEW message, so the old ids go. */
const MESSAGE_FIELDS = ["chatId", "messageId"] as const;

/** Fold the ledger into one entry per card, by the rules in `IntakeLedgerCard`. Order: first record first. */
export function foldIntakeLedger(records: readonly IntakeLedgerRecord[]): IntakeLedgerCard[] {
  const cards = new Map<string, Mutable<IntakeLedgerCard>>();
  for (const rec of records) {
    let card = cards.get(rec.cardId);
    if (card === undefined) {
      card = { cardId: rec.cardId, eventKey: rec.eventKey, kind: rec.kind, state: rec.state, reminded: false, createdAt: rec.at, updatedAt: rec.at };
      cards.set(rec.cardId, card);
    }
    if (rec.state === "queued" || rec.state === "sent") for (const f of [...DECISION_FIELDS, ...MESSAGE_FIELDS]) delete card[f];
    card.state = rec.state;
    card.updatedAt = rec.at;
    if (rec.suggestion !== undefined) card.suggestion = rec.suggestion;
    if (rec.state === "sent") card.sentAt = rec.at;
    for (const f of ["choice", "decidedBy", "decidedAt", "flowId", "chatId", "messageId", "collapsedInto"] as const) {
      if (rec[f] !== undefined) (card as Record<string, unknown>)[f] = rec[f];
    }
    if (rec.timeToAnswerMs !== undefined) card.timeToAnswerMs = rec.timeToAnswerMs;
    if (rec.state === "decided") {
      if (rec.remindAt !== undefined) card.remindAt = rec.remindAt;
      else delete card.remindAt;
    }
    if (rec.reason !== undefined) card.reason = rec.reason;
    else if (rec.state !== "failed" && rec.state !== "undelivered") delete card.reason;
    if (rec.reason === "reminder") card.reminded = true;
  }
  return [...cards.values()];
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export async function readIntakeLedgerCards(root: string): Promise<IntakeLedgerCard[]> {
  return foldIntakeLedger(await readIntakeLedger(root));
}

/** The registry content joined with the ledger's word: what a surface renders. Cards missing from the registry are left out. */
export async function readIntakeCardViews(root: string): Promise<IntakeCardView[]> {
  const [cards, folded] = await Promise.all([readIntakeCards(root), readIntakeLedgerCards(root)]);
  const views: IntakeCardView[] = [];
  for (const f of folded) {
    const content = cards[f.cardId];
    if (content === undefined) continue;
    const { cardId: _id, eventKey: _key, kind: _kind, suggestion: _suggestion, createdAt: _created, ...rest } = f;
    views.push({ ...content, ...rest });
  }
  return views;
}

export async function readIntakeCardView(root: string, id: string): Promise<IntakeCardView | undefined> {
  return (await readIntakeCardViews(root)).find((c) => c.id === id);
}

export type AppendResult = { readonly ok: true; readonly state: IntakeCardState } | { readonly ok: false; readonly state: IntakeCardState | undefined };

/** Fields of a record the caller chooses; the rest is taken from the card. */
export type IntakeLedgerInput = Omit<IntakeLedgerRecord, "v" | "at" | "cardId" | "eventKey" | "kind"> & { readonly at?: string };

/**
 * Append a record to a card only if the card is in one of `expected` states: the check and the append happen under
 * one lock, so two presses cannot both move a card out of `sent`. A press that finds another state gets it back.
 * `timeToAnswerMs` is filled from the card's last send when the record has `decidedAt` and does not carry its own.
 */
export async function appendIntakeIfState(root: string, cardId: string, expected: readonly IntakeCardState[], input: IntakeLedgerInput, now: () => Date = () => new Date()): Promise<AppendResult> {
  return locked(root, ledgerLockPath(root), async () => {
    const card = foldIntakeLedger(await readIntakeLedger(root)).find((c) => c.cardId === cardId);
    if (card === undefined) return { ok: false, state: undefined } as const;
    if (!expected.includes(card.state)) return { ok: false, state: card.state } as const;
    const at = input.at ?? now().toISOString();
    let timeToAnswerMs = input.timeToAnswerMs;
    if (timeToAnswerMs === undefined && input.decidedAt !== undefined && card.sentAt !== undefined) {
      timeToAnswerMs = Math.max(0, Date.parse(input.decidedAt) - Date.parse(card.sentAt));
    }
    const { at: _at, ...rest } = input;
    const record: IntakeLedgerRecord = {
      v: 1,
      at,
      cardId,
      eventKey: card.eventKey,
      kind: card.kind,
      ...(card.suggestion !== undefined && rest.suggestion === undefined ? { suggestion: card.suggestion } : {}),
      ...rest,
      ...(timeToAnswerMs !== undefined && Number.isFinite(timeToAnswerMs) ? { timeToAnswerMs } : {}),
    };
    if (record.choice !== undefined && !(INTAKE_ACTIONS as readonly string[]).includes(record.choice)) return { ok: false, state: card.state } as const;
    await appendFile(intakeLedgerPath(root), line(record), "utf8");
    return { ok: true, state: record.state } as const;
  });
}

/** Append without a state check: for records no concurrent writer can race (the poll's own `queued`/`sent` bookkeeping). */
export async function appendIntakeRecord(root: string, record: Omit<IntakeLedgerRecord, "v">): Promise<void> {
  await locked(root, ledgerLockPath(root), async () => {
    await appendFile(intakeLedgerPath(root), line({ v: 1, ...record }), "utf8");
  });
}

// ---- edits of the Telegram card made from another surface ---------------------------------------

/** A decision taken in the TUI or the CLI: the card in Telegram still shows its buttons until serve edits it. */
export async function queueIntakeCardEdit(root: string, cardId: string, statusLine: string, now: () => Date = () => new Date()): Promise<void> {
  await updateIntakeState(root, (s) => {
    // Queueing is also where a project that never runs serve's flush sheds the edits nobody will ever apply.
    const edits: Record<string, string> = {};
    const tries: Record<string, { since: string; attempts: number }> = {};
    for (const [id, line] of Object.entries(s.pendingEdits)) {
      const t = s.pendingEditTries[id];
      if (t !== undefined && now().getTime() - Date.parse(t.since) > INTAKE_PENDING_EDIT_TTL_MS) continue;
      edits[id] = line;
      if (t !== undefined) tries[id] = t;
    }
    edits[cardId] = statusLine;
    tries[cardId] = { since: now().toISOString(), attempts: 0 };
    return { ...s, pendingEdits: edits, pendingEditTries: tries };
  });
}

/** Count one refused attempt to put a pending edit on its card. */
export async function recordIntakeEditRefused(root: string, cardIds: readonly string[], now: () => Date = () => new Date()): Promise<void> {
  if (cardIds.length === 0) return;
  await updateIntakeState(root, (s) => {
    const next = { ...s.pendingEditTries };
    for (const id of cardIds) next[id] = { since: next[id]?.since ?? now().toISOString(), attempts: (next[id]?.attempts ?? 0) + 1 };
    return { ...s, pendingEditTries: next };
  });
}

/** Forget a pending edit once it has been applied (or when it no longer applies). */
export async function clearIntakeCardEdits(root: string, cardIds: readonly string[]): Promise<void> {
  if (cardIds.length === 0) return;
  await updateIntakeState(root, (s) => {
    const next = { ...s.pendingEdits };
    const tries = { ...s.pendingEditTries };
    for (const id of cardIds) {
      delete next[id];
      delete tries[id];
    }
    return { ...s, pendingEdits: next, pendingEditTries: tries };
  });
}
