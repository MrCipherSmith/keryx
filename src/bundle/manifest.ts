// Flow 313 (W4 portability), T6 — manifest parse/serialize against
// `portable-bundle.schema.json`, plus the structural checks the schema alone
// cannot express (duplicate paths, formatVersion major, kind/path shape).

import manifestSchemaJson from "../../docs/requirements/keryx-agent-platform-expansion/schemas/portable-bundle.schema.json" with {
  type: "json",
};
import { validateAgainstSchemaObject } from "../contracts/validator";
import { normalizeBundlePath, validateKindPath } from "./paths";
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

  const refusals: BundleRefusal[] = [];
  const seenPaths = new Set<string>();
  // R1-F22: two entries whose paths differ only by case are the SAME file on
  // a case-insensitive filesystem (`rules/a.md` and `rules/A.md` both write
  // `rules/a.md` on APFS), so an exact-match duplicate check alone lets a
  // bundle silently write one path twice under two different ledger keys —
  // which later confuses conflict detection and uninstall. Compared
  // case-folded + NFC-normalized, same as the reserved-path guard.
  const seenFolded = new Map<string, string>(); // folded path -> first original path that produced it
  // A path that is a PREFIX DIRECTORY of another entry (`skills/a` as a file
  // AND `skills/a/SKILL.md` as another entry) collides on disk too — the
  // second write needs `skills/a` to be a directory that the first entry
  // already claimed as a file. Tracked case-folded as well.
  const seenFoldedSorted: string[] = [];
  for (const entry of manifest.contents) {
    if (seenPaths.has(entry.path)) {
      refusals.push({ reason: BUNDLE_REFUSAL.duplicatePath, path: entry.path, message: `duplicate contents[].path: ${entry.path}` });
      continue;
    }
    seenPaths.add(entry.path);

    const folded = entry.path.normalize("NFC").toLowerCase();
    const priorForFolded = seenFolded.get(folded);
    if (priorForFolded !== undefined) {
      refusals.push({
        reason: BUNDLE_REFUSAL.duplicatePath,
        path: entry.path,
        message: `contents[].path "${entry.path}" is a case-only duplicate of "${priorForFolded}" — the same file on a case-insensitive filesystem`,
      });
      continue;
    }
    const collidesAsPrefix = seenFoldedSorted.some((other) => folded === other || folded.startsWith(`${other}/`) || other.startsWith(`${folded}/`));
    if (collidesAsPrefix) {
      refusals.push({
        reason: BUNDLE_REFUSAL.duplicatePath,
        path: entry.path,
        message: `contents[].path "${entry.path}" collides with another entry's path as a file/directory prefix`,
      });
      continue;
    }
    seenFolded.set(folded, entry.path);
    seenFoldedSorted.push(folded);

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
