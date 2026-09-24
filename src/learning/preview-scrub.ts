// Token-based path classifier shared by the Observe stage (`observe.ts`) for
// BOTH free text (Bash commands, tool stdout/stderr) and path-valued fields
// (`file_path`/`path`/`filePath`/`notebook_path`, and `filenames`/`files`/
// `paths` arrays). One classifier (`classifyPath`), two renderers: a
// structured path-valued field never carries a "./" prefix
// (`renderClassifiedPathForField`, e.g. `"src/a.ts"`), while a path literal
// found inside free text keeps the "./" a shell would show
// (`renderClassifiedPathForText`, e.g. `"cd ./src"`). This replaced an
// earlier, purely regex-based free-text scrubber that could not agree with
// the field-valued relativizer on where the project root's boundary actually
// falls (`<root>-secret` was previously mis-rewritten as `.-secret`).
import { realpathSync } from "node:fs";
import path from "node:path";
import { toPosix } from "../lib/fs";

// --- root variants -----------------------------------------------------------

/** `root`'s resolved form plus its realpath (macOS `/private/var` vs `/var`), longest-first so a more specific path is tried before a shorter prefix of it. Memoized per root — cheap, and `root` does not change within a process. */
const rootVariantsCache = new Map<string, readonly string[]>();
export function rootVariants(root: string): readonly string[] {
  let variants = rootVariantsCache.get(root);
  if (variants === undefined) {
    const resolved = path.resolve(root);
    const set = new Set<string>();
    if (resolved.length > 0) set.add(toPosix(resolved));
    try {
      const real = realpathSync(resolved);
      if (real.length > 0) set.add(toPosix(real));
    } catch {
      // root may not exist yet (fixtures, dry runs) — resolved form only.
    }
    variants = [...set].sort((a, b) => b.length - a.length);
    rootVariantsCache.set(root, variants);
  }
  return variants;
}

// --- classifyPath --------------------------------------------------------------

export type ClassifiedPath = { kind: "root" } | { kind: "relative"; value: string } | { kind: "home" } | { kind: "basename"; value: string };

/** Best-effort basename (never a full path) for a normalized (forward-slash) path string. */
function basenameOf(normalized: string): string {
  const trimmed = normalized.replace(/\/+$/, "");
  const base = trimmed.split("/").pop();
  return base !== undefined && base.length > 0 ? base : "[path]";
}

/**
 * True when `normalized` (trailing slash stripped) is itself a home-shaped
 * root (`/Users/<u>`, `/home/<u>`, `X:/Users/<u>`, `~`, `~user`) or has
 * further path segments beyond one. Returns `null` for anything not
 * home-shaped at all.
 */
function matchHomeShaped(normalized: string): { hasFurtherSegments: boolean } | null {
  const trimmed = normalized.replace(/\/+$/, "");
  let m = /^\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(trimmed);
  if (m) return { hasFurtherSegments: m[1] !== undefined };
  m = /^[A-Za-z]:\/Users\/[^/]+(\/.*)?$/.exec(trimmed);
  if (m) return { hasFurtherSegments: m[1] !== undefined };
  m = /^~[A-Za-z0-9_.-]*(\/.*)?$/.exec(trimmed);
  if (m) return { hasFurtherSegments: m[1] !== undefined };
  return null;
}

/** Root-boundary check against every `rootVariants(root)` entry: exact match -> `root`, a real path-segment boundary below it -> `relative`, otherwise `null` (a sibling like `<root>-secret` never matches — the next char after the root must be end-of-string or `/`). */
function matchRootBoundary(root: string, absoluteForm: string): ClassifiedPath | null {
  for (const variant of rootVariants(root)) {
    if (absoluteForm === variant) return { kind: "root" };
    if (absoluteForm.startsWith(`${variant}/`)) return { kind: "relative", value: absoluteForm.slice(variant.length + 1) };
  }
  return null;
}

/**
 * Classifies one path-shaped string once, for use by both a free-text token
 * and a structured path-valued field:
 * 1. Inside the project root (any `rootVariants`) at a real segment boundary
 *    -> `root` (the root itself) or `relative` (a project-relative posix
 *    path) — checked FIRST so a project that happens to live under
 *    `/Users/<you>/...` is never mistaken for someone else's home directory.
 * 2. A home-shaped path (`/Users/<u>`, `/home/<u>`, `X:\Users\<u>`/`X:/Users/<u>`,
 *    `~`, `~user`) with no further segments -> `home`; with further segments
 *    -> `basename`.
 * 3. A relative path that climbs outside the root (`../x`), or any other
 *    absolute/drive-letter path -> `basename`.
 */
export function classifyPath(root: string, rawPath: string): ClassifiedPath {
  const normalized = toPosix(rawPath);
  const isAbsolutePosix = normalized.startsWith("/");
  const isDriveAbs = /^[A-Za-z]:[\\/]/.test(rawPath);
  const isTilde = normalized.startsWith("~");
  const isRelative = !isAbsolutePosix && !isDriveAbs && !isTilde;

  let absoluteForm: string | null = null;
  if (isAbsolutePosix) absoluteForm = normalized;
  else if (isRelative) absoluteForm = toPosix(path.resolve(root, rawPath));

  if (absoluteForm !== null) {
    const boundary = matchRootBoundary(root, absoluteForm);
    if (boundary !== null) return boundary;
  }

  const home = matchHomeShaped(normalized);
  if (home !== null) return home.hasFurtherSegments ? { kind: "basename", value: basenameOf(normalized) } : { kind: "home" };

  return { kind: "basename", value: basenameOf(normalized) };
}

