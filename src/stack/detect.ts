/**
 * Deterministic, offline, general-purpose stack detection (flow 309, W1,
 * Lane A) — `docs/requirements/keryx-agent-platform-expansion/workstreams/
 * W1-stack-catalog.md` §"Stack detection — output contract".
 *
 * Generalizes `src/review/stack.ts`'s `detectProjectStack` (a 7-tag,
 * `package.json`-only check feeding review dispatch) into a marker-file +
 * manifest + bounded-extension scan across every target stack family in the
 * requirements table. `src/review/stack.ts` is left UNCHANGED — review
 * dispatch keeps using its own 7-tag detector; this module does not import
 * from or replace it, it independently reuses the same fail-open discipline.
 *
 * # The one rule this module will not break
 *
 * **Uncertain always means included**, generalized from a single global flag
 * to PER-SIGNAL contribution: a signal that cannot be read, cannot be parsed,
 * or names a monorepo/workspace root with no leaf dependency sets `uncertain:
 * true` for only the tags ITS family covers — never for every tag. A tag's
 * overall value is `true` if any signal marks it present OR uncertain; a tag
 * only comes back `false` when every signal that could have named it either
 * did not run (no signal source found) or ran cleanly and plainly did not
 * name it.
 *
 * # Determinism
 *
 * No network, no model call, no `Date`/`Math.random` inside this module (the
 * caller — `src/stack/service.ts` — supplies `detectedAt` separately, via an
 * injectable clock). Every list this module returns is sorted before it is
 * returned: `matched`, `perSignal` (by `signal` id), the tags each per-signal
 * entry names. Directory listings are sorted before use so a re-run on the
 * same tree produces byte-identical output regardless of the OS's own
 * readdir order.
 */

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export const STACK_DETECTION_SCHEMA_VERSION = "1.0.0";

export type StackFamily =
  | "js"
  | "python"
  | "go"
  | "rust"
  | "jvm"
  | "dotnet"
  | "swift"
  | "dart"
  | "php"
  | "ruby"
  | "c-cpp"
  | "infra"
  | "ci"
  | "sql";

/** One entry per known tag: its family, and nothing else — a plain data table. */
export const STACK_DETECT_TAGS: readonly { readonly tag: string; readonly family: StackFamily }[] = [
  // js
  { tag: "javascript", family: "js" },
  { tag: "typescript", family: "js" },
  { tag: "node", family: "js" },
  { tag: "react", family: "js" },
  { tag: "vue", family: "js" },
  { tag: "angular", family: "js" },
  { tag: "nextjs", family: "js" },
  { tag: "nuxt", family: "js" },
  { tag: "nestjs", family: "js" },
  { tag: "mobx", family: "js" },
  { tag: "prisma", family: "js" },
  { tag: "playwright", family: "js" },
  { tag: "express", family: "js" },
  // python
  { tag: "python", family: "python" },
  { tag: "django", family: "python" },
  { tag: "fastapi", family: "python" },
  { tag: "flask", family: "python" },
  // go
  { tag: "go", family: "go" },
  // rust
  { tag: "rust", family: "rust" },
  // jvm
  { tag: "java", family: "jvm" },
  { tag: "kotlin", family: "jvm" },
  { tag: "spring", family: "jvm" },
  { tag: "android", family: "jvm" },
  // dotnet
  { tag: "csharp", family: "dotnet" },
  { tag: "dotnet", family: "dotnet" },
  // swift
  { tag: "swift", family: "swift" },
  { tag: "ios", family: "swift" },
  // dart
  { tag: "dart", family: "dart" },
  { tag: "flutter", family: "dart" },
  // php
  { tag: "php", family: "php" },
  { tag: "laravel", family: "php" },
  // ruby
  { tag: "ruby", family: "ruby" },
  { tag: "rails", family: "ruby" },
  // c-cpp
  { tag: "c-cpp", family: "c-cpp" },
  // infra
  { tag: "docker", family: "infra" },
  { tag: "docker-compose", family: "infra" },
  { tag: "terraform", family: "infra" },
  // ci
  { tag: "github-actions", family: "ci" },
  { tag: "gitlab-ci", family: "ci" },
  // sql
  { tag: "sql", family: "sql" },
] as const;

