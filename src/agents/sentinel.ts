// Flow 310 (W2), R2 fix (R2-F1/R2-F6): the ONE place that defines what a
// "keryx-managed" sentinel STRUCTURALLY is, for every shape `compile.ts`'s
// renderers write. R2-F1 found every prior consumer (export.ts's
// overwrite/--force decision, its uninstall scan, and the audit's tier
// fallback) testing only `content.includes(AGENT_SENTINEL_PREFIX)` — a
// substring test a hand-authored file that merely QUOTES the prefix in prose
// satisfies just as well as a real export does.
//
// This module's predicate instead requires the sentinel to sit on its
// renderer-defined STRUCTURAL position:
//   - markdown (claude/opencode host exports, and the instruction-only prose
//     fallback under `.metaproject/agents-export/**`): the line immediately
//     after the closing `---` frontmatter delimiter, or — when the file opens
//     with no frontmatter at all (the prose fallback's shape) — the file's
//     first line.
//   - TOML (codex): the file's first line.
//   - kiro's JSON: the first line of the parsed `prompt` field.
//
// A file that merely mentions the sentinel prefix anywhere else — in body
// prose, a comment elsewhere, or a later line — is UNMANAGED: `export.ts`
// never overwrites it (even with `--force`) and never deletes it on
// uninstall. `AGENT_SENTINEL_PREFIX` alone (a bare substring) is kept only
// for the one caller (the audit's tier fallback) that deliberately wants a
// LOOSE "is this candidate line even trying to be a sentinel" pre-check
// alongside its own structural anchor — never as the sole ownership test.

const AGENT_NAME_PATTERN_SOURCE = "[a-z][a-z0-9-]{1,63}";
const HEX64 = "[0-9a-f]{64}";
const MODEL_TIER_ALTERNATION = "light|standard|deep";

/** The fixed, name/hash-independent PREFIX every managed sentinel begins with. NEVER use this alone to decide ownership (R2-F1) — it is a substring, and a hand-authored file can quote it in prose. */
export const AGENT_SENTINEL_PREFIX = "keryx-managed: keryx agents export (";

/**
 * Matches at the START of a sentinel's text content (comment/line-body text,
 * delimiters already stripped) — not anchored to the end, since the
 * instruction-only prose fallback appends `"; instruction-only prose — ..."`
 * after the closing `)`. Capture groups: name, source sha256, model tier,
 * content sha256 (or, pre-finalization, the fixed all-zero placeholder —
 * still 64 hex characters, so it still matches).
 */
const SENTINEL_BODY_RE = new RegExp(
  `^keryx-managed: keryx agents export \\((${AGENT_NAME_PATTERN_SOURCE}), sha256:(${HEX64}), model_tier=(${MODEL_TIER_ALTERNATION}), content-sha256:(${HEX64})\\)`,
);

/** `model_tier=<tier>` — used by the audit's LOOSE tier fallback, which anchors to the structural candidate line but does not require the rest of the grammar (see `structuralSentinelModelTier`). */
const MODEL_TIER_RE = /\bmodel_tier=(light|standard|deep)\b/;

export interface ParsedSentinel {
  readonly name: string;
  readonly sourceHash: string;
  readonly modelTier: string;
  readonly contentHash: string;
}

function parseSentinelBody(text: string): ParsedSentinel | undefined {
  const match = SENTINEL_BODY_RE.exec(text);
  if (!match) return undefined;
  return { name: match[1]!, sourceHash: match[2]!, modelTier: match[3]!, contentHash: match[4]! };
}

export type AgentSentinelFormat = "md" | "toml" | "kiro-json";

/** Format from a runtime's file extension — the same mapping `export.ts`'s `HOST_AGENTS_DIR` writes into and `compile.ts`'s renderers emit. */
export function agentSentinelFormatOf(relativePath: string): AgentSentinelFormat {
  if (relativePath.endsWith(".toml")) return "toml";
  if (relativePath.endsWith(".json")) return "kiro-json";
  return "md";
}

// ---------------------------------------------------------------------------
// Structural line location — the one seam every "is this really the
// sentinel" check in this codebase anchors to. `md`/`toml` are genuinely
// line-based; `kiro-json`'s sentinel sits inside the `prompt` STRING value
// (JSON encodes it with escaped `\n`, so it is one physical text line even
// though it is logically multi-line prose) and is handled separately below.
// ---------------------------------------------------------------------------

export interface StructuralLineLocation {
  /** `content` split on `\r?\n`. */
  readonly lines: readonly string[];
  /** Index into `lines` of the structural sentinel candidate. */
  readonly index: number;
}

