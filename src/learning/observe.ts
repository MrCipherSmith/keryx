// Observe stage (W3 spec, "Observe" + "Observation event contract" + "Hook
// event to observation event mapping"; plan T6). Builds and appends one
// redacted, bounded JSONL line per hook event to
// `.metaproject/data/learning/observations/<YYYY-MM-DD>.jsonl`, and adapts
// both W6's in-process `LearningObservation` port and a Claude Code host
// hook's raw stdin payload into that same line shape.
//
// `src/learning` is import-zone `core` (`src/lib/import-zones.ts`);
// `src/harness` (where `LearningObservation`/`LearningObservationSink` are
// declared, `harness/hooks/builtins.ts`) is zone `client`. A core module can
// never import a client one, so `LearningObservationLike`/
// `LearningObservationSink` below are a structurally identical LOCAL
// re-declaration, not an import — the wiring site
// (`src/commands/agent-hooks.ts`, itself zone `client`) can freely assign an
// object built here wherever the harness's own `HookRuntimePorts.
// learningSink` is expected, because TypeScript's structural typing accepts
// it as long as the shapes line up. Keep this file's two interfaces
// byte-for-byte in sync with `builtins.ts`'s `LearningObservation`/
// `LearningObservationSink`.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathExists, toPosix, withFileLock } from "../lib/fs";
import { assertInsideLearningRoot, learningDataDir, observationFilePath, observationsDir } from "./paths";
import { resolveProjectIdentity, type ResolveProjectIdentityDeps } from "./identity";
import { redactPreview } from "./scan";
import { validateObservationEvent } from "./schema";
import type { ObservationEvent, ObservationEventName, ProjectIdentity } from "./types";

const MAX_PREVIEW_LEN = 200;
const DEFAULT_MAX_LINES_PER_FILE = 5000;

// O-4: `sessionId`/`toolUseId` (free-form host-supplied strings) and `tool`
// (a host-supplied tool name) are bounded and shape-checked before they ever
// reach a stored line — an unbounded or exotic value is replaced with a
// deterministic, harmless stand-in rather than stored verbatim.
const SESSION_OR_TOOL_USE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deterministic serialization: object keys sorted (recursively), array order preserved. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
    return sorted;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "";
  return JSON.stringify(sortKeysDeep(value));
}

// --- C-14: hook event -> observation event mapping -------------------------

const HOOK_EVENT_TO_OBSERVATION: Readonly<Record<string, ObservationEventName>> = {
  PreToolUse: "tool-start",
  PostToolUse: "tool-complete",
  PostToolUseFailure: "tool-failed",
  UserPromptSubmit: "user-prompt",
  SessionStart: "session-start",
  Stop: "turn-stop",
  SessionEnd: "session-end",
};

const OBSERVATION_EVENT_NAMES: readonly ObservationEventName[] = [
  "tool-start",
  "tool-complete",
  "tool-failed",
  "user-prompt",
  "session-start",
  "turn-stop",
  "session-end",
];

/**
 * Maps a W6 hook event name (`PreToolUse`, ...) to its W3 observation `event`
 * value (C-14 table). Also accepts a W6 `LearningObservation.kind` value
 * directly — those are already observation-event names, so a caller that
 * already resolved `kind` (e.g. `createLearningObservationSink`) can pass it
 * straight through. Returns `null` for anything else.
 */
export function mapHookEventToObservation(hookEvent: string): ObservationEventName | null {
  const mapped = HOOK_EVENT_TO_OBSERVATION[hookEvent];
  if (mapped !== undefined) return mapped;
  return (OBSERVATION_EVENT_NAMES as readonly string[]).includes(hookEvent) ? (hookEvent as ObservationEventName) : null;
}

// --- buildObservationLine ---------------------------------------------------

export interface BuildObservationLineInput {
  event: ObservationEventName;
  tool: string | null;
  toolInput?: unknown;
  toolOutput?: unknown;
  sessionId: string;
  toolUseId: string | null;
  prompt?: string;
  cwd: string;
  observedAt: string;
}

