// Flow 313 (W4 portability), T6 — `keryx bundle export`'s deterministic core.
// Offline: the only process spawned is a local `git remote get-url origin`
// read for bundle-identity provenance (never bundle CONTENT execution, which
// this module never does).

import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { validateAgainstSchemaObject } from "../contracts/validator";
import { parseAgentFrontmatter } from "../agents/frontmatter";
import { MEMORY_TYPES } from "../memory/types";
import hookConfigSchemaJson from "../../docs/requirements/keryx-agent-platform-expansion/schemas/hook-config.schema.json" with {
  type: "json",
};
import learnedPatternSchemaJson from "../../docs/requirements/keryx-agent-platform-expansion/schemas/learned-pattern.schema.json" with {
  type: "json",
};
import { sha256Hex } from "./checksum";
import { buildBundleArchive } from "./archive";
import { serializeManifest } from "./manifest";
import { normalizeBundlePath, scopeRoot, type PathCtx } from "./paths";
import {
  BUNDLE_FORMAT_VERSION,
  BUNDLE_REFUSAL,
  type BundleContentEntry,
  type BundleContentKind,
  type BundleManifest,
  type BundleRefusal,
  type BundleScope,
} from "./types";

export interface ExportOptions {
  projectRoot: string;
  scope: BundleScope;
  out: string;
  include?: string[] | undefined;
  kinds?: BundleContentKind[] | undefined;
  bundleId?: string | undefined;
  targetHarnesses?: string[] | undefined;
  keryxVersion: string;
  now?: (() => Date) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  homeDir?: string | undefined;
}

export interface ExportSkipped {
  path: string;
  reason: string;
}

export interface ExportResult {
  manifest: BundleManifest;
  outPath: string;
  entries: BundleContentEntry[];
  skipped: ExportSkipped[];
}

export type ExportOutcome = { ok: true; result: ExportResult } | { ok: false; refusals: BundleRefusal[] };

// --- glob matching (minimal: `*` within a segment, `**` across segments) ---

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] ?? "";
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i += 1;
      if (glob[i + 1] === "/") i += 1;
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

function matchesInclude(include: string[] | undefined, bundlePath: string): boolean {
  if (include === undefined || include.length === 0) return true;
  return include.some((glob) => globToRegExp(glob).test(bundlePath));
}

// --- identity / bundleId ---

function readGitRemoteOriginUrl(projectRoot: string): string | undefined {
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: projectRoot,
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString("utf8")
      .trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function normalizeRemoteIdentity(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^@/]+@)/, "$1");
  const scp = /^([^@\s]+)@([^:\s]+):(.+)$/.exec(s);
  if (scp) {
    const [, user, host, rest] = scp;
    s = `${user}@${(host as string).toLowerCase()}:${rest}`;
  } else {
    try {
      const u = new URL(s);
      u.username = "";
      u.password = "";
      u.hostname = u.hostname.toLowerCase();
      s = u.toString();
    } catch {
      // not a parseable URL (e.g. a local filesystem path) — leave as-is
    }
  }
  s = s.replace(/\.git\/?$/, "");
  s = s.replace(/\/$/, "");
  return s;
}

interface Identity {
  identity: string;
  hasRemote: boolean;
}

function resolveIdentity(projectRoot: string, scope: BundleScope): Identity {
  const remote = readGitRemoteOriginUrl(projectRoot);
  if (remote !== undefined) {
    return { identity: normalizeRemoteIdentity(remote), hasRemote: true };
  }
  return { identity: scope === "user" ? "user" : "local", hasRemote: false };
}

function defaultBundleId(scope: BundleScope, identity: string): string {
  const hash = sha256Hex(Buffer.from(identity, "utf8")).slice(0, 12);
  return `keryx-${scope}-${hash}`;
}