const ALL_TAGS: readonly string[] = STACK_DETECT_TAGS.map((entry) => entry.tag)
  .slice()
  .sort();

const TAGS_BY_FAMILY: ReadonlyMap<StackFamily, readonly string[]> = (() => {
  const map = new Map<StackFamily, string[]>();
  for (const entry of STACK_DETECT_TAGS) {
    const list = map.get(entry.family) ?? [];
    list.push(entry.tag);
    map.set(entry.family, list);
  }
  for (const [family, list] of map) {
    map.set(family, list.slice().sort());
  }
  return map;
})();

function tagsOf(family: StackFamily): readonly string[] {
  return TAGS_BY_FAMILY.get(family) ?? [];
}

export interface StackPerSignal {
  readonly signal: string;
  readonly tags: readonly string[];
  readonly uncertain: boolean;
  readonly reason: string;
}

export interface StackDetection {
  readonly schemaVersion: "1.0.0";
  readonly detectedAt: string;
  readonly inputsSha256: string;
  readonly tags: Record<string, boolean>;
  readonly uncertain: boolean;
  readonly reason: string;
  readonly matched: readonly string[];
  readonly perSignal: readonly StackPerSignal[];
}

/** The fields `detectStack` itself computes — `detectedAt`/`inputsSha256` are filled in by `src/stack/service.ts`. */
export type StackDetectionCore = Omit<StackDetection, "detectedAt" | "inputsSha256">;

// ---------------------------------------------------------------------------
// Injectable filesystem
// ---------------------------------------------------------------------------

export interface StackDirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

/**
 * The filesystem surface `detectStack` needs, injectable for tests. Every
 * method THROWS when the path does not exist — callers catch, never check
 * existence separately, matching `src/review/stack.ts`'s `readFile` shape.
 */
export interface StackDetectFs {
  readTextFile(path: string): Promise<string>;
  readDir(path: string): Promise<StackDirEntry[]>;
}

function joinPath(...parts: string[]): string {
  return parts
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "") || "/";
}

async function defaultReadTextFile(path: string): Promise<string> {
  return await Bun.file(path).text();
}

async function defaultReadDir(path: string): Promise<StackDirEntry[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(path, { withFileTypes: true });
  return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
}

export const defaultStackDetectFs: StackDetectFs = {
  readTextFile: defaultReadTextFile,
  readDir: defaultReadDir,
};

// ---------------------------------------------------------------------------
// Signal result builders
// ---------------------------------------------------------------------------

interface SignalOutcome {
  readonly tags: readonly string[];
  readonly matched: readonly string[];
  readonly uncertain: boolean;
  readonly reason: string;
}

function present(tags: readonly string[], matched: readonly string[], reason: string): SignalOutcome {
  return { tags: [...new Set(tags)].sort(), matched: [...new Set(matched)].sort(), uncertain: false, reason };
}

function uncertainFamily(family: StackFamily, reason: string): SignalOutcome {
  return { tags: tagsOf(family), matched: [], uncertain: true, reason };
}

// ---------------------------------------------------------------------------
// Fail-open error handling (W1 review F1) — a signal source that cannot be
// read for a reason OTHER than "it does not exist" must never look identical
// to "absent". Only ENOENT (no such file/dir) and ENOTDIR (a path component
// that should have been a directory is a file — same practical meaning: the
// thing this signal looks for is not there) mean absent. Anything else —
// EACCES, EISDIR, EIO, EMFILE, a symlink loop, ... — means this module could
// not find out, so the family that signal covers goes `uncertain: true`
// rather than silently `false`.
// ---------------------------------------------------------------------------

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") {
      return code;
    }
  }
  return undefined;
}