export interface BuildObservationLineDeps {
  /** Skips `resolveProjectIdentity` (e.g. a sink caching it per instance). */
  projectIdentity?: ProjectIdentity;
  identityDeps?: ResolveProjectIdentityDeps;
  warn?: (message: string, error?: unknown) => void;
}

// O-1: a preview must never carry an absolute path (which can embed a
// username), raw edit content, or the raw project root / home directory —
// only what's needed to be useful for extraction while remaining safe to
// persist and, eventually, review on screen.

/** Path-shaped keys across Claude's own tool-input/tool-response shapes (snake_case input, camelCase response) and Keryx's own (`file_path`). */
const PATH_LIKE_KEYS = new Set(["file_path", "path", "filePath", "notebook_path"]);

/** Array fields that are lists of paths (Grep's `filenames`, generic `files`/`paths`) rather than free text — each entry is relativized like a `PATH_LIKE_KEYS` value, never scrubbed as prose. */
const PATH_LIST_KEYS = new Set(["filenames", "files", "paths"]);

/**
 * Raw-content-bearing keys on an edit-like tool's input or Claude's
 * `tool_response` for one — never previewed; the D3 `edit` hash-only field
 * covers them instead (O2-1/O2-2: includes NotebookEdit's `new_source`
 * input key and `original_file` response key). Also covers prompt-like
 * keys (O2-3: a Task/Agent tool's `prompt`/`messages`/`system`/
 * `instructions` input) — dropped from every tool's preview the same way;
 * `inputDigest` still covers the full input regardless.
 */
const CONTENT_DROP_KEYS = new Set([
  "old_string",
  "new_string",
  "oldString",
  "newString",
  "content",
  "edits",
  "originalFile",
  "structuredPatch",
  "new_source",
  "original_file",
  "prompt",
  "messages",
  "system",
  "instructions",
]);

/** Edit-like tool names (Claude's own + Keryx's `apply_patch`/`shell_exec` aliases) whose `tool_response` can carry a raw file body — O2-1: their output preview is a fixed summary, never a `content`/`originalFile`/... extraction. */
const EDIT_LIKE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch"]);

/** `root`'s resolved form plus its realpath (O2-5: macOS `/private/var` vs `/var`), longest-first so a more specific path is tried before a shorter prefix of it. Memoized per root — cheap, and `root` does not change within a process. */
const rootVariantsCache = new Map<string, readonly string[]>();
function rootVariants(root: string): readonly string[] {
  let variants = rootVariantsCache.get(root);
  if (variants === undefined) {
    const resolved = path.resolve(root);
    const set = new Set<string>();
    if (resolved.length > 0) set.add(resolved);
    try {
      const real = realpathSync(resolved);
      if (real.length > 0) set.add(real);
    } catch {
      // root may not exist yet (fixtures, dry runs) — resolved form only.
    }
    variants = [...set].sort((a, b) => b.length - a.length);
    rootVariantsCache.set(root, variants);
  }
  return variants;
}

