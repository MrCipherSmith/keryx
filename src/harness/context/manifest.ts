// Release 0 trusted-context manifest builder (flow 009, W7 / S1, R0-01).
//
// `buildContextManifest` produces a bounded, deterministic `ContextManifest`
// that validates against the frozen `harness-context-manifest.schema.json`.
// It records each context source with a content fingerprint and an explicit
// trust classification: available sources are `trustedAsPolicy: true` with an
// `exact` reliability; unavailable optional artifacts are recorded (never
// silently dropped) with `trustedAsPolicy: false` and `unknown` reliability,
// carrying the caller's skip reason as the summary.
//
// Determinism: all timestamps come from `deps.clock`; hashes are sha256 over a
// stable serialization. NO `Date.now`, `Math.random`, network, or fs mutation.
import { createHash } from "node:crypto";

// Documented Release 0 context ceilings (ADR-0001 / README §Startup and Resume
// Preconditions / PRD §Success Criteria): <= 2 MiB, <= 200,000 tokens.
export const MAX_CONTEXT_BYTES = 2 * 1024 * 1024;
export const MAX_CONTEXT_TOKENS = 200_000;

/** Reliability grades, mirroring the frozen manifest schema enum. */
export type SourceReliability = "exact" | "estimated" | "unknown";

/** Redaction states, mirroring the frozen manifest schema enum. */
export type SourceRedaction = "not-needed" | "applied" | "failed-safe";

export interface ContextManifestSource {
  kind: string;
  path: string;
  hash: string;
  summary?: string;
  reliability: SourceReliability;
  trustedAsPolicy: boolean;
  redaction?: SourceRedaction;
}

export interface ContextManifestScope {
  paths: string[];
  scopeHash: string;
  base?: string;
  head?: string;
}

export interface ContextManifestLimits {
  maxBytes: number;
  maxTokens: number;
  actualBytes?: number;
  estimatedTokens?: number;
}

export interface ContextManifest {
  schemaVersion: number;
  contextHash: string;
  projectRoot: string;
  worktree?: string;
  createdAt: string;
  freshness?: "fresh" | "stale" | "partial" | "unknown";
  scope: ContextManifestScope;
  sources: ContextManifestSource[];
  limits: ContextManifestLimits;
}

/**
 * Caller-supplied context source at the build seam. `available` sources carry
 * `content` (fingerprinted exactly); unavailable ones carry `skipReason`
 * (recorded as the summary). Extra fields are ignored.
 */
export interface ContextSourceInput {
  kind: string;
  path: string;
  available: boolean;
  content?: string | undefined;
  skipReason?: string | undefined;
}

export interface BuildContextManifestInput {
  projectRoot: string;
  /** Opaque at the seam; each entry is interpreted as a {@link ContextSourceInput}. */
  sources: unknown[];
  limits: { maxBytes: number; maxTokens: number };
}

export interface BuildContextManifestDeps {
  clock: () => string;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function normalizeSource(value: unknown): ContextSourceInput {
  const record: Record<string, unknown> =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    kind: typeof record.kind === "string" ? record.kind : "unknown",
    path: typeof record.path === "string" ? record.path : "",
    available: record.available === true,
    content: typeof record.content === "string" ? record.content : undefined,
    skipReason: typeof record.skipReason === "string" ? record.skipReason : undefined,
  };
}

function mapSource(source: ContextSourceInput): ContextManifestSource {
  if (source.available) {
    const content = source.content ?? "";
    return {
      kind: source.kind,
      path: source.path,
      hash: sha256(content),
      summary: `Available ${source.kind} loaded from ${source.path}`,
      reliability: "exact",
      trustedAsPolicy: true,
    };
  }
  return {
    kind: source.kind,
    path: source.path,
    // Deterministic non-empty fingerprint for an unavailable source; distinct
    // from any content hash so a skipped artifact can never be mistaken for a
    // loaded one.
    hash: sha256(`unavailable:${source.kind}:${source.path}`),
    summary: source.skipReason ?? `Optional ${source.kind} at ${source.path} is unavailable`,
    reliability: "unknown",
    trustedAsPolicy: false,
  };
}

/**
 * Build a bounded, deterministic trusted-context manifest. Two builds over
 * identical input (with an identical `deps.clock`) are byte-identical.
 */
export function buildContextManifest(
  input: BuildContextManifestInput,
  deps: BuildContextManifestDeps,
): ContextManifest {
  const normalized = input.sources.map(normalizeSource);
  const sources = normalized.map(mapSource);

  const paths: string[] = [];
  for (const source of normalized) {
    if (source.path.length > 0 && !paths.includes(source.path)) {
      paths.push(source.path);
    }
  }
  const scopeHash = sha256(JSON.stringify(paths));

  const actualBytes = normalized.reduce(
    (sum, source) => sum + (source.available ? Buffer.byteLength(source.content ?? "", "utf8") : 0),
    0,
  );
  const estimatedTokens = Math.ceil(actualBytes / 4);

  const limits: ContextManifestLimits = {
    maxBytes: input.limits.maxBytes,
    maxTokens: input.limits.maxTokens,
    actualBytes,
    estimatedTokens,
  };

  const scope: ContextManifestScope = { paths, scopeHash };

  // Content fingerprint over everything except the timestamp, so identical
  // context yields an identical `contextHash` regardless of when it was built.
  const contextHash = sha256(JSON.stringify({ projectRoot: input.projectRoot, scope, sources, limits }));

  return {
    schemaVersion: 1,
    contextHash,
    projectRoot: input.projectRoot,
    createdAt: deps.clock(),
    scope,
    sources,
    limits,
  };
}
