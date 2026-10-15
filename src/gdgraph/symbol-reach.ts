// Symbol-level reach for the review blast radius (flow 457, AC1).
//
// `computeAffected` walks every reverse import edge, so a one-line change to
// one exported function of a module imported by 1,700 files puts 1,700 files
// in the radius, most of which never call that function. This walk carries the
// NAMES that changed instead of the file:
//
// - Seeds are the exported names a changed file's diff actually touched: an
//   edited declaration, an `export { a, b }` list, a body edit (hunk lines that
//   fall inside an exported declaration), and a non-exported helper or import
//   the edit touched, propagated to every exported declaration that mentions
//   it. Names exported at the base and gone at the head are changed too.
// - At each importer the import clause naming the target is re-parsed. The
//   importer is a consumer only when it imports a changed name, a namespace
//   (`* as m`), or the default export when the default changed. Its own
//   exported names that use those bindings become the names walked next.
// - A barrel (`export * from`, `export { x } from`) passes the names through to
//   its importers without counting a hop: it re-exports, it does not consume.
// - Hubs are damped: the weight of a reached file is the product over the
//   expanded nodes of `min(1, log2(2 + HUB_FREE_FAN_IN) / log2(2 + fanIn))`,
//   i.e. `1/log2(2 + fanIn)` scaled so a node with at most HUB_FREE_FAN_IN
//   importers costs nothing. A relevant importer under HUB_WEIGHT_CUTOFF is
//   recorded as damped, not walked.
//
// Whenever the names cannot be known the walk falls back to the plain file
// edge (every importer is relevant, names `*`): a file that is not JS/TS, a
// source that does not parse, a diff with no hunks for the file, an import
// clause that cannot be found, or a change to module-level code (a side
// effect) rather than to an exported declaration. The fallback is the old
// behaviour, never something narrower.
//
// The parse is a small top-level statement scanner validated by Bun.Transpiler
// (which throws on a syntax error and lists the runtime exports, which must be
// a subset of what the scanner found). TypeScript is a dev dependency only and
// tree-sitter grammars are downloaded on demand, so neither is used here.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { GraphData } from "./types";

/** A node with at most this many importers is not damped. */
export const HUB_FREE_FAN_IN = 16;
/** A relevant importer whose weight falls under this is recorded as hub-damped and not walked. */
export const HUB_WEIGHT_CUTOFF = 0.5;

const JS_TS = /\.(?:[cm]?[jt]sx?)$/i;

export type DiffHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number };
export type FileDiff = { path: string; oldPath: string; hunks: DiffHunk[] };

