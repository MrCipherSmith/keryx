// Implicit consumers of a change: files tied to it by a string, not an import (flow 457, AC3).
//
// The code graph is built from import specifiers, so a consumer reached through
// a string key is invisible to it (see the "What the blast radius cannot see"
// note in blast-radius.ts): a translation key, an event name, a CSS class, a
// config key. This module pulls those strings out of the diff's changed lines
// and finds the files that mention them with a fixed-string search. A key that
// many files mention is a hub — following it would re-create the unbounded
// radius symbol reach just removed — so it is recorded as an omission with its
// hit count instead of being followed.
//
// The search runs through an injectable runner with a fixed argv, the pattern
// after `-e` and every operand after `--`, so a key from a diff can never be
// read as an option (pattern: src/harness/tool/builtin/spill-search.ts).

import { HunkBodyTracker } from "../gdgraph/symbol-reach";

export const TEXT_LINK_KINDS =["i18n-key", "event", "css-class", "config-key"] as const;
export type TextLinkKind = (typeof TEXT_LINK_KINDS)[number];

/** A key mentioned by more files than this is a hub: recorded, not followed. */
export const DEFAULT_TEXT_LINK_MAX_HITS = 20;
/** At most this many keys are searched per radius; the rest are reported as skipped. */
export const DEFAULT_TEXT_LINK_MAX_KEYS = 100;

export type TextKey = { key: string; kind: TextLinkKind; file: string };

export type TextLink = { file: string; key: string; kind: TextLinkKind; via: string };
export type TextHub = { key: string; kind: TextLinkKind; via: string; hits: number; files: string[]; detail: string };

export type TextLinksResult = {
  keys: TextKey[];
  links: TextLink[];
  hubs: TextHub[];
  /** Keys not searched (over the key cap) or whose search failed, with why. */
  skipped: Array<{ key: string; detail: string }>;
};

/** Files containing `key` as a fixed string, relative to the project root; `undefined` when the search could not run. */
export type TextSearcher = (key: string) => Promise<string[] | undefined>;

export type TextSearchRunner = (argv: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export const defaultTextSearchRunner: TextSearchRunner = async (argv, cwd) => {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
};

function lines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter((line) => line.length > 0);
}

/** `rg -F -l` over the working tree. Exit 1 is "no match", not a failure. */
export function ripgrepSearcher(cwd: string, run: TextSearchRunner = defaultTextSearchRunner): TextSearcher {
  return async (key) => {
    const result = await run(["rg", "--fixed-strings", "--files-with-matches", "--no-messages", "-e", key, "--", "."], cwd).catch(() => undefined);
    if (result === undefined || (result.exitCode !== 0 && result.exitCode !== 1)) return undefined;
    return lines(result.stdout).sort();
  };
}

/** `git grep -F -l` at a commit, for a radius computed against a pinned head rather than the working tree. */
export function gitGrepSearcher(cwd: string, rev: string, run: TextSearchRunner = defaultTextSearchRunner): TextSearcher {
  return async (key) => {
    const result = await run(["git", "grep", "--fixed-strings", "--files-with-matches", "-e", key, rev, "--", "."], cwd).catch(() => undefined);
    if (result === undefined || (result.exitCode !== 0 && result.exitCode !== 1)) return undefined;
    const prefix = `${rev}:`;
    return lines(result.stdout)
      .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
      .sort();
  };
}

// ---------------------------------------------------------------------------
// Key extraction
// ---------------------------------------------------------------------------

