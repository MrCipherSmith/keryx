// Flow 307 (W5-b), T7: the generated harness capability matrix.
//
// `generateCapabilityMatrix` derives a `harness-capability-matrix.schema.json`
// -conformant document straight from `HARNESS_ADAPTERS` — the SAME registry
// `src/ctx`, `src/security` and (T6) the installer core read — so the matrix
// can never assert a fact the registry does not also encode. It is
// deterministic (no `Date.now`, no I/O in the pure generation path): every
// input is a plain value already sitting on the registry's adapters/surfaces.
//
// `checkCapabilityMatrix` is the CI guard's engine (W5-AC4): regenerate,
// validate against the schema, and diff byte-for-byte against the checked-in
// artifact (`docs/integrations/harness-capability-matrix.json`). Drift in
// either direction — a hand-edit of the artifact, or a registry change nobody
// regenerated the artifact for — is reported, never silently accepted.
//
// Schema loading: the schema file lives under `docs/requirements/...`, not
// under `src/contracts`'s frozen-schema directory, so it is pulled in as a
// static JSON import (`with { type: "json" }`) rather than read through
// `SchemaResolver`/`schemaDir` — the same pattern `src/cli.ts` and several
// `src/commands/*.ts` already use for `package.json`. This bundles cleanly
// into the compiled CLI (`bun build` inlines the JSON at build time) and
// needs no repo-root path resolution at runtime. The limitation: because the
// schema has no cross-file `$ref`s (only local `#/$defs/...` pointers), this
// works without ever handing `SchemaResolver` a `schemaDir` — if a future
// edit adds a cross-file ref to this schema, `validateCapabilityMatrix` would
// need a real directory to resolve it against, which this static-import path
// does not have.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import matrixSchemaJson from "../../docs/requirements/keryx-agent-platform-expansion/schemas/harness-capability-matrix.schema.json" with {
  type: "json",
};
import { validateAgainstSchemaObject, type ValidationResult } from "../contracts/validator";
import { HARNESS_ADAPTERS } from "./registry";
import { SUBSYSTEM_INSTRUCTIONS, type AdapterKind, type Confidence, type HarnessAdapter, type SurfaceAdapter, type SurfaceFlag } from "./types";

// ---------------------------------------------------------------------------
// Schema-derived constants — read off the imported JSON rather than
// hand-copied, so the flag/harness-id ordering used below can never drift
// from what the schema actually enumerates.
// ---------------------------------------------------------------------------

interface MatrixSchemaDoc {
  readonly $defs: {
    readonly surfaceFlag: { readonly enum: readonly string[] };
    readonly harnessId: { readonly enum: readonly string[] };
  };
}

const MATRIX_SCHEMA = matrixSchemaJson as unknown as MatrixSchemaDoc;

/** The 12 `SurfaceFlag` values, in the exact order the schema's enum declares. */
export const SURFACE_FLAG_ORDER: readonly SurfaceFlag[] = MATRIX_SCHEMA.$defs.surfaceFlag.enum as SurfaceFlag[];

/** The canonical harness ids the schema's `harnessId` enum declares, in enum order. */
export const CANONICAL_HARNESS_IDS: readonly string[] = MATRIX_SCHEMA.$defs.harnessId.enum;

export const MATRIX_VERSION = "0.1.0";

/** Default location of the checked-in matrix artifact, relative to a project root. */
export const DEFAULT_MATRIX_ARTIFACT = "docs/integrations/harness-capability-matrix.json";

// ---------------------------------------------------------------------------
// Document shape (mirrors harness-capability-matrix.schema.json's $defs).
// ---------------------------------------------------------------------------

export type MatrixSurfaceState = "native" | "adapter" | "instruction-only" | "unsupported";

export interface MatrixSupportedSurface {
  readonly surface: SurfaceFlag;
  readonly state: MatrixSurfaceState;
  readonly settingsFile?: string;
}

export interface MatrixUnsupportedSurface {
  readonly surface: SurfaceFlag;
  readonly reason: string;
}