/**
 * The no-remote (and always-for-user) default bundleId (R1-F23): a digest of
 * the export's own sorted `"<path>\t<sha256>"` content list, so two exports
 * with different content never collide on id, and the same content always
 * reproduces the same id (this export is still deterministic).
 *
 * Class "ownership" (R1-F1/R2-F1): because this id is derived from CONTENT,
 * not from a stable per-source label, re-exporting the SAME logical bundle
 * after its content changes produces a DIFFERENT bundleId — which plan.ts's
 * ownership check (R1-F1) then reads as "a different bundle", requiring
 * `--force` to update files the previous export already owns. `--id` (the
 * `ExportOptions.bundleId` override, wired to `bundle export --id` in
 * src/commands/bundle.ts) is the intended way to keep one bundle's identity
 * stable across re-exports: pass the SAME `--id` every time you re-export
 * the same logical bundle, and ownership carries forward without a forced
 * takeover. This is documented behavior, not a gap — see docs/docs/cli-reference.md's
 * `## bundle` section.
 */
function contentDigestBundleId(scope: BundleScope, entries: readonly { path: string; sha256: string }[]): string {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const content = sorted.map((e) => `${e.path}\t${e.sha256}`).join("\n");
  const hash = sha256Hex(Buffer.from(content, "utf8")).slice(0, 12);
  return `keryx-${scope}-${hash}`;
}

// --- collectors ---

interface Candidate {
  bundlePath: string;
  kind: BundleContentKind;
  absolutePath: string;
}

async function walkFiles(dir: string, relPrefix: string, out: { path: string; abs: string }[], skipped: ExportSkipped[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    const rel = relPrefix.length > 0 ? `${relPrefix}/${entry.name}` : entry.name;
    const st = await lstat(abs);
    if (st.isSymbolicLink()) {
      skipped.push({ path: rel, reason: "symlink" });
      continue;
    }
    if (st.isDirectory()) {
      await walkFiles(abs, rel, out, skipped);
    } else if (st.isFile()) {
      out.push({ path: rel, abs });
    }
  }
}

async function collectSkills(root: string, scope: BundleScope, skipped: ExportSkipped[]): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const baseDirName of scope === "project" ? ["skills", "project-skills"] : ["skills"]) {
    const base = path.join(root, baseDirName);
    if (!existsSync(base)) continue;
    const files: { path: string; abs: string }[] = [];
    await walkFiles(base, baseDirName, files, skipped);
    for (const f of files) candidates.push({ bundlePath: f.path, kind: "skill", absolutePath: f.abs });
  }
  return candidates;
}

async function collectRules(root: string, scope: BundleScope, skipped: ExportSkipped[]): Promise<Candidate[]> {
  if (scope === "user") return [];
  const base = path.join(root, "rules");
  if (!existsSync(base)) return [];
  const files: { path: string; abs: string }[] = [];
  await walkFiles(base, "rules", files, skipped);
  return files
    .filter((f) => /\.(md|mdc)$/.test(f.path))
    .map((f) => ({ bundlePath: f.path, kind: "rule" as const, absolutePath: f.abs }));
}

async function collectAgents(root: string, skipped: ExportSkipped[]): Promise<Candidate[]> {
  const base = path.join(root, "agents");
  if (!existsSync(base)) return [];
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates: Candidate[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(base, entry.name);
    const st = await lstat(abs);
    if (st.isSymbolicLink()) {
      skipped.push({ path: `agents/${entry.name}`, reason: "symlink" });
      continue;
    }
    if (st.isFile() && entry.name.endsWith(".md")) {
      candidates.push({ bundlePath: `agents/${entry.name}`, kind: "agent", absolutePath: abs });
    }
  }
  return candidates;
}

