// LWG-11 deterministic refresh, marker migration, and provenance stamping
// (flow 227, phase 2).
//
// NOTHING HERE CALLS A MODEL. That is the point of the phase: the machine half
// of a page is repaired mechanically, and prose — the half that needs
// judgement — is left for phase 3 and for people. AC2 pins it with a provider
// that throws on any call.
//
// The Reference content comes from `collectGraphWikiCandidates`
// (`./service`), the same function `wiki collect` uses. Not an extracted copy
// of its renderer and not a second implementation: one renderer means a change
// to the Reference format reaches `refresh` automatically rather than drifting
// away from it. That is the fourth time in this package that reusing an
// existing read was the right call, after `validModuleNames`,
// `wikiPruneOrphans` and `computePageNodeHash`.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadGraph } from "../gdgraph/query";
import { collectPages, computeModuleKeyFiles } from "./collect";
import { resolveDescribeSet } from "./describes";
import {
  findManagedBlock,
  replaceManagedBlock,
  wrapReferenceSection,
} from "./managed-block";
import { computeVerifiedScope, writeProvenance } from "./provenance";
import { collectGraphWikiCandidates } from "./service";
import type { WikiPage } from "./types";

const DEFAULT_LIMIT = 400;

export type RefreshAction =
  | "refreshed"
  | "unchanged"
  | "conflict"
  | "no-block"
  | "no-source";

export interface RefreshPageResult {
  path: string;
  action: RefreshAction;
  /** Set when `action` is `conflict`. */
  reason?: string;
  /** Version after the refresh, when one happened. */
  version?: string;
}

export interface RefreshResult {
  pages: RefreshPageResult[];
  refreshed: number;
  unchanged: number;
  conflicts: number;
}

export interface MigrateResult {
  migrated: string[];
  /** Pages with no Reference section — left alone, not given one. */
  skippedNoSection: string[];
  /** Pages already carrying markers. */
  alreadyMigrated: string[];
  /** Pages whose markers or headings are damaged; reported, never rewritten. */
  malformed: Array<{ path: string; reason: string }>;
}

function wikiRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "wiki");
}