/** The caller's home directory plus its realpath, same rationale as `rootVariants`. Memoized once per process — `os.homedir()` does not change mid-run. */
let homeVariantsCache: readonly string[] | undefined;
function homeVariants(): readonly string[] {
  if (homeVariantsCache === undefined) {
    const home = os.homedir();
    const set = new Set<string>();
    if (home.length > 0) {
      set.add(home);
      try {
        const real = realpathSync(home);
        if (real.length > 0) set.add(real);
      } catch {
        // home may not exist under a sandboxed HOME — resolved form only.
      }
    }
    homeVariantsCache = [...set].sort((a, b) => b.length - a.length);
  }
  return homeVariantsCache;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces `target` in `text` only where it ends at a path-segment boundary (end of string, or the next char is not part of the same path component) — O2-5: a root of `/a/proj` must not rewrite `/a/proj-secret` into `.-secret`. */
function replaceAtPathBoundary(text: string, target: string, replacement: string): string {
  if (target.length === 0) return text;
  const pattern = new RegExp(`${escapeRegExp(target)}(?![A-Za-z0-9_.-])`, "g");
  return text.replace(pattern, replacement);
}

/** Best-effort basename (or `[abs-path]` when none) for a matched absolute-path token — never the full path. */
function basenameOfToken(token: string): string {
  const trimmed = token.replace(/[\\/]+$/, "");
  const base = trimmed.split(/[/\\]/).pop();
  return base !== undefined && base.length > 0 ? base : "[abs-path]";
}

// O2-5: after root/home are scrubbed, anything still shaped like an absolute
// path (someone else's `/home/<user>/…` or `/Users/<user>/…`, a Windows
// `C:\Users\…`/`C:/Users/…`, a sibling `~otheruser/…`) is reduced to its
// basename rather than surviving verbatim in free text. A leading boundary
// (`(?<![\w:./~-])`) keeps these from matching mid-token (e.g. inside a URL).
const POSIX_ABS_PATH = /(?<![\w:./~-])\/[^\s"'<>|]+\/[^\s"'<>|]*/g;
const WINDOWS_ABS_PATH = /(?<![\w:./~-])[A-Za-z]:[\\/][^\s"'<>|]*/g;
const TILDE_USER_PATH = /(?<![\w:./~-])~[A-Za-z0-9_.-]+(?:\/[^\s"'<>|]*)?/g;

function replaceRemainingAbsolutePaths(text: string): string {
  return text
    .replace(POSIX_ABS_PATH, basenameOfToken)
    .replace(WINDOWS_ABS_PATH, basenameOfToken)
    .replace(TILDE_USER_PATH, basenameOfToken);
}

/** Replaces every occurrence of the project root with `.` and the caller's home directory with `~` in free text (a Bash command, stdout/stderr, …), then reduces any other absolute-path-shaped token to its basename. Root variants are tried first (longer, more specific) so a project rooted under `$HOME` is not double-replaced; each replacement only fires at a path-segment boundary (O2-5). */
function scrubPathsInText(root: string, text: string): string {
  let out = text;
  const roots = rootVariants(root);
  for (const variant of roots) out = replaceAtPathBoundary(out, variant, ".");
  const rootSet = new Set(roots);
  for (const variant of homeVariants()) {
    if (rootSet.has(variant)) continue;
    out = replaceAtPathBoundary(out, variant, "~");
  }
  return replaceRemainingAbsolutePaths(out);
}

/** One path-like field's preview value: project-relative when inside root, basename-only (never a full path) when outside it or unresolvable. */
function relativizePathForPreview(root: string, filePath: string): string {
  if (!path.isAbsolute(filePath)) return toPosix(filePath);
  const relative = path.relative(path.resolve(root), filePath);
  if (relative.length === 0) return ".";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    const base = filePath.split(/[/\\]/).pop();
    return base !== undefined && base.length > 0 ? base : "[outside-project]";
  }
  return toPosix(relative);
}

/** Recursively sanitizes a tool-input/tool-output JSON value for preview: drops raw edit content, relativizes path-like fields, and scrubs root/home from remaining free text. Never mutates `value`. */
function sanitizeForPreview(root: string, value: unknown): unknown {
  if (typeof value === "string") return scrubPathsInText(root, value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeForPreview(root, entry));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (CONTENT_DROP_KEYS.has(key)) continue;
      if (PATH_LIKE_KEYS.has(key) && typeof v === "string") {
        out[key] = relativizePathForPreview(root, v);
        continue;
      }
      // O2-5: a Grep-shaped `filenames` (or generic `files`/`paths`) array is
      // a list of paths, not prose — relativize each entry the same way a
      // single `PATH_LIKE_KEYS` value is, instead of scrubbing it as text.
      if (PATH_LIST_KEYS.has(key) && Array.isArray(v)) {
        out[key] = v.map((entry) => (typeof entry === "string" ? relativizePathForPreview(root, entry) : sanitizeForPreview(root, entry)));
        continue;
      }
      out[key] = sanitizeForPreview(root, v);
    }
    return out;
  }
  return value;
}

function rawInputPreviewText(root: string, input: BuildObservationLineInput): string {
  const obj = isPlainObject(input.toolInput) ? input.toolInput : undefined;
  if (obj !== undefined && typeof obj.command === "string") return scrubPathsInText(root, obj.command);
  if (input.toolInput !== undefined) return canonicalJson(sanitizeForPreview(root, input.toolInput));
  return "";
}

/** True for a `tool_response` shape carrying `filePath` + a `create`/`update` `type` — Claude's own Write/Edit response envelope, even when `tool` itself wasn't recognized (e.g. an unaliased/renamed tool). */
function isEditLikeResponseShape(toolOutput: Record<string, unknown>): boolean {
  return (
    typeof toolOutput.filePath === "string" &&
    typeof toolOutput.type === "string" &&
    (toolOutput.type === "create" || toolOutput.type === "update")
  );
}

/** O2-1 fixed short summary for an edit-like tool's output: `{"type":"...","filePath":"<relative>"}` (only the keys actually present), never the raw `content`/`originalFile`/`structuredPatch`/... body. */
function editLikeOutputSummary(root: string, toolOutput: Record<string, unknown>): string {
  const summary: Record<string, string> = {};
  if (typeof toolOutput.type === "string") summary.type = toolOutput.type;
  const filePath = typeof toolOutput.filePath === "string" ? toolOutput.filePath : typeof toolOutput.file_path === "string" ? toolOutput.file_path : undefined;
  if (filePath !== undefined) summary.filePath = relativizePathForPreview(root, filePath);
  return Object.keys(summary).length > 0 ? canonicalJson(summary) : "";
}

function rawOutputPreviewText(root: string, tool: string | null, toolOutput: unknown): string {
  if (typeof toolOutput === "string") return scrubPathsInText(root, toolOutput);
  if (isPlainObject(toolOutput)) {
    // O2-1: an edit-like tool's `tool_response` can carry the raw file body
    // (Write's top-level `content`, Edit's `originalFile`/`structuredPatch`,
    // ...) under a KEY this function would otherwise extract directly
    // (`content`) or recurse into via `sanitizeForPreview` — never previewed
    // for these; a fixed short summary replaces the whole extraction.
    if ((tool !== null && EDIT_LIKE_TOOLS.has(tool)) || isEditLikeResponseShape(toolOutput)) {
      return editLikeOutputSummary(root, toolOutput);
    }
    const parts: string[] = [];
    for (const key of ["stdout", "stderr", "output", "content"]) {
      const value = toolOutput[key];
      if (typeof value === "string" && value.length > 0) parts.push(scrubPathsInText(root, value));
    }
    if (parts.length > 0) return parts.join("\n");
    return canonicalJson(sanitizeForPreview(root, toolOutput));
  }
  if (toolOutput === undefined || toolOutput === null) return "";
  return canonicalJson(sanitizeForPreview(root, toolOutput));
}

function normalizeProjectRelativePath(root: string, filePath: string): string {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
  return toPosix(path.relative(root, absolute));
}

/**
 * Best-effort, single-file parse of a unified diff / `apply_patch`-shaped
 * patch string: the first `+++`-named path, and its removed (`-`, not
 * `---`)/added (`+`, not `+++`) line bodies. Deliberately simple (plan D3:
 * "keep simple") — stops at the second `diff --git` header so a multi-file
 * patch still only reports its first file.
 */
function parsePatchFirstFile(patch: string): { path: string; removed: string; added: string } | null {
  const lines = patch.split(/\r?\n/);
  let filePath: string | null = null;
  const removed: string[] = [];
  const added: string[] = [];
  let seenFirstDiffHeader = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (seenFirstDiffHeader) break;
      seenFirstDiffHeader = true;
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (filePath === null) {
        filePath = line.slice(4).trim().replace(/^[ab]\//, "");
      }
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
    else if (line.startsWith("-") && !line.startsWith("---")) removed.push(line.slice(1));
  }
  if (filePath === null || filePath.length === 0) return null;
  return { path: filePath, removed: removed.join("\n"), added: added.join("\n") };
}

/**
 * D3 hash-only `edit` field, computed only for `tool-complete` of an
 * edit-like tool: Claude-style `Edit`/`MultiEdit`/`Write`, or an
 * `apply_patch`/`shell_exec`-shaped call whose input carries a unified-diff
 * `patch`/`diff` string. Never stores raw paths or content — only sha256
 * digests. Anything else (unrecognized tool/shape) is `null`.
 */
function computeEditField(
  tool: string | null,
  toolInput: unknown,
  root: string,
): { pathDigest: string; removedDigest: string | null; addedDigest: string | null } | null {
  if (tool === null) return null;
  const obj = isPlainObject(toolInput) ? toolInput : undefined;
  if (obj === undefined) return null;

  if (tool === "Edit" && typeof obj.file_path === "string" && typeof obj.old_string === "string" && typeof obj.new_string === "string") {
    return {
      pathDigest: sha256Hex(normalizeProjectRelativePath(root, obj.file_path)),
      removedDigest: sha256Hex(obj.old_string),
      addedDigest: sha256Hex(obj.new_string),
    };
  }

  if (tool === "MultiEdit" && typeof obj.file_path === "string" && Array.isArray(obj.edits)) {
    const oldParts: string[] = [];
    const newParts: string[] = [];
    for (const entry of obj.edits) {
      if (isPlainObject(entry)) {
        oldParts.push(typeof entry.old_string === "string" ? entry.old_string : "");
        newParts.push(typeof entry.new_string === "string" ? entry.new_string : "");
      }
    }
    return {
      pathDigest: sha256Hex(normalizeProjectRelativePath(root, obj.file_path)),
      removedDigest: sha256Hex(oldParts.join("\n")),
      addedDigest: sha256Hex(newParts.join("\n")),
    };
  }

  if (tool === "Write" && typeof obj.file_path === "string" && typeof obj.content === "string") {
    return {
      pathDigest: sha256Hex(normalizeProjectRelativePath(root, obj.file_path)),
      removedDigest: null,
      addedDigest: sha256Hex(obj.content),
    };
  }

  if (tool === "apply_patch" || tool === "shell_exec") {
    const patchText = typeof obj.patch === "string" ? obj.patch : typeof obj.diff === "string" ? obj.diff : undefined;
    if (patchText !== undefined) {
      const parsed = parsePatchFirstFile(patchText);
      if (parsed !== null) {
        return {
          pathDigest: sha256Hex(normalizeProjectRelativePath(root, parsed.path)),
          removedDigest: parsed.removed.length > 0 ? sha256Hex(parsed.removed) : null,
          addedDigest: parsed.added.length > 0 ? sha256Hex(parsed.added) : null,
        };
      }
    }
  }

  return null;
}

/**
 * Builds one observation-event line (W3 "Observation event contract"),
 * redacting every `*Preview` field through `keryx security check-output`
 * (`redactPreview`, T5) before it is ever assembled, and validates the
 * result against `validateObservationEvent`. Returns `null` (never throws)
 * and calls `deps.warn` when the assembled line fails validation — the
 * caller drops it rather than appending an invalid line.
 */
export async function buildObservationLine(
  root: string,
  input: BuildObservationLineInput,
  deps: BuildObservationLineDeps = {},
): Promise<ObservationEvent | null> {
  const warn = deps.warn ?? ((): void => {});
  const identity = deps.projectIdentity ?? resolveProjectIdentity(root, deps.identityDeps);

  const digestSource =
    input.event === "user-prompt" ? (input.prompt ?? "") : input.toolInput !== undefined ? canonicalJson(input.toolInput) : "";
  const inputDigest = sha256Hex(digestSource);
  // O-2: a prompt's *content* is never previewed — the observation must stay
  // useful for detecting repetition/correction (via `inputDigest`) without
  // ever storing user-prompt text, even truncated.
  const inputPreview =
    input.event === "user-prompt" ? "" : await redactPreview(root, rawInputPreviewText(root, input), MAX_PREVIEW_LEN);

  const isOutputEvent = input.event === "tool-complete" || input.event === "tool-failed";
  const outputPreview = isOutputEvent
    ? await redactPreview(root, rawOutputPreviewText(root, input.tool, input.toolOutput), MAX_PREVIEW_LEN)
    : null;

  const cwdHash = sha256Hex(path.resolve(input.cwd));
  const edit = input.event === "tool-complete" ? computeEditField(input.tool, input.toolInput, root) : null;

  // O-4: bound and shape-check host-supplied identifiers before they are
  // ever stored — an out-of-pattern value (unbounded length, unexpected
  // characters) is replaced with a deterministic digest-derived stand-in
  // rather than stored as-is.
  const sessionId = SESSION_OR_TOOL_USE_ID_PATTERN.test(input.sessionId)
    ? input.sessionId
    : `h-${sha256Hex(input.sessionId).slice(0, 32)}`;
  const toolUseId =
    input.toolUseId === null
      ? null
      : SESSION_OR_TOOL_USE_ID_PATTERN.test(input.toolUseId)
        ? input.toolUseId
        : `h-${sha256Hex(input.toolUseId).slice(0, 32)}`;
  const tool = input.tool === null ? null : TOOL_NAME_PATTERN.test(input.tool) ? input.tool : "other";

  const line: ObservationEvent = {
    schemaVersion: 1,
    event: input.event,
    tool,
    inputDigest,
    inputPreview,
    outputPreview,
    sessionId,
    toolUseId,
    cwdHash,
    project: { identity: identity.identity, identityKind: identity.identityKind },
    observedAt: input.observedAt,
    ...(edit !== null ? { edit } : {}),
  };

  const result = validateObservationEvent(line);
  if (!result.ok) {
    warn(`learning observation line failed validation, dropped: ${result.errors.join("; ")}`);
    return null;
  }
  return line;
}

// --- appendObservation -------------------------------------------------------

export interface AppendObservationDeps {
  warn?: (message: string, error?: unknown) => void;
  /** Injectable bound for tests; defaults to 5000 (W3 spec). */
  maxLinesPerFile?: number;
}

function utcDateString(iso: string): string {
  const parsed = new Date(iso);
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return date.toISOString().slice(0, 10);
}

function nextUtcDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, day));
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

