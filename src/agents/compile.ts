// `compileAgentDefinition` — the ONLY producer of dispatch/export inputs from
// an `AgentDefinition` (D-2, W2 §Design "Compiler"). No second reader may
// re-derive the keryx-shell input shape or a host file's content; every
// caller (the CLI's `export`/`verify`, a future orchestrator skill) goes
// through this function.
//
// Steps, in the fixed order W2 specifies:
//   1. validate the definition (schema.ts) and refuse a body that repeats
//      the prompt-defense baseline (AC3 — the compiler is the only injector).
//   2. render the compiled header: baseline + role + body, that fixed order.
//   3. project into the target's shape — `keryx-shell` returns the literal
//      `spawn_subagent` input subset (AC2) plus a policy sidecar; a host
//      target returns a `HostAgentExport`.
//
// `model_tier` is passed through UNCHANGED — never resolved to a model name
// here (AC7). `src/gdskills/model-tier.ts` (`isModelTier`) is the only tier
// authority this module defers to; the actual model resolution happens later,
// inside `spawn_subagent` itself, against the session's own provider.

import { createHash } from "node:crypto";
import { PROMPT_DEFENSE_BASELINE } from "./baseline";
import { validateAgentDefinition, type AgentSchemaError } from "./schema";
import { mapToolsForTarget, type HostToolTarget } from "./tools";
import { isAgentPolicyProfile, resolveKeryxShellPolicy, type AgentPolicyProfile, type KeryxShellMode } from "./policy";
import type { AgentDefinition, AgentExportRuntime, ExportSupportLevel, IsolationMode, ModelTier } from "./types";

export type CompileErrorReason =
  | "invalid-definition"
  | "baseline-in-body"
  | "unknown-policy-profile"
  | "target-not-implemented";

export interface CompileError {
  readonly reason: CompileErrorReason;
  readonly message: string;
  readonly details?: readonly string[];
}

/**
 * R1-F6: what `spawn_subagent` actually enforces from the `policy` sidecar
 * versus what is recorded only for a future dispatcher to honor. `mode` is
 * the ONE field `spawn_subagent`'s own input schema carries (see
 * `KeryxShellCompileResult.input.mode`) and the only one its tool-set
 * construction reads (`spawn-subagent-tool.ts`'s `mode === "read_only" ? ... : ...`
 * branch). `toolAllowlist`/`isolation` are carried in `policy` so a future
 * caller CAN read the definition's intent, but nothing in `spawn_subagent`
 * consumes them today — least of all `isolation: "worktree"`, which has no
 * corresponding input slot at all.
 */
export interface KeryxShellEnforcement {
  /** Sidecar fields `spawn_subagent` actually acts on. */
  readonly enforced: readonly string[];
  /** Sidecar fields recorded but not consumed by `spawn_subagent` today. */
  readonly advisory: readonly string[];
  readonly note: string;
}

const KERYX_SHELL_ENFORCEMENT: KeryxShellEnforcement = {
  enforced: ["mode"],
  advisory: ["toolAllowlist", "isolation"],
  note:
    "spawn_subagent enforces only `mode` (read_only vs general) as of v1 — see " +
    "src/harness/tool/builtin/spawn-subagent-tool.ts's mode-to-tools construction. " +
    "`general` mode currently grants the SAME tool set as `read_only` (the read-only " +
    "+ metaproject builtin tools; still no shell_exec, apply_patch, web_fetch or " +
    "web_search — \"v1 general: still no shell_exec\", parent owns mutations). " +
    "toolAllowlist and isolation are carried here for a future dispatcher to read " +
    "but are NOT enforced by spawn_subagent today; nothing is silently dropped (every " +
    "field lands in input or here), but only `mode` actually constrains the child.",
};

