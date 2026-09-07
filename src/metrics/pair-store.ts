// The crash-safe pair store (AC7 / AC-M07, metrics-and-validation.md §"M06/M07" ¶5):
//
//   "immutable arm artifact по (runId, taskId, repetition, arm, protocolDigest),
//    atomic pair manifest после двух проверенных arms. Scorer читает только
//    manifest-complete пары, проверяет единственность ключей и identical
//    task/protocol. Orphan quarantine не получает вес. Resume валидирует каждое
//    поле, не усредняет дубли; same key/different data — conflict. Crash между
//    arm writes → resume → restart снова даёт ровно одну пару. Invalid task не
//    исчезает бесследно: counts/reasons и missingness опубликованы отдельно от
//    scored outcomes."
//
// ## Why the intent record exists
//
// The resume clause is a durability question, not a bookkeeping one. A restarted
// process cannot look at a half-finished run and tell "this arm never started"
// apart from "this arm finished and I lost the acknowledgement" — unless
// something was made durable *before* the work began. `src/sac/proposal-lifecycle.ts`
// reached the same conclusion for owner writes: the write intent is the last
// thing made durable before crossing into the subsystem, precisely so a restart
// can account for the attempt.
//
// Here the intent is written at the *pair* level, before either arm runs, and it
// names both arms. That one record is what separates the four states a restart
// has to distinguish and which otherwise all look like "one file on disk":
//
//   intent + 0 arms            -> incomplete, retry both, no weight
//   intent + 1 arm             -> incomplete, retry the missing arm, no weight
//   intent + 2 arms, agreeing  -> seal exactly one pair, weight 1
//   no intent + arms           -> orphan; nothing accounts for these, no weight
//
// ## Immutability, and why duplicates are not merged
//
// An arm artifact is written once and never rewritten. A second write of the
// same key with the same payload is collapsed onto the artifact already on disk
// and counted (`duplicatesCollapsed`) — this is the naive-restart case, where a
// runner that does not know which arms it finished re-runs both, and it must not
// double-count. A second write with *different* payload is a conflict: the two
// results disagree about what the same key measured, and there is no honest way
// to choose. Averaging them would invent a third result nobody observed, so the
// pair is excluded, the conflict is durable, and the exclusion is published.
//
// ## What happens to an orphan
//
// It is quarantined, not deleted and not scored. Deleting it would make the
// exclusion invisible, and the norm forbids exactly that: "Invalid task не
// исчезает бесследно: counts/reasons и missingness опубликованы отдельно от
// scored outcomes". So `PairStoreState` carries `pairs` (the only thing a scorer
// may read) alongside `quarantined`, `incomplete` and a `missingness` report with
// per-reason counts, and `weightOf` counts sealed pairs only.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** Identity of one pair: everything but the arm. */
export type PairKey = {
  readonly runId: string;
  readonly taskId: string;
  readonly repetition: number;
  readonly protocolDigest: string;
};

/** Identity of one immutable arm artifact — the norm's five-field key. */
export type ArmKey = PairKey & { readonly arm: string };

const KEY_FIELDS = ["runId", "taskId", "repetition", "protocolDigest"] as const;

/**
 * Canonical key string. Every component is percent-encoded before joining, so a
 * value containing the separator cannot forge a field boundary and collide with
 * a different key.
 */
export function canonicalKeyString(key: ArmKey | PairKey): string {
  const arm = "arm" in key ? key.arm : "";
  return [key.runId, key.taskId, String(key.repetition), arm, key.protocolDigest]
    .map((part) => encodeURIComponent(part))
    .join("|");
}

export function armKeyId(key: ArmKey): string {
  return sha256(canonicalKeyString(key));
}