async function countLines(filePath: string): Promise<number> {
  if (!(await pathExists(filePath))) return 0;
  const raw = await readFile(filePath, "utf8");
  if (raw.length === 0) return 0;
  return raw.split("\n").filter((line) => line.length > 0).length;
}

/**
 * Appends one validated observation line to
 * `.metaproject/data/learning/observations/<YYYY-MM-DD>.jsonl` for the UTC
 * date of `line.observedAt`. Bounded at `deps.maxLinesPerFile` (default
 * 5000) lines per daily file: when the day's file is full, rolls to the next
 * UTC day's file early; when that is full too, the line is dropped (counted
 * via `deps.warn`, never thrown). File-locked
 * (`observations/.append.lock`), append-only (`appendFile`, never a
 * rewrite), and the target is asserted inside `learningDataDir` before any
 * write.
 */
export async function appendObservation(root: string, line: ObservationEvent, deps: AppendObservationDeps = {}): Promise<void> {
  const warn = deps.warn ?? ((): void => {});
  const maxLines = deps.maxLinesPerFile ?? DEFAULT_MAX_LINES_PER_FILE;
  const dir = observationsDir(root);
  const lockPath = path.join(dir, ".append.lock");
  const startDate = utcDateString(line.observedAt);
  const serialized = `${JSON.stringify(line)}\n`;

  try {
    let date = startDate;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const filePath = observationFilePath(root, date);
      assertInsideLearningRoot(filePath, [learningDataDir(root)]);
      const wrote = await withFileLock(lockPath, async () => {
        await mkdir(dir, { recursive: true });
        if ((await countLines(filePath)) >= maxLines) return false;
        await appendFile(filePath, serialized, "utf8");
        return true;
      });
      if (wrote) return;
      date = nextUtcDate(date);
    }
    warn(`learning observation dropped: daily files for ${startDate} and its rollover day are both full`);
  } catch (error) {
    warn("failed to append learning observation", error);
  }
}