async function collectMemory(root: string, skipped: ExportSkipped[]): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const { folder } of MEMORY_TYPES) {
    const base = path.join(root, "memory", folder);
    if (!existsSync(base)) continue;
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(base, entry.name);
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        skipped.push({ path: `memory/${folder}/${entry.name}`, reason: "symlink" });
        continue;
      }
      if (st.isFile() && entry.name.endsWith(".md")) {
        candidates.push({ bundlePath: `memory/${folder}/${entry.name}`, kind: "memory-entry", absolutePath: abs });
      }
    }
  }
  return candidates;
}

async function collectHookConfig(root: string): Promise<Candidate[]> {
  const abs = path.join(root, "hooks.json");
  if (!existsSync(abs)) return [];
  const st = await lstat(abs);
  if (st.isSymbolicLink() || !st.isFile()) return [];
  return [{ bundlePath: "hooks.json", kind: "hook-config", absolutePath: abs }];
}

async function collectLearnedPatterns(root: string, scope: BundleScope): Promise<Candidate[]> {
  const relDir = scope === "user" ? "learning/patterns" : "data/learning/candidates";
  const base = path.join(root, ...relDir.split("/"));
  if (!existsSync(base)) return [];
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates: Candidate[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      candidates.push({ bundlePath: `${relDir}/${entry.name}`, kind: "learned-pattern", absolutePath: path.join(base, entry.name) });
    }
  }
  return candidates;
}

/**
 * Rewrite only the frontmatter `origin:` key of an agent `.md` file's text to
 * `{ kind: imported, sourceRef }`, preserving every other byte verbatim
 * (adds the key if absent). The caller must have already confirmed the
 * source parses with `parseAgentFrontmatter`.
 */
export function rewriteAgentOrigin(content: string, sourceRef: string): string {
  const end = content.indexOf("\n---", 3);
  if (!content.startsWith("---") || end === -1) return content;
  const frontmatterRaw = content.slice(3, end);
  const rest = content.slice(end);
  const lines = frontmatterRaw.split("\n");
  const originLines = ["origin:", "  kind: imported", `  sourceRef: ${sourceRef}`];

  let originIdx = -1;
  let originEnd = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^origin:(\s*)$/.test(lines[i] ?? "")) {
      originIdx = i;
      let j = i + 1;
      while (j < lines.length && /^[ \t]+\S/.test(lines[j] ?? "")) j += 1;
      originEnd = j;
      break;
    }
  }

  const newLines =
    originIdx === -1
      ? [...lines, ...originLines]
      : [...lines.slice(0, originIdx), ...originLines, ...lines.slice(originEnd)];

  return `---${newLines.join("\n")}${rest}`;
}

async function outDirIsEmpty(out: string): Promise<boolean> {
  try {
    const entries = await readdir(out);
    return entries.length === 0;
  } catch {
    return true;
  }
}

async function writeDirectoryBundle(out: string, manifestBytes: Buffer, files: Map<string, Buffer>): Promise<void> {
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "bundle.json"), manifestBytes);
  for (const [rel, bytes] of files) {
    const abs = path.join(out, ...rel.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
  }
}