/**
 * Locates the structural sentinel LINE for `format` ("md" or "toml") within
 * `content` — the line right after a closing `---` frontmatter delimiter, the
 * file's first line when there is no frontmatter (md), or always the first
 * line (toml). `undefined` when that position does not exist: an unterminated
 * frontmatter block, or a completely empty file.
 */
export function locateStructuralLine(content: string, format: "md" | "toml"): StructuralLineLocation | undefined {
  const lines = content.split(/\r?\n/);
  if (format === "toml") {
    return lines.length > 0 && lines[0] !== undefined ? { lines, index: 0 } : undefined;
  }
  if (lines[0] !== "---") {
    return lines.length > 0 && lines[0] !== undefined ? { lines, index: 0 } : undefined;
  }
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === "---") {
      return i + 1 < lines.length ? { lines, index: i + 1 } : undefined;
    }
  }
  return undefined;
}

/**
 * The structural sentinel CANDIDATE text for `format` — the raw line (md/
 * toml, delimiters still attached) or the first line of the parsed kiro
 * `prompt` field — independent of whether it actually validates as a
 * well-formed sentinel. `undefined` when the position does not exist (no
 * frontmatter close, unparsable JSON, or a `prompt` that is not a string).
 * Never a substring search over the WHOLE file.
 */
export function structuralSentinelCandidate(content: string, format: AgentSentinelFormat): string | undefined {
  if (format === "kiro-json") {
    const prompt = kiroPromptOf(content);
    if (prompt === undefined) return undefined;
    const firstNewline = prompt.indexOf("\n");
    return firstNewline === -1 ? prompt : prompt.slice(0, firstNewline);
  }
  const location = locateStructuralLine(content, format);
  return location?.lines[location.index];
}

function kiroPromptOf(content: string): string | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return undefined;
  const prompt = (doc as Record<string, unknown>).prompt;
  return typeof prompt === "string" ? prompt : undefined;
}

const MD_COMMENT_RE = /^<!--\s(.*)\s-->$/;
const TOML_COMMENT_RE = /^#\s(.*)$/;

/** Strip the per-format comment/line wrapper off a structural candidate, returning the inner sentinel text — `undefined` when the candidate is not even shaped like a sentinel line for `format` (e.g. an md line that is not an HTML comment at all). kiro has no wrapper: the candidate IS the inner text already. */
function innerSentinelText(candidate: string, format: AgentSentinelFormat): string | undefined {
  if (format === "kiro-json") return candidate;
  if (format === "toml") return TOML_COMMENT_RE.exec(candidate)?.[1];
  return MD_COMMENT_RE.exec(candidate)?.[1];
}

/**
 * True when `content` carries a well-formed keryx-managed sentinel on its
 * STRUCTURAL position for `format` (R2-F1) — never a substring match.
 * `export.ts` uses this to decide overwrite/refuse-unmanaged and what
 * uninstall may delete. When `expectedName` is given, the sentinel's own
 * `name` field must also match it (a file whose structural sentinel claims a
 * DIFFERENT agent's name is not this agent's export).
 */
export function structuralSentinelOf(content: string, format: AgentSentinelFormat, expectedName?: string): ParsedSentinel | undefined {
  const candidate = structuralSentinelCandidate(content, format);
  if (candidate === undefined) return undefined;
  const inner = innerSentinelText(candidate, format);
  if (inner === undefined) return undefined;
  const parsed = parseSentinelBody(inner);
  if (!parsed) return undefined;
  if (expectedName !== undefined && parsed.name !== expectedName) return undefined;
  return parsed;
}

export function isStructurallyManaged(content: string, format: AgentSentinelFormat, expectedName?: string): boolean {
  return structuralSentinelOf(content, format, expectedName) !== undefined;
}

/**
 * The audit's LOOSE tier fallback (R2-F6): anchored to the same structural
 * candidate position as `structuralSentinelOf` above, but does not require
 * the full grammar (a hand-authored fixture, or a stale sentinel predating
 * `content-sha256`, still counts) — it only requires the candidate to
 * actually START with the sentinel prefix (so body prose that happens to sit
 * in the structural position, e.g. right after frontmatter with no real
 * sentinel, is never mistaken for one) and to carry a `model_tier=` token.
 * For kiro this fixes the R2-F6 gap directly: only the FIRST LINE of the
 * parsed `prompt` is ever tested, never the whole one-physical-line JSON
 * string that also contains the entire header.
 */
export function structuralSentinelModelTier(content: string, format: AgentSentinelFormat): string | undefined {
  const candidate = structuralSentinelCandidate(content, format);
  if (candidate === undefined) return undefined;
  const inner = innerSentinelText(candidate, format);
  if (inner === undefined || !inner.startsWith(AGENT_SENTINEL_PREFIX)) return undefined;
  return MODEL_TIER_RE.exec(inner)?.[1];
}
