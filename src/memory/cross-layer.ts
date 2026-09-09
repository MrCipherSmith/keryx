// Flow 242 (forgetting), lane E — the memory layer's answer to a reference
// into deleted wiki knowledge.
//
// Measured on a scratch project. `.metaproject/memory/decisions/charge-once.md`
// links `../../wiki/architecture/billing-charges.md` and cites the section ref
// `keryx:page/architecture-billing-charges#constraints`. The page is deleted.
//
//     $ keryx memory check
//     All checks passed.
//
// `checkMemory` (`./check.ts`) validated exactly one kind of outbound link —
// the `Related Scopes` → `Files:` list, against the filesystem — and nothing
// else. Every reference in an entry's PROSE, which is where an entry actually
// names the knowledge it depends on, was unexamined. So a memory entry whose
// whole justification had been removed reported clean, and a reader following
// the citation got the wiki's own answer for a ref nobody had ever registered.
//
// The verdicts below exist because "the target is not there" is not one fact.
// The wiki's identity registry (`../wiki/section-tombstone.ts`) can distinguish
// removed-with-a-record, removed-but-not-yet-recorded, present-but-not-the-same
// content, and no-record-at-all — and this module carries all four through
// instead of flattening them into "broken link", which is the flattening that
// `wiki check-links` still performs one layer over (it renders both a deleted
// page and a page that never existed as `(target not found)`).
//
// One honesty constraint drove the naming of `no-record`. The registry only
// ever holds pages that carry a `keryx:page` marker — `stableEntries` skips
// `version-bound` identities on purpose. So for an unmarked page, a removal
// leaves NO record anywhere, and "the registry has never heard of it" does not
// mean it never existed. `no-record` says exactly that and refuses to say more.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { collectPages } from "../wiki/collect";
import { buildSectionIndex, type SectionIndex } from "../wiki/section-index";
import {
  readSectionRegistryState,
  resolveSectionIdentity,
  type SectionRegistryRead,
} from "../wiki/section-tombstone";
import type { MemoryEntry } from "./types";

/** How an entry names the wiki knowledge it depends on. */
export type WikiReferenceKind =
  /** A Markdown link resolving inside `.metaproject/wiki/`. */
  | "page-path"
  /** A `keryx:page/<id>` or `keryx:page/<id>#<section>` identity. */
  | "section-ref";

export type WikiReference = {
  /** Memory-root-relative path of the entry holding it, e.g. `decisions/x.md`. */
  entry: string;
  kind: WikiReferenceKind;
  /** The reference as written. */
  raw: string;
  /** Wiki-relative path for `page-path`; the ref itself for `section-ref`. */
  target: string;
  /** 1-based line in the entry. */
  line: number;
};

const MARKDOWN_LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;
// `keryx:page/<id>` with an optional `#<section>`. Bounded to the id charset
// `section-marker.ts` enforces, so a sentence that merely contains the word
// does not become a reference.
const SECTION_REF_RE = /keryx:page\/[a-z0-9][a-z0-9._-]*(?:#[a-z0-9][a-z0-9._-]*)?/gi;

/**
 * Pull every wiki reference out of one entry's RAW bytes.
 *
 * Raw bytes rather than `MemoryEntry.summary`/`details`, deliberately: those
 * are two named sections, and an entry is free to cite the knowledge it depends
 * on anywhere — `parseEntry` (`./store.ts`) would silently drop a reference in
 * `Provenance` or in an unnamed section, and a check that misses references is
 * the thing being fixed.
 */
export function extractWikiReferences(
  entryRelativePath: string,
  entryAbsolutePath: string,
  content: string,
  wikiRoot: string,
): WikiReference[] {
  const references: WikiReference[] = [];
  const entryDir = path.dirname(entryAbsolutePath);
  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    const line = index + 1;

    for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
      const href = match[1];
      if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
        // An absolute URL scheme (http:, mailto:, keryx:) is not a file link.
        continue;
      }
      const withoutAnchor = href.split("#")[0] ?? "";
      if (withoutAnchor.length === 0) {
        continue;
      }
      const absolute = path.resolve(entryDir, withoutAnchor);
      const relativeToWiki = path.relative(wikiRoot, absolute);
      if (relativeToWiki.startsWith("..") || path.isAbsolute(relativeToWiki)) {
        continue;
      }
      references.push({
        entry: entryRelativePath,
        kind: "page-path",
        raw: href,
        target: relativeToWiki.split(path.sep).join("/"),
        line,
      });
    }

    for (const match of text.matchAll(SECTION_REF_RE)) {
      references.push({
        entry: entryRelativePath,
        kind: "section-ref",
        raw: match[0],
        target: match[0],
        line,
      });
    }
  }

  return references;
}