/** Unified diff text to per-file hunks, keyed by the head path. Deleted files are skipped. */
export function parseDiffHunks(diff: string): Map<string, FileDiff> {
  const files = new Map<string, FileDiff>();
  let oldPath: string | undefined;
  let current: FileDiff | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      oldPath = undefined;
      current = undefined;
      continue;
    }
    if (line.startsWith("--- ")) {
      const value = line.slice(4).trim();
      oldPath = value === "/dev/null" ? "" : value.replace(/^a\//, "");
      continue;
    }
    if (line.startsWith("+++ ")) {
      const value = line.slice(4).trim();
      if (value === "/dev/null") {
        current = undefined;
        continue;
      }
      const head = value.replace(/^b\//, "");
      current = files.get(head) ?? { path: head, oldPath: oldPath ?? head, hunks: [] };
      files.set(head, current);
      continue;
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match !== null && current !== undefined) {
      current.hunks.push({
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
      });
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

type ImportBinding = { imported: string; local: string };
type Reexport = { imported: string; exported: string };

type StatementKind = "import" | "export-from" | "export-list" | "declaration" | "export-default" | "code";

type Statement = {
  kind: StatementKind;
  startLine: number;
  endLine: number;
  /** Comments and string contents blanked: what identifier mentions are searched in. */
  masked: string;
  /** Local names this statement declares. */
  names: string[];
  /** Exported names this statement declares directly (`export function f` → f, `export default` → default). */
  exports: string[];
  specifier?: string;
  bindings?: ImportBinding[];
  reexports?: Reexport[];
  /** `export { a as b }` without `from`. */
  exportList?: Reexport[];
};

export type ModuleOutline = {
  statements: Statement[];
  /** Lines (1-based) carrying anything but whitespace and comments. */
  codeLines: Set<number>;
  /** local name → exported names. */
  exportsOf: Map<string, string[]>;
  exportedNames: Set<string>;
  /** `import("x")` / `require("x")` specifiers, found anywhere. */
  dynamicSpecifiers: Set<string>;
};

const REGEX_PREV = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const REGEX_KEYWORDS = /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;
// Unindented continuations are rare in formatted code; `<`/`>` are left out so `type A = B<C>` ends at its newline.
const CONTINUES = new Set(["=", ",", "+", "-", "*", "&", "|", "?", ":", "."]);
const CONTINUED_BY = /^(?:[.)\]}?:+\-*%&|^,=<>]|\/[^/*])/;

/**
 * Splits a module into top-level statements. Returns `undefined` when the
 * nesting does not balance, which the caller treats as a parse failure.
 */
function scanStatements(source: string): { statements: Array<{ start: number; end: number }>; masked: string; noComments: string; lineAt: number[] } | undefined {
  const n = source.length;
  const masked: string[] = new Array(n);
  const noComments: string[] = new Array(n);
  const lineAt: number[] = new Array(n + 1);
  let line = 1;
  let depth = 0;
  const templateDepths: number[] = [];
  /** Newlines inside a template literal's body: never a statement boundary. */
  const sticky = new Set<number>();
  let lastSignificant = "";
  let lastWord = "";

  const put = (index: number, maskedChar: string, plainChar: string): void => {
    masked[index] = maskedChar;
    noComments[index] = plainChar;
  };
  const blank = (ch: string): string => (ch === "\n" ? "\n" : " ");

  let i = 0;
  while (i < n) {
    const ch = source[i] as string;
    lineAt[i] = line;
    const next = source[i + 1];
    // Comments
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        lineAt[i] = line;
        put(i, " ", " ");
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      for (; i < stop; i += 1) {
        lineAt[i] = line;
        const c = source[i] as string;
        put(i, blank(c), blank(c));
        if (c === "\n") line += 1;
      }
      continue;
    }
    // Quoted strings end at their quote or at a newline (so a stray apostrophe in JSX text costs one line, not the file).
    if (ch === '"' || ch === "'") {
      put(i, ch, ch);
      i += 1;
      while (i < n && source[i] !== ch && source[i] !== "\n") {
        lineAt[i] = line;
        if (source[i] === "\\" && i + 1 < n && source[i + 1] !== "\n") {
          put(i, " ", source[i] as string);
          lineAt[i + 1] = line;
          put(i + 1, " ", source[i + 1] as string);
          i += 2;
          continue;
        }
        put(i, " ", source[i] as string);
        i += 1;
      }
      if (i < n && source[i] === ch) {
        lineAt[i] = line;
        put(i, ch, ch);
        i += 1;
      }
      lastSignificant = ch;
      lastWord = "";
      continue;
    }
    if (ch === "`" || (ch === "}" && templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === depth)) {
      // Template body: from a backtick, or from the `}` closing a `${` back into the template.
      if (ch === "}") templateDepths.pop();
      put(i, ch, ch);
      i += 1;
      let reopened = false;
      while (i < n) {
        lineAt[i] = line;
        const c = source[i] as string;
        if (c === "\\") {
          put(i, " ", c);
          if (i + 1 < n) {
            lineAt[i + 1] = line;
            const escaped = source[i + 1] as string;
            put(i + 1, blank(escaped), escaped);
            if (escaped === "\n") {
              line += 1;
              sticky.add(i + 1);
            }
          }
          i += 2;
          continue;
        }
        if (c === "`") {
          put(i, c, c);
          i += 1;
          break;
        }
        if (c === "$" && source[i + 1] === "{") {
          put(i, "$", "$");
          lineAt[i + 1] = line;
          put(i + 1, "{", "{");
          i += 2;
          templateDepths.push(depth);
          reopened = true;
          break;
        }
        put(i, blank(c), c);
        if (c === "\n") {
          line += 1;
          sticky.add(i);
        }
        i += 1;
      }
      lastSignificant = reopened ? "{" : "`";
      lastWord = "";
      continue;
    }
    // Regular expression literal, decided by what precedes it; single-line.
    if (ch === "/" && (REGEX_PREV.has(lastSignificant) || REGEX_KEYWORDS.test(lastWord))) {
      put(i, "/", "/");
      i += 1;
      let inClass = false;
      while (i < n && source[i] !== "\n") {
        lineAt[i] = line;
        const c = source[i] as string;
        if (c === "\\" && i + 1 < n) {
          put(i, " ", c);
          lineAt[i + 1] = line;
          put(i + 1, " ", source[i + 1] as string);
          i += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          put(i, "/", "/");
          i += 1;
          break;
        }
        put(i, " ", c);
        i += 1;
      }
      while (i < n && /[a-z]/i.test(source[i] as string)) {
        lineAt[i] = line;
        put(i, source[i] as string, source[i] as string);
        i += 1;
      }
      lastSignificant = "/x";
      lastWord = "";
      continue;
    }
    put(i, ch, ch);
    if (ch === "\n") line += 1;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth < 0) return undefined;
    }
    lastWord = /[\w$]/.test(ch) ? (i > 0 && /[\w$]/.test(source[i - 1] as string) ? lastWord + ch : ch) : "";
    lastSignificant = ch;
    i += 1;
  }
  lineAt[n] = line;
  if (depth !== 0 || templateDepths.length > 0) return undefined;
  const maskedText = masked.join("");
  return { statements: splitStatements(maskedText, sticky), masked: maskedText, noComments: noComments.join(""), lineAt };
}