// --- W6 sink (structurally mirrors harness/hooks/builtins.ts) --------------

/**
 * Structurally identical to `harness/hooks/builtins.ts`'s `LearningObservation`
 * — declared locally because `src/learning` (zone `core`) cannot import
 * `src/harness` (zone `client`). Keep in sync by hand.
 */
export interface LearningObservationLike {
  kind: ObservationEventName;
  sessionId: string;
  runId: string;
  timestamp: string;
  payload: unknown;
}

/** Structurally identical to `harness/hooks/builtins.ts`'s `LearningObservationSink`. */
export interface LearningObservationSink {
  record(observation: LearningObservationLike): Promise<void> | void;
}

export interface CreateLearningObservationSinkDeps {
  now?: () => string;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string, error?: unknown) => void;
  maxLinesPerFile?: number;
  identityDeps?: ResolveProjectIdentityDeps;
}

/**
 * Extracts the fields `buildObservationLine` needs from a keryx-shell hook
 * payload (`fire(event, payload)`'s `payload`, mirrored verbatim into
 * `LearningObservation.payload` by `runtime.ts`'s `runBuiltinHook`). Prefers
 * `keryxToolName` (the UNALIASED tool name — `agent-hooks.ts`'s
 * `HOOK_TOOL_NAME_ALIASES` only changes what a hook `matcher` regex is
 * tested against, e.g. `shell_exec` -> `Bash`) over the possibly-aliased
 * `toolName`, so the observation records the real Keryx tool name. For
 * `PostToolUseFailure`, there is no `toolOutput` field — its `error` object
 * is used instead, so a failure's output preview still carries something.
 */
