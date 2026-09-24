// Flow 313 (W4 portability), T6 — manifest parse/serialize against
// `portable-bundle.schema.json`, plus the structural checks the schema alone
// cannot express (duplicate paths, formatVersion major, kind/path shape).

import manifestSchemaJson from "../../docs/requirements/keryx-agent-platform-expansion/schemas/portable-bundle.schema.json" with {
  type: "json",
};
import { validateAgainstSchemaObject } from "../contracts/validator";
import { DEFAULT_BUNDLE_LIMITS } from "./archive";
import { caseFold, normalizeBundlePath, validateKindPath } from "./paths";
import { BUNDLE_FORMAT_VERSION, BUNDLE_REFUSAL, type BundleContentEntry, type BundleManifest, type BundleRefusal } from "./types";

export type ParseManifestResult = { ok: true; manifest: BundleManifest } | { ok: false; refusals: BundleRefusal[] };

function majorOf(version: string): string {
  return version.split(".")[0] ?? version;
}

export function parseManifest(bytes: Buffer | string): ParseManifestResult {
  let data: unknown;
  try {
    data = JSON.parse(typeof bytes === "string" ? bytes : bytes.toString("utf8"));
  } catch (err) {
    return {
      ok: false,
      refusals: [{ reason: BUNDLE_REFUSAL.schemaInvalid, message: `bundle.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }

  // R3-F19: the entry-count cap runs BEFORE the full JSON-schema validation
  // below, not only before the per-entry loop that used to follow it — a
  // structurally-valid-shaped `contents` array with hundreds of thousands of
  // entries made `validateAgainstSchemaObject` itself (which walks and
  // validates every entry against the schema) the expensive step (6s / 1.68
  // GB at ~100k entries), not the loop the R2-F4 fix already capped. This is
  // a cheap, manual shape check — `Array.isArray`, not full validation — so
  // it costs O(1) regardless of how large an oversized `contents` claims to
  // be, and runs even before we know the rest of the document is otherwise
  // schema-valid.
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const contents = (data as Record<string, unknown>).contents;
    if (Array.isArray(contents) && contents.length > DEFAULT_BUNDLE_LIMITS.maxEntries) {
      return {
        ok: false,
        refusals: [
          {
            reason: BUNDLE_REFUSAL.archiveTooLarge,
            message: `manifest lists ${contents.length} contents entries, more than the ${DEFAULT_BUNDLE_LIMITS.maxEntries}-entry cap`,
          },
        ],
      };
    }
  }

  const validation = validateAgainstSchemaObject(manifestSchemaJson as Record<string, unknown>, data);
  if (!validation.valid) {
    return {
      ok: false,
      refusals: validation.errors.map((e) => ({ reason: BUNDLE_REFUSAL.schemaInvalid, path: e.path, message: e.message })),
    };
  }

  const manifest = data as BundleManifest;

  if (majorOf(manifest.formatVersion) !== majorOf(BUNDLE_FORMAT_VERSION)) {
    return {
      ok: false,
      refusals: [
        {
          reason: BUNDLE_REFUSAL.unsupportedFormatVersion,
          message: `bundle formatVersion ${manifest.formatVersion} major does not match the supported ${BUNDLE_FORMAT_VERSION} major`,
        },
      ],
    };
  }

  // R2-F4 (kept as defense-in-depth): re-checked post-schema-validation too,
  // in case a future schema change ever lets `contents` through without
  // being an array at the point the cheap check above runs.
  if (manifest.contents.length > DEFAULT_BUNDLE_LIMITS.maxEntries) {
    return {
      ok: false,
      refusals: [
        {
          reason: BUNDLE_REFUSAL.archiveTooLarge,
          message: `manifest lists ${manifest.contents.length} contents entries, more than the ${DEFAULT_BUNDLE_LIMITS.maxEntries}-entry cap`,
        },
      ],
    };
  }

  const refusals: BundleRefusal[] = [];
  const seenPaths = new Set<string>();
  // R1-F22/R2-F1: two entries whose paths differ only by case are the SAME
  // file on a case-insensitive filesystem (`rules/a.md` and `rules/A.md`
  // both write `rules/a.md` on APFS), so an exact-match duplicate check
  // alone lets a bundle silently write one path twice under two different
  // ledger keys — which later confuses conflict detection and uninstall.
  // Compared on the same canonical (portable-ASCII, lower-cased) form the
  // reserved-path guard in paths.ts uses.
  const seenFolded = new Map<string, string>(); // folded path -> first original path that produced it
  // A path that is a PREFIX DIRECTORY of another entry (`skills/a` as a file
  // AND `skills/a/SKILL.md` as another entry) collides on disk too — the
  // second write needs `skills/a` to be a directory that the first entry
  // already claimed as a file. R2-F4: checked with two Sets keyed on the
  // folded form — `seenFileKeys` (paths already claimed as a FILE) and
  // `seenDirKeys` (path prefixes already claimed as a DIRECTORY) — so each
  // entry costs O(depth) rather than comparing against every prior entry.
  const seenFileKeys = new Set<string>();
  const seenDirKeys = new Set<string>();
  for (const entry of manifest.contents) {
    if (seenPaths.has(entry.path)) {
      refusals.push({ reason: BUNDLE_REFUSAL.duplicatePath, path: entry.path, message: `duplicate contents[].path: ${entry.path}` });
      continue;
    }
    seenPaths.add(entry.path);

    const folded = caseFold(entry.path);
    const priorForFolded = seenFolded.get(folded);
    if (priorForFolded !== undefined) {
      refusals.push({
        reason: BUNDLE_REFUSAL.duplicatePath,
        path: entry.path,
        message: `contents[].path "${entry.path}" is a case-only duplicate of "${priorForFolded}" — the same file on a case-insensitive filesystem`,
      });
      continue;
    }
    const foldedSegments = folded.split("/");
    const ancestorDirKeys: string[] = [];
    for (let i = 1; i < foldedSegments.length; i += 1) {
      ancestorDirKeys.push(foldedSegments.slice(0, i).join("/"));
    }
    const collidesAsPrefix = seenDirKeys.has(folded) || ancestorDirKeys.some((dirKey) => seenFileKeys.has(dirKey));
    if (collidesAsPrefix) {
      refusals.push({
        reason: BUNDLE_REFUSAL.duplicatePath,
        path: entry.path,
        message: `contents[].path "${entry.path}" collides with another entry's path as a file/directory prefix`,
      });
      continue;
    }
    seenFolded.set(folded, entry.path);
    seenFileKeys.add(folded);
    for (const dirKey of ancestorDirKeys) seenDirKeys.add(dirKey);

    const normalized = normalizeBundlePath(entry.path);
    if (!normalized.ok) {
      refusals.push(normalized.refusal);
      continue;
    }
    const kindCheck = validateKindPath(entry.kind, entry.scope, normalized.path);
    if (!kindCheck.ok) {
      refusals.push(kindCheck.refusal);
    }
  }

  if (refusals.length > 0) {
    return { ok: false, refusals };
  }
  return { ok: true, manifest };
}