/** Lift the `## Reference` section out of a freshly generated page. */
function referenceSectionOf(generated: string): string | null {
  const lines = generated.split("\n");
  const start = lines.findIndex((line) => /^##\s+Reference\b/i.test(line.trim()));
  if (start < 0) {
    return null;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,2}\s/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").replace(/\s+$/, "");
}

/**
 * Add markers to an existing corpus. Idempotent, and never authors content:
 * a page without a Reference section is skipped rather than given one, and a
 * damaged page is reported rather than repaired by guesswork.
 */
export async function migrateMarkers(
  cwd: string,
  options: { dryRun?: boolean } = {},
): Promise<MigrateResult> {
  const result: MigrateResult = {
    migrated: [],
    skippedNoSection: [],
    alreadyMigrated: [],
    malformed: [],
  };

  for (const page of await collectPages(cwd)) {
    const content = await readFile(page.absolutePath, "utf8");
    const state = findManagedBlock(content);

    if (state.kind === "present") {
      result.alreadyMigrated.push(page.relativePath);
      continue;
    }
    if (state.kind === "no-reference-section") {
      result.skippedNoSection.push(page.relativePath);
      continue;
    }
    if (state.kind === "malformed") {
      result.malformed.push({ path: page.relativePath, reason: state.reason });
      continue;
    }

    const wrapped = wrapReferenceSection(content);
    if (wrapped === null) {
      result.skippedNoSection.push(page.relativePath);
      continue;
    }
    if (!options.dryRun) {
      await writeFile(page.absolutePath, wrapped, "utf8");
    }
    result.migrated.push(page.relativePath);
  }

  return result;
}

/** patch-only bump; a mechanical Reference refresh is never minor or major. */
export function bumpPatch(version: string | null): string {
  const match = (version ?? "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return "0.1.1";
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function appendChangelogLine(content: string, line: string): string {
  const lines = content.split("\n");
  const heading = lines.findIndex((entry) => /^##\s+Changelog\s*$/i.test(entry.trim()));
  if (heading < 0) {
    return `${content.replace(/\s+$/, "")}\n\n## Changelog\n\n${line}\n`;
  }
  let insert = heading + 1;
  while (insert < lines.length && (lines[insert] ?? "").trim().length === 0) {
    insert += 1;
  }
  lines.splice(insert, 0, line);
  return lines.join("\n");
}

export interface RefreshInput {
  cwd: string;
  /** Wiki-relative page path; omit to refresh every page carrying a block. */
  page?: string | undefined;
  /** Overwrite a hand-edited block. */
  force?: boolean | undefined;
  dryRun?: boolean | undefined;
  /** Revision to stamp as `VerifiedAt`; omitted when git is unavailable. */
  head?: string | undefined;
  now?: () => Date;
}

export async function refreshPages(input: RefreshInput): Promise<RefreshResult> {
  const cwd = input.cwd;
  const generatedAt = (input.now ?? (() => new Date()))().toISOString();
  const graph = await loadGraph(cwd);
  const keyFilesIndex = computeModuleKeyFiles(graph);
  const knownPaths = new Set(
    graph.nodes.filter((node) => node.kind === "file").map((node) => node.path),
  );

  const candidates = await collectGraphWikiCandidates(cwd, generatedAt, DEFAULT_LIMIT, null);
  const referenceBySlug = new Map<string, string>();
  for (const candidate of candidates) {
    const section = referenceSectionOf(candidate.content);
    if (section !== null) {
      referenceBySlug.set(candidate.slug, section);
    }
  }

  const pages = (await collectPages(cwd)).filter(
    (page) => input.page === undefined || page.relativePath === input.page,
  );

  const result: RefreshResult = { pages: [], refreshed: 0, unchanged: 0, conflicts: 0 };

  for (const page of pages) {
    const outcome = await refreshOne({
      page,
      cwd,
      graph,
      knownPaths,
      keyFilesIndex,
      referenceBySlug,
      force: input.force === true,
      dryRun: input.dryRun === true,
      head: input.head,
      generatedAt,
    });
    result.pages.push(outcome);
    if (outcome.action === "refreshed") result.refreshed += 1;
    else if (outcome.action === "unchanged") result.unchanged += 1;
    else if (outcome.action === "conflict") result.conflicts += 1;
  }

  return result;
}

async function refreshOne(input: {
  page: WikiPage;
  cwd: string;
  graph: Awaited<ReturnType<typeof loadGraph>>;
  knownPaths: Set<string>;
  keyFilesIndex: ReadonlyMap<string, string[]>;
  referenceBySlug: ReadonlyMap<string, string>;
  force: boolean;
  dryRun: boolean;
  head: string | undefined;
  generatedAt: string;
}): Promise<RefreshPageResult> {
  const { page } = input;
  const content = await readFile(page.absolutePath, "utf8");
  const state = findManagedBlock(content);

  if (state.kind !== "present") {
    return {
      path: page.relativePath,
      action: state.kind === "malformed" ? "conflict" : "no-block",
      ...(state.kind === "malformed" ? { reason: state.reason } : {}),
    };
  }
  if (state.block.handEdited && !input.force) {
    // Refused, not overwritten. See managed-block.ts: a human who edited
    // inside the machine region probably meant to.
    return {
      path: page.relativePath,
      action: "conflict",
      reason: "the managed block was edited by hand; pass --force to overwrite it",
    };
  }

  const slug = page.relativePath.replace(/^.*\//, "").replace(/\.md$/, "");
  const replacement = input.referenceBySlug.get(slug);
  if (replacement === undefined) {
    // The graph no longer produces this page. Saying so is more useful than
    // silently leaving a stale block that looks maintained.
    return { path: page.relativePath, action: "no-source" };
  }

  if (state.block.content.trim() === replacement.trim()) {
    // AC9: an already-current page is not rewritten at all — no version bump,
    // no changelog line, no provenance stamp. Stamping here would assert a
    // verification that never happened.
    return { path: page.relativePath, action: "unchanged" };
  }

  let next = replaceManagedBlock(content, replacement);
  if (next === null) {
    return { path: page.relativePath, action: "conflict", reason: "block replacement failed" };
  }

  const version = bumpPatch(page.version);
  next = next.replace(/^Version:\s*.+$/m, `Version: ${version}`);

  const describeSet = resolveDescribeSet({
    page: { relativePath: page.relativePath },
    content: next,
    knownPaths: input.knownPaths,
    keyFilesIndex: input.keyFilesIndex,
  });
  const scope = await computeVerifiedScope(input.cwd, describeSet.paths, input.graph);
  next = writeProvenance(next, {
    ...(input.head ? { verifiedAt: input.head } : {}),
    verifiedScope: scope,
  });

  const stamp = input.head ? ` (${input.head.slice(0, 8)})` : "";
  next = appendChangelogLine(next, `- ${version} - Reference refreshed from the code graph${stamp}.`);

  if (!input.dryRun) {
    await writeFile(page.absolutePath, next, "utf8");
  }
  return { path: page.relativePath, action: "refreshed", version };
}

/**
 * Stamp provenance without touching content (LWG-4's writing half).
 *
 * This is what "a human looked and confirmed" means, and it is what turns the
 * phase-1 report from all-`unknown` into a real backlog. It deliberately does
 * NOT regenerate anything: verification and repair are different claims.
 */
export async function verifyPages(input: {
  cwd: string;
  page?: string | undefined;
  head?: string | undefined;
}): Promise<Array<{ path: string; verifiedAt: string | null; verifiedScope: string }>> {
  const graph = await loadGraph(input.cwd);
  const keyFilesIndex = computeModuleKeyFiles(graph);
  const knownPaths = new Set(
    graph.nodes.filter((node) => node.kind === "file").map((node) => node.path),
  );

  const stamped: Array<{ path: string; verifiedAt: string | null; verifiedScope: string }> = [];
  for (const page of await collectPages(input.cwd)) {
    if (input.page !== undefined && page.relativePath !== input.page) {
      continue;
    }
    const content = await readFile(page.absolutePath, "utf8");
    const describeSet = resolveDescribeSet({
      page: { relativePath: page.relativePath },
      content,
      knownPaths,
      keyFilesIndex,
    });
    if (describeSet.paths.length === 0) {
      // Nothing to verify against; stamping would be an empty claim.
      continue;
    }
    const scope = await computeVerifiedScope(input.cwd, describeSet.paths, graph);
    const next = writeProvenance(content, {
      ...(input.head ? { verifiedAt: input.head } : {}),
      verifiedScope: scope,
    });
    if (next !== content) {
      await writeFile(page.absolutePath, next, "utf8");
    }
    stamped.push({ path: page.relativePath, verifiedAt: input.head ?? null, verifiedScope: scope });
  }
  return stamped;
}

export { wikiRoot };