function extractKeryxShellPayloadFields(payload: unknown): {
  tool: string | null;
  toolInput?: unknown;
  toolOutput?: unknown;
  toolUseId: string | null;
  prompt?: string;
} {
  if (!isPlainObject(payload)) return { tool: null, toolUseId: null };
  const tool = typeof payload.keryxToolName === "string" ? payload.keryxToolName : typeof payload.toolName === "string" ? payload.toolName : null;
  const toolUseId = typeof payload.toolCallId === "string" ? payload.toolCallId : null;
  let toolOutput: unknown;
  if ("toolOutput" in payload) toolOutput = payload.toolOutput;
  else if (isPlainObject(payload.error)) toolOutput = payload.error;
  return {
    tool,
    toolUseId,
    ...("toolInput" in payload ? { toolInput: payload.toolInput } : {}),
    ...(toolOutput !== undefined ? { toolOutput } : {}),
    ...(typeof payload.prompt === "string" ? { prompt: payload.prompt } : {}),
  };
}

/**
 * Builds the `LearningObservationSink` W6's `keryx.learning-observer` builtin
 * hook invokes in-process (`HookRuntimePorts.learningSink`). Disabled
 * (no-op) whenever `deps.env.KERYX_LEARNING === "off"`. `record()` never
 * throws into the hook runtime — every failure (redaction call, disk
 * error, malformed payload) is caught and reported through `deps.warn`
 * instead, matching the one hard rule this sink is built under (W3 D-3: the
 * observation sink is the one place that must never throw). The resolved
 * `project.identity` is computed once and cached for the lifetime of the
 * returned sink rather than per call.
 */