function isAbsentError(error: unknown): boolean {
  const code = errorCode(error);
  if (code !== undefined) {
    return code === "ENOENT" || code === "ENOTDIR";
  }
  // No `.code` on the thrown value (e.g. a hand-built test double) — fall
  // back to sniffing the message so "absent" still means absent there too.
  const message = error instanceof Error ? error.message : String(error);
  return /\bENOENT\b/.test(message) || /\bENOTDIR\b/.test(message);
}

/**
 * `undefined` when `error` means the path is simply absent (the caller's
 * normal "no signal here" path); a `SignalOutcome` marking `family`
 * uncertain, naming the error code, for anything else.
 */
function readFailureOutcome(family: StackFamily, label: string, error: unknown): SignalOutcome | undefined {
  if (isAbsentError(error)) {
    return undefined;
  }
  return uncertainFamily(family, `${label} could not be read: ${errorCode(error) ?? "unknown error"}`);
}

// ---------------------------------------------------------------------------
// JS family — package.json (reuses `src/review/stack.ts`'s semantics)
// ---------------------------------------------------------------------------

const JS_DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

const JS_TAG_MARKERS: Record<string, readonly string[]> = {
  react: ["react", "react-dom"],
  vue: ["vue"],
  angular: ["@angular/core"],
  nextjs: ["next"],
  nuxt: ["nuxt"],
  mobx: ["mobx", "mobx-react", "mobx-react-lite"],
  prisma: ["prisma", "@prisma/client"],
  playwright: ["playwright", "@playwright/test"],
  express: ["express"],
  typescript: ["typescript"],
};

function workspacePatterns(record: Record<string, unknown>): string[] {
  const declared = record["workspaces"];
  const list = Array.isArray(declared)
    ? declared
    : typeof declared === "object" && declared !== null
      ? (declared as Record<string, unknown>)["packages"]
      : undefined;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string" && item !== "") : [];
}