export async function exportBundle(opts: ExportOptions): Promise<ExportOutcome> {
  const ctx: PathCtx = { projectRoot: opts.projectRoot, env: opts.env, homeDir: opts.homeDir };
  const root = scopeRoot(opts.scope, ctx);
  const now = opts.now ?? (() => new Date());
  const kindsWanted = new Set(opts.kinds ?? ([...(["skill", "rule", "agent", "learned-pattern", "memory-entry", "hook-config"] as BundleContentKind[])]));

  const skipped: ExportSkipped[] = [];
  const allCandidates: Candidate[] = [];
  if (kindsWanted.has("skill")) allCandidates.push(...(await collectSkills(root, opts.scope, skipped)));
  if (kindsWanted.has("rule")) allCandidates.push(...(await collectRules(root, opts.scope, skipped)));
  if (kindsWanted.has("agent")) allCandidates.push(...(await collectAgents(root, skipped)));
  if (kindsWanted.has("memory-entry")) allCandidates.push(...(await collectMemory(root, skipped)));
  if (kindsWanted.has("hook-config")) allCandidates.push(...(await collectHookConfig(root)));
  if (kindsWanted.has("learned-pattern")) allCandidates.push(...(await collectLearnedPatterns(root, opts.scope)));

  const filtered = allCandidates.filter((c) => matchesInclude(opts.include, c.bundlePath)).sort((a, b) => a.bundlePath.localeCompare(b.bundlePath));

  // R1-F23: `resolveIdentity`'s remote-based identity is scoped to project/
  // team content — a user-scope export is not "this project's" content, so
  // its identity/bundleId must never be derived from whatever directory it
  // happens to run in (its git remote is unrelated to the exported bytes).
  // And when there IS no remote (or the scope is user), every export from
  // an unrelated source previously hashed to the SAME constant id
  // (`keryx-<scope>-local`/`keryx-<scope>-user`), which — combined with
  // R1-F1 — let one bundle's uninstall delete another's files. The no-remote
  // (and always-for-user) default is instead a digest of the export's own
  // content list, unique per actual content rather than per fixed label.
  // Computed from the RAW (pre-agent-origin-rewrite) bytes, so it does not
  // depend on the bundleId it is itself producing.
  const identity = opts.scope === "user" ? undefined : resolveIdentity(opts.projectRoot, opts.scope);
  let bundleId = opts.bundleId;
  if (bundleId === undefined) {
    if (identity !== undefined && identity.hasRemote) {
      bundleId = defaultBundleId(opts.scope, identity.identity);
    } else {
      const rawDigestEntries: { path: string; sha256: string }[] = [];
      for (const candidate of filtered) {
        const bytes = await readFile(candidate.absolutePath);
        rawDigestEntries.push({ path: candidate.bundlePath, sha256: sha256Hex(bytes) });
      }
      bundleId = contentDigestBundleId(opts.scope, rawDigestEntries);
    }
  }

  const refusals: BundleRefusal[] = [];
  const files = new Map<string, Buffer>();
  const entries: BundleContentEntry[] = [];

  for (const candidate of filtered) {
    // R2-F1/R2-F21 (class "path identity"): a source file/directory NAME on
    // disk is not restricted to portable ASCII the way a bundle path is — a
    // skill directory named with a non-ASCII character, or one that only
    // differs from a sibling by case, would otherwise export successfully
    // and then fail on every `bundle import` of the resulting bundle.
    //
    // R3-F21: this used to be a hard REFUSAL that aborted the WHOLE export —
    // one file named `rules/Code Style.md` (a space is not in the portable
    // set) meant nobody could export ANY content at all. A single
    // non-portable name is instead skipped, with a named reason, into the
    // same `skipped[]` the symlink-skip path above already reports through;
    // every OTHER, portable entry still exports normally.
    const portable = normalizeBundlePath(candidate.bundlePath);
    if (!portable.ok) {
      skipped.push({ path: candidate.bundlePath, reason: `non-portable-name: ${portable.refusal.message}` });
      continue;
    }

    let bytes = await readFile(candidate.absolutePath);

    if (candidate.kind === "hook-config") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        refusals.push({ reason: BUNDLE_REFUSAL.contentInvalid, path: candidate.bundlePath, message: "hooks.json is not valid JSON" });
        continue;
      }
      const validation = validateAgainstSchemaObject(hookConfigSchemaJson as Record<string, unknown>, parsed);
      if (!validation.valid) {
        refusals.push({ reason: BUNDLE_REFUSAL.contentInvalid, path: candidate.bundlePath, message: `hooks.json fails hook-config schema: ${validation.errors[0]?.message ?? "invalid"}` });
        continue;
      }
    }

    if (candidate.kind === "learned-pattern") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        refusals.push({ reason: BUNDLE_REFUSAL.contentInvalid, path: candidate.bundlePath, message: `${candidate.bundlePath} is not valid JSON` });
        continue;
      }
      const validation = validateAgainstSchemaObject(learnedPatternSchemaJson as Record<string, unknown>, parsed);
      if (!validation.valid) {
        refusals.push({ reason: BUNDLE_REFUSAL.contentInvalid, path: candidate.bundlePath, message: `${candidate.bundlePath} fails learned-pattern schema: ${validation.errors[0]?.message ?? "invalid"}` });
        continue;
      }
    }

    if (candidate.kind === "agent") {
      const text = bytes.toString("utf8");
      const parsed = parseAgentFrontmatter(text);
      if (!parsed.ok) {
        refusals.push({ reason: BUNDLE_REFUSAL.contentInvalid, path: candidate.bundlePath, message: `${candidate.bundlePath}: ${parsed.error.message}` });
        continue;
      }
      const rewritten = rewriteAgentOrigin(text, bundleId);
      const reparsed = parseAgentFrontmatter(rewritten);
      if (!reparsed.ok) {
        refusals.push({ reason: BUNDLE_REFUSAL.contentInvalid, path: candidate.bundlePath, message: `${candidate.bundlePath}: origin rewrite produced unparseable frontmatter` });
        continue;
      }
      bytes = Buffer.from(rewritten, "utf8");
    }

    files.set(candidate.bundlePath, bytes);
    entries.push({
      path: candidate.bundlePath,
      kind: candidate.kind,
      scope: opts.scope,
      sha256: sha256Hex(bytes),
      sizeBytes: bytes.length,
    });
  }

  if (refusals.length > 0) {
    return { ok: false, refusals };
  }

  // R2-F18: zero matching entries produced a manifest that violates the
  // schema's `contents` `minItems: 1` — `ok: true, entries: 0` looked like
  // success, but the artifact could never be imported. Refuse before
  // writing anything.
  if (entries.length === 0) {
    return {
      ok: false,
      refusals: [{ reason: BUNDLE_REFUSAL.emptyBundle, message: "export matched no content entries; refusing to write a bundle with an empty contents[]" }],
    };
  }

  const manifest: BundleManifest = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    bundleId,
    createdAt: now().toISOString(),
    sourceKeryxVersion: opts.keryxVersion,
    provenance: {
      producedBy: "keryx bundle export",
      // sourceProject is never set for a user-scope export: `identity` is
      // `undefined` for scope "user" precisely so this can never leak
      // whatever project directory the export happened to run from (R1-F23).
      ...(identity !== undefined && identity.hasRemote ? { sourceProject: `sha256:${sha256Hex(Buffer.from(identity.identity, "utf8"))}` } : {}),
      sourceScope: opts.scope,
    },
    compat: {
      minKeryxVersion: opts.keryxVersion,
      targetHarnesses: opts.targetHarnesses ?? [],
    },
    contents: entries,
  };

  const manifestBytes = Buffer.from(serializeManifest(manifest), "utf8");

  const isArchive = opts.out.endsWith(".tar.gz") || opts.out.endsWith(".tgz");
  if (isArchive) {
    if (existsSync(opts.out)) {
      return { ok: false, refusals: [{ reason: BUNDLE_REFUSAL.notABundle, message: `${opts.out} already exists` }] };
    }
    const archive = buildBundleArchive(files, manifestBytes);
    if (!archive.ok) return { ok: false, refusals: [archive.refusal] };
    await mkdir(path.dirname(opts.out), { recursive: true });
    await writeFile(opts.out, archive.value);
  } else {
    if (existsSync(opts.out) && !(await outDirIsEmpty(opts.out))) {
      return { ok: false, refusals: [{ reason: BUNDLE_REFUSAL.notABundle, message: `${opts.out} already exists and is not empty` }] };
    }
    await writeDirectoryBundle(opts.out, manifestBytes, files);
  }

  return { ok: true, result: { manifest, outPath: opts.out, entries, skipped } };
}
