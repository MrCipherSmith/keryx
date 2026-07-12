import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Deterministic schema loading and `$ref` / `$defs` resolution for the frozen
// Keryx harness contract schemas (Draft 2020-12 subset).
//
// The 34 frozen schemas live in a single directory and reference each other in
// three ways:
//   - local pointer            `#/$defs/schemaVersion`
//   - cross-file with pointer   `harness-envelope.schema.json#/$defs/id`
//   - cross-file whole document `completion-gate-result.schema.json`
// plus the absolute `$id` form `https://keryx.local/schemas/harness/<file>`.
//
// No network and no clock: refs resolve purely by reading sibling schema files
// from `schemaDir` and walking RFC 6901 JSON Pointers. Loaded documents are
// cached so repeated resolution is stable and cheap.
// ---------------------------------------------------------------------------

export type JsonSchema = Record<string, unknown> | boolean;

const ID_PREFIX = "https://keryx.local/schemas/harness/";

export interface ResolvedRef {
  /** The schema node the ref points at. */
  schema: JsonSchema;
  /** The root document that owns the node, used to resolve further local refs. */
  root: Record<string, unknown>;
}

function decodePointerSegment(segment: string): string {
  // RFC 6901: `~1` -> `/`, `~0` -> `~` (order matters).
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Resolve an RFC 6901 JSON Pointer fragment (e.g. `/$defs/id`) within a document. */
export function resolvePointer(doc: Record<string, unknown>, fragment: string): unknown {
  if (fragment === "" || fragment === "/") {
    return doc;
  }
  if (!fragment.startsWith("/")) {
    throw new Error(`Unsupported JSON Pointer fragment (must start with "/"): ${fragment}`);
  }
  const segments = fragment.split("/").slice(1).map(decodePointerSegment);
  let node: unknown = doc;
  for (const segment of segments) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      throw new Error(`Pointer segment "${segment}" not resolvable in fragment #${fragment}`);
    }
    const record = node as Record<string, unknown>;
    if (!(segment in record)) {
      throw new Error(`Pointer segment "${segment}" not resolvable in fragment #${fragment}`);
    }
    node = record[segment];
  }
  return node;
}

export class SchemaResolver {
  private readonly cache = new Map<string, Record<string, unknown>>();

  constructor(private readonly schemaDir: string) {}

  /** Load and cache a schema file by its bare filename. */
  loadSchema(file: string): Record<string, unknown> {
    const cached = this.cache.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const raw = readFileSync(path.join(this.schemaDir, file), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Schema file ${file} is not a JSON object`);
    }
    const doc = parsed as Record<string, unknown>;
    this.cache.set(file, doc);
    return doc;
  }

  /**
   * Resolve a `$ref` against `docRoot`. Returns the target node together with
   * the root document that owns it, so nested local pointers resolve correctly.
   */
  resolve(ref: string, docRoot: Record<string, unknown>): ResolvedRef {
    const hashIndex = ref.indexOf("#");
    const base = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? "" : ref.slice(hashIndex + 1);

    const root = base === "" ? docRoot : this.loadSchema(this.baseToFile(base));
    const node = fragment === "" ? root : resolvePointer(root, fragment);
    return { schema: node as JsonSchema, root };
  }

  private baseToFile(base: string): string {
    if (base.startsWith(ID_PREFIX)) {
      return base.slice(ID_PREFIX.length);
    }
    return base;
  }
}