const CONTENT_ENTRY_KEY_ORDER: readonly (keyof BundleContentEntry)[] = [
  "path",
  "kind",
  "scope",
  "sha256",
  "sizeBytes",
  "description",
  "origin",
];

function orderedContentEntry(entry: BundleContentEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CONTENT_ENTRY_KEY_ORDER) {
    if (entry[key] !== undefined) out[key] = entry[key];
  }
  return out;
}

/** Stable, schema-key-ordered JSON, 2-space indent, trailing newline. */
export function serializeManifest(manifest: BundleManifest): string {
  const ordered = {
    formatVersion: manifest.formatVersion,
    bundleId: manifest.bundleId,
    createdAt: manifest.createdAt,
    sourceKeryxVersion: manifest.sourceKeryxVersion,
    provenance: {
      producedBy: manifest.provenance.producedBy,
      ...(manifest.provenance.sourceProject !== undefined ? { sourceProject: manifest.provenance.sourceProject } : {}),
      sourceScope: manifest.provenance.sourceScope,
    },
    compat: {
      minKeryxVersion: manifest.compat.minKeryxVersion,
      ...(manifest.compat.targetHarnesses !== undefined ? { targetHarnesses: manifest.compat.targetHarnesses } : {}),
    },
    contents: manifest.contents.map(orderedContentEntry),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