/**
 * The `target="keryx-shell"` compiled result: `input`'s keys are always a
 * SUBSET of `spawn_subagent`'s `inputSchema.properties`
 * (`task`/`mode`/`label`/`max_tool_calls`/`max_rounds`/`model_tier`/
 * `runtime`) — this workstream adds no new keys to that tool (AC2). Fields
 * with no direct `spawn_subagent` input slot (`tools`, `policy_profile`,
 * `isolation`) are threaded through the `policy` sidecar instead of being
 * silently dropped.
 */
export interface KeryxShellCompileResult {
  readonly target: "keryx-shell";
  readonly input: {
    readonly task: string;
    readonly mode: KeryxShellMode;
    readonly label: string;
    readonly model_tier: ModelTier;
  };
  readonly policy: {
    readonly profile: string;
    readonly toolAllowlist: readonly string[];
    readonly isolation: IsolationMode;
    /** R1-F6: which of the above `spawn_subagent` actually enforces today. */
    readonly enforcement: KeryxShellEnforcement;
  };
}

/** A host-target compiled result. `renderHostExport` (below) is the one hook point every host renderer plugs into. */
export interface HostAgentExport {
  readonly target: Exclude<AgentExportRuntime, "keryx-shell">;
  readonly supportLevel: ExportSupportLevel;
  readonly relativePath: string;
  readonly content: string;
  readonly droppedTools: readonly string[];
}

export type CompiledAgent = KeryxShellCompileResult | HostAgentExport;

export type CompileResult = { readonly ok: true; readonly result: CompiledAgent } | { readonly ok: false; readonly error: CompileError };

/** Baseline + role + body, in that fixed order (W2 §Design "Compiler", step 2). */
function renderHeader(definition: AgentDefinition): string {
  return `${PROMPT_DEFENSE_BASELINE}\n\n${definition.role}\n\n${definition.body}`;
}

function formatValidationErrors(errors: readonly AgentSchemaError[]): readonly string[] {
  return errors.map((error) => `${error.field}: ${error.message}`);
}

// ---------------------------------------------------------------------------
// R1-F14: near-copy baseline guard.
//
// `body.includes(PROMPT_DEFENSE_BASELINE)` only ever catches a byte-exact
// copy. A lightly reworded or re-wrapped copy (extra whitespace, rewrapped
// line breaks, a word or two changed) carries the same long runs of baseline
// words and is exactly the "divergent copy" the old guard test asserted
// nothing about (it exercised only JS string equality, not this module). This
// n-gram check catches that class: any run of `BASELINE_NGRAM_WORDS`
// consecutive baseline words appearing consecutively (whitespace-normalized)
// anywhere in the body fails compilation, the same as an exact copy.
// ---------------------------------------------------------------------------

const BASELINE_NGRAM_WORDS = 10;

function ngramsOf(words: readonly string[], n: number): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i + n <= words.length; i += 1) {
    grams.add(words.slice(i, i + n).join(" "));
  }
  return grams;
}

const BASELINE_WORDS = PROMPT_DEFENSE_BASELINE.split(/\s+/).filter((w) => w.length > 0);
const BASELINE_NGRAMS = ngramsOf(BASELINE_WORDS, BASELINE_NGRAM_WORDS);

/** True when `body` shares a long (>= `BASELINE_NGRAM_WORDS` word) consecutive run with the baseline, whitespace differences aside. Subsumes an exact copy. */
function containsBaselineNearCopy(body: string): boolean {
  const words = body.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < BASELINE_NGRAM_WORDS) return false;
  for (let i = 0; i + BASELINE_NGRAM_WORDS <= words.length; i += 1) {
    if (BASELINE_NGRAMS.has(words.slice(i, i + BASELINE_NGRAM_WORDS).join(" "))) return true;
  }
  return false;
}

/**
 * A deterministic, field-by-field serialization of an {@link AgentDefinition}
 * (T7): every field in a fixed order, never `JSON.stringify(definition)`
 * directly (object key order is not a contract this module wants to depend
 * on). This is the "canonical source" every host export's managed sentinel
 * hashes — see {@link definitionSourceHash} — so the SAME hash appears in
 * every target's export of one definition version, letting a caller notice
 * "this source changed since it was exported" without diffing rendered,
 * per-target content against itself.
 */
