// AFC-W01 (flow 235, phase 3) — "Удаление оставляет missing binding/tombstone
// без автоматического redirect на одноимённый раздел."
//
// The failure this module exists to prevent was measured on a real page of
// this repository's own wiki before it existed: renaming
// `.metaproject/wiki/architecture/os-sandbox.md` produced a new id, dropped the
// old one with no diagnostic, and a DIFFERENT page moved into the vacated path
// then answered to the old id — a stale reference resolving to whatever now
// occupies the position. A plausible substitute is the defect; a tombstone
// saying the thing is gone is the correct answer.
//
// The registry is the only thing in this lane that touches the filesystem, and
// it is written ONLY by an explicit command (`keryx wiki sections sync`, and the
// marker migration). Retrieval never writes it — AC4's "чистое чтение не пишет"
// clause, which `wiki ask` violated before this phase by persisting the user's
// own query text into `.metaproject/runtime/wiki-ask/translations.json` from a
// tool declared `mutating: false` / `risk: "read"`.
//
// ---------------------------------------------------------------------------
// Flow 242 (forgetting), lane B. Three holes, each measured on a real scratch
// project before it was closed, each closing a case where an ABSENCE or a
// FAILURE was rendered as a positive claim.
//
// 1. A read failure became a destructive write. `readSectionRegistryState`
//    replaces the old `readJsonFileOr(path, EMPTY)` read, whose bare `catch`
//    turned EACCES, EIO and a half-written file into "the registry is empty".
//    With the registry `chmod 000` and seven genuine tombstones on it, `resolve`
//    answered "nothing records it as removed" and `sync` then wrote that empty
//    history back over the file at exit 0. A registry that could not be read is
//    now its own named state, and a sync that hits it REFUSES and writes
//    nothing.
//
// 2. Delete a page and create a different document at the same path, and the
//    page id is re-minted from the path. The tombstone was overridden with no
//    diagnostic (`resolveSectionIdentity` looked at `index.sections` first) and
//    then erased (`diffSectionRegistry` classified it `revived`). The earlier
//    fix closed the RENAME case; this is delete-then-recreate-in-place. The
//    distinction that decides it is content: a registry entry now carries the
//    digest it was registered with, so an identity that comes back byte
//    identical is a restoration (`found`, with its removal history attached) and
//    one that comes back different is a REOCCUPATION — a separate answer that
//    hands back both the tombstone and the occupant and never passes for an
//    ordinary `found`. A tombstone written before digests were recorded cannot
//    decide between the two, so it says `unverifiable` rather than guessing.
//
// 3. Between deleting a page and running `sync`, the registry still holds the
//    identity as a live entry while the index no longer carries it — the data
//    that `sync --dry-run` uses to name the pending tombstone. `resolve` never
//    looked at `registry.entries` and answered `unknown`, so in the interruption
//    window a deleted ref read as never-existed. That window is now its own
//    answer, `pending-tombstone`.

import path from "node:path";
import { stat } from "node:fs/promises";
import { isNotFound, writeFileAtomic } from "../lib/fs";
import { readJsonObjectFile } from "../lib/json";
import {
  parseProvisionalSectionId,
  type SectionIndex,
  type WikiSectionRecord,
} from "./section-index";

/**
 * 2 adds `digest` and `registeredAt` to an entry, and `lifted` to the registry.
 * A version-1 file still reads: its entries carry `null` for both new fields,
 * which is what makes `unverifiable` a state the code has to have rather than a
 * hypothetical.
 */
export const SECTION_REGISTRY_VERSION = 2;

export type RegistryKind = "page" | "section";

export type RegistryEntry = {
  kind: RegistryKind;
  /** `keryx:page/<id>` for a page, `keryx:page/<id>#<sectionId>` for a section. */
  ref: string;
  page: string;
  title: string;
  /**
   * What the identity CONTAINED when it was registered: the section body digest,
   * or the whole file digest for a page. This is the whole basis on which a
   * returning id is judged a restoration or a reoccupation, so it is recorded at
   * registration time rather than reconstructed later. `null` on an entry
   * written before registry version 2 — and a null here is never read as "the
   * content matches".
   */
  digest: string | null;
  /** When this identity was first registered. `null` on a pre-version-2 entry. */
  registeredAt: string | null;
};