export interface MatrixHarnessEntry {
  readonly id: string;
  readonly label: string;
  readonly state: MatrixSurfaceState;
  readonly adapterKind: AdapterKind;
  readonly confidence: Confidence;
  readonly surfaces_supported: readonly MatrixSupportedSurface[];
  readonly surfaces_unsupported: readonly MatrixUnsupportedSurface[];
  readonly install_command: string;
  readonly verification_command: string;
  readonly risk_notes: string;
  readonly last_verified: string;
  readonly source_docs: readonly string[];
}

export interface CapabilityMatrixDocument {
  readonly version: string;
  readonly generatedAt: string;
  readonly harnesses: readonly MatrixHarnessEntry[];
}

// ---------------------------------------------------------------------------
// Per-surface / per-entry classification.
// ---------------------------------------------------------------------------

// native > adapter > instruction-only > unsupported. Used both to pick the
// BEST state among surfaces sharing one flag, and to pick an entry's overall
// state from its (already flag-deduplicated) supported-surface list.
const STATE_RANK: Record<MatrixSurfaceState, number> = {
  native: 3,
  adapter: 2,
  "instruction-only": 1,
  unsupported: 0,
};

function installsIntoHostFile(surface: SurfaceAdapter): boolean {
  return (surface.merge !== undefined && surface.strip !== undefined) || surface.customInstall !== undefined;
}

/**
 * One surface's state, per the W5 states (`Generated capability matrix` in
 * W5-multi-harness.md):
 *   - `instruction-only` — the subsystem IS instructions: a file is
 *     written/read but nothing decides anything, whatever the adapter kind
 *     that surface belongs to (checked first — it is the most specific fact,
 *     and it overrides what the surface's adapter kind would otherwise imply:
 *     zed's `instructions` surface belongs to a `policy-travels-with-agent`
 *     adapter, but it is still an instructions surface, not a policy).
 *   - `native` — verified confidence, a `host-hook` adapter, AND the surface
 *     actually installs into a host file (`merge`+`strip`, or `customInstall`
 *     for a non-JSON artifact like OpenCode's plugin).
 *   - `adapter` — an experimental `host-hook` surface (including a
 *     custom-plugin one, still `host-hook` at the adapter level), or ANY
 *     surface belonging to a `policy-travels-with-agent` adapter (the policy
 *     travels with the agent binary rather than a host settings file, which
 *     is a thin-bridge shape regardless of that one surface's own
 *     confidence — see zed's `verified` `acp-permission` surface).
 */
export function classifySurfaceState(adapter: HarnessAdapter, surface: SurfaceAdapter): MatrixSurfaceState {
  if (surface.subsystem === SUBSYSTEM_INSTRUCTIONS) return "instruction-only";
  if (adapter.adapterKind === "host-hook") {
    return surface.confidence === "verified" && installsIntoHostFile(surface) ? "native" : "adapter";
  }
  if (adapter.adapterKind === "policy-travels-with-agent") return "adapter";
  throw new Error(
    `matrix: cannot classify surface "${surface.id}" of adapter "${adapter.id}" — unhandled adapterKind "${adapter.adapterKind}"`,
  );
}

function betterState(a: MatrixSurfaceState, b: MatrixSurfaceState): MatrixSurfaceState {
  return STATE_RANK[b] > STATE_RANK[a] ? b : a;
}

/**
 * `surfaces_supported`: one item per DISTINCT flag the adapter's surfaces
 * carry, sorted by the schema's flag enum order. When several surfaces share
 * a flag (Claude's ctx-guard `block` and its security check-output `block`,
 * both in `.claude/settings.json`), the BEST state wins and its settingsFile
 * is the one reported — ties keep the first surface in registry order, which
 * is deterministic and (for Claude) points at the same file either way.
 */
function supportedSurfacesFor(adapter: HarnessAdapter): MatrixSupportedSurface[] {
  const byFlag = new Map<SurfaceFlag, { state: MatrixSurfaceState; settingsFile?: string }>();
  for (const surface of adapter.surfaces) {
    const state = classifySurfaceState(adapter, surface);
    const existing = byFlag.get(surface.flag);
    if (existing === undefined || STATE_RANK[state] > STATE_RANK[existing.state]) {
      byFlag.set(surface.flag, surface.relativePath === undefined ? { state } : { state, settingsFile: surface.relativePath });
    }
  }
  return SURFACE_FLAG_ORDER.filter((flag) => byFlag.has(flag)).map((flag) => {
    const found = byFlag.get(flag)!;
    return found.settingsFile === undefined
      ? { surface: flag, state: found.state }
      : { surface: flag, state: found.state, settingsFile: found.settingsFile };
  });
}