export function createLearningObservationSink(root: string, deps: CreateLearningObservationSinkDeps = {}): LearningObservationSink {
  const env = deps.env ?? process.env;
  const warn = deps.warn ?? ((): void => {});
  const now = deps.now ?? ((): string => new Date().toISOString());
  let cachedIdentity: ProjectIdentity | undefined;
  const getIdentity = (): ProjectIdentity => {
    if (cachedIdentity === undefined) cachedIdentity = resolveProjectIdentity(root, deps.identityDeps);
    return cachedIdentity;
  };

  return {
    async record(observation: LearningObservationLike): Promise<void> {
      try {
        if (env.KERYX_LEARNING === "off") return;
        const event = mapHookEventToObservation(observation.kind);
        if (event === null) return;
        const fields = extractKeryxShellPayloadFields(observation.payload);
        const line = await buildObservationLine(
          root,
          {
            event,
            tool: fields.tool,
            sessionId: observation.sessionId,
            toolUseId: fields.toolUseId,
            cwd: root,
            observedAt: now(),
            ...("toolInput" in fields ? { toolInput: fields.toolInput } : {}),
            ...("toolOutput" in fields ? { toolOutput: fields.toolOutput } : {}),
            ...(fields.prompt !== undefined ? { prompt: fields.prompt } : {}),
          },
          { projectIdentity: getIdentity(), warn },
        );
        if (line === null) return;
        await appendObservation(root, line, { warn, ...(deps.maxLinesPerFile !== undefined ? { maxLinesPerFile: deps.maxLinesPerFile } : {}) });
      } catch (error) {
        warn("learning observation sink failed", error);
      }
    },
  };
}