export type TombstoneEntry = RegistryEntry & {
  removedAt: string;
  reason: string;
};

/**
 * A tombstone that was lifted, kept rather than deleted.
 *
 * AC6 of flow 242: the record of a removal is not destroyed by the same call
 * that reverses it. Before this, reviving an id dropped its tombstone on the
 * floor, so a section that had been deleted and restored was indistinguishable
 * from one that had never moved.
 */
export type LiftedTombstone = TombstoneEntry & {
  restoredAt: string;
  restoredReason: string;
};

export type SectionRegistry = {
  version: number;
  entries: RegistryEntry[];
  tombstones: TombstoneEntry[];
  lifted: LiftedTombstone[];
};

export function sectionRegistryPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "wiki", ".sections.json");
}

export function emptySectionRegistry(): SectionRegistry {
  return { version: SECTION_REGISTRY_VERSION, entries: [], tombstones: [], lifted: [] };
}

/**
 * What is on disk, in the three states a caller genuinely has to tell apart.
 *
 * `absent` is "this project has never been synced" — a legitimate empty
 * history. `unreadable` is "there IS a history and I could not read it", which
 * is not an empty history and must never be written over as though it were.
 */
export type SectionRegistryRead =
  | { state: "absent"; path: string }
  | { state: "present"; path: string; registry: SectionRegistry }
  | { state: "unreadable"; path: string; reason: string };

function describeJsonValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  return `a ${typeof value}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

type ParsedEntry<T> = { ok: true; value: T } | { ok: false };

function parseEntry(value: unknown): ParsedEntry<RegistryEntry> {
  if (!isRecord(value)) {
    return { ok: false };
  }
  const kind = value["kind"];
  const ref = value["ref"];
  if ((kind !== "page" && kind !== "section") || typeof ref !== "string" || ref.length === 0) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      kind,
      ref,
      page: stringOr(value["page"], ""),
      title: stringOr(value["title"], ref),
      digest: nullableString(value["digest"]),
      registeredAt: nullableString(value["registeredAt"]),
    },
  };
}

function parseTombstone(value: unknown): ParsedEntry<TombstoneEntry> {
  const base = parseEntry(value);
  if (!base.ok || !isRecord(value)) {
    return { ok: false };
  }
  const removedAt = value["removedAt"];
  if (typeof removedAt !== "string" || removedAt.length === 0) {
    return { ok: false };
  }
  return {
    ok: true,
    value: { ...base.value, removedAt, reason: stringOr(value["reason"], "no reason was recorded") },
  };
}

function parseLifted(value: unknown): ParsedEntry<LiftedTombstone> {
  const base = parseTombstone(value);
  if (!base.ok || !isRecord(value)) {
    return { ok: false };
  }
  const restoredAt = value["restoredAt"];
  if (typeof restoredAt !== "string" || restoredAt.length === 0) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      ...base.value,
      restoredAt,
      restoredReason: stringOr(value["restoredReason"], "no reason was recorded"),
    },
  };
}

/**
 * Read the registry, and say which of the three things happened.
 *
 * Every damaged record is counted, and ANY damaged record makes the whole read
 * `unreadable`. That is deliberate and it is the point of this function: the
 * alternative — silently dropping the records that would not parse — hands a
 * caller a registry that looks complete and is not, and the next `sync` writes
 * the survivors back and destroys the rest. A partly damaged history is a fault
 * to be reported and repaired, not a smaller history.
 */
export async function readSectionRegistryState(cwd: string): Promise<SectionRegistryRead> {
  const file = sectionRegistryPath(cwd);

  try {
    await stat(file);
  } catch (error) {
    if (isNotFound(error)) {
      return { state: "absent", path: file };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: "unreadable",
      path: file,
      reason: `the section registry could not be examined (${message}). This is not the same as "no registry": the file may exist and hold removal history.`,
    };
  }

  const read = await readJsonObjectFile(file);
  if (read.state === "unreadable") {
    return {
      state: "unreadable",
      path: file,
      reason:
        "the section registry exists but could not be read or parsed — a permission, a device error, or a truncated write. " +
        "Its removal history is present on disk and is NOT empty just because this read failed.",
    };
  }
  if (read.state === "non-object") {
    return {
      state: "unreadable",
      path: file,
      reason: `the section registry parsed to ${describeJsonValue(read.value)}, not to a registry object.`,
    };
  }

  const raw = read.value;
  const entries: RegistryEntry[] = [];
  const tombstones: TombstoneEntry[] = [];
  const lifted: LiftedTombstone[] = [];
  let damaged = 0;

  const rawEntries = Array.isArray(raw["entries"]) ? raw["entries"] : [];
  for (const item of rawEntries) {
    const parsed = parseEntry(item);
    if (parsed.ok) {
      entries.push(parsed.value);
    } else {
      damaged += 1;
    }
  }
  const rawTombstones = Array.isArray(raw["tombstones"]) ? raw["tombstones"] : [];
  for (const item of rawTombstones) {
    const parsed = parseTombstone(item);
    if (parsed.ok) {
      tombstones.push(parsed.value);
    } else {
      damaged += 1;
    }
  }
  const rawLifted = Array.isArray(raw["lifted"]) ? raw["lifted"] : [];
  for (const item of rawLifted) {
    const parsed = parseLifted(item);
    if (parsed.ok) {
      lifted.push(parsed.value);
    } else {
      damaged += 1;
    }
  }

  if (damaged > 0) {
    return {
      state: "unreadable",
      path: file,
      reason: `the section registry holds ${damaged} record${damaged === 1 ? "" : "s"} that could not be parsed. The rest is not reported as the whole history, because writing the readable part back would destroy the damaged part.`,
    };
  }

  return {
    state: "present",
    path: file,
    registry: {
      version: typeof raw["version"] === "number" ? raw["version"] : 0,
      entries,
      tombstones,
      lifted,
    },
  };
}

export async function writeSectionRegistry(cwd: string, registry: SectionRegistry): Promise<void> {
  await writeFileAtomic(sectionRegistryPath(cwd), `${JSON.stringify(registry, null, 2)}\n`);
}

/** Only identities that can actually be promised are registered. */
function stableEntries(index: SectionIndex, now: string): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  for (const [relativePath, identity] of index.pageIdentities) {
    if (identity.stability !== "stable") {
      continue;
    }
    const page = index.pages.get(relativePath);
    entries.push({
      kind: "page",
      ref: identity.pageId,
      page: relativePath,
      title: page?.sections[0]?.pageTitle ?? relativePath,
      digest: page?.contentDigest ?? null,
      registeredAt: now,
    });
  }
  for (const section of index.sections) {
    if (section.stability !== "stable") {
      continue;
    }
    entries.push({
      kind: "section",
      ref: section.sectionRef,
      page: section.pageRelativePath,
      title: section.title,
      digest: section.digest,
      registeredAt: now,
    });
  }
  return entries.sort((a, b) => a.ref.localeCompare(b.ref));
}

/** Why a returning identity was judged the way it was. Never a guess. */
export type ReoccupationEvidence = "different-content" | "unverifiable";

export type ReoccupiedIdentity = {
  ref: string;
  tombstone: TombstoneEntry;
  /** What holds the address now. */
  current: RegistryEntry;
  evidence: ReoccupationEvidence;
  reason: string;
};

export type RegistryDiff = {
  next: SectionRegistry;
  added: RegistryEntry[];
  tombstoned: TombstoneEntry[];
  /**
   * A tombstoned id that is present again AND carries the content it was
   * removed with — a genuine restoration. Its tombstone moves to `lifted`.
   */
  revived: RegistryEntry[];
  /**
   * A tombstoned id that is present again holding something else. Its tombstone
   * is KEPT: the address is occupied by a different document and answering
   * `found` for it is the defect this lane exists to close.
   */
  reoccupied: ReoccupiedIdentity[];
};

export type DiffOptions = {
  now: string;
  reason?: string;
  /**
   * Refs whose reoccupation an operator has explicitly accepted. Without this
   * the reoccupied state has no exit that is not "delete the registry", which is
   * a dead end wearing the costume of a safety property.
   */
  acceptReoccupation?: ReadonlyArray<string>;
};

/**
 * Diff the freshly built index against what was registered last time.
 *
 * An id that was registered and is now absent becomes a tombstone. This is the
 * whole mechanism: without a persisted record of what once existed, "deleted"
 * and "never existed" are the same observation, which is the second recurring
 * defect class of this programme (a failure rendered indistinguishable from a
 * legitimate empty result).
 *
 * An id that comes BACK is the flow-242 addition, and it splits in two. Byte
 * identical content at the same address is a restoration and the tombstone is
 * lifted — kept, with the moment it was lifted, not deleted. Different content
 * is a reoccupation, and the tombstone stays: the id was re-minted from a path
 * by a document that has nothing to do with the one that was removed.
 */
export function diffSectionRegistry(
  previous: SectionRegistry,
  index: SectionIndex,
  options: DiffOptions,
): RegistryDiff {
  const now = options.now;
  const previousByRef = new Map(previous.entries.map((entry) => [entry.ref, entry]));
  const accepted = new Set(options.acceptReoccupation ?? []);

  // Registration time is a property of the identity, not of this run: an entry
  // that was already registered keeps the moment it first appeared.
  const current = stableEntries(index, now).map((entry) => {
    const before = previousByRef.get(entry.ref);
    return before?.registeredAt ? { ...entry, registeredAt: before.registeredAt } : entry;
  });
  const currentByRef = new Map(current.map((entry) => [entry.ref, entry]));

  const added = current.filter((entry) => !previousByRef.has(entry.ref));

  const tombstoned: TombstoneEntry[] = [];
  for (const entry of previous.entries) {
    if (currentByRef.has(entry.ref)) {
      continue;
    }
    tombstoned.push({
      ...entry,
      removedAt: now,
      reason:
        options.reason ??
        `${entry.kind === "page" ? "page" : "section"} "${entry.title}" is no longer present in ${entry.page}`,
    });
  }

  const revived: RegistryEntry[] = [];
  const reoccupied: ReoccupiedIdentity[] = [];
  const newlyLifted: LiftedTombstone[] = [];

  for (const tombstone of previous.tombstones) {
    const back = currentByRef.get(tombstone.ref);
    if (!back) {
      continue;
    }
    if (accepted.has(tombstone.ref)) {
      revived.push(back);
      newlyLifted.push({
        ...tombstone,
        restoredAt: now,
        restoredReason:
          "an operator accepted this reoccupation explicitly (`--accept-reoccupation`); the content at this address is NOT the content that was removed.",
      });
      continue;
    }
    if (tombstone.digest !== null && back.digest !== null && tombstone.digest === back.digest) {
      revived.push(back);
      newlyLifted.push({
        ...tombstone,
        restoredAt: now,
        restoredReason:
          "the identity is present again and its content is byte-identical to what was removed — a restoration, not a substitution.",
      });
      continue;
    }
    const evidence: ReoccupationEvidence =
      tombstone.digest === null || back.digest === null ? "unverifiable" : "different-content";
    reoccupied.push({
      ref: tombstone.ref,
      tombstone,
      current: back,
      evidence,
      reason:
        evidence === "different-content"
          ? `this identity was removed on ${tombstone.removedAt} and is present again in ${back.page} holding DIFFERENT content. The id was re-minted at the same address; the tombstone is kept and this is not reported as a revival.`
          : `this identity was removed on ${tombstone.removedAt} and is present again in ${back.page}, but the tombstone predates content recording, so restoration and substitution cannot be told apart here. The tombstone is kept rather than guessed away.`,
    });
  }

  const revivedRefs = new Set(revived.map((entry) => entry.ref));
  const tombstonedRefs = new Set(tombstoned.map((entry) => entry.ref));
  const tombstones = [
    ...previous.tombstones.filter(
      (tombstone) => !revivedRefs.has(tombstone.ref) && !tombstonedRefs.has(tombstone.ref),
    ),
    ...tombstoned,
  ].sort((a, b) => a.ref.localeCompare(b.ref));

  const lifted = [...previous.lifted, ...newlyLifted].sort(
    (a, b) => a.ref.localeCompare(b.ref) || a.removedAt.localeCompare(b.removedAt),
  );

  return {
    next: { version: SECTION_REGISTRY_VERSION, entries: current, tombstones, lifted },
    added,
    tombstoned,
    revived,
    reoccupied,
  };
}

/**
 * The outcome of a sync, with refusal as a first-class result.
 *
 * `refused` is not an error path bolted on: it is the answer AC3 of flow 242
 * asks for — "нет прав, хранилище нечитаемо" is a named outcome distinct both
 * from a successful sync and from "there was nothing to do". Before this, a sync
 * over an unreadable registry reported `registered 7, added 7, tombstoned 0` and
 * exited 0 while deleting seven tombstone records.
 */
export type RegistrySync =
  | { status: "refused"; reason: string; registryPath: string }
  | ({ status: "synced"; dryRun: boolean; registryPath: string } & RegistryDiff);

/**
 * `keryx wiki sections sync` — the ONE write in this lane.
 *
 * Kept as an explicit command rather than a side effect of retrieval, because
 * AC4's "чистое чтение не пишет" clause means a search must leave the working
 * tree untouched. `wikiAsk` builds its index in memory and never calls this.
 *
 * It refuses in two ways and writes nothing in either: when the previous
 * registry could not be read (writing would replace a history it never saw),
 * and when the write itself fails (a read-only directory is a refusal, not a
 * completed sync).
 */
export async function syncSectionRegistry(
  cwd: string,
  index: SectionIndex,
  options: {
    now?: string;
    reason?: string;
    dryRun?: boolean;
    acceptReoccupation?: ReadonlyArray<string>;
  } = {},
): Promise<RegistrySync> {
  const read = await readSectionRegistryState(cwd);
  if (read.state === "unreadable") {
    return {
      status: "refused",
      registryPath: read.path,
      reason:
        `${read.reason} Refusing to sync: this run would write a registry built from a history it could not read, ` +
        `which permanently destroys every tombstone on disk. Repair or restore ${read.path} (check its permissions first), then run the sync again.`,
    };
  }
  const previous = read.state === "present" ? read.registry : emptySectionRegistry();
  const diff = diffSectionRegistry(previous, index, {
    now: options.now ?? new Date().toISOString(),
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.acceptReoccupation ? { acceptReoccupation: options.acceptReoccupation } : {}),
  });

  const dryRun = options.dryRun === true;
  if (!dryRun) {
    try {
      await writeSectionRegistry(cwd, diff.next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "refused",
        registryPath: read.path,
        reason: `the section registry could not be written (${message}). Nothing was changed: the registry on disk still holds the previous history.`,
      };
    }
  }

  return { status: "synced", dryRun, registryPath: read.path, ...diff };
}

/** How an identity that is present today relates to a removal on record. */
export type RemovalHistory = {
  removedAt: string;
  reason: string;
  /** When the tombstone was lifted, or `null` when the sync has not run yet. */
  restoredAt: string | null;
};

export type SectionResolution =
  | {
      kind: "found";
      section: WikiSectionRecord;
      /** Non-null when this address was removed and came back. */
      history: RemovalHistory | null;
    }
  | { kind: "page-found"; page: string; pageId: string; history: RemovalHistory | null }
  | { kind: "tombstoned"; tombstone: TombstoneEntry }
  | {
      kind: "reoccupied";
      tombstone: TombstoneEntry;
      /** The section now at this address, or null when a PAGE id was reoccupied. */
      section: WikiSectionRecord | null;
      /** The wiki-relative path of whatever holds the address now. */
      occupantPage: string;
      evidence: ReoccupationEvidence;
      reason: string;
    }
  | {
      kind: "pending-tombstone";
      entry: RegistryEntry;
      reason: string;
    }
  | {
      kind: "stale-locator";
      page: string;
      reason: string;
      /** What the locator was taken against, for a bounded next action. */
      recordedPageVersion: string | null;
      currentPageVersion: string | null;
    }
  | { kind: "registry-unreadable"; registryPath: string; reason: string }
  | { kind: "unknown"; reason: string };

function historyFor(
  registry: SectionRegistry,
  ref: string,
  digest: string | null,
): RemovalHistory | null {
  const tombstone = registry.tombstones.find((entry) => entry.ref === ref);
  if (tombstone && digest !== null && tombstone.digest === digest) {
    // Present again with the content it was removed with, and `sync` has not
    // been run since — a restoration in the interruption window.
    return { removedAt: tombstone.removedAt, reason: tombstone.reason, restoredAt: null };
  }
  const lifted = [...registry.lifted]
    .filter((entry) => entry.ref === ref)
    .sort((a, b) => b.restoredAt.localeCompare(a.restoredAt))[0];
  if (lifted) {
    return { removedAt: lifted.removedAt, reason: lifted.reason, restoredAt: lifted.restoredAt };
  }
  return null;
}

/**
 * Resolve an identity, and NEVER substitute.
 *
 * The rule that matters is the one this function does not implement: there is
 * no title fallback, no nearest-heading match and no same-name redirect. A
 * removed id resolves to its tombstone; an unknown id resolves to unknown; a
 * provisional locator taken against an older body resolves to `stale-locator`
 * rather than reading the new body at the old offsets (spec §2: "query не
 * смешивает старые offsets с новым body").
 *
 * Flow 242 adds the three answers it had been collapsing into the other five.
 *
 * - The registry could not be read. Every one of this function's answers is a
 *   claim about history, so with the history unreadable it makes none: it
 *   returns `registry-unreadable`, including for an id that IS in the index,
 *   because an occupied address whose removal record cannot be consulted is
 *   exactly the case where `found` was the lie.
 * - The address is occupied by a document that is not the one that was removed
 *   (`reoccupied`). The page id is derived from the file path, so deleting a
 *   page and writing a different one at that path re-mints the id — and the
 *   index hit was being returned as an ordinary `found`, with content that
 *   contradicted the tombstoned section.
 * - The identity is registered, is gone from the index, and `sync` has not run
 *   (`pending-tombstone`). The registry holds the evidence; it simply was not
 *   being read.
 */
export function resolveSectionIdentity(
  index: SectionIndex,
  registry: SectionRegistryRead,
  ref: string,
): SectionResolution {
  if (registry.state === "unreadable") {
    return {
      kind: "registry-unreadable",
      registryPath: registry.path,
      reason:
        `${registry.reason} Every answer here is a claim about what this project has removed, so none is made: ` +
        `"present", "removed" and "never existed" cannot be told apart while ${registry.path} is unreadable.`,
    };
  }
  const history = registry.state === "present" ? registry.registry : emptySectionRegistry();

  const exact = index.sections.find((section) => section.sectionRef === ref);
  if (exact) {
    const tombstone = history.tombstones.find((entry) => entry.ref === ref);
    if (tombstone && tombstone.digest !== exact.digest) {
      return {
        kind: "reoccupied",
        tombstone,
        section: exact,
        occupantPage: exact.pageRelativePath,
        evidence: tombstone.digest === null ? "unverifiable" : "different-content",
        reason: reoccupationReason(tombstone, exact.pageRelativePath),
      };
    }
    return { kind: "found", section: exact, history: historyFor(history, ref, exact.digest) };
  }

  for (const [relativePath, identity] of index.pageIdentities) {
    if (identity.pageId !== ref) {
      continue;
    }
    const digest = index.pages.get(relativePath)?.contentDigest ?? null;
    const tombstone = history.tombstones.find((entry) => entry.ref === ref);
    if (tombstone && tombstone.digest !== digest) {
      return {
        kind: "reoccupied",
        tombstone,
        section: null,
        occupantPage: relativePath,
        evidence: tombstone.digest === null || digest === null ? "unverifiable" : "different-content",
        reason: reoccupationReason(tombstone, relativePath),
      };
    }
    return {
      kind: "page-found",
      page: relativePath,
      pageId: identity.pageId,
      history: historyFor(history, ref, digest),
    };
  }

  const tombstone = history.tombstones.find((entry) => entry.ref === ref);
  if (tombstone) {
    return { kind: "tombstoned", tombstone };
  }

  // Registered, absent from the index, and no tombstone yet: the deletion has
  // happened and `keryx wiki sections sync` has not. The registry names it, so
  // "never existed" is a false answer that the data in hand already refutes.
  const registered = history.entries.find((entry) => entry.ref === ref);
  if (registered) {
    return {
      kind: "pending-tombstone",
      entry: registered,
      reason:
        `this identity is recorded in the registry as ${registered.kind === "page" ? "a page" : "a section"} ` +
        `"${registered.title}" in ${registered.page}${registered.registeredAt ? `, registered ${registered.registeredAt}` : ""}, ` +
        "and nothing in the wiki carries it now. It was REMOVED and `keryx wiki sections sync` has not run since — " +
        "run it to write the tombstone. This is not \"never existed\".",
    };
  }

  const hash = ref.indexOf("#");
  if (hash > 0) {
    const pageRef = ref.slice(0, hash);
    const sectionId = ref.slice(hash + 1);
    const provisional = parseProvisionalSectionId(sectionId);
    if (provisional) {
      const owner = [...index.pageIdentities.entries()].find(
        ([, identity]) => identity.pageId === pageRef,
      );
      if (owner) {
        const [relativePath] = owner;
        const page = index.pages.get(relativePath);
        return {
          kind: "stale-locator",
          page: relativePath,
          reason:
            "this is a version-bound provisional locator and the page's body has changed since it was taken; " +
            "it is not resolved against the new body. Re-query the page, or migrate it to stable section markers.",
          recordedPageVersion: provisional.pageVersion,
          currentPageVersion: page?.pageVersion ?? null,
        };
      }
    }
  }

  return {
    kind: "unknown",
    reason:
      "no section or page carries this identity, and nothing records it as removed. " +
      "It is not resolved to a similarly titled section.",
  };
}

function reoccupationReason(tombstone: TombstoneEntry, occupantPage: string): string {
  if (tombstone.digest === null) {
    return (
      `this identity was removed on ${tombstone.removedAt} (${tombstone.reason}) and something now occupies the ` +
      `same address in ${occupantPage}. The tombstone predates content recording, so whether this is the same ` +
      "content restored or a different document that re-minted the id CANNOT be determined here. It is not " +
      "returned as an ordinary result."
    );
  }
  return (
    `this identity was removed on ${tombstone.removedAt} (${tombstone.reason}) and a DIFFERENT document now ` +
    `occupies the same address in ${occupantPage}. The id is derived from the path, so a new document written ` +
    "there re-mints it; the content here is not the content that was removed, and it is not returned as one. " +
    "Give the new document its own id, or accept the reoccupation explicitly with " +
    "`keryx wiki sections sync --accept-reoccupation <ref>`."
  );
}