async function packageJsonSignal(cwd: string, fs: StackDetectFs): Promise<SignalOutcome | undefined> {
  const manifestPath = joinPath(cwd, "package.json");
  let raw: string;
  try {
    raw = await fs.readTextFile(manifestPath);
  } catch (error) {
    return readFailureOutcome("js", "package.json", error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return uncertainFamily(
      "js",
      `package.json did not parse as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return uncertainFamily("js", "package.json is not a JSON object");
  }

  const record = parsed as Record<string, unknown>;
  const names = new Set<string>();
  for (const field of JS_DEPENDENCY_FIELDS) {
    const value = record[field];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const name of Object.keys(value as Record<string, unknown>)) {
        names.add(name);
      }
    }
  }

  const workspaceGlobs = workspacePatterns(record);
  if (workspaceGlobs.length > 0) {
    return uncertainFamily(
      "js",
      `package.json declares workspaces (${workspaceGlobs.join(
        ", ",
      )}); the dependencies that decide the stack live in the sub-packages, which this module does not walk`,
    );
  }
  if (names.size === 0) {
    return uncertainFamily(
      "js",
      `package.json declares no dependencies in ${JS_DEPENDENCY_FIELDS.join(
        "/",
      )} — a manifest that declares nothing has not said the repository uses nothing`,
    );
  }

  const matched: string[] = [];
  const tags = new Set<string>(["javascript", "node"]);

  const nestjsMatches = [...names].filter((name) => name.startsWith("@nestjs/")).sort();
  if (nestjsMatches.length > 0) {
    tags.add("nestjs");
    matched.push(...nestjsMatches);
  }
  for (const [tag, markers] of Object.entries(JS_TAG_MARKERS)) {
    const hit = markers.filter((marker) => names.has(marker));
    if (hit.length > 0) {
      tags.add(tag);
      matched.push(...hit);
    }
  }

  return present(
    [...tags],
    matched,
    `detected from package.json (${names.size} declared dependenc${names.size === 1 ? "y" : "ies"})`,
  );
}

// ---------------------------------------------------------------------------
// Python family — pyproject.toml / setup.cfg / requirements.txt
// ---------------------------------------------------------------------------

const PYTHON_FRAMEWORK_MARKERS: Record<string, RegExp> = {
  django: /\bdjango\b/i,
  fastapi: /\bfastapi\b/i,
  flask: /\bflask\b/i,
};

/**
 * A structurally broken TOML file: unbalanced `[`/`]` brackets (an
 * unterminated `[table]` header, or an array/inline-table that never
 * closes), or a string that is never closed. Bracket and string tracking is
 * done over the WHOLE file with a small state machine covering TOML's four
 * string kinds — basic `"..."` (backslash escapes apply, an escaped
 * backslash `\\` before the closing `"` does not close it), literal
 * `'...'` (no escapes), and their multi-line `"""..."""` / `'''...'''`
 * forms (span newlines; `[`/`]` inside them are content, not table/array
 * syntax) — plus `#` comments. A valid multi-line array or nested array
 * (`matrix = [\n    [1, 2],\n    [3, 4],\n]`) nets its brackets to zero
 * across the lines it spans instead of being judged one line at a time.
 * Unterminated-string detection comes from the state machine's own end
 * state (still open at EOF) rather than a quote-parity count, since parity
 * breaks on an escaped backslash. A single-line basic (`"..."`) string
 * that hits a bare newline before its closing quote is flagged right
 * there — TOML basic strings can't contain a raw newline, so that is
 * always broken. A single-line literal (`'...'`) string left open past a
 * bare newline is not flagged the same way: it just stops being tracked
 * as a string at line end, so an unterminated `'` doesn't swallow the
 * rest of the file (and its real brackets/quotes) as "inside a string".
 * A lightweight heuristic, not a TOML parser — deliberately, matching the
 * spec's "line/regex scans" discipline for every non-JSON manifest.
 */
function pyprojectBrokenReason(text: string): string | undefined {
  type State = "normal" | "double" | "single" | "double3" | "single3" | "comment";
  let state: State = "normal";
  let depth = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (state === "comment") {
      if (ch === "\n") {
        state = "normal";
      }
      continue;
    }

    if (state === "single") {
      // TOML literal strings don't span a bare newline — stop tracking at
      // line end rather than let an unterminated `'` swallow the rest of
      // the file (and its real brackets/quotes) as "inside a string".
      if (ch === "\n" || ch === "'") {
        state = "normal";
      }
      continue;
    }

    if (state === "double") {
      // Basic strings escape with `\`: `\"` doesn't close the string, and
      // `\\` is an escaped backslash (the quote right after it is NOT
      // escaped). Skip the escaped character as a pair so a trailing
      // `\\` before the closing `"` is read correctly either way.
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === "\n") {
        // A raw newline inside a basic string is invalid TOML on its own —
        // report it here rather than resetting silently, so an unterminated
        // `"..."` value (not a `"""` block) is still caught.
        return "unbalanced quotes";
      }
      if (ch === '"') {
        state = "normal";
      }
      continue;
    }

    if (state === "double3") {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
        state = "normal";
        i += 2;
      }
      continue;
    }

    if (state === "single3") {
      // Literal strings, multi-line included, have no escapes.
      if (ch === "'" && text[i + 1] === "'" && text[i + 2] === "'") {
        state = "normal";
        i += 2;
      }
      continue;
    }

    // state === "normal"
    if (ch === "#") {
      state = "comment";
    } else if (ch === '"') {
      if (text[i + 1] === '"' && text[i + 2] === '"') {
        state = "double3";
        i += 2;
      } else {
        state = "double";
      }
    } else if (ch === "'") {
      if (text[i + 1] === "'" && text[i + 2] === "'") {
        state = "single3";
        i += 2;
      } else {
        state = "single";
      }
    } else if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
    }
  }

  if (depth !== 0) {
    return depth > 0
      ? "unterminated table header or array (unbalanced '[')"
      : "unbalanced brackets (unexpected ']')";
  }
  if (state === "double" || state === "double3" || state === "single3") {
    return "unterminated string";
  }
  return undefined;
}

function pythonFrameworkTags(text: string): string[] {
  const tags: string[] = [];
  for (const [tag, pattern] of Object.entries(PYTHON_FRAMEWORK_MARKERS)) {
    if (pattern.test(text)) {
      tags.push(tag);
    }
  }
  return tags;
}