function canonicalDefinitionSource(definition: AgentDefinition): string {
  return JSON.stringify({
    schema_version: definition.schema_version ?? null,
    name: definition.name,
    description: definition.description,
    role: definition.role,
    tools: [...definition.tools],
    model_tier: definition.model_tier,
    policy_profile: definition.policy_profile,
    skills: [...definition.skills],
    stacks: [...definition.stacks],
    output_contract: definition.output_contract,
    isolation: definition.isolation,
    origin: definition.origin ?? null,
    body: definition.body,
  });
}

/** sha256 hex of {@link canonicalDefinitionSource} — the hash every managed-export sentinel carries. */
export function definitionSourceHash(definition: AgentDefinition): string {
  return createHash("sha256").update(canonicalDefinitionSource(definition), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// R1-F9: content-hash sentinel.
//
// The sentinel's `sha256:` clause (above) hashes the SOURCE definition — it
// tells a caller "this source changed since export", but says nothing about
// whether the EXPORTED FILE itself was hand-edited afterward (the source
// could be unchanged while the file was edited, or vice versa). A second
// clause, `content-sha256:`, closes that gap: it hashes the file's own
// rendered content (sentinel line included, via a fixed placeholder swapped
// in before hashing so the hash does not have to depend on itself). A
// well-formed sentinel line's `content-sha256:` therefore always answers "is
// this file's content, right now, the exact content it claims to be" —
// `export.ts`'s `decideAction` uses that to tell a stale-but-untouched export
// (safe to overwrite) apart from a hand-edited one (refuse unless `--force`).
// ---------------------------------------------------------------------------

/** Fixed-width placeholder swapped for the real content hash before/after hashing — see {@link finalizeAgentContentHash}. */
export const AGENT_CONTENT_HASH_PLACEHOLDER = "0".repeat(64);
const CONTENT_HASH_MARKER = "content-sha256:";

/**
 * The ONE managed-sentinel wording every host renderer below embeds (task
 * text, T7): `<!-- keryx-managed: keryx agents export (<name>,
 * sha256:<hash-of-canonical-source>, model_tier=<tier>,
 * content-sha256:<hash-of-rendered-content>) -->` for markdown, `#
 * keryx-managed: ...` for TOML (codex), and — for kiro's JSON, whose
 * unknown-key tolerance is undocumented — the SAME text as the first line of
 * the `prompt` field instead of a new top-level key. Sharing this one string
 * (with only the comment delimiter varying) is what lets `export.ts`'s
 * refuse-unmanaged / unchanged detection substring-match ONE pattern across
 * every target.
 *
 * `content-sha256:` is always emitted here as {@link AGENT_CONTENT_HASH_PLACEHOLDER}
 * — every renderer below MUST pass its finished content through
 * {@link finalizeAgentContentHash} as its last step, which swaps the
 * placeholder for the real hash of the rendered content (R1-F9).
 *
 * Flow 310 (W2) T13: `model_tier=<tier>` travels inside this sentinel on
 * EVERY target, including claude, so the canonical tier is always readable
 * straight off the exported file even for a host format with no first-party
 * `model`/`model_tier` field of its own (codex/kiro omit `model` entirely —
 * "omit = inherit parent" per their docs; opencode's frontmatter carries no
 * tier field either). `src/security/audit-harness/checks.ts`'s
 * `checkAgentMissingModelTier` reads this same annotation as a fallback for
 * those formats — never in place of a format's own explicit `model`/
 * `model_tier` field where one exists (claude's frontmatter is checked
 * first), only as the one signal available where none does.
 */
export function agentManagedSentinelText(definition: AgentDefinition): string {
  return (
    `keryx-managed: keryx agents export (${definition.name}, sha256:${definitionSourceHash(definition)}, ` +
    `model_tier=${definition.model_tier}, ${CONTENT_HASH_MARKER}${AGENT_CONTENT_HASH_PLACEHOLDER})`
  );
}

/**
 * The last step every renderer's `content` passes through: hash the
 * placeholder-bearing draft content (the placeholder is a fixed constant, so
 * this is deterministic — no circularity), then swap every occurrence of the
 * placeholder for that hash. There is exactly one occurrence in practice (the
 * sentinel line), but `split`/`join` rather than a single `replace` costs
 * nothing and never under-replaces if a future renderer embeds it twice.
 */
export function finalizeAgentContentHash(draftContent: string): string {
  const hash = createHash("sha256").update(draftContent, "utf8").digest("hex");
  return draftContent.split(AGENT_CONTENT_HASH_PLACEHOLDER).join(hash);
}

/**
 * R1-F9: true when `content`'s own embedded `content-sha256:` still matches
 * a hash recomputed from `content` itself — i.e. `content` is exactly what
 * some `finalizeAgentContentHash` call produced, unedited since. Reconstructs
 * the placeholder-bearing draft by swapping the recorded hash back out, then
 * re-hashes and compares. Content with no `content-sha256:` clause at all
 * (no sentinel, or an older sentinel predating this field) is unverifiable —
 * reported `false` (fail closed: the caller treats "cannot verify" the same
 * as "hand-edited").
 */
export function verifyAgentContentHash(content: string): boolean {
  const markerIndex = content.indexOf(CONTENT_HASH_MARKER);
  if (markerIndex === -1) return false;
  const hashStart = markerIndex + CONTENT_HASH_MARKER.length;
  const recorded = content.slice(hashStart, hashStart + 64);
  if (!/^[0-9a-f]{64}$/.test(recorded)) return false;
  const reconstructed = content.slice(0, hashStart) + AGENT_CONTENT_HASH_PLACEHOLDER + content.slice(hashStart + 64);
  const actual = createHash("sha256").update(reconstructed, "utf8").digest("hex");
  return actual === recorded;
}

/**
 * The fixed, name/hash-independent PREFIX of every managed sentinel this
 * module writes — `export.ts`'s "does this existing file carry a
 * keryx-managed sentinel at all" check (refuse-unmanaged vs
 * create/update/unchanged) substring-matches this, not the full
 * per-definition text (which also carries the current name/hash and would
 * never match a STALE export from an earlier source version).
 */
export const AGENT_SENTINEL_PREFIX = "keryx-managed: keryx agents export (";

/** `target="keryx-shell"` projection (W2 §Design "Keryx shell child agents"). */
function compileKeryxShell(definition: AgentDefinition, header: string): CompileResult {
  const policyResolution = resolveKeryxShellPolicy(definition.policy_profile);
  if (!policyResolution.ok) {
    return { ok: false, error: { reason: "unknown-policy-profile", message: policyResolution.error.message } };
  }
  return {
    ok: true,
    result: {
      target: "keryx-shell",
      input: {
        task: header,
        mode: policyResolution.resolution.mode,
        label: definition.name,
        model_tier: definition.model_tier,
      },
      policy: {
        profile: policyResolution.resolution.profileName,
        toolAllowlist: [...definition.tools],
        isolation: definition.isolation,
        enforcement: KERYX_SHELL_ENFORCEMENT,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// R1-F1: YAML scalar quoting.
//
// `JSON.stringify` produces a valid YAML double-quoted scalar for any string:
// YAML's double-quoted scalar escapes are a superset of JSON's (backslash,
// double-quote, and C0 control characters all use the same `\...`/`\uXXXX`
// forms), so wrapping every interpolated frontmatter value this way — rather
// than interpolating it as a bare plain scalar — closes the whole class of
// injection the round-1 review found: a `: ` inside the value no longer reads
// as a new mapping key, a leading `- ` no longer reads as a sequence item, a
// leading `#`/trailing ` #` no longer starts a comment, and an embedded
// newline cannot inject a sibling frontmatter key (`permissionMode: ...` was
// the round-1 probe). Never interpolate a definition-controlled string into
// YAML frontmatter unquoted.
// ---------------------------------------------------------------------------
function yamlDoubleQuoted(value: string): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// R1-F5: policy_profile enforcement in host exports whose tool vocabulary can
// express mutation at all (claude/kiro name individual tools; opencode's
// renderer already folds `policy_profile` in below; codex has no per-tool
// allowlist to strip from — governed by `sandbox_mode` alone).
// ---------------------------------------------------------------------------

/** Vocabulary entries that grant a mutation capability (write or shell) on a host that can express one. */
const MUTATION_TOOL_NAMES = new Set(["apply_patch", "shell_exec"]);

/**
 * Split `tools` into what a `read-only` definition is still allowed to
 * declare and what must be stripped (`apply_patch`/`shell_exec`) — a no-op
 * for `workspace-write` (or any other profile; `mapToolsForTarget`'s target
 * mapping still governs everything else). The stripped names are folded into
 * the renderer's `droppedTools` so a `read-only` definition naming a mutation
 * tool is visibly downgraded, not silently exported with it, on every host
 * whose vocabulary can name one.
 */
function stripMutationToolsForPolicy(
  tools: readonly string[],
  policyProfile: string,
): { readonly allowed: readonly string[]; readonly strippedForPolicy: readonly string[] } {
  if (policyProfile !== "read-only") return { allowed: tools, strippedForPolicy: [] };
  const allowed: string[] = [];
  const strippedForPolicy: string[] = [];
  for (const tool of tools) {
    (MUTATION_TOOL_NAMES.has(tool) ? strippedForPolicy : allowed).push(tool);
  }
  return { allowed, strippedForPolicy };
}

// R1-F4: the read baseline emitted when a target's mapped tool list would
// otherwise be empty (empty `tools[]`, every entry unmapped for this target,
// or every mutation tool stripped by R1-F5 above) — an omitted/empty `tools:`
// is claude's own documented signal for "inherit every tool", the exact
// least-privilege inversion R1-F4 found; kiro's own coarse vocabulary has no
// "inherit" reading for `tools: []` but an explicit empty allowlist is still
// the wrong default for a definition that named tools at all. Both baselines
// grant read access only, matching every target's `policy_profile: read-only`
// floor.
const CLAUDE_READ_BASELINE: readonly string[] = ["Read", "Grep", "Glob"];
const KIRO_READ_BASELINE: readonly string[] = ["read"];

/**
 * Claude Code renderer (`.claude/agents/<name>.md`) — the one host renderer
 * this task implements end-to-end, so the compile path is testable without
 * waiting on T7. codex/kiro/opencode are the hook point T7 fills in; they
 * throw a clear, named refusal here rather than emitting a guessed shape.
 *
 * `supportLevel` is hardcoded `"native"` for claude here because T5 has no
 * W5 registry lookup wired in yet (that lookup — `agentExportSupport` — is
 * `export.ts`'s job, owned by T7); this renderer is the content-shape half
 * of the exporter, not the honesty-gated dispatcher in front of it.
 */
/** A markdown HTML-comment sentinel line, the shape claude/opencode both use. */
function mdSentinelLine(definition: AgentDefinition): string {
  return `<!-- ${agentManagedSentinelText(definition)} -->`;
}

function renderClaudeExport(definition: AgentDefinition, header: string): HostAgentExport {
  const { allowed, strippedForPolicy } = stripMutationToolsForPolicy(definition.tools, definition.policy_profile);
  const { mappedTools, droppedTools } = mapToolsForTarget(allowed, "claude");
  const claudeTools = mappedTools.length > 0 ? mappedTools : CLAUDE_READ_BASELINE;
  const frontmatter = [
    "---",
    `name: ${yamlDoubleQuoted(definition.name)}`,
    `description: ${yamlDoubleQuoted(definition.description)}`,
    `tools: ${yamlDoubleQuoted(claudeTools.join(", "))}`,
    // Tier is never mapped to a model alias (AC7) — `inherit` never
    // downgrades and names no concrete model.
    "model: inherit",
    "---",
  ].join("\n");
  const draft = `${frontmatter}\n${mdSentinelLine(definition)}\n\n${header}\n`;
  return {
    target: "claude",
    supportLevel: "native",
    relativePath: `.claude/agents/${definition.name}.md`,
    content: finalizeAgentContentHash(draft),
    droppedTools: [...droppedTools, ...strippedForPolicy],
  };
}

/**
 * TOML basic-string escaping (single-line fields: name/description/
 * sandbox_mode — none of these carry embedded newlines by schema, but the
 * escape still guards backslash/quote/control-char content defensively).
 */
function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    // eslint-disable-next-line no-control-regex -- matching control characters is the point (R1-F1: TOML basic strings must escape them)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, (ch) => `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`);
  return `"${escaped}"`;
}

/**
 * TOML multi-line basic string for `developer_instructions` (the compiled
 * header, which is always multi-line). Backslashes are escaped first, then
 * `\r` (a lone carriage return is not itself a valid TOML newline), then any
 * remaining C0/DEL control character (R1-F1: `Bun.TOML.parse` rejects an
 * unescaped one, e.g. U+0007 BEL) is escaped as `\uXXXX` — real `\n`/`\t` are
 * left literal, since TOML multiline basic strings allow both unescaped —
 * and finally any run of 3+ quotes is broken up so it can never be mistaken
 * for the closing `"""` delimiter. The header is agent-authored prose, not
 * TOML-aware input, so this guards against pathological content rather than
 * an expected shape.
 */
function tomlMultilineString(value: string): string {
  const escapedBackslashes = value.replace(/\\/g, "\\\\");
  const escapedCr = escapedBackslashes.replace(/\r/g, "\\r");
  // eslint-disable-next-line no-control-regex -- matching control characters is the point (R1-F1: TOML multiline basic strings must escape them)
  const escapedControls = escapedCr.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, (ch) => `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`);
  const escapedQuoteRuns = escapedControls.replace(/"{3,}/g, (run) => run.replace(/"/g, '\\"'));
  return `"""\n${escapedQuoteRuns}\n"""`;
}

/**
 * Codex renderer (`.codex/agents/<name>.toml`, context.md's first-party docs
 * check): codex has NO per-tool allowlist — access is governed entirely by
 * `sandbox_mode` (`read-only` | `workspace-write`, the SAME two values
 * `policy_profile` already uses — `policy.ts`'s canonical vocabulary maps
 * onto codex's directly, no separate table needed). Every declared tool is
 * therefore reported governed-by-sandbox rather than dropped: `droppedTools`
 * is always `[]` here, a deliberate choice (not an oversight — see
 * `tools.ts`'s empty codex map comment), documented in this renderer rather
 * than silently inherited from `mapToolsForTarget`. `model`/
 * `model_reasoning_effort` are both omitted (omit = inherit the parent,
 * confirmed by docs) — never a literal model name (AC7).
 */
function renderCodexExport(definition: AgentDefinition, header: string): CompileResult {
  const policy = resolveKeryxShellPolicy(definition.policy_profile);
  if (!policy.ok) {
    return { ok: false, error: { reason: "unknown-policy-profile", message: policy.error.message } };
  }
  // codex's sandbox_mode vocabulary IS `policy_profile`'s vocabulary
  // (`AgentPolicyProfile`) verbatim — asserted here rather than re-derived,
  // so a future third profile value fails loudly instead of silently mapping
  // to the wrong sandbox mode.
  const sandboxMode: AgentPolicyProfile = isAgentPolicyProfile(definition.policy_profile)
    ? definition.policy_profile
    : "read-only";
  const lines = [
    `# ${agentManagedSentinelText(definition)}`,
    `name = ${tomlString(definition.name)}`,
    `description = ${tomlString(definition.description)}`,
    `developer_instructions = ${tomlMultilineString(header)}`,
    `sandbox_mode = ${tomlString(sandboxMode)}`,
  ];
  const draft = `${lines.join("\n")}\n`;
  return {
    ok: true,
    result: {
      target: "codex",
      supportLevel: "adapter",
      relativePath: `.codex/agents/${definition.name}.toml`,
      content: finalizeAgentContentHash(draft),
      droppedTools: [],
    },
  };
}

/**
 * Kiro renderer (`.kiro/agents/<name>.json`, context.md's first-party docs
 * check): unknown-key tolerance is undocumented, so NO extra top-level key
 * carries the managed sentinel — it is the first line of `prompt` instead.
 * `tools` uses kiro's documented coarse tags (`read`/`write`/`shell`/`web`,
 * `tools.ts`'s kiro map) — every vocabulary entry maps onto one of the four,
 * so nothing is ever dropped here for an unmapped-vocabulary reason (R1-F5's
 * policy-driven strip below is the one source of `droppedTools` on kiro).
 * `model` is omitted (omit = inherit). `allowedTools` is deliberately NOT
 * emitted: its interaction with `tools` is not confirmed by first-party
 * docs, and inventing a value would be a guess this renderer refuses to
 * make. The whole `content` (a JSON document) is emitted via
 * `JSON.stringify`, which is inherently injection-safe (R1-F1) — no manual
 * escaping needed here the way the md/TOML renderers need.
 */
function renderKiroExport(definition: AgentDefinition, header: string): CompileResult {
  const { allowed, strippedForPolicy } = stripMutationToolsForPolicy(definition.tools, definition.policy_profile);
  const { mappedTools, droppedTools } = mapToolsForTarget(allowed, "kiro");
  const kiroTools = mappedTools.length > 0 ? mappedTools : KIRO_READ_BASELINE;
  const prompt = `${agentManagedSentinelText(definition)}\n\n${header}`;
  const doc = {
    name: definition.name,
    description: definition.description,
    prompt,
    tools: kiroTools,
  };
  const draft = `${JSON.stringify(doc, null, 2)}\n`;
  return {
    ok: true,
    result: {
      target: "kiro",
      supportLevel: "adapter",
      relativePath: `.kiro/agents/${definition.name}.json`,
      content: finalizeAgentContentHash(draft),
      droppedTools: [...droppedTools, ...strippedForPolicy],
    },
  };
}

/**
 * OpenCode renderer (`.opencode/agents/<name>.md`, context.md's first-party
 * docs check): the documented `tools` boolean map is deprecated — this
 * renderer emits a `permission` map instead (`edit`/`bash`/`webfetch`/
 * `websearch`, each `allow`/`deny`), derived from BOTH the definition's
 * `tools[]` (does the mapped OpenCode tool actually appear) and its
 * `policy_profile` (a `read-only` definition denies `edit`/`bash`
 * regardless of what `tools[]` names — the enforced policy always wins over
 * a merely-declared intent; `webfetch`/`websearch` are non-mutating and
 * follow tool presence alone, unaffected by the write/no-write distinction
 * `policy_profile` encodes — this is already the reference implementation
 * R1-F5 held claude/kiro to). `mode: subagent` and an omitted `model` (=
 * inherit) are both fixed per docs.
 */
function renderOpencodeExport(definition: AgentDefinition, header: string): CompileResult {
  const { mappedTools, droppedTools } = mapToolsForTarget(definition.tools, "opencode");
  const has = (toolName: string) => mappedTools.includes(toolName);
  const canWrite = definition.policy_profile === "workspace-write";
  const permission = {
    edit: canWrite && has("edit") ? "allow" : "deny",
    bash: canWrite && has("bash") ? "allow" : "deny",
    webfetch: has("webfetch") ? "allow" : "deny",
    websearch: has("websearch") ? "allow" : "deny",
  };
  const frontmatter = [
    "---",
    `description: ${yamlDoubleQuoted(definition.description)}`,
    "mode: subagent",
    "permission:",
    `  edit: ${permission.edit}`,
    `  bash: ${permission.bash}`,
    `  webfetch: ${permission.webfetch}`,
    `  websearch: ${permission.websearch}`,
    "---",
  ].join("\n");
  const draft = `${frontmatter}\n${mdSentinelLine(definition)}\n\n${header}\n`;
  return {
    ok: true,
    result: {
      target: "opencode",
      supportLevel: "adapter",
      relativePath: `.opencode/agents/${definition.name}.md`,
      content: finalizeAgentContentHash(draft),
      droppedTools,
    },
  };
}

/**
 * The hook point every host renderer plugs into. `supportLevel` on each
 * result is the renderer's OWN mechanical-shape fact (claude verified/native
 * per T5, codex/kiro/opencode experimental/adapter per context.md's docs
 * check) — never the final honesty gate a caller relies on; `export.ts`'s
 * `agentExportSupport` (reading the W5 registry) is the one place that
 * decides whether this render is actually used for a given project, per
 * AC4.
 */
export function renderHostExport(
  definition: AgentDefinition,
  target: HostToolTarget,
  header: string,
): CompileResult {
  if (target === "claude") {
    return { ok: true, result: renderClaudeExport(definition, header) };
  }
  if (target === "codex") {
    return renderCodexExport(definition, header);
  }
  if (target === "kiro") {
    return renderKiroExport(definition, header);
  }
  if (target === "opencode") {
    return renderOpencodeExport(definition, header);
  }
  return {
    ok: false,
    error: {
      reason: "target-not-implemented",
      message: `host export target "${String(target)}" has no renderer`,
    },
  };
}

export type CompileHeaderResult = { readonly ok: true; readonly header: string } | { readonly ok: false; readonly error: CompileError };

/**
 * Validate + render the header alone (baseline + role + body), with none of
 * a target's own shape applied — the same first two steps
 * `compileAgentDefinition` always runs before dispatching on `target`.
 * `export.ts`'s instruction-only prose fallback (AC4: a runtime with no
 * W5 registry `agents` record) is the one caller that needs the header
 * WITHOUT committing to any one host's frontmatter/TOML/JSON shape — reusing
 * this avoids a second, independent copy of the validate-then-render steps.
 */
export function compileAgentHeader(definition: AgentDefinition): CompileHeaderResult {
  const validation = validateAgentDefinition(definition);
  if (!validation.ok) {
    return {
      ok: false,
      error: {
        reason: "invalid-definition",
        message: `agent "${definition.name}" failed schema validation`,
        details: formatValidationErrors(validation.errors),
      },
    };
  }
  // R1-F14: an exact copy OR a long-enough near-copy (reworded/re-wrapped) of
  // the baseline in the body is rejected the same way — see
  // `containsBaselineNearCopy` above.
  if (definition.body.includes(PROMPT_DEFENSE_BASELINE) || containsBaselineNearCopy(definition.body)) {
    return {
      ok: false,
      error: {
        reason: "baseline-in-body",
        message: `agent "${definition.name}"'s body repeats the prompt-defense baseline text — the compiler injects it once; remove it from the body`,
      },
    };
  }
  return { ok: true, header: renderHeader(definition) };
}

/** The only producer of dispatch/export inputs from an {@link AgentDefinition} (D-2). Never throws. */
export function compileAgentDefinition(definition: AgentDefinition, target: AgentExportRuntime): CompileResult {
  const headerResult = compileAgentHeader(definition);
  if (!headerResult.ok) {
    return { ok: false, error: headerResult.error };
  }
  const header = headerResult.header;
  if (target === "keryx-shell") {
    return compileKeryxShell(definition, header);
  }
  return renderHostExport(definition, target, header);
}