const FILE_EXTENSION = /\.(?:[cm]?[jt]sx?|json|jsonl|md|mdx|ya?ml|toml|css|scss|less|html?|svg|png|jpe?g|gif|txt|sh|py|java|go|rs|lock|log|map|wasm|d)$/i;
const DOTTED = /^[A-Za-z][\w-]*(?:\.[A-Za-z][\w-]*){1,}$/;
const EVENT_CALL = /\b(?:emit|on|once|off|addEventListener|removeEventListener|dispatch|dispatchEvent|subscribe|publish|listen|trigger)\s*\(\s*(?:new\s+\w*Event\s*\(\s*)?["'`]([^"'`\s]{2,80})["'`]/g;
const EVENT_TYPE = /\btype\s*:\s*["']([a-z][\w:./-]{2,80})["']/g;
const I18N_CALL = /\b(?:t|i18n\.t|translate|formatMessage|\$t)\s*\(\s*["'`]([^"'`\s]{2,120})["'`]/g;
const CLASS_ATTR = /\b(?:className|class)\s*=\s*\{?\s*["'`]([^"'`]{1,400})["'`]/g;
const CLASS_LIST = /\bclassList\.(?:add|remove|toggle|contains)\s*\(\s*["']([^"']{2,80})["']/g;
const CONFIG_CALL = /\b(?:config|settings|options|env)\s*(?:\.\s*(?:get|has|set)\s*)?\(\s*["']([^"'\s]{3,120})["']/g;
const ENV_READ = /\bprocess\.env\.([A-Z][A-Z0-9_]{2,})\b/g;
const QUOTED = /["']([^"'\s]{3,120})["']/g;
/** A configuration file: named like one (config, settings, options, flags, env), or a dotenv file. Data JSON is not config. */
const CONFIG_FILE = /(?:^|\/)[^/]*(?:config|settings|options|flags|\.env)[^/]*\.(?:json|ya?ml|toml|ini)$|(?:^|\/)\.env[^/]*$/i;
/** Any key from a structured file, so a data file's keys are never mistaken for code. */
const STRUCTURED_FILE = /\.(?:json|jsonl|ya?ml|toml|ini|lock)$/i;

/** snake_case, kebab-case, dotted or SCREAMING keys: a camelCase field name (`createdAt`) is too generic to follow. */
function isConfigLikeKey(key: string): boolean {
  return key.length >= 4 && /[_.-]/.test(key);
}

function isDottedKey(value: string): boolean {
  return DOTTED.test(value) && !FILE_EXTENSION.test(value) && !/^(?:node|bun|npm|https?|www)\./.test(value);
}

/** The keys one changed line carries. Import lines carry none: their strings are module specifiers. */
export function keysFromLine(text: string, file: string): TextKey[] {
  const out: TextKey[] = [];
  const add = (key: string, kind: TextLinkKind): void => {
    if (key.includes("${")) return;
    out.push({ key, kind, file });
  };
  const trimmed = text.trim();
  if (/^(?:import\b|export\s.*\bfrom\b|.*\brequire\s*\()/.test(trimmed)) return out;
  if (CONFIG_FILE.test(file)) {
    const jsonKey = /^\s*"([^"]+)"\s*:/.exec(text) ?? /^\s*([A-Za-z_][\w.-]*)\s*[:=]/.exec(text);
    if (jsonKey !== null && isConfigLikeKey(jsonKey[1] as string)) add(jsonKey[1] as string, "config-key");
    return out;
  }
  if (STRUCTURED_FILE.test(file)) return out;
  for (const match of text.matchAll(I18N_CALL)) add(match[1] as string, "i18n-key");
  for (const match of text.matchAll(EVENT_CALL)) add(match[1] as string, "event");
  for (const match of text.matchAll(EVENT_TYPE)) if (/[:./-]/.test(match[1] as string)) add(match[1] as string, "event");
  for (const match of text.matchAll(CLASS_ATTR)) {
    for (const token of (match[1] as string).split(/\s+/)) if (token.length >= 3 && /^[A-Za-z_-][\w-]*$/.test(token)) add(token, "css-class");
  }
  for (const match of text.matchAll(CLASS_LIST)) add(match[1] as string, "css-class");
  for (const match of text.matchAll(CONFIG_CALL)) add(match[1] as string, "config-key");
  for (const match of text.matchAll(ENV_READ)) add(match[1] as string, "config-key");
  for (const match of text.matchAll(QUOTED)) {
    const value = match[1] as string;
    if (isDottedKey(value)) add(value, "i18n-key");
  }
  return out;
}

/**
 * Keys from the added and removed lines of a unified diff, deduplicated by key
 * (the first file and kind that named it win), in diff order.
 */
export function extractTextKeys(diff: string): TextKey[] {
  const seen = new Map<string, TextKey>();
  let file: string | undefined;
  // Headers are parsed only outside a hunk body, so a removed `-- comment` or an added `++ x` line is content.
  const body = new HunkBodyTracker();
  const locale = new LocaleKeyPath();
  for (const line of diff.split("\n")) {
    if (body.consume(line)) {
      if (file === undefined || (!line.startsWith("+") && !line.startsWith("-"))) {
        if (file !== undefined && line.startsWith(" ")) locale.observe(line.slice(1));
        continue;
      }
      const text = line.slice(1);
      const localeKey = locale.observe(text);
      for (const key of keysFromLine(text, file)) if (!seen.has(key.key)) seen.set(key.key, key);
      if (localeKey !== undefined && !seen.has(localeKey)) seen.set(localeKey, { key: localeKey, kind: "i18n-key", file });
      continue;
    }
    if (line.startsWith("diff --git ")) {
      file = undefined;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const value = line.slice(4).trim();
      file = value === "/dev/null" ? file : value.replace(/^b\//, "");
      locale.reset(file);
      continue;
    }
    if (line.startsWith("--- ")) {
      const value = line.slice(4).trim();
      if (value !== "/dev/null") file = value.replace(/^a\//, "");
      locale.reset(file);
      continue;
    }
    if (body.open(line) !== undefined) locale.reset(file);
  }
  return [...seen.values()];
}

/** A structured locale file (`locales/en.json`, `i18n/fr.yaml`, `messages.de.yml`, `en-US.json`…). */
const LOCALE_FILE = /(?:^|\/)(?:locales?|i18n|lang|langs|translations?|messages)(?:\/|\.)[^]*\.(?:json|ya?ml)$|(?:^|\/)[a-z]{2}(?:[-_][A-Za-z]{2})?\.(?:json|ya?ml)$/i;

/**
 * The key a changed line of a structured locale file names. A nested key is joined with dots (`{"a": {"b": "x"}}`
 * → `a.b`) as far as the hunk shows its parents; with zero context the parent is unknown and the leaf key is used.
 * Only leaves (a key with a scalar value) are keys: a parent object line opens a scope.
 */
class LocaleKeyPath {
  private stack: Array<{ indent: number; key: string }> = [];
  private active = false;
  private yaml = false;

  reset(file: string | undefined): void {
    this.stack = [];
    this.active = file !== undefined && LOCALE_FILE.test(file) && !CONFIG_FILE.test(file);
    this.yaml = file !== undefined && /\.ya?ml$/i.test(file);
  }

  observe(text: string): string | undefined {
    if (!this.active) return undefined;
    const match = this.yaml ? /^(\s*)(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w.-]*))\s*:\s*(.*)$/.exec(text) : /^(\s*)"([^"]+)"\s*:\s*(.*)$/.exec(text);
    if (match === null) return undefined;
    const indent = (match[1] as string).length;
    const key = (match[2] ?? match[3] ?? match[4]) as string;
    const value = ((this.yaml ? match[5] : match[3]) ?? "").trim();
    while (this.stack.length > 0 && (this.stack[this.stack.length - 1] as { indent: number }).indent >= indent) this.stack.pop();
    const opensScope = this.yaml ? value === "" || value.startsWith("#") : value.startsWith("{") && !value.includes("}");
    if (opensScope) {
      this.stack.push({ indent, key });
      return undefined;
    }
    const full = [...this.stack.map((entry) => entry.key), key].join(".");
    return full.length >= 3 ? full : undefined;
  }
}

/**
 * The files tied to the change by a key it touched. The changed files are never
 * links (they are the change). A key with more than `maxHits` other files is a
 * hub; its files are listed on the hub, not linked.
 */
export async function findTextLinks(input: {
  diff: string;
  changedFiles: readonly string[];
  search: TextSearcher;
  maxHits?: number | undefined;
  maxKeys?: number | undefined;
}): Promise<TextLinksResult> {
  const maxHits = input.maxHits ?? DEFAULT_TEXT_LINK_MAX_HITS;
  const maxKeys = input.maxKeys ?? DEFAULT_TEXT_LINK_MAX_KEYS;
  const changed = new Set(input.changedFiles);
  const keys = extractTextKeys(input.diff);
  const links = new Map<string, TextLink>();
  const hubs: TextHub[] = [];
  const skipped: Array<{ key: string; detail: string }> = [];
  for (const [index, key] of keys.entries()) {
    if (index >= maxKeys) {
      skipped.push({ key: key.key, detail: `over the ${maxKeys}-key cap for one radius; not searched` });
      continue;
    }
    const found = await input.search(key.key);
    if (found === undefined) {
      skipped.push({ key: key.key, detail: "the text search could not run" });
      continue;
    }
    const others = found.filter((file) => !changed.has(file));
    if (others.length === 0) continue;
    if (others.length > maxHits) {
      hubs.push({
        key: key.key,
        kind: key.kind,
        via: key.file,
        hits: others.length,
        files: others,
        detail: `${key.kind} "${key.key}" (changed in ${key.file}) is mentioned by ${others.length} files, over the ${maxHits}-file hub limit; its consumers are not followed one by one`,
      });
      continue;
    }
    for (const file of others) if (!links.has(file)) links.set(file, { file, key: key.key, kind: key.kind, via: key.file });
  }
  return { keys, links: [...links.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)), hubs, skipped };
}