async function pyprojectSignal(cwd: string, fs: StackDetectFs): Promise<SignalOutcome | undefined> {
  const manifestPath = joinPath(cwd, "pyproject.toml");
  let raw: string;
  try {
    raw = await fs.readTextFile(manifestPath);
  } catch (error) {
    return readFailureOutcome("python", "pyproject.toml", error);
  }
  const broken = pyprojectBrokenReason(raw);
  if (broken !== undefined) {
    return uncertainFamily("python", `pyproject.toml is structurally broken: ${broken}`);
  }
  return present(
    ["python", ...pythonFrameworkTags(raw)],
    ["pyproject.toml", ...pythonFrameworkTags(raw)],
    "detected from pyproject.toml",
  );
}

async function simplePythonManifestSignal(
  cwd: string,
  fs: StackDetectFs,
  fileName: string,
): Promise<SignalOutcome | undefined> {
  const manifestPath = joinPath(cwd, fileName);
  let raw: string;
  try {
    raw = await fs.readTextFile(manifestPath);
  } catch (error) {
    return readFailureOutcome("python", fileName, error);
  }
  return present(
    ["python", ...pythonFrameworkTags(raw)],
    [fileName, ...pythonFrameworkTags(raw)],
    `detected from ${fileName}`,
  );
}

// ---------------------------------------------------------------------------
// Other single-manifest families
// ---------------------------------------------------------------------------

async function markerFileSignal(
  cwd: string,
  fs: StackDetectFs,
  fileName: string,
  tags: readonly string[],
  family: StackFamily,
): Promise<SignalOutcome | undefined> {
  const filePath = joinPath(cwd, fileName);
  try {
    await fs.readTextFile(filePath);
  } catch (error) {
    return readFailureOutcome(family, fileName, error);
  }
  return present(tags, [fileName], `detected from ${fileName}`);
}

async function goModSignal(cwd: string, fs: StackDetectFs): Promise<SignalOutcome | undefined> {
  return markerFileSignal(cwd, fs, "go.mod", ["go"], "go");
}

async function cargoTomlSignal(cwd: string, fs: StackDetectFs): Promise<SignalOutcome | undefined> {
  return markerFileSignal(cwd, fs, "Cargo.toml", ["rust"], "rust");
}

async function packageSwiftSignal(cwd: string, fs: StackDetectFs): Promise<SignalOutcome | undefined> {
  const filePath = joinPath(cwd, "Package.swift");
  let raw: string;
  try {
    raw = await fs.readTextFile(filePath);
  } catch (error) {
    return readFailureOutcome("swift", "Package.swift", error);
  }
  const tags = ["swift"];
  if (/\.iOS\(/.test(raw)) {
    tags.push("ios");
  }
  return present(tags, ["Package.swift"], "detected from Package.swift");
}

async function pubspecSignal(cwd: string, fs: StackDetectFs): Promise<SignalOutcome | undefined> {
  const filePath = joinPath(cwd, "pubspec.yaml");
  let raw: string;
  try {
    raw = await fs.readTextFile(filePath);
  } catch (error) {
    return readFailureOutcome("dart", "pubspec.yaml", error);
  }
  const tags = ["dart"];
  if (/\bflutter\b/.test(raw)) {
    tags.push("flutter");
  }
  return present(tags, ["pubspec.yaml"], "detected from pubspec.yaml");
}

async function composerSignal(cwd: string, fs: StackDetectFs): Promise<SignalOutcome | undefined> {
  const filePath = joinPath(cwd, "composer.json");
  let raw: string;
  try {
    raw = await fs.readTextFile(filePath);
  } catch (error) {
    return readFailureOutcome("php", "composer.json", error);
  }
  const tags = ["php"];
  let laravel = false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const require = parsed["require"];
    if (typeof require === "object" && require !== null) {
      laravel = Object.keys(require as Record<string, unknown>).includes("laravel/framework");
    }
  } catch {
    laravel = /laravel\/framework/.test(raw);
  }
  if (laravel) {
    tags.push("laravel");
  }
  return present(
    tags,
    laravel ? ["composer.json", "laravel/framework"] : ["composer.json"],
    "detected from composer.json",
  );
}

