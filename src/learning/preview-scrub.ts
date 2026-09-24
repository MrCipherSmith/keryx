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

/**
 * Like `splitTrailingPunct`, but first peels a trailing stack-trace-style
 * `:<line>` or `:<line>:<col>` suffix (R2-F1) off the end so it is kept
 * verbatim rather than fed into `classifyPath` as part of the path
 * (`x.ts:10:5` -> core `x.ts`, suffix `:10:5`, not a path literally ending
 * in digits). Falls back to `splitTrailingPunct` alone when there is no
 * such suffix.
 */
function splitTrailingPathSuffix(value: string): { core: string; suffix: string } {
  const { core: afterPunct, suffix: punctSuffix } = splitTrailingPunct(value);
  const lineCol = /^(.*?)(:\d+(?::\d+)?)$/.exec(afterPunct);
  if (lineCol?.[1] !== undefined && lineCol[2] !== undefined) {
    return { core: lineCol[1], suffix: `${lineCol[2]}${punctSuffix}` };
  }
  return { core: afterPunct, suffix: punctSuffix };
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

/**
 * A literal `file://` URL: the scheme is stripped and the absolute path that
 * follows is classified normally (R2-F1). Any other URL scheme
 * (`http(s)://`, ...) never matches here and is left alone.
 */
const FILE_URL_RE = /file:\/\/(\/[^\s"'`)\]},]*)/;

/**
 * An embedded path start (R2-F1): a `/`, `~`, or drive-letter path
 * immediately after one of `( < > " ' \` = : [ { ,` — inside a stack-trace
 * frame `(/Users/…)`, a JSON string value `:"/Users/…"`, a shell redirect
 * `2>/home/…`, or a backtick-quoted literal `` `/Users/…` ``. The
 * `/(?!\/)` guard on the plain-slash alternative keeps a `scheme://host/…`
 * URL (`:` immediately followed by `//`) from being misread as a
 * `:`-prefixed embedded path — `file://` itself is handled separately by
 * `FILE_URL_RE`. The match stops at whitespace, a quote, `` ` ``, `)`,
 * `]`, `}`, or `,`.
 */
const EMBEDDED_PATH_RE = /(?<=[(<>"'`=:[{,])(\/(?!\/)[^\s"'`)\]},]*|~[^\s"'`)\]},]*|[A-Za-z]:[\\/][^\s"'`)\]},]*)/;

const EMBEDDED_SCAN_RE = new RegExp(`${FILE_URL_RE.source}|${EMBEDDED_PATH_RE.source}`, "g");

/**
 * R2-F1 fallback: once whole-token classification (below) finds no path
 * shape at the START of `inner`, scans the rest of it for a path embedded
 * after a delimiter — see `EMBEDDED_PATH_RE`/`FILE_URL_RE` — and rewrites
 * just the path-shaped run(s), leaving surrounding text (punctuation,
 * other words) untouched. Returns `inner` unchanged when nothing embedded
 * looks like a path.
 */
function scrubEmbeddedPaths(root: string, inner: string): string {
  return inner.replace(EMBEDDED_SCAN_RE, (_whole: string, fileUrlPath: string | undefined, embedded: string | undefined) => {
    const isFileUrl = fileUrlPath !== undefined;
    const raw = isFileUrl ? fileUrlPath : (embedded ?? "");
    const { core, suffix } = splitTrailingPathSuffix(raw);
    const rendered = renderClassifiedPathForText(classifyPath(root, core));
    return `${isFileUrl ? "file://" : ""}${rendered}${suffix}`;
  });
}

/** Classifies the path shape (if any) found within one already-unquoted token: a drive-letter absolute path (checked first so `C:` is never misread as a `host:` prefix), a flag/`=`/`host:`-prefixed path, a bare `/`, `~`, `./`, `../` start, or — failing all of those — an embedded path start found anywhere later in the token (`scrubEmbeddedPaths`, R2-F1). Returns `null` (token left unchanged) when none of these shapes match — this is what keeps `bun test ./src/a.test.ts`'s `bun`/`test` words and `(fail) … 1 fail` intact. */
function classifyPathInToken(root: string, inner: string): string | null {
  if (/^[A-Za-z]:[\\/]/.test(inner)) {
    const { core, suffix } = splitTrailingPathSuffix(inner);
    return renderClassifiedPathForText(classifyPath(root, core)) + suffix;
  }
  const prefixed = matchPrefixedPath(inner);
  if (prefixed !== null) {
    const { core, suffix } = splitTrailingPathSuffix(prefixed.rest);
    return `${prefixed.prefix}${renderClassifiedPathForText(classifyPath(root, core))}${suffix}`;
  }
  if (/^\/|^~|^\.\.?\//.test(inner)) {
    const { core, suffix } = splitTrailingPathSuffix(inner);
    return renderClassifiedPathForText(classifyPath(root, core)) + suffix;
  }
  const embedded = scrubEmbeddedPaths(root, inner);
  return embedded === inner ? null : embedded;
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
 * True when `text` has an opening `"`/`'` with no matching close after it —
 * a shell/JSON quoting error (R2-F1). When that happens, the text from that
 * quote to the end of the string must be treated as ONE run rather than
 * re-tokenized on whitespace, or a directory name containing a space
 * (`Acme Merger/plan.txt`) leaks through as an un-scrubbed word once the
 * space splits it from the path token before it. Returns the index of the
 * unmatched quote and which character it is, or `null` when every quote in
 * `text` is balanced.
 */
function findUnbalancedQuoteRun(text: string): { start: number; quoteChar: string } | null {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const closeIdx = text.indexOf(ch, i + 1);
      if (closeIdx === -1) return { start: i, quoteChar: ch };
      i = closeIdx;
    }
  }
  return null;
}