/**
 * Top-level statement spans over the masked text (comments, strings, template
 * bodies and regex bodies already blanked, so every bracket left is code). A
 * statement ends at a top-level `;`, or at a top-level newline when the next
 * code starts at column 0 and neither side reads as a continuation.
 */
function splitStatements(masked: string, sticky: ReadonlySet<number>): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = -1;
  let last = "";
  const n = masked.length;
  for (let i = 0; i < n; i += 1) {
    const ch = masked[i] as string;
    if (ch === "\n") {
      if (depth !== 0 || start < 0 || sticky.has(i)) continue;
      let j = i + 1;
      while (j < n && /\s/.test(masked[j] as string)) j += 1;
      if (j >= n) continue;
      const atColumnZero = masked[j - 1] === "\n";
      const rest = masked.slice(j, j + 2);
      if (atColumnZero && !CONTINUED_BY.test(rest) && !CONTINUES.has(last) && masked[start] !== "@") {
        out.push({ start, end: i });
        start = -1;
      }
      continue;
    }
    if (/\s/.test(ch)) continue;
    if (start < 0) start = i;
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    last = ch;
    if (ch === ";" && depth === 0) {
      out.push({ start, end: i + 1 });
      start = -1;
    }
  }
  if (start >= 0) out.push({ start, end: n });
  return out;
}

const IDENT = /[A-Za-z_$][\w$]*/g;