async function gemfileSignal(cwd: string, fs: StackDetectFs): Promise<SignalOutcome | undefined> {
  const filePath = joinPath(cwd, "Gemfile");
  let raw: string;
  try {
    raw = await fs.readTextFile(filePath);
  } catch (error) {
    return readFailureOutcome("ruby", "Gemfile", error);
  }
  const tags = ["ruby"];
  if (/\brails\b/.test(raw)) {
    tags.push("rails");
  }
  return present(tags, ["Gemfile"], "detected from Gemfile");
}

async function jvmManifestSignal(
  cwd: string,
  fs: StackDetectFs,
  fileName: string,
): Promise<SignalOutcome | undefined> {
  const filePath = joinPath(cwd, fileName);
  let raw: string;
  try {
    raw = await fs.readTextFile(filePath);
  } catch (error) {
    return readFailureOutcome("jvm", fileName, error);
  }
  const tags = ["java"];
  if (/spring-boot|springframework\.boot/i.test(raw)) {
    tags.push("spring");
  }
  if (/\.kts$/.test(fileName) || /\bkotlin\b/i.test(raw)) {
    tags.push("kotlin");
  }
  if (/com\.android\.(application|library)/.test(raw)) {
    tags.push("android");
  }
  return present(tags, [fileName], `detected from ${fileName}`);
}

