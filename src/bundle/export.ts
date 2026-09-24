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
import { scopeRoot, type PathCtx } from "./paths";
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

  const identity = resolveIdentity(opts.projectRoot, opts.scope);
  const bundleId = opts.bundleId ?? defaultBundleId(opts.scope, identity.identity);

  const refusals: BundleRefusal[] = [];
  const files = new Map<string, Buffer>();
  const entries: BundleContentEntry[] = [];

  for (const candidate of filtered) {
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

  const manifest: BundleManifest = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    bundleId,
    createdAt: now().toISOString(),
    sourceKeryxVersion: opts.keryxVersion,
    provenance: {
      producedBy: "keryx bundle export",
      ...(identity.hasRemote ? { sourceProject: `sha256:${sha256Hex(Buffer.from(identity.identity, "utf8"))}` } : {}),
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
