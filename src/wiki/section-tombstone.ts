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

import path from "node:path";
import { readJsonFileOr } from "../lib/json";
import { writeFileAtomic } from "../lib/fs";
import {
  parseProvisionalSectionId,
  type SectionIndex,
  type WikiSectionRecord,
} from "./section-index";

export const SECTION_REGISTRY_VERSION = 1;

export type RegistryKind = "page" | "section";

export type RegistryEntry = {
  kind: RegistryKind;
  /** `keryx:page/<id>` for a page, `keryx:page/<id>#<sectionId>` for a section. */
  ref: string;
  page: string;
  title: string;
};

export type TombstoneEntry = RegistryEntry & {
  removedAt: string;
  reason: string;
};

export type SectionRegistry = {
  version: number;
  entries: RegistryEntry[];
  tombstones: TombstoneEntry[];
};

export function sectionRegistryPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "wiki", ".sections.json");
}

const EMPTY: SectionRegistry = { version: SECTION_REGISTRY_VERSION, entries: [], tombstones: [] };

export async function readSectionRegistry(cwd: string): Promise<SectionRegistry> {
  const raw = await readJsonFileOr<unknown>(sectionRegistryPath(cwd), EMPTY);
  if (raw === null || typeof raw !== "object") {
    return { version: SECTION_REGISTRY_VERSION, entries: [], tombstones: [] };
  }
  const value = raw as Partial<SectionRegistry>;
  return {
    version: SECTION_REGISTRY_VERSION,
    entries: Array.isArray(value.entries) ? value.entries : [],
    tombstones: Array.isArray(value.tombstones) ? value.tombstones : [],
  };
}

export async function writeSectionRegistry(cwd: string, registry: SectionRegistry): Promise<void> {
  await writeFileAtomic(sectionRegistryPath(cwd), `${JSON.stringify(registry, null, 2)}\n`);
}

/** Only identities that can actually be promised are registered. */
function stableEntries(index: SectionIndex): RegistryEntry[] {
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
    });
  }
  return entries.sort((a, b) => a.ref.localeCompare(b.ref));
}

export type RegistrySync = {
  next: SectionRegistry;
  added: RegistryEntry[];
  tombstoned: TombstoneEntry[];
  /** An id that had a tombstone and is present again — the tombstone is lifted. */
  revived: RegistryEntry[];
};

/**
 * Diff the freshly built index against what was registered last time.
 *
 * An id that was registered and is now absent becomes a tombstone. This is the
 * whole mechanism: without a persisted record of what once existed, "deleted"
 * and "never existed" are the same observation, which is the second recurring
 * defect class of this programme (a failure rendered indistinguishable from a
 * legitimate empty result).
 */
export function diffSectionRegistry(
  previous: SectionRegistry,
  index: SectionIndex,
  options: { now: string; reason?: string },
): RegistrySync {
  const current = stableEntries(index);
  const currentRefs = new Set(current.map((entry) => entry.ref));
  const previousRefs = new Map(previous.entries.map((entry) => [entry.ref, entry]));

  const added = current.filter((entry) => !previousRefs.has(entry.ref));

  const tombstoned: TombstoneEntry[] = [];
  for (const entry of previous.entries) {
    if (currentRefs.has(entry.ref)) {
      continue;
    }
    tombstoned.push({
      ...entry,
      removedAt: options.now,
      reason:
        options.reason ??
        `${entry.kind === "page" ? "page" : "section"} "${entry.title}" is no longer present in ${entry.page}`,
    });
  }

  const revived = current.filter((entry) =>
    previous.tombstones.some((tombstone) => tombstone.ref === entry.ref),
  );
  const revivedRefs = new Set(revived.map((entry) => entry.ref));

  const tombstones = [
    ...previous.tombstones.filter(
      (tombstone) => !revivedRefs.has(tombstone.ref) && !tombstoned.some((t) => t.ref === tombstone.ref),
    ),
    ...tombstoned,
  ].sort((a, b) => a.ref.localeCompare(b.ref));

  return {
    next: { version: SECTION_REGISTRY_VERSION, entries: current, tombstones },
    added,
    tombstoned,
    revived,
  };
}

/**
 * `keryx wiki sections sync` — the ONE write in this lane.
 *
 * Kept as an explicit command rather than a side effect of retrieval, because
 * AC4's "чистое чтение не пишет" clause means a search must leave the working
 * tree untouched. `wikiAsk` builds its index in memory and never calls this.
 */
export async function syncSectionRegistry(
  cwd: string,
  index: SectionIndex,
  options: { now?: string; reason?: string; dryRun?: boolean } = {},
): Promise<RegistrySync> {
  const previous = await readSectionRegistry(cwd);
  const sync = diffSectionRegistry(previous, index, {
    now: options.now ?? new Date().toISOString(),
    ...(options.reason ? { reason: options.reason } : {}),
  });
  if (!options.dryRun) {
    await writeSectionRegistry(cwd, sync.next);
  }
  return sync;
}

export type SectionResolution =
  | { kind: "found"; section: WikiSectionRecord }
  | { kind: "page-found"; page: string; pageId: string }
  | { kind: "tombstoned"; tombstone: TombstoneEntry }
  | {
      kind: "stale-locator";
      page: string;
      reason: string;
      /** What the locator was taken against, for a bounded next action. */
      recordedPageVersion: string | null;
      currentPageVersion: string | null;
    }
  | { kind: "unknown"; reason: string };

/**
 * Resolve an identity, and NEVER substitute.
 *
 * The rule that matters is the one this function does not implement: there is
 * no title fallback, no nearest-heading match and no same-name redirect. A
 * removed id resolves to its tombstone; an unknown id resolves to unknown; a
 * provisional locator taken against an older body resolves to `stale-locator`
 * rather than reading the new body at the old offsets (spec §2: "query не
 * смешивает старые offsets с новым body").
 */
export function resolveSectionIdentity(
  index: SectionIndex,
  registry: SectionRegistry,
  ref: string,
): SectionResolution {
  const exact = index.sections.find((section) => section.sectionRef === ref);
  if (exact) {
    return { kind: "found", section: exact };
  }

  for (const [relativePath, identity] of index.pageIdentities) {
    if (identity.pageId === ref) {
      return { kind: "page-found", page: relativePath, pageId: identity.pageId };
    }
  }

  const tombstone = registry.tombstones.find((entry) => entry.ref === ref);
  if (tombstone) {
    return { kind: "tombstoned", tombstone };
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