// --- Host harness observer (Claude Code) ------------------------------------

/**
 * Maps a Claude Code hook's raw stdin JSON payload
 * (`hook_event_name`/`session_id`/`tool_name`/`tool_input`/`tool_response`/
 * `tool_use_id`/`prompt`/`cwd`) to the same observation line shape
 * `createLearningObservationSink` produces for a keryx-shell session, and
 * appends it. `runtime` is accepted (not yet branched on) so a future host
 * beyond Claude can be added without changing this function's signature;
 * `"claude"` is the only value T11 wires today. Never throws — every failure
 * is reported through `deps.warn`. Disabled (no-op) by `KERYX_LEARNING=off`.
 */
export async function observeHostHookPayload(
  root: string,
  runtime: "claude",
  payload: unknown,
  deps: CreateLearningObservationSinkDeps = {},
): Promise<void> {
  void runtime;
  const env = deps.env ?? process.env;
  const warn = deps.warn ?? ((): void => {});
  const now = deps.now ?? ((): string => new Date().toISOString());
  try {
    if (env.KERYX_LEARNING === "off") return;
    if (!isPlainObject(payload)) {
      warn("observeHostHookPayload: payload is not an object");
      return;
    }
    const hookEventName = typeof payload.hook_event_name === "string" ? payload.hook_event_name : undefined;
    if (hookEventName === undefined) {
      warn("observeHostHookPayload: missing hook_event_name");
      return;
    }
    const event = mapHookEventToObservation(hookEventName);
    if (event === null) return;

    const sessionId = typeof payload.session_id === "string" ? payload.session_id : "unknown";
    const tool = typeof payload.tool_name === "string" ? payload.tool_name : null;
    const toolUseId = typeof payload.tool_use_id === "string" ? payload.tool_use_id : null;
    const cwd = typeof payload.cwd === "string" ? payload.cwd : root;

    const line = await buildObservationLine(
      root,
      {
        event,
        tool,
        sessionId,
        toolUseId,
        cwd,
        observedAt: now(),
        ...("tool_input" in payload ? { toolInput: payload.tool_input } : {}),
        ...("tool_response" in payload ? { toolOutput: payload.tool_response } : {}),
        ...(typeof payload.prompt === "string" ? { prompt: payload.prompt } : {}),
      },
      { ...(deps.identityDeps !== undefined ? { identityDeps: deps.identityDeps } : {}), warn },
    );
    if (line === null) return;
    await appendObservation(root, line, { warn, ...(deps.maxLinesPerFile !== undefined ? { maxLinesPerFile: deps.maxLinesPerFile } : {}) });
  } catch (error) {
    warn("observeHostHookPayload failed", error);
  }
}