export function pairKeyId(key: PairKey): string {
  return sha256(canonicalKeyString({ runId: key.runId, taskId: key.taskId, repetition: key.repetition, protocolDigest: key.protocolDigest }));
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type QuarantineReason =
  /** An arm nothing accounts for: no intent was ever recorded for its pair. */
  | "orphan-unpaired"
  /** The same key was written twice with different data. */
  | "conflicting-duplicate"
  /** A pair that began and never finished, at the point the run was closed. */
  | "incomplete-arm"
  /** An artifact whose stored key, digest or JSON no longer matches itself. */
  | "key-mismatch"
  /** An arm outside the protocol roster, or written with no intent in force. */
  | "unexpected-arm";

export type QuarantineEntry = {
  readonly key: ArmKey | PairKey;
  readonly reason: QuarantineReason;
  readonly detail: string;
};

export type StoredArm = {
  readonly key: ArmKey;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payloadDigest: string;
  readonly recordedAt: string;
};

export type PairIntent = {
  readonly key: PairKey;
  readonly arms: readonly string[];
  readonly startedAt: string;
};

export type PairRecord = {
  readonly key: PairKey;
  readonly arms: readonly string[];
  readonly armDigests: Readonly<Record<string, string>>;
  readonly sealedAt: string;
};

/** Published beside the scored outcomes, never folded into them. */
export type MissingnessReport = {
  readonly quarantinedArms: number;
  readonly incompletePairs: number;
  readonly duplicatesCollapsed: number;
  readonly reasons: Readonly<Record<QuarantineReason, number>>;
};

export type PairStoreState = {
  /** The only thing a scorer may read: sealed, manifest-complete pairs. */
  readonly pairs: readonly PairRecord[];
  readonly quarantined: readonly QuarantineEntry[];
  readonly incomplete: readonly PairKey[];
  readonly missingness: MissingnessReport;
};

export type RecordArmOutcome =
  | { readonly status: "stored" }
  | { readonly status: "duplicate-identical" }
  | { readonly status: "conflict"; readonly detail: string }
  | { readonly status: "rejected"; readonly reason: QuarantineReason; readonly detail: string };

/** Scored weight: sealed pairs only. Quarantine and incompletes weigh nothing. */
export function weightOf(state: PairStoreState): number {
  return state.pairs.length;
}

/** The pairs a scorer is allowed to read. */
export function scoredPairs(state: PairStoreState): readonly PairRecord[] {
  return state.pairs;
}

// ---------------------------------------------------------------------------

const DIRS = { intents: "intents", arms: "arms", pairs: "pairs", conflicts: "conflicts", duplicates: "duplicates" } as const;

export class PairStore {
  constructor(
    private readonly dir: string,
    private readonly protocolArms: readonly [string, string],
  ) {}

  /**
   * The durable record that a pair is about to be measured, written BEFORE
   * either arm runs. Idempotent: re-declaring the same intent is a no-op, and a
   * restart re-declaring it is the normal path.
   */
  async beginPair(key: PairKey): Promise<void> {
    const file = this.path(DIRS.intents, pairKeyId(key));
    if (existsSync(file)) {
      const existing = await readJson<PairIntent>(file);
      if (existing && samePairKey(existing.key, key)) return;
      // A different pair hashing to the same id, or an unreadable intent: refuse
      // rather than overwrite the record a resume depends on.
      throw new Error(`pair intent at ${file} does not match the pair being begun`);
    }
    const intent: PairIntent = { key, arms: [...this.protocolArms], startedAt: new Date().toISOString() };
    await writeFileAtomic(file, `${JSON.stringify(intent, null, 2)}\n`);
  }

  /**
   * Write one immutable arm artifact. Never overwrites: a repeat of the same key
   * is either an identical duplicate (collapsed, counted) or a conflict
   * (durable, excluded).
   */
  async recordArm(input: { key: ArmKey; payload: Record<string, unknown> }): Promise<RecordArmOutcome> {
    const { key, payload } = input;

    if (!this.protocolArms.includes(key.arm)) {
      const detail = `arm ${key.arm} is not in the protocol roster [${this.protocolArms.join(", ")}]`;
      await this.quarantine(key, "unexpected-arm", detail);
      return { status: "rejected", reason: "unexpected-arm", detail };
    }

    const intentFile = this.path(DIRS.intents, pairKeyId(key));
    if (!existsSync(intentFile)) {
      const detail = `no durable pair intent for ${canonicalKeyString(key)}: this arm cannot be accounted for`;
      await this.quarantine(key, "unexpected-arm", detail);
      return { status: "rejected", reason: "unexpected-arm", detail };
    }

    const payloadDigest = sha256(canonicalJson(payload));
    const armFile = this.path(DIRS.arms, armKeyId(key));

    if (existsSync(armFile)) {
      const existing = await readJson<StoredArm>(armFile);
      if (existing && existing.payloadDigest === payloadDigest) {
        await this.countDuplicate(key);
        return { status: "duplicate-identical" };
      }
      const detail = `same key, different data: stored ${existing?.payloadDigest ?? "unreadable"} vs incoming ${payloadDigest}`;
      await writeFileAtomic(
        this.path(DIRS.conflicts, armKeyId(key)),
        `${JSON.stringify({ key, detail, at: new Date().toISOString() }, null, 2)}\n`,
      );
      return { status: "conflict", detail };
    }

    const stored: StoredArm = { key, payload, payloadDigest, recordedAt: new Date().toISOString() };
    await writeFileAtomic(armFile, `${JSON.stringify(stored, null, 2)}\n`);
    return { status: "stored" };
  }

  async readArm(key: ArmKey): Promise<StoredArm | null> {
    return await readJson<StoredArm>(this.path(DIRS.arms, armKeyId(key)));
  }

  /**
   * Rebuild the whole state from disk, sealing every pair whose two arms are
   * present and verified. Safe to call any number of times: sealing is
   * idempotent, so a second resume adds no weight.
   */
  async resume(): Promise<PairStoreState> {
    return await this.rebuild({ closeIncomplete: false });
  }

  /** Close the run: a pair still incomplete becomes a counted exclusion. */
  async finalize(): Promise<PairStoreState> {
    return await this.rebuild({ closeIncomplete: true });
  }

  // -------------------------------------------------------------------------

  private async rebuild(options: { closeIncomplete: boolean }): Promise<PairStoreState> {
    const quarantined: QuarantineEntry[] = [...(await this.readQuarantine())];
    const conflicted = new Set<string>();

    // Conflicts recorded at write time are durable and survive a restart.
    for (const entry of await this.listJson<{ key: ArmKey; detail: string }>(DIRS.conflicts)) {
      conflicted.add(pairKeyId(entry.value.key));
      quarantined.push({ key: entry.value.key, reason: "conflicting-duplicate", detail: entry.value.detail });
    }

    const intents = new Map<string, PairIntent>();
    for (const entry of await this.listJson<PairIntent>(DIRS.intents)) {
      if (isPairKey(entry.value?.key) && pairKeyId(entry.value.key) === entry.id) {
        intents.set(entry.id, entry.value);
      }
    }

    // Every arm artifact is re-validated against its own filename and contents.
    const groups = new Map<string, StoredArm[]>();
    const armsDir = path.join(this.dir, DIRS.arms);
    for (const file of await listFiles(armsDir)) {
      const id = path.basename(file, ".json");
      const full = path.join(armsDir, file);
      const stored = await readJson<StoredArm>(full);
      const problem = validateStoredArm(stored, id, this.protocolArms);
      if (problem !== null || !stored) {
        quarantined.push({
          key: (stored?.key ?? { runId: "?", taskId: "?", repetition: -1, protocolDigest: "?", arm: "?" }) as ArmKey,
          reason: "key-mismatch",
          detail: `${file}: ${problem ?? "unreadable"}`,
        });
        continue;
      }
      const pairId = pairKeyId(stored.key);
      groups.set(pairId, [...(groups.get(pairId) ?? []), stored]);
    }

    const pairs: PairRecord[] = [];
    const incomplete: PairKey[] = [];

    for (const [pairId, intent] of intents) {
      const arms = groups.get(pairId) ?? [];
      if (conflicted.has(pairId)) continue; // excluded, never averaged
      if (arms.length < this.protocolArms.length) {
        if (options.closeIncomplete) {
          const detail = `pair began with ${arms.length}/${this.protocolArms.length} arms and was never completed`;
          quarantined.push({ key: intent.key, reason: "incomplete-arm", detail });
          await this.quarantine(intent.key, "incomplete-arm", detail);
        } else {
          incomplete.push(intent.key);
        }
        continue;
      }
      const sealed = await this.seal(pairId, intent, arms);
      if (sealed.ok) pairs.push(sealed.record);
      else quarantined.push({ key: intent.key, reason: "key-mismatch", detail: sealed.detail });
    }

    // Arms nobody ever intended. Quarantined rather than deleted, so the
    // exclusion is visible and counted.
    for (const [pairId, arms] of groups) {
      if (intents.has(pairId)) continue;
      for (const arm of arms) {
        quarantined.push({
          key: arm.key,
          reason: "orphan-unpaired",
          detail: `no pair intent for ${canonicalKeyString(arm.key)}`,
        });
      }
    }

    return {
      pairs,
      quarantined,
      incomplete,
      missingness: summarize(quarantined, incomplete.length, await this.duplicateCount()),
    };
  }

  /**
   * Atomic pair manifest, written once. If one already exists it is verified
   * field by field and left alone — that is what makes a second resume add no
   * weight, and a third, and a tenth.
   */
  private async seal(
    pairId: string,
    intent: PairIntent,
    arms: readonly StoredArm[],
  ): Promise<{ ok: true; record: PairRecord } | { ok: false; detail: string }> {
    const seen = new Set(arms.map((arm) => arm.key.arm));
    if (seen.size !== arms.length) return { ok: false, detail: "arm keys are not unique within the pair" };
    for (const arm of arms) {
      if (!samePairKey(arm.key, intent.key)) return { ok: false, detail: "arm carries a different task/protocol than the intent" };
    }

    const armNames = [...this.protocolArms];
    if (!armNames.every((arm) => seen.has(arm))) return { ok: false, detail: "pair does not carry both protocol arms" };

    const armDigests: Record<string, string> = {};
    for (const arm of arms) armDigests[arm.key.arm] = arm.payloadDigest;

    const file = this.path(DIRS.pairs, pairId);
    const existing = await readJson<PairRecord>(file);
    if (existsSync(file)) {
      if (!existing) return { ok: false, detail: "the sealed pair manifest is unreadable" };
      if (!samePairKey(existing.key, intent.key)) return { ok: false, detail: "the sealed pair manifest is for a different pair" };
      const drifted = armNames.filter((arm) => existing.armDigests[arm] !== armDigests[arm]);
      if (drifted.length > 0) {
        return { ok: false, detail: `the sealed pair manifest no longer matches its arm artifacts: ${drifted.join(", ")}` };
      }
      return { ok: true, record: existing };
    }

    const record: PairRecord = { key: intent.key, arms: armNames, armDigests, sealedAt: new Date().toISOString() };
    await writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
    return { ok: true, record };
  }

  private async countDuplicate(key: ArmKey): Promise<void> {
    const file = this.path(DIRS.duplicates, armKeyId(key));
    const existing = await readJson<{ key: ArmKey; count: number }>(file);
    const count = (existing?.count ?? 0) + 1;
    await writeFileAtomic(file, `${JSON.stringify({ key, count }, null, 2)}\n`);
  }

  private async duplicateCount(): Promise<number> {
    const entries = await this.listJson<{ count: number }>(DIRS.duplicates);
    return entries.reduce((total, entry) => total + (typeof entry.value?.count === "number" ? entry.value.count : 0), 0);
  }

  private async quarantine(key: ArmKey | PairKey, reason: QuarantineReason, detail: string): Promise<void> {
    const id = "arm" in key ? armKeyId(key) : pairKeyId(key);
    await writeFileAtomic(
      this.path("quarantine", `${reason}-${id}`),
      `${JSON.stringify({ key, reason, detail, at: new Date().toISOString() }, null, 2)}\n`,
    );
  }

  private async readQuarantine(): Promise<readonly QuarantineEntry[]> {
    const entries = await this.listJson<QuarantineEntry>("quarantine");
    return entries.map((entry) => entry.value).filter((value): value is QuarantineEntry => Boolean(value?.reason));
  }

  private path(kind: string, id: string): string {
    return path.join(this.dir, kind, `${id}.json`);
  }

  private async listJson<T>(kind: string): Promise<readonly { id: string; value: T }[]> {
    const dir = path.join(this.dir, kind);
    const out: { id: string; value: T }[] = [];
    for (const file of await listFiles(dir)) {
      const value = await readJson<T>(path.join(dir, file));
      if (value !== null) out.push({ id: path.basename(file, ".json"), value });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------

function validateStoredArm(
  stored: StoredArm | null,
  filenameId: string,
  protocolArms: readonly string[],
): string | null {
  if (!stored) return "unreadable or not JSON";
  if (!isArmKey(stored.key)) return "stored key is missing required fields";
  if (armKeyId(stored.key) !== filenameId) return "stored key does not match the artifact's own id";
  if (!protocolArms.includes(stored.key.arm)) return `arm ${stored.key.arm} is outside the protocol roster`;
  if (typeof stored.payloadDigest !== "string" || stored.payloadDigest.length === 0) return "missing payload digest";
  if (typeof stored.payload !== "object" || stored.payload === null) return "missing payload";
  if (sha256(canonicalJson(stored.payload as Record<string, unknown>)) !== stored.payloadDigest) {
    return "payload does not match its recorded digest";
  }
  return null;
}

function isPairKey(value: unknown): value is PairKey {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    KEY_FIELDS.every((field) => (field === "repetition" ? typeof record[field] === "number" : typeof record[field] === "string"))
  );
}

function isArmKey(value: unknown): value is ArmKey {
  return isPairKey(value) && typeof (value as Record<string, unknown>)["arm"] === "string";
}

function samePairKey(a: PairKey, b: PairKey): boolean {
  return KEY_FIELDS.every((field) => a[field] === b[field]);
}

function summarize(
  quarantined: readonly QuarantineEntry[],
  incompletePairs: number,
  duplicatesCollapsed: number,
): MissingnessReport {
  const reasons: Record<QuarantineReason, number> = {
    "orphan-unpaired": 0,
    "conflicting-duplicate": 0,
    "incomplete-arm": 0,
    "key-mismatch": 0,
    "unexpected-arm": 0,
  };
  for (const entry of quarantined) reasons[entry.reason] += 1;
  return { quarantinedArms: quarantined.length, incompletePairs, duplicatesCollapsed, reasons };
}

async function listFiles(dir: string): Promise<readonly string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name).sort();
}

async function readJson<T>(file: string): Promise<T | null> {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Stable serialization, so a digest depends on the data and not on key order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