/** `surfaces_unsupported`: `adapter.unsupported` entries, schema enum order. */
function unsupportedSurfacesFor(adapter: HarnessAdapter): MatrixUnsupportedSurface[] {
  return SURFACE_FLAG_ORDER.filter((flag) => adapter.unsupported[flag] !== undefined).map((flag) => ({
    surface: flag,
    reason: adapter.unsupported[flag]!,
  }));
}

/**
 * `risk_notes`: adapter-level notes then every surface's notes, de-duplicated
 * (several W5-b surfaces intentionally restate their adapter's note
 * verbatim — e.g. gemini-cli's ctx-guard surface — so a naive concatenation
 * would repeat the same sentence), joined with a space. THROWS, naming the
 * adapter, when confidence is experimental and no note (adapter or surface)
 * backs it — the schema requires this non-empty, and an invented placeholder
 * would be worse than a hard failure at generation time.
 */
function riskNotesFor(adapter: HarnessAdapter): string {
  const seen = new Set<string>();
  const notes: string[] = [];
  const add = (list: readonly string[] | undefined) => {
    for (const note of list ?? []) {
      if (!seen.has(note)) {
        seen.add(note);
        notes.push(note);
      }
    }
  };
  add(adapter.riskNotes);
  for (const surface of adapter.surfaces) add(surface.riskNotes);
  const joined = notes.join(" ");
  if (adapter.confidence === "experimental" && joined.length === 0) {
    throw new Error(
      `matrix: adapter "${adapter.id}" is confidence:"experimental" but carries no riskNotes (adapter-level or ` +
        `per-surface) to back it — the schema requires risk_notes to be non-empty here`,
    );
  }
  return joined;
}

/** `source_docs`: adapter ∪ every surface's sourceDocs, de-duplicated, sorted. */
function sourceDocsFor(adapter: HarnessAdapter): string[] {
  const set = new Set<string>(adapter.sourceDocs);
  for (const surface of adapter.surfaces) {
    for (const doc of surface.sourceDocs) set.add(doc);
  }
  return [...set].sort();
}

function harnessEntryFor(adapter: HarnessAdapter): MatrixHarnessEntry {
  const surfacesSupported = supportedSurfacesFor(adapter);
  const surfacesUnsupported = unsupportedSurfacesFor(adapter);
  const bestState = surfacesSupported.reduce<MatrixSurfaceState>(
    (best, s) => betterState(best, s.state),
    "unsupported",
  );
  // Schema: an entry with state "native" must be confidence "verified". A
  // registry could (in principle) have an experimental adapter whose best
  // surface state computed as "native" — it cannot today (native requires
  // `confidence === "verified"` at the SURFACE level, and a `host-hook`
  // adapter's surfaces do not carry a confidence the adapter itself
  // disagrees with in the current registry) — but this downgrade keeps the
  // generator correct-by-construction rather than relying on that coincidence.
  const state = bestState === "native" && adapter.confidence === "experimental" ? "adapter" : bestState;
  return {
    id: adapter.id,
    label: adapter.label,
    state,
    adapterKind: adapter.adapterKind,
    confidence: adapter.confidence,
    surfaces_supported: surfacesSupported,
    surfaces_unsupported: surfacesUnsupported,
    install_command: `keryx integrations install --runtime ${adapter.id}`,
    verification_command: `keryx integrations doctor --runtime ${adapter.id}`,
    risk_notes: riskNotesFor(adapter),
    last_verified: adapter.lastVerified,
    source_docs: sourceDocsFor(adapter),
  };
}

function maxLastVerified(adapters: readonly HarnessAdapter[]): string {
  if (adapters.length === 0) {
    throw new Error("matrix: cannot derive generatedAt from an empty adapter list");
  }
  return adapters.reduce((max, a) => (a.lastVerified > max ? a.lastVerified : max), adapters[0]!.lastVerified);
}