/**
 * What the wiki says about a reference held by memory.
 *
 * `undecidable` is a first-class answer and is never merged into the others:
 * with the registry unreadable, "removed" and "never recorded" cannot be told
 * apart, and reporting either one would be a claim the data does not support.
 */
export type CrossLayerState =
  | "intact"
  | "removed"
  | "pending-removal"
  | "reoccupied"
  | "no-record"
  | "undecidable";

export type CrossLayerFinding = {
  reference: WikiReference;
  state: CrossLayerState;
  /** Full sentence, suitable for a check issue message. */
  detail: string;
  /** When the target was removed, when that is on record. */
  removedAt: string | null;
};

/** A finding that leaves a live reference pointing at knowledge that is gone. */
export function isDangling(finding: CrossLayerFinding): boolean {
  return finding.state !== "intact";
}

export type WikiKnowledgeView = {
  index: SectionIndex;
  registry: SectionRegistryRead;
  /** Wiki-relative paths of the pages currently on disk. */
  presentPages: Set<string>;
  wikiRoot: string;
};

/** Read the wiki once, so a whole memory corpus can be checked against it. */
export async function loadWikiKnowledgeView(cwd: string): Promise<WikiKnowledgeView> {
  const wikiRoot = path.join(cwd, ".metaproject", "wiki");
  const pages = await collectPages(cwd);
  const index = buildSectionIndex(
    await Promise.all(
      pages.map(async (page) => ({
        page,
        content: await readFile(page.absolutePath, "utf8").catch(() => ""),
      })),
    ),
  );
  return {
    index,
    registry: await readSectionRegistryState(cwd),
    presentPages: new Set(pages.map((page) => page.relativePath)),
    wikiRoot,
  };
}

export function resolveWikiReference(view: WikiKnowledgeView, reference: WikiReference): CrossLayerFinding {
  return reference.kind === "section-ref"
    ? resolveSectionReference(view, reference)
    : resolvePageReference(view, reference);
}

function resolveSectionReference(view: WikiKnowledgeView, reference: WikiReference): CrossLayerFinding {
  const resolution = resolveSectionIdentity(view.index, view.registry, reference.target);
  switch (resolution.kind) {
    case "found":
    case "page-found":
      return { reference, state: "intact", detail: "resolves to live wiki knowledge.", removedAt: null };
    case "tombstoned":
      return {
        reference,
        state: "removed",
        detail:
          `cites \`${reference.target}\`, which the wiki records as REMOVED on ${resolution.tombstone.removedAt} ` +
          `(${resolution.tombstone.reason}). The citation is dangling: this entry still asserts knowledge the ` +
          "wiki no longer carries.",
        removedAt: resolution.tombstone.removedAt,
      };
    case "pending-tombstone":
      return {
        reference,
        state: "pending-removal",
        detail:
          `cites \`${reference.target}\`, which the wiki registered and no longer carries. The tombstone has not ` +
          "been written yet (`keryx sync --apply`, or `keryx wiki sections sync`). This is a removal in progress, " +
          'not "never existed".',
        removedAt: null,
      };
    case "reoccupied":
      return {
        reference,
        state: "reoccupied",
        detail:
          `cites \`${reference.target}\`, whose address is now held by different content in ` +
          `${resolution.occupantPage}. ${resolution.reason}`,
        removedAt: resolution.tombstone.removedAt,
      };
    case "registry-unreadable":
      return {
        reference,
        state: "undecidable",
        detail:
          `cites \`${reference.target}\`, and whether that was removed CANNOT BE DETERMINED: ${resolution.reason}`,
        removedAt: null,
      };
    case "stale-locator":
      return {
        reference,
        state: "undecidable",
        detail: `cites \`${reference.target}\`, a version-bound locator taken against an older body: ${resolution.reason}`,
        removedAt: null,
      };
    default:
      return {
        reference,
        state: "no-record",
        detail:
          `cites \`${reference.target}\`, which nothing in the wiki carries and nothing records as removed. ` +
          "The identity registry only records pages carrying a `keryx:page` marker, so this is NO RECORD — not " +
          "proof the knowledge never existed.",
        removedAt: null,
      };
  }
}