function splitList(body: string): Reexport[] {
  const out: Reexport[] = [];
  for (const raw of body.split(",")) {
    const part = raw.trim().replace(/^type\s+/, "");
    if (part === "") continue;
    const match = /^([\w$]+|"[^"]*"|'[^']*')(?:\s+as\s+([\w$]+|"[^"]*"|'[^']*'))?$/.exec(part);
    if (match === null) continue;
    const unquote = (value: string): string => value.replace(/^["']|["']$/g, "");
    const imported = unquote(match[1] as string);
    out.push({ imported, exported: unquote(match[2] ?? imported) });
  }
  return out;
}

/** Binding names of `const a = …, { b, c: d } = …, [e] = …` (after the keyword). Approximate on purpose. */
function bindingNames(text: string): string[] {
  const names: string[] = [];
  let i = 0;
  const n = text.length;
  const skipTo = (stops: string): void => {
    let depth = 0;
    while (i < n) {
      const c = text[i] as string;
      if (c === "(" || c === "[" || c === "{" || c === "<") depth += 1;
      else if (c === ")" || c === "]" || c === "}" || c === ">") depth = Math.max(0, depth - 1);
      else if (depth === 0 && stops.includes(c)) return;
      i += 1;
    }
  };
  while (i < n) {
    while (i < n && /[\s,]/.test(text[i] as string)) i += 1;
    if (i >= n) break;
    const c = text[i] as string;
    if (c === "{" || c === "[") {
      const open = c;
      const closeChar = open === "{" ? "}" : "]";
      let depth = 0;
      const begin = i;
      for (; i < n; i += 1) {
        if (text[i] === open) depth += 1;
        else if (text[i] === closeChar) {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
      }
      const pattern = text.slice(begin, i);
      // Identifiers not followed by `:` (a property key) and not after `=` (a default value).
      const cleaned = pattern.replace(/=[^,}\]]*/g, "");
      for (const match of cleaned.matchAll(/([A-Za-z_$][\w$]*)\s*(:)?/g)) if (match[2] === undefined) names.push(match[1] as string);
    } else {
      const match = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
      if (match === null) break;
      names.push(match[0]);
      i += match[0].length;
    }
    skipTo("=,;");
    if (text[i] === "=") {
      i += 1;
      skipTo(",;");
    }
    if (text[i] === ";") break;
  }
  return names;
}

function classify(masked: string, plain: string): Omit<Statement, "startLine" | "endLine" | "masked"> {
  const head = masked.trimStart();
  const text = plain.trimStart();
  const empty = { names: [] as string[], exports: [] as string[] };
  let match: RegExpExecArray | null;
  if ((match = /^import\s+([\w$]+)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/.exec(text)) !== null) {
    return { kind: "import", ...empty, names: [match[1] as string], specifier: match[2] as string, bindings: [{ imported: "*", local: match[1] as string }] };
  }
  if (/^import\s*["']/.test(text)) {
    const spec = /^import\s*["']([^"']+)["']/.exec(text)?.[1];
    return { kind: "import", ...empty, ...(spec === undefined ? {} : { specifier: spec }), bindings: [] };
  }
  if (/^import[\s{*]/.test(head) && !/^import\s*\(/.test(head)) {
    match = /^import\s+(?:type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']/.exec(text);
    if (match === null) return { kind: "code", ...empty };
    const clause = (match[1] as string).trim();
    const bindings: ImportBinding[] = [];
    const namespace = /\*\s*as\s+([\w$]+)/.exec(clause);
    if (namespace !== null) bindings.push({ imported: "*", local: namespace[1] as string });
    const braces = /\{([\s\S]*)\}/.exec(clause);
    if (braces !== null) for (const item of splitList(braces[1] as string)) bindings.push({ imported: item.imported, local: item.exported });
    const defaultName = /^([\w$]+)\s*(?:,|$)/.exec(clause);
    if (defaultName !== null && defaultName[1] !== "type") bindings.push({ imported: "default", local: defaultName[1] as string });
    return { kind: "import", ...empty, names: bindings.map((b) => b.local), specifier: match[2] as string, bindings };
  }
  if ((match = /^export\s+(?:type\s+)?\*\s*(?:as\s+([\w$]+)\s*)?from\s*["']([^"']+)["']/.exec(text)) !== null) {
    const ns = match[1];
    return {
      kind: "export-from",
      ...empty,
      exports: ns === undefined ? [] : [ns],
      specifier: match[2] as string,
      reexports: [{ imported: "*", exported: ns ?? "*" }],
    };
  }
  if ((match = /^export\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/.exec(text)) !== null) {
    const reexports = splitList(match[1] as string);
    return { kind: "export-from", ...empty, exports: reexports.map((r) => r.exported), specifier: match[2] as string, reexports };
  }
  if ((match = /^export\s+(?:type\s+)?\{([\s\S]*?)\}/.exec(head)) !== null) {
    const list = splitList((/^export\s+(?:type\s+)?\{([\s\S]*?)\}/.exec(text)?.[1] ?? match[1]) as string);
    return { kind: "export-list", ...empty, exports: list.map((r) => r.exported), exportList: list };
  }
  if (/^export\s+default\b/.test(head)) {
    const named = /^export\s+default\s+(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class)\s+([\w$]+)/.exec(head);
    return { kind: "export-default", names: named === null ? [] : [named[1] as string], exports: ["default"] };
  }
  if (/^export\s*=/.test(head)) return { kind: "export-default", names: [], exports: ["default"] };
  const exported = /^export\s+/.test(head);
  const body = exported ? head.replace(/^export\s+/, "") : head;
  const decl = /^(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|interface|type|enum|const\s+enum|namespace|module)\s+([\w$]+)/.exec(body);
  if (decl !== null && !/^(?:declare\s+)?(?:module|namespace)\s+["']/.test(body)) {
    const name = decl[1] as string;
    return { kind: "declaration", names: [name], exports: exported ? [name] : [] };
  }
  const variable = /^(?:declare\s+)?(?:const|let|var|using)\s+/.exec(body);
  if (variable !== null) {
    const names = bindingNames(body.slice(variable[0].length));
    return { kind: "declaration", names, exports: exported ? names : [] };
  }
  return { kind: "code", ...empty };
}

const DYNAMIC = /(?:\bimport|\brequire)\s*\(\s*["']([^"']+)["']\s*\)/g;

function loaderFor(file: string): "ts" | "tsx" | "jsx" {
  if (/\.(?:tsx|jsx)$/i.test(file)) return "tsx";
  if (/\.[cm]?ts$/i.test(file)) return "ts";
  return "jsx";
}

/**
 * The top-level outline of a JS/TS module, or `undefined` when it cannot be
 * trusted: not JS/TS, a syntax error, unbalanced nesting, or a runtime export
 * Bun.Transpiler sees that the scanner did not find.
 */
export function outlineModule(file: string, source: string): ModuleOutline | undefined {
  if (!JS_TS.test(file)) return undefined;
  let runtimeExports: string[];
  try {
    runtimeExports = new Bun.Transpiler({ loader: loaderFor(file) }).scan(source).exports;
  } catch {
    return undefined;
  }
  const scanned = scanStatements(source);
  if (scanned === undefined) return undefined;
  const statements: Statement[] = [];
  const codeLines = new Set<number>();
  for (let index = 0; index < scanned.masked.length; index += 1) {
    const c = scanned.masked[index] as string;
    if (!/\s/.test(c)) codeLines.add(scanned.lineAt[index] as number);
  }
  for (const span of scanned.statements) {
    const masked = scanned.masked.slice(span.start, span.end);
    if (masked.trim() === "") continue;
    const plain = scanned.noComments.slice(span.start, span.end);
    const leading = masked.length - masked.trimStart().length;
    const trailing = masked.trimEnd().length;
    const startLine = scanned.lineAt[span.start + leading] as number;
    const endLine = scanned.lineAt[Math.max(span.start, span.start + trailing - 1)] as number;
    statements.push({ ...classify(masked, plain), startLine, endLine, masked });
  }
  const exportsOf = new Map<string, string[]>();
  const exportedNames = new Set<string>();
  const addExport = (local: string, exported: string): void => {
    exportedNames.add(exported);
    const list = exportsOf.get(local) ?? [];
    if (!list.includes(exported)) list.push(exported);
    exportsOf.set(local, list);
  };
  for (const statement of statements) {
    if (statement.kind === "declaration") for (const name of statement.exports) addExport(name, name);
    if (statement.kind === "export-default") {
      exportedNames.add("default");
      for (const name of statement.names) addExport(name, "default");
    }
    if (statement.kind === "export-list") for (const item of statement.exportList ?? []) addExport(item.imported, item.exported);
    if (statement.kind === "export-from") for (const name of statement.exports) exportedNames.add(name);
  }
  const hasStar = statements.some((s) => s.kind === "export-from" && (s.reexports ?? []).some((r) => r.exported === "*"));
  if (!hasStar && runtimeExports.some((name) => !exportedNames.has(name))) return undefined;
  const dynamicSpecifiers = new Set<string>();
  for (const match of scanned.noComments.matchAll(DYNAMIC)) dynamicSpecifiers.add(match[1] as string);
  return { statements, codeLines, exportsOf, exportedNames, dynamicSpecifiers };
}

// ---------------------------------------------------------------------------
// Names a change affects, inside one module
// ---------------------------------------------------------------------------

/** `"*"`: every export (module-level code changed, or the names could not be known). */
export type ChangedNames = Set<string> | "*";

function mentions(masked: string, names: ReadonlySet<string>): boolean {
  for (const match of masked.matchAll(IDENT)) {
    const index = match.index ?? 0;
    if (index > 0 && masked[index - 1] === ".") continue;
    if (names.has(match[0])) return true;
  }
  return false;
}

/**
 * The exported names a module's change reaches, from touched lines and/or
 * changed local bindings, propagated through every top-level statement that
 * mentions a changed local until nothing moves.
 */
export function affectedExports(
  outline: ModuleOutline,
  input: { touchedLines?: ReadonlySet<number>; changedLocals?: Iterable<string> },
): { names: ChangedNames; moduleLevel: boolean } {
  const locals = new Set<string>(input.changedLocals ?? []);
  const exported = new Set<string>();
  const done = new Set<Statement>();
  let star = false;
  const touched = input.touchedLines;
  const touches = (s: Statement): boolean => {
    if (touched === undefined) return false;
    for (let line = s.startLine; line <= s.endLine; line += 1) if (touched.has(line) && outline.codeLines.has(line)) return true;
    return false;
  };
  const mark = (s: Statement): void => {
    done.add(s);
    switch (s.kind) {
      case "import":
        for (const name of s.names) locals.add(name);
        if ((s.bindings ?? []).length === 0) star = true; // a side-effect import changed: module-level behaviour
        break;
      case "export-from":
        if ((s.reexports ?? []).some((r) => r.exported === "*")) star = true;
        for (const name of s.exports) exported.add(name);
        break;
      case "export-list":
        for (const name of s.exports) exported.add(name);
        break;
      case "export-default":
        exported.add("default");
        for (const name of s.names) locals.add(name);
        break;
      case "declaration":
        for (const name of s.names) locals.add(name);
        for (const name of s.exports) exported.add(name);
        break;
      case "code":
        star = true;
        break;
    }
  };
  for (const statement of outline.statements) if (touches(statement)) mark(statement);
  let moved = true;
  while (moved && !star) {
    moved = false;
    for (const statement of outline.statements) {
      if (done.has(statement) || statement.kind === "import" || statement.kind === "export-list" || statement.kind === "export-from") continue;
      if (locals.size > 0 && mentions(statement.masked, locals)) {
        mark(statement);
        moved = true;
      }
    }
  }
  if (star) return { names: "*", moduleLevel: true };
  for (const local of locals) for (const name of outline.exportsOf.get(local) ?? []) exported.add(name);
  return { names: exported, moduleLevel: false };
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

export type SourceReader = {
  /** The file's text at the head, or undefined when it cannot be read. */
  head(file: string): string | undefined;
  /** The file's text at the base, or undefined (a new file, or no base). */
  base?(file: string): string | undefined;
};

export type SymbolReachSeed = {
  file: string;
  /** Changed exported names, or `*` when the walk falls back to the file edge. */
  names: string[] | "*";
  mode: "symbol" | "file-edge";
  detail: string;
};

export type SymbolReachEntry = {
  file: string;
  hop: number;
  weight: number;
  fanIn: number;
  via: string;
  /** `[file, …, via]`, barrels included. */
  path: string[];
  /** The names this file was reached by (`*` for a file-edge reach). */
  names: string[] | "*";
  mode: "symbol" | "file-edge";
};

export type SymbolReachOmission = {
  file: string;
  hop: number;
  fanIn: number;
  via: string;
  path: string[];
  reason: "unrelated-symbol" | "hub-damped";
  detail: string;
};

export type SymbolReachResult = {
  seeds: SymbolReachSeed[];
  reached: SymbolReachEntry[];
  omitted: SymbolReachOmission[];
  /** Pure re-export files the walk passed through without counting a hop. */
  barrels: string[];
};

export type SymbolReachInput = {
  graph: GraphData;
  /** Changed files that are graph nodes. */
  seeds: readonly string[];
  /** Every changed file: none is reported as reached. */
  changedFiles: readonly string[];
  /** Per changed file, its hunks; a changed file with none falls back to the file edge. */
  diff?: ReadonlyMap<string, FileDiff> | undefined;
  read: SourceReader;
  depth: number;
  hubFreeFanIn?: number | undefined;
  weightCutoff?: number | undefined;
};

function namesOut(names: ChangedNames): string[] | "*" {
  return names === "*" ? "*" : [...names].sort();
}

function seedNames(file: string, diff: FileDiff | undefined, read: SourceReader): SymbolReachSeed {
  const fallback = (detail: string): SymbolReachSeed => ({ file, names: "*", mode: "file-edge", detail });
  if (!JS_TS.test(file)) return fallback("not a JS/TS module: every importer is reached by the file edge");
  if (diff === undefined || diff.hunks.length === 0) return fallback("no hunks for this file in the diff: the changed names are unknown");
  const head = read.head(file);
  const outline = head === undefined ? undefined : outlineModule(file, head);
  if (outline === undefined) return fallback(head === undefined ? "the head source could not be read" : "the head source did not parse");
  const baseText = diff.hunks.some((hunk) => hunk.oldLines > 0) ? read.base?.(diff.oldPath) : undefined;
  const touched = new Set<number>();
  for (const hunk of diff.hunks) {
    if (hunk.newLines === 0 && hunk.oldLines > 0 && baseText === undefined) {
      // A pure deletion with no base to read sits between two head lines: both neighbours are touched.
      touched.add(hunk.newStart);
      touched.add(hunk.newStart + 1);
    }
    for (let line = hunk.newStart; line < hunk.newStart + hunk.newLines; line += 1) touched.add(line);
  }
  const after = affectedExports(outline, { touchedLines: touched });
  if (after.names === "*") return fallback("the change touches module-level code (a side effect), not only exported declarations");
  const names = new Set(after.names);
  if (baseText !== undefined) {
    const baseOutline = outlineModule(diff.oldPath, baseText);
    if (baseOutline === undefined) return fallback("the base source did not parse");
    const oldTouched = new Set<number>();
    for (const hunk of diff.hunks) for (let line = hunk.oldStart; line < hunk.oldStart + hunk.oldLines; line += 1) oldTouched.add(line);
    const before = affectedExports(baseOutline, { touchedLines: oldTouched });
    if (before.names === "*") return fallback("the change removes or edits module-level code at the base");
    for (const name of before.names) names.add(name);
    for (const name of baseOutline.exportedNames) if (!outline.exportedNames.has(name)) names.add(name);
  }
  const list = [...names].sort();
  return {
    file,
    names: list,
    mode: "symbol",
    detail: list.length === 0 ? "the change touches no exported declaration" : `changed exports: ${list.join(", ")}`,
  };
}

type ImporterVerdict =
  | { kind: "fallback"; detail: string }
  | { kind: "analysed"; consumer: boolean; imported: string[]; passThrough: ChangedNames | undefined; next: ChangedNames };

function unionNames(a: ChangedNames | undefined, b: ChangedNames | undefined): ChangedNames {
  if (a === "*" || b === "*") return "*";
  return new Set([...(a ?? []), ...(b ?? [])]);
}

function judgeImporter(importer: string, specifiers: readonly string[], names: ChangedNames, read: SourceReader): ImporterVerdict {
  if (!JS_TS.test(importer)) return { kind: "fallback", detail: "importer is not a JS/TS module" };
  const source = read.head(importer);
  if (source === undefined) return { kind: "fallback", detail: "importer source could not be read" };
  const outline = outlineModule(importer, source);
  if (outline === undefined) return { kind: "fallback", detail: "importer did not parse" };
  if (specifiers.some((spec) => outline.dynamicSpecifiers.has(spec))) return { kind: "fallback", detail: "importer loads the module dynamically" };
  const matching = outline.statements.filter((s) => s.specifier !== undefined && specifiers.includes(s.specifier));
  if (matching.length === 0) return { kind: "fallback", detail: "the import clause naming the module was not found" };
  const has = (name: string): boolean => names === "*" || names.has(name);
  const locals = new Set<string>();
  const imported = new Set<string>();
  let sideEffect = false;
  let passThrough: ChangedNames | undefined;
  for (const statement of matching) {
    if (statement.kind === "import") {
      const bindings = statement.bindings ?? [];
      if (bindings.length === 0 && names === "*") sideEffect = true;
      for (const binding of bindings) {
        imported.add(binding.imported);
        if (binding.imported === "*" || has(binding.imported)) locals.add(binding.local);
      }
    } else if (statement.kind === "export-from") {
      for (const item of statement.reexports ?? []) {
        if (item.imported === "*" && item.exported === "*") {
          const passed: ChangedNames = names === "*" ? "*" : new Set([...names].filter((name) => name !== "default"));
          if (passed === "*" || passed.size > 0) passThrough = unionNames(passThrough, passed);
        } else if (item.imported === "*") {
          passThrough = unionNames(passThrough, new Set([item.exported]));
        } else if (has(item.imported)) {
          passThrough = unionNames(passThrough, new Set([item.exported]));
        }
      }
    }
  }
  const consumer = sideEffect || locals.size > 0;
  const own = consumer ? (sideEffect ? ({ names: "*" } as const) : affectedExports(outline, { changedLocals: locals })) : { names: new Set<string>() as ChangedNames };
  return { kind: "analysed", consumer, imported: [...imported].sort(), passThrough, next: unionNames(own.names, passThrough) };
}

/**
 * The symbol-level reach of a change. Deterministic for a given graph, diff and
 * sources; reads sources only through `read`.
 */
export function computeSymbolReach(input: SymbolReachInput): SymbolReachResult {
  const graph = input.graph;
  const free = Math.log2(2 + (input.hubFreeFanIn ?? HUB_FREE_FAN_IN));
  const cutoff = input.weightCutoff ?? HUB_WEIGHT_CUTOFF;
  const depth = Math.max(1, Math.trunc(input.depth));
  const changed = new Set(input.changedFiles);

  const importersOf = new Map<string, Map<string, string[]>>();
  const fanIn = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.kind === "unresolved") continue;
    fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1);
    const byImporter = importersOf.get(edge.to) ?? new Map<string, string[]>();
    const specs = byImporter.get(edge.from) ?? [];
    if (!specs.includes(edge.specifier)) specs.push(edge.specifier);
    byImporter.set(edge.from, specs);
    importersOf.set(edge.to, byImporter);
  }
  const damp = (file: string): number => Math.min(1, free / Math.log2(2 + (fanIn.get(file) ?? 0)));

  const seeds = [...new Set(input.seeds)].sort().map((file) => seedNames(file, input.diff?.get(file), input.read));
  type Item = { file: string; hop: number; weight: number; names: ChangedNames; via: string; path: string[]; mode: "symbol" | "file-edge" };
  const queue: Item[] = seeds.map((seed) => ({
    file: seed.file,
    hop: 0,
    weight: 1,
    names: seed.names === "*" ? "*" : new Set(seed.names),
    via: seed.file,
    path: [seed.file],
    mode: seed.mode,
  }));
  const reached = new Map<string, SymbolReachEntry>();
  const omitted = new Map<string, SymbolReachOmission>();
  const barrels = new Set<string>();
  const expanded = new Map<string, { hop: number; names: ChangedNames }>();

  const better = (a: { hop: number; weight: number; file: string }, b: { hop: number; weight: number }): boolean => a.hop < b.hop || (a.hop === b.hop && a.weight > b.weight);

  while (queue.length > 0) {
    queue.sort((a, b) => a.hop - b.hop || b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    const item = queue.shift() as Item;
    if (item.names !== "*" && item.names.size === 0) continue;
    const prior = expanded.get(item.file);
    if (prior !== undefined && prior.hop <= item.hop) {
      // Re-expand only for names not walked yet.
      if (prior.names === "*") continue;
      if (item.names !== "*" && [...item.names].every((name) => (prior.names as Set<string>).has(name))) continue;
    }
    expanded.set(item.file, { hop: Math.min(item.hop, prior?.hop ?? item.hop), names: unionNames(prior?.names, item.names) });
    if (item.hop >= depth) continue;
    const weight = item.weight * damp(item.file);
    for (const [importer, specifiers] of [...(importersOf.get(item.file) ?? new Map<string, string[]>())].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (importer === item.file) continue;
      const path = [importer, ...item.path];
      const hop = item.hop + 1;
      const importerFanIn = fanIn.get(importer) ?? 0;
      if (weight < cutoff) {
        if (!changed.has(importer) && !reached.has(importer) && !omitted.has(importer)) {
          omitted.set(importer, {
            file: importer,
            hop,
            fanIn: importerFanIn,
            via: item.via,
            path,
            reason: "hub-damped",
            detail: `weight ${weight.toFixed(2)} < ${cutoff}: reached through ${item.file} (fan-in ${fanIn.get(item.file) ?? 0}); the hub's importers are not walked one by one`,
          });
        }
        continue;
      }
      const verdict: ImporterVerdict = item.names === "*" && item.mode === "file-edge"
        ? { kind: "fallback", detail: "file edge" }
        : judgeImporter(importer, specifiers, item.names, input.read);
      if (verdict.kind === "fallback") {
        record({ file: importer, hop, weight, via: item.via, path, names: "*", mode: "file-edge" }, importerFanIn);
        queue.push({ file: importer, hop, weight, names: "*", via: item.via, path, mode: "file-edge" });
        continue;
      }
      if (!verdict.consumer && verdict.passThrough === undefined) {
        if (!changed.has(importer) && !reached.has(importer) && !omitted.has(importer)) {
          const wanted = item.names === "*" ? "*" : [...item.names].sort().join(", ");
          omitted.set(importer, {
            file: importer,
            hop,
            fanIn: importerFanIn,
            via: item.via,
            path,
            reason: "unrelated-symbol",
            detail: `imports ${verdict.imported.length === 0 ? "nothing by name" : `{${verdict.imported.join(", ")}}`} from ${item.file}; changed: {${wanted}}`,
          });
        }
        continue;
      }
      if (!verdict.consumer) {
        // A pure barrel: the names pass through at the same hop.
        barrels.add(importer);
        queue.push({ file: importer, hop: item.hop, weight, names: verdict.passThrough as ChangedNames, via: item.via, path, mode: "symbol" });
        continue;
      }
      record({ file: importer, hop, weight, via: item.via, path, names: namesOut(verdict.next), mode: "symbol" }, importerFanIn);
      queue.push({ file: importer, hop, weight, names: verdict.next, via: item.via, path, mode: "symbol" });
    }
  }

  function record(entry: Omit<SymbolReachEntry, "fanIn">, entryFanIn: number): void {
    if (changed.has(entry.file)) return;
    const existing = reached.get(entry.file);
    if (existing !== undefined && !better(entry, existing)) return;
    omitted.delete(entry.file);
    reached.set(entry.file, { ...entry, fanIn: entryFanIn });
  }

  for (const file of reached.keys()) omitted.delete(file);
  for (const file of barrels) if (reached.has(file)) barrels.delete(file);
  const order = <T extends { hop: number; file: string }>(a: T, b: T): number => a.hop - b.hop || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  return {
    seeds,
    reached: [...reached.values()].sort(order),
    omitted: [...omitted.values()].sort(order),
    barrels: [...barrels].sort(),
  };
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function gitText(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : undefined;
}

/** Head = the working tree (what an unpinned radius measures); base read from git when given. */
export function workingTreeSourceReader(cwd: string, base?: string): SourceReader {
  const cache = new Map<string, string | undefined>();
  const read = (key: string, load: () => string | undefined): string | undefined => {
    if (!cache.has(key)) cache.set(key, load());
    return cache.get(key);
  };
  return {
    head: (file) =>
      read(`head\0${file}`, () => {
        try {
          return readFileSync(path.join(cwd, file), "utf8");
        } catch {
          return undefined;
        }
      }),
    ...(base === undefined ? {} : { base: (file: string) => read(`base\0${file}`, () => gitText(cwd, ["show", "--end-of-options", `${base}:${file}`])) }),
  };
}

/**
 * Reads sources at `head` (and `base`) from git. When the checkout's HEAD is
 * `head`, a file without uncommitted changes is read from disk instead, which
 * is the same bytes without a process per file.
 */
export function gitSourceReader(cwd: string, head: string, base?: string): SourceReader {
  const checkoutHead = gitText(cwd, ["rev-parse", "HEAD"])?.trim();
  const headFull = gitText(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${head}^{commit}`])?.trim();
  const fromDisk = checkoutHead !== undefined && checkoutHead === headFull;
  const dirty = new Set<string>();
  if (fromDisk) {
    for (const line of (gitText(cwd, ["status", "--porcelain", "--no-renames"]) ?? "").split("\n")) {
      if (line.length > 3) dirty.add(line.slice(3).trim());
    }
  }
  const cache = new Map<string, string | undefined>();
  const at = (rev: string, file: string, disk: boolean): string | undefined => {
    const key = `${rev}\0${file}`;
    if (cache.has(key)) return cache.get(key);
    let text: string | undefined;
    if (disk && !dirty.has(file)) {
      try {
        text = readFileSync(path.join(cwd, file), "utf8");
      } catch {
        text = undefined;
      }
    } else {
      text = gitText(cwd, ["show", "--end-of-options", `${rev}:${file}`]);
    }
    cache.set(key, text);
    return text;
  };
  return {
    head: (file) => at(head, file, fromDisk),
    ...(base === undefined ? {} : { base: (file: string) => at(base, file, false) }),
  };
}