/**
 * Generate a `harness-capability-matrix.schema.json`-conformant document from
 * the registry. Deterministic: no `Date.now`, no randomness, no I/O —
 * `generatedAt` is derived from the max `lastVerified` across `adapters`
 * rather than the wall clock, so re-running this against an unchanged
 * registry always produces byte-identical output (what
 * {@link checkCapabilityMatrix} relies on).
 */
export function generateCapabilityMatrix(adapters: readonly HarnessAdapter[] = HARNESS_ADAPTERS): CapabilityMatrixDocument {
  return {
    version: MATRIX_VERSION,
    generatedAt: `${maxLastVerified(adapters)}T00:00:00Z`,
    harnesses: adapters.map(harnessEntryFor),
  };
}

/** Serialize a matrix document the one way it is ever written: 2-space JSON, trailing newline. */
export function serializeCapabilityMatrix(doc: CapabilityMatrixDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Validate a matrix document against `harness-capability-matrix.schema.json`. */
export function validateCapabilityMatrix(doc: CapabilityMatrixDocument): ValidationResult {
  return validateAgainstSchemaObject(matrixSchemaJson as unknown as Record<string, unknown>, doc);
}

function resolveArtifactPath(root: string, artifactPath: string): string {
  return path.join(root, ...artifactPath.split("/"));
}

function firstDifferingHarnessId(
  existing: readonly MatrixHarnessEntry[] | undefined,
  generated: readonly MatrixHarnessEntry[] | undefined,
): string | undefined {
  const byId = new Map((existing ?? []).map((entry) => [entry.id, entry] as const));
  for (const entry of generated ?? []) {
    const prior = byId.get(entry.id);
    if (prior === undefined || JSON.stringify(prior) !== JSON.stringify(entry)) {
      return entry.id;
    }
  }
  if ((existing?.length ?? 0) !== (generated?.length ?? 0)) {
    return "(harness count differs)";
  }
  return undefined;
}

export interface MatrixCheckResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * Regenerate the matrix, validate it, and compare it byte-for-byte against
 * the checked-in artifact at `<root>/<artifactPath>` (W5-AC4). A missing
 * file, a schema-invalid regeneration, or any drift between the two is
 * reported in `problems`; `ok` is `problems.length === 0`.
 */
export async function checkCapabilityMatrix(
  root: string,
  artifactPath: string = DEFAULT_MATRIX_ARTIFACT,
): Promise<MatrixCheckResult> {
  const problems: string[] = [];
  const generated = generateCapabilityMatrix();
  const validation = validateCapabilityMatrix(generated);
  if (!validation.valid) {
    problems.push(
      `the regenerated matrix fails schema validation: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
    );
  }
  const serialized = serializeCapabilityMatrix(generated);
  const fullPath = resolveArtifactPath(root, artifactPath);
  let existingText: string | undefined;
  try {
    existingText = await readFile(fullPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existingText === undefined) {
    problems.push(`${artifactPath} is missing — run \`keryx integrations matrix --write\` to generate it`);
  } else if (existingText !== serialized) {
    let hint = "";
    try {
      const existingDoc = JSON.parse(existingText) as CapabilityMatrixDocument;
      const generatedDoc = JSON.parse(serialized) as CapabilityMatrixDocument;
      const firstDiff = firstDifferingHarnessId(existingDoc.harnesses, generatedDoc.harnesses);
      if (firstDiff !== undefined) hint = ` (first differing harness: ${firstDiff})`;
    } catch {
      // The checked-in file is not even valid JSON — report drift without a hint.
    }
    problems.push(
      `${artifactPath} does not match the regenerated matrix${hint} — run \`keryx integrations matrix --write\` to update it`,
    );
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Regenerate the matrix and write it to `<root>/<artifactPath>` (2-space
 * JSON, trailing newline). Throws if the regenerated document fails schema
 * validation — this never writes a document `checkCapabilityMatrix` would
 * itself reject.
 */
export async function writeCapabilityMatrix(root: string, artifactPath: string = DEFAULT_MATRIX_ARTIFACT): Promise<void> {
  const doc = generateCapabilityMatrix();
  const validation = validateCapabilityMatrix(doc);
  if (!validation.valid) {
    throw new Error(
      `matrix: generated document fails schema validation: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
    );
  }
  const fullPath = resolveArtifactPath(root, artifactPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, serializeCapabilityMatrix(doc), "utf8");
}