function resolvePageReference(view: WikiKnowledgeView, reference: WikiReference): CrossLayerFinding {
  // The unreadable check comes FIRST, before the page-is-present check, and
  // that order is the point. `resolveSectionIdentity` makes the same choice for
  // the same reason (lane B): a file sitting at the address is not proof the
  // reference resolves to what it named — the removal history is where a
  // reoccupation would be recorded, and with that history unreadable, "this is
  // the page you meant" is a claim nothing supports. Answering `intact` here
  // because a file exists was this module's own first version of the defect it
  // was written to remove.
  if (view.registry.state === "unreadable") {
    return {
      reference,
      state: "undecidable",
      detail:
        `links \`${reference.target}\`, and whether that is the page this entry meant CANNOT BE DETERMINED: ` +
        `${view.registry.reason}`,
      removedAt: null,
    };
  }
  const registry = view.registry.state === "present" ? view.registry.registry : null;
  const tombstone = registry?.tombstones.find((entry) => entry.page === reference.target && entry.kind === "page");

  if (view.presentPages.has(reference.target)) {
    // A file at the path is not the end of the question. Measured live: delete
    // the page, record the tombstone, then write a DIFFERENT document at the
    // same path — the link resolved `intact` and the entry went on citing a
    // stranger, while the section identity one level down correctly answered
    // `reoccupied`. A page path is an address, and an address can be reoccupied
    // exactly as an id can.
    const digest = view.index.pages.get(reference.target)?.contentDigest ?? null;
    if (tombstone && (tombstone.digest === null || digest === null || tombstone.digest !== digest)) {
      return {
        reference,
        state: "reoccupied",
        detail:
          `links \`${reference.target}\`, which the wiki records as REMOVED on ${tombstone.removedAt} ` +
          `(${tombstone.reason}) and where a document is present again. ` +
          (tombstone.digest === null || digest === null
            ? "Whether that is the same content restored or a different one written at the same path CANNOT be " +
              "determined here, so it is not returned as an ordinary link."
            : "Its content is NOT the content that was removed — a different document now holds this path, and " +
              "this entry is citing it as though it were the original."),
        removedAt: tombstone.removedAt,
      };
    }
    return { reference, state: "intact", detail: "resolves to a live wiki page.", removedAt: null };
  }
  if (tombstone) {
    return {
      reference,
      state: "removed",
      detail:
        `links \`${reference.target}\`, which the wiki records as REMOVED on ${tombstone.removedAt} ` +
        `(${tombstone.reason}). The link is dangling.`,
      removedAt: tombstone.removedAt,
    };
  }
  const registered = registry?.entries.find((entry) => entry.page === reference.target && entry.kind === "page");
  if (registered) {
    return {
      reference,
      state: "pending-removal",
      detail:
        `links \`${reference.target}\`, which the wiki registered as "${registered.title}" and no longer carries. ` +
        'The tombstone has not been written yet (`keryx sync --apply`). This is a removal in progress, not "never existed".',
      removedAt: null,
    };
  }
  return {
    reference,
    state: "no-record",
    detail:
      `links \`${reference.target}\`, which is not in the wiki and which the identity registry says nothing ` +
      "about. The registry only records pages carrying a `keryx:page` marker, so this is NO RECORD — it is not " +
      "evidence the page never existed.",
    removedAt: null,
  };
}

/**
 * Every cross-layer reference in the memory corpus, with the wiki's answer.
 *
 * Intact references are returned too. A caller that only ever sees problems
 * cannot tell "nothing is broken" from "nothing was looked at" — the same
 * collapse this lane exists to remove.
 */
export async function checkMemoryCrossLayer(
  cwd: string,
  entries: ReadonlyArray<MemoryEntry>,
  view?: WikiKnowledgeView,
): Promise<CrossLayerFinding[]> {
  const resolved = view ?? (await loadWikiKnowledgeView(cwd));
  const findings: CrossLayerFinding[] = [];
  for (const entry of entries) {
    const content = await readFile(entry.absolutePath, "utf8").catch(() => null);
    if (content === null) {
      // An entry this pass could not READ is the one case where returning
      // nothing for it is a lie. It was the first version of this loop: a
      // `continue`, and an unreadable entry then contributed zero findings —
      // indistinguishable, to `checkMemory` and to the propagation report, from
      // an entry that was read and found to cite nothing. `keryx memory check`
      // would have answered "All checks passed" over a corpus it could not
      // open, which is the exact collapse this lane exists to remove, one level
      // up from where it was found.
      //
      // `undecidable` is the honest state and it is load-bearing: it makes the
      // memory layer's inspection `failed` in `../forgetting/propagation.ts`,
      // so the whole reconcile reports `undecidable` rather than `clean`.
      findings.push({
        reference: {
          entry: entry.relativePath,
          kind: "page-path",
          raw: "(the entry itself)",
          target: entry.relativePath,
          line: 0,
        },
        state: "undecidable",
        detail:
          "could not be read, so whether it references removed knowledge CANNOT BE DETERMINED. It is reported " +
          "here rather than skipped: an unreadable entry contributing no findings would read exactly like an " +
          "entry that was checked and holds none.",
        removedAt: null,
      });
      continue;
    }
    for (const reference of extractWikiReferences(
      entry.relativePath,
      entry.absolutePath,
      content,
      resolved.wikiRoot,
    )) {
      findings.push(resolveWikiReference(resolved, reference));
    }
  }
  return findings;
}