async function dotnetProjectSignal(cwd: string, fs: StackDetectFs): Promise<SignalOutcome | undefined> {
  let entries: StackDirEntry[];
  try {
    entries = await fs.readDir(cwd);
  } catch (error) {
    return readFailureOutcome("dotnet", "the repository root", error);
  }
  const hit = entries
    .filter((entry) => !entry.isDirectory && (entry.name.endsWith(".csproj") || entry.name.endsWith(".sln")))
    .map((entry) => entry.name)
    .sort();
  if (hit.length === 0) {
    return undefined;
  }
  return present(["csharp", "dotnet"], hit, `detected from ${hit.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Infra / CI / SQL markers
// ---------------------------------------------------------------------------

async function dockerfileSignal(cwd: string, fs: StackDetectFs): Promise<SignalOutcome | undefined> {
  return markerFileSignal(cwd, fs, "Dockerfile", ["docker"], "infra");
}

async function dockerComposeSignal(cwd: string, fs: StackDetectFs): Promise<SignalOutcome | undefined> {
  for (const name of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    const outcome = await markerFileSignal(cwd, fs, name, ["docker-compose"], "infra");
    if (outcome !== undefined) {
      return outcome;
    }
  }
  return undefined;
}

async function gitlabCiSignal(cwd: string, fs: StackDetectFs): Promise<SignalOutcome | undefined> {
  return markerFileSignal(cwd, fs, ".gitlab-ci.yml", ["gitlab-ci"], "ci");
}

async function githubWorkflowsSignal(cwd: string, fs: StackDetectFs): Promise<SignalOutcome | undefined> {
  const dirPath = joinPath(cwd, ".github", "workflows");
  let entries: StackDirEntry[];
  try {
    entries = await fs.readDir(dirPath);
  } catch (error) {
    return readFailureOutcome("ci", ".github/workflows", error);
  }
  const hit = entries
    .filter((entry) => !entry.isDirectory && (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")))
    .map((entry) => entry.name)
    .sort();
  if (hit.length === 0) {
    return undefined;
  }
  return present(
    ["github-actions"],
    hit.map((name) => `.github/workflows/${name}`),
    `detected from .github/workflows (${hit.join(", ")})`,
  );
}

async function rootGlobSignal(
  cwd: string,
  fs: StackDetectFs,
  extension: string,
  tags: readonly string[],
  family: StackFamily,
): Promise<SignalOutcome | undefined> {
  let entries: StackDirEntry[];
  try {
    entries = await fs.readDir(cwd);
  } catch (error) {
    return readFailureOutcome(family, "the repository root", error);
  }
  const hit = entries
    .filter((entry) => !entry.isDirectory && entry.name.endsWith(extension))
    .map((entry) => entry.name)
    .sort();
  if (hit.length === 0) {
    return undefined;
  }
  return present(tags, hit, `detected from ${hit.join(", ")}`);
}

async function terraformSignal(cwd: string, fs: StackDetectFs): Promise<SignalOutcome | undefined> {
  return rootGlobSignal(cwd, fs, ".tf", ["terraform"], "infra");
}

async function sqlSignal(cwd: string, fs: StackDetectFs): Promise<SignalOutcome | undefined> {
  return rootGlobSignal(cwd, fs, ".sql", ["sql"], "sql");
}

// ---------------------------------------------------------------------------
// Bounded extension scan (c-cpp — the one family with no manifest/marker of
// its own)
// ---------------------------------------------------------------------------

const SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "vendor",
  ".metaproject",
  "target",
  ".venv",
]);

const C_CPP_EXTENSIONS = new Set([".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"]);

interface ExtensionScanResult {
  readonly cCppFiles: readonly string[];
  readonly capHit: boolean;
  /** A subdirectory (the scan root included) could not be read for a reason other than it being absent. */
  readonly erred: boolean;
  readonly erredCode: string | undefined;
}

async function scanExtensions(cwd: string, fs: StackDetectFs, maxFiles: number): Promise<ExtensionScanResult> {
  const cCppFiles: string[] = [];
  let visited = 0;
  let capHit = false;
  let erred = false;
  let erredCode: string | undefined;

  async function walk(dir: string, depth: number): Promise<void> {
    if (capHit || depth > 3) {
      return;
    }
    let entries: StackDirEntry[];
    try {
      entries = await fs.readDir(dir);
    } catch (error) {
      if (!isAbsentError(error)) {
        erred = true;
        erredCode = erredCode ?? errorCode(error);
      }
      return;
    }
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      if (capHit) {
        return;
      }
      if (visited >= maxFiles) {
        capHit = true;
        return;
      }
      visited += 1;
      if (entry.isDirectory) {
        if (SCAN_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        await walk(joinPath(dir, entry.name), depth + 1);
        continue;
      }
      const dotIndex = entry.name.lastIndexOf(".");
      const ext = dotIndex === -1 ? "" : entry.name.slice(dotIndex);
      if (C_CPP_EXTENSIONS.has(ext)) {
        cCppFiles.push(joinPath(dir, entry.name));
      }
    }
  }

  await walk(cwd, 0);
  return { cCppFiles: cCppFiles.sort(), capHit, erred, erredCode };
}

async function extensionScanSignal(cwd: string, fs: StackDetectFs, maxFiles: number): Promise<SignalOutcome | undefined> {
  const { cCppFiles, capHit, erred, erredCode } = await scanExtensions(cwd, fs, maxFiles);
  if (erred) {
    return uncertainFamily(
      "c-cpp",
      `extension scan could not read a subdirectory: ${erredCode ?? "unknown error"}`,
    );
  }
  if (capHit) {
    return uncertainFamily(
      "c-cpp",
      `extension scan hit its file cap (${maxFiles}) before finishing — the scan cannot say whether C/C++ sources exist beyond what it already saw`,
    );
  }
  if (cCppFiles.length === 0) {
    return undefined;
  }
  return present(
    ["c-cpp"],
    [],
    `detected ${cCppFiles.length} C/C++ source file${cCppFiles.length === 1 ? "" : "s"} in a bounded scan (depth ≤ 3)`,
  );
}

// ---------------------------------------------------------------------------
// detectStack
// ---------------------------------------------------------------------------

export interface DetectStackOptions {
  /** Injectable for tests; defaults to the real filesystem. */
  readonly fs?: StackDetectFs;
  /** Cap on files visited by the bounded extension scan. Default 5000. */
  readonly maxFiles?: number;
}

interface RawSignal {
  readonly id: string;
  readonly outcome: SignalOutcome | undefined;
}

/**
 * Detect the stack(s) a repository at `cwd` uses — manifests, marker files,
 * and a bounded extension scan, root-level only (no workspace walking; see
 * the module doc and the W1 spec's open question on that). Deterministic,
 * offline, no `Date`.
 */
export async function detectStack(cwd: string, opts: DetectStackOptions = {}): Promise<StackDetectionCore> {
  const fs = opts.fs ?? defaultStackDetectFs;
  const maxFiles = opts.maxFiles ?? 5000;
  const root = cwd.replace(/\/+$/, "") || "/";

  const raw: RawSignal[] = [
    { id: "manifest:package.json", outcome: await packageJsonSignal(root, fs) },
    { id: "manifest:pyproject.toml", outcome: await pyprojectSignal(root, fs) },
    { id: "manifest:setup.cfg", outcome: await simplePythonManifestSignal(root, fs, "setup.cfg") },
    { id: "manifest:requirements.txt", outcome: await simplePythonManifestSignal(root, fs, "requirements.txt") },
    { id: "manifest:go.mod", outcome: await goModSignal(root, fs) },
    { id: "manifest:Cargo.toml", outcome: await cargoTomlSignal(root, fs) },
    { id: "manifest:pom.xml", outcome: await jvmManifestSignal(root, fs, "pom.xml") },
    { id: "manifest:build.gradle", outcome: await jvmManifestSignal(root, fs, "build.gradle") },
    { id: "manifest:build.gradle.kts", outcome: await jvmManifestSignal(root, fs, "build.gradle.kts") },
    { id: "manifest:dotnet-project", outcome: await dotnetProjectSignal(root, fs) },
    { id: "manifest:Package.swift", outcome: await packageSwiftSignal(root, fs) },
    { id: "manifest:pubspec.yaml", outcome: await pubspecSignal(root, fs) },
    { id: "manifest:composer.json", outcome: await composerSignal(root, fs) },
    { id: "manifest:Gemfile", outcome: await gemfileSignal(root, fs) },
    { id: "marker:Dockerfile", outcome: await dockerfileSignal(root, fs) },
    { id: "marker:docker-compose", outcome: await dockerComposeSignal(root, fs) },
    { id: "marker:terraform", outcome: await terraformSignal(root, fs) },
    { id: "marker:github-workflows", outcome: await githubWorkflowsSignal(root, fs) },
    { id: "marker:gitlab-ci", outcome: await gitlabCiSignal(root, fs) },
    { id: "marker:sql", outcome: await sqlSignal(root, fs) },
    { id: "scan:extensions", outcome: await extensionScanSignal(root, fs, maxFiles) },
  ];

  const tags: Record<string, boolean> = {};
  for (const tag of ALL_TAGS) {
    tags[tag] = false;
  }

  const matched = new Set<string>();
  const reasons: string[] = [];
  const perSignal: StackPerSignal[] = [];
  let uncertain = false;

  for (const { id, outcome } of raw) {
    if (outcome === undefined) {
      continue;
    }
    for (const tag of outcome.tags) {
      tags[tag] = true;
    }
    for (const name of outcome.matched) {
      matched.add(name);
    }
    if (outcome.uncertain) {
      uncertain = true;
    }
    reasons.push(outcome.reason);
    perSignal.push({ signal: id, tags: outcome.tags, uncertain: outcome.uncertain, reason: outcome.reason });
  }

  perSignal.sort((a, b) => a.signal.localeCompare(b.signal));
  reasons.sort();

  const reason = reasons.length > 0 ? reasons.join("; ") : "no known stack signals found at the repository root";

  const sortedTags: Record<string, boolean> = {};
  for (const tag of ALL_TAGS) {
    sortedTags[tag] = tags[tag] ?? false;
  }

  return {
    schemaVersion: "1.0.0",
    tags: sortedTags,
    uncertain,
    reason,
    matched: [...matched].sort(),
    perSignal,
  };
}