/**
 * Handles the tail after an unbalanced quote (`findUnbalancedQuoteRun`):
 * finds the first embedded path start in `run` — at the very start or after
 * a delimiter, mirroring `EMBEDDED_PATH_RE` — and classifies everything
 * from there to the end of the string as one path literal, spaces and all
 * (this is what reduces `Acme Merger/plan.txt` to a bare basename instead
 * of leaking `Merger/plan.txt` as a second, un-scrubbed word). The text
 * before the path start is scrubbed token-by-token as usual. Falls back to
 * ordinary token scrubbing when nothing in `run` looks like a path start.
 */
function scrubUnclosedRun(root: string, run: string): string {
  const match = /(^|[\s(<>"'`=:[{,])(\/(?!\/)|~|[A-Za-z]:[\\/])/.exec(run);
  if (match === null) return run.replace(TOKEN_RE, (token) => scrubToken(root, token));
  const boundaryLen = match[1]?.length ?? 0;
  const pathStartIdx = (match.index ?? 0) + boundaryLen;
  const before = run.slice(0, pathStartIdx);
  const pathPart = run.slice(pathStartIdx);
  const rewrittenBefore = before.replace(TOKEN_RE, (token) => scrubToken(root, token));
  const { core, suffix } = splitTrailingPathSuffix(pathPart);
  const rendered = renderClassifiedPathForText(classifyPath(root, core));
  return `${rewrittenBefore}${rendered}${suffix}`;
}

/**
 * Rewrites every path-shaped token in `text` (a Bash command, stdout/stderr,
 * ...) through `classifyPath`: project-relative paths become `./<relative>`,
 * the root itself becomes `.`, a home-shaped path becomes `[home]` or a
 * basename, and any other absolute/drive-letter/outside-root path is reduced
 * to its basename. A token with no path shape (a plain word, a bare relative
 * path with no `./`/`../` prefix, a URL) is left unchanged. A path embedded
 * inside a token (a stack frame, JSON, a redirect, `file://`, a
 * backtick-quoted literal) is scrubbed too (`scrubEmbeddedPaths`, R2-F1), and
 * an unbalanced quote's remainder is treated as one run so a space inside a
 * leaked directory name never survives as its own un-scrubbed word
 * (`scrubUnclosedRun`).
 */
export function scrubPathsInText(root: string, text: string): string {
  const unbalanced = findUnbalancedQuoteRun(text);
  if (unbalanced !== null) {
    const prefix = text.slice(0, unbalanced.start);
    const run = text.slice(unbalanced.start + 1);
    const rewrittenPrefix = prefix.replace(TOKEN_RE, (token) => scrubToken(root, token));
    return `${rewrittenPrefix}${unbalanced.quoteChar}${scrubUnclosedRun(root, run)}`;
  }
  return text.replace(TOKEN_RE, (token) => scrubToken(root, token));
}