/** Renders a classified path for a structured path-valued field (`file_path`, a `filenames` entry, ...): never a "./" prefix. */
export function renderClassifiedPathForField(classified: ClassifiedPath): string {
  switch (classified.kind) {
    case "root":
      return ".";
    case "relative":
      return classified.value;
    case "home":
      return "[home]";
    case "basename":
      return classified.value;
  }
}

/** Renders a classified path for a literal found inside free text (a Bash command, stdout/stderr, ...): a project-relative path keeps the "./" a shell would show (`cd ./src`). */
export function renderClassifiedPathForText(classified: ClassifiedPath): string {
  switch (classified.kind) {
    case "root":
      return ".";
    case "relative":
      return `./${classified.value}`;
    case "home":
      return "[home]";
    case "basename":
      return classified.value;
  }
}

/** One path-like field's preview value: project-relative when inside root, `.` for the root itself, `[home]`/basename for a home-shaped or otherwise outside-root path. Non-absolute, non-home-shaped relative input is passed through `toPosix` unchanged (mirrors the field's own already-relative form) only when it is also inside the root — otherwise it is reduced like any other outside-root path. */
export function relativizePathForPreview(root: string, filePath: string): string {
  return renderClassifiedPathForField(classifyPath(root, filePath));
}

// --- free-text token scrubbing ------------------------------------------------

/** A token is a `"…"`/`'…'` quoted segment (kept whole, spaces and all) or a run of non-whitespace characters. Whitespace between tokens is preserved verbatim by `String.replace`. */
const TOKEN_RE = /"[^"]*"|'[^']*'|\S+/g;

/** Splits trailing sentence/list punctuation (never `.`, which is legitimately part of a path/extension) off the end of a matched path so it survives the rewrite untouched. */
function splitTrailingPunct(value: string): { core: string; suffix: string } {
  const m = /^(.*?)([,;:!?)\]}>]*)$/.exec(value);
  return m ? { core: m[1] ?? value, suffix: m[2] ?? "" } : { core: value, suffix: "" };
}

interface PrefixMatch {
  prefix: string;
  rest: string;
}

/** Locates a `-I`/`-L`-style short flag, a `--foo=`/`KEY=`-style `=` prefix, or a `host:` prefix (never a URL scheme — the negative lookahead excludes anything followed by `//`) immediately before a `/`-rooted path within one token. */
function matchPrefixedPath(inner: string): PrefixMatch | null {
  let m = /^(-[A-Za-z])(\/.*)$/.exec(inner);
  if (m?.[1] !== undefined && m[2] !== undefined) return { prefix: m[1], rest: m[2] };
  m = /^([^\s/:=]*=)(\/.*)$/.exec(inner);
  if (m?.[1] !== undefined && m[2] !== undefined) return { prefix: m[1], rest: m[2] };
  m = /^([^\s/:=]+:)(?!\/\/)(\/.*)$/.exec(inner);
  if (m?.[1] !== undefined && m[2] !== undefined) return { prefix: m[1], rest: m[2] };
  return null;
}

/** Classifies the path shape (if any) found within one already-unquoted token: a drive-letter absolute path (checked first so `C:` is never misread as a `host:` prefix), a flag/`=`/`host:`-prefixed path, or a bare `/`, `~`, `./`, `../` start. Returns `null` (token left unchanged) when none of these shapes match — this is what keeps `bun test ./src/a.test.ts`'s `bun`/`test` words and `(fail) … 1 fail` intact. */
function classifyPathInToken(root: string, inner: string): string | null {
  if (/^[A-Za-z]:[\\/]/.test(inner)) {
    const { core, suffix } = splitTrailingPunct(inner);
    return renderClassifiedPathForText(classifyPath(root, core)) + suffix;
  }
  const prefixed = matchPrefixedPath(inner);
  if (prefixed !== null) {
    const { core, suffix } = splitTrailingPunct(prefixed.rest);
    return `${prefixed.prefix}${renderClassifiedPathForText(classifyPath(root, core))}${suffix}`;
  }
  if (/^\/|^~|^\.\.?\//.test(inner)) {
    const { core, suffix } = splitTrailingPunct(inner);
    return renderClassifiedPathForText(classifyPath(root, core)) + suffix;
  }
  return null;
}

/** Rewrites one whitespace/quote-delimited token: a quoted segment (`"…"`/`'…'`) is unwrapped, classified, and rewrapped so a quoted path with spaces (`"/Users/bob/Acme Merger Docs/plan.txt"`) is treated as one token, not scrubbed word-by-word. */
function scrubToken(root: string, token: string): string {
  const quoteChar = token.length >= 2 && (token[0] === '"' || token[0] === "'") && token[token.length - 1] === token[0] ? token[0] : "";
  const inner = quoteChar.length > 0 ? token.slice(1, -1) : token;
  const classified = classifyPathInToken(root, inner);
  if (classified === null) return token;
  return quoteChar.length > 0 ? `${quoteChar}${classified}${quoteChar}` : classified;
}

/**
 * Rewrites every path-shaped token in `text` (a Bash command, stdout/stderr,
 * ...) through `classifyPath`: project-relative paths become `./<relative>`,
 * the root itself becomes `.`, a home-shaped path becomes `[home]` or a
 * basename, and any other absolute/drive-letter/outside-root path is reduced
 * to its basename. A token with no path shape (a plain word, a bare relative
 * path with no `./`/`../` prefix, a URL) is left unchanged.
 */
export function scrubPathsInText(root: string, text: string): string {
  return text.replace(TOKEN_RE, (token) => scrubToken(root, token));
}
