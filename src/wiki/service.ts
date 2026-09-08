import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { guardOutput, prepareOutputForPersistence } from "../security/guard";
import { wikiAsk } from "./ask";
import { backlinksFor, buildBacklinkIndex } from "./backlinks";
import { collectPages } from "./collect";
import {
  assembleEvidencePackage,
  type EvidencePackage,
  type EvidenceScope,
  type EvidenceSeed,
} from "./evidence";
import { buildSectionIndex } from "./section-index";
import { readSectionRegistryState } from "./section-tombstone";
import { HEAD_NOT_REQUESTED, resolveWikiSourceGate } from "./staleness";
import {
  WIKI_INDEX_BEGIN,
  WIKI_INDEX_END,
  renderWikiIndexScaffold,
  renderWikiPage,
} from "./templates";
import {
  WIKI_PAGE_TYPES,
  WIKI_PAGE_TYPE_VALUES,
  type GdWikiService,
  type WikiCollectInput,
  type WikiCollectedPage,
  type WikiCollectResult,
  type WikiBrokenLink,
  type WikiCheckLinksResult,
  type WikiCreatePageInput,
  type WikiCreatePageResult,
  type WikiIndexResult,
  type WikiLinkCheckState,
  type WikiPage,
  type WikiPageType,
  type WikiStatusResult,
  type WikiValidateIssue,
  type WikiValidateResult,
} from "./types";

const EXTERNAL_LINK = /^(https?:|mailto:|tel:)/i;
// The wiki scaffold is graph-driven: by default it covers EVERY module the graph
// knows (a page per `src/<dir>` with at least MIN_MODULE_FILES files), not an
// arbitrary top-N. A high default cap is a safety ceiling; `--limit` narrows it.
// Threshold skips 1-file stray top-level files that aren't real modules.
const DEFAULT_COLLECT_LIMIT = 500;
const MIN_MODULE_FILES = 2;

function wikiRootPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "wiki");
}

function dataRootPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "gdwiki");
}

function linkCheckReportPath(cwd: string): string {
  return path.join(dataRootPath(cwd), "link-check", "latest.md");
}

export async function wikiStatus(cwd: string): Promise<WikiStatusResult> {
  const root = wikiRootPath(cwd);
  const enabled = await pathExists(root);
  const pages = enabled ? await collectPages(cwd) : [];

  return {
    enabled,
    wikiRoot: path.relative(cwd, root),
    totalPages: pages.length,
    countsByType: WIKI_PAGE_TYPES.map(({ type }) => ({
      type,
      count: pages.filter((page) => page.pageType === type).length,
    })),
    lastIndexGeneratedAt: await readIndexGeneratedAt(cwd),
    lastLinkCheck: await readLinkCheckState(cwd),
  };
}

export async function wikiCreatePage(
  input: WikiCreatePageInput,
): Promise<WikiCreatePageResult> {
  const typeConfig = WIKI_PAGE_TYPES.find((entry) => entry.type === input.type);
  if (!typeConfig) {
    throw new Error(
      `Unsupported page type: ${input.type}. Supported types: ${WIKI_PAGE_TYPE_VALUES.join(", ")}`,
    );
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(input.slug)) {
    throw new Error(
      `Invalid slug: ${input.slug}. Use lowercase letters, digits, and hyphens.`,
    );
  }

  const dir = path.join(wikiRootPath(input.cwd), typeConfig.folder);
  const filePath = path.join(dir, `${input.slug}.md`);
  const relativePath = path.relative(input.cwd, filePath);

  if ((await pathExists(filePath)) && !input.force) {
    throw new Error(
      `Page already exists: ${relativePath}. Use --force to overwrite.`,
    );
  }

  await mkdir(dir, { recursive: true });
  const title = input.title ?? slugToTitle(input.slug);
  await writeFile(
    filePath,
    renderWikiPage({ title, type: typeConfig.type }),
    "utf8",
  );

  return { path: relativePath, type: typeConfig.type, created: true };
}

export async function wikiGenerateIndex(cwd: string): Promise<WikiIndexResult> {
  const root = wikiRootPath(cwd);
  const indexPath = path.join(root, "index.md");
  const pages = await collectPages(cwd);
  const generatedAt = new Date().toISOString();
  const managedBlock = `${WIKI_INDEX_BEGIN}\n${renderIndexBody(pages, generatedAt)}\n${WIKI_INDEX_END}`;

  const existing = (await pathExists(indexPath))
    ? await readFile(indexPath, "utf8")
    : renderWikiIndexScaffold();
  const pattern = new RegExp(
    `${escapeRegExp(WIKI_INDEX_BEGIN)}[\\s\\S]*?${escapeRegExp(WIKI_INDEX_END)}`,
  );
  const replaced = pattern.test(existing)
    ? existing.replace(pattern, managedBlock)
    : `${existing.trimEnd()}\n\n${managedBlock}\n`;
  const next = replaced.endsWith("\n") ? replaced : `${replaced}\n`;

  await mkdir(root, { recursive: true });
  await writeFile(indexPath, next, "utf8");

  return {
    path: path.relative(cwd, indexPath),
    pageCount: pages.length,
    generatedAt,
  };
}

export async function wikiCheckLinks(
  cwd: string,
): Promise<WikiCheckLinksResult> {
  const root = wikiRootPath(cwd);
  const allFiles = (await pathExists(root)) ? await walkMarkdown(root) : [];
  // Skip the scaffold under `templates/`: it ships intentional placeholder links.
  const files = allFiles.filter(
    (absolutePath) =>
      !path.relative(root, absolutePath).startsWith(`templates${path.sep}`),
  );
  const broken: WikiBrokenLink[] = [];
  let checkedLinks = 0;
  let skippedExternal = 0;

  for (const absolutePath of files) {
    const content = await readFile(absolutePath, "utf8");
    const pageRelative = path.relative(cwd, absolutePath);

    for (const target of extractLinkTargets(content)) {
      if (EXTERNAL_LINK.test(target)) {
        skippedExternal += 1;
        continue;
      }

      const filePart = target.split("#")[0] ?? "";
      if (filePart.length === 0) {
        // Pure in-page anchor, nothing to resolve on disk.
        continue;
      }

      checkedLinks += 1;
      const resolved = path.resolve(path.dirname(absolutePath), filePart);
      if (!(await pathExists(resolved))) {
        broken.push({
          page: pageRelative,
          target,
          reason: "target not found",
        });
      }
    }
  }

  const generatedAt = new Date().toISOString();
  const reportPath = linkCheckReportPath(cwd);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    renderLinkCheckReport({
      generatedAt,
      checkedPages: files.length,
      checkedLinks,
      skippedExternal,
      broken,
    }),
    "utf8",
  );

  return {
    reportPath: path.relative(cwd, reportPath),
    checkedPages: files.length,
    checkedLinks,
    skippedExternal,
    broken,
  };
}

export async function wikiValidate(cwd: string): Promise<WikiValidateResult> {
  const issues: WikiValidateIssue[] = [];
  const pages = await collectPages(cwd);

  for (const page of pages) {
    if (!page.version) {
      issues.push({
        page: page.relativePath,
        kind: "version",
        message: "missing Version field",
      });
    }
    if (!page.type) {
      issues.push({
        page: page.relativePath,
        kind: "metadata",
        message: "missing Type field",
      });
    } else if (page.type !== page.pageType) {
      issues.push({
        page: page.relativePath,
        kind: "metadata",
        message: `Type "${page.type}" does not match folder type "${page.pageType}"`,
      });
    }
    if (!page.status) {
      issues.push({
        page: page.relativePath,
        kind: "metadata",
        message: "missing Status field",
      });
    }
  }

  // LWG-14 (flow 227): structural rules the managed block makes checkable.
  // Deterministic only — no model is consulted here, and `--deep` prose
  // checking is deliberately not part of `validate`, so this stays safe to
  // run in CI.
  await validateStructure(cwd, pages, issues);

  const linkCheck = await wikiCheckLinks(cwd);
  for (const broken of linkCheck.broken) {
    issues.push({
      page: broken.page,
      kind: "link",
      message: `broken link -> ${broken.target}`,
    });
  }

  if (await isIndexStale(cwd, pages)) {
    issues.push({
      page: path.join(path.relative(cwd, wikiRootPath(cwd)), "index.md"),
      kind: "index",
      message: "index out of date, run `keryx wiki index`",
    });
  }

  return { ok: issues.length === 0, issues };
}

export async function wikiCollect(input: WikiCollectInput): Promise<WikiCollectResult> {
  const generatedAt = new Date().toISOString();
  const limit = input.limit && input.limit > 0 ? input.limit : DEFAULT_COLLECT_LIMIT;
  const pages: WikiCollectedPage[] = [];

  // --changed: only regenerate pages for modules touched since <since> (default
  // HEAD), and treat those pages as force-refreshable. Deterministic, no model -
  // ideal for a post-commit hook. Prose stays owned by the enrich skill.
  const onlyModules = input.changed === true ? await changedModules(input.cwd, input.since) : null;
  const force = input.force === true || input.changed === true;
  const candidates = input.changed === true
    ? await collectGraphWikiCandidates(input.cwd, generatedAt, limit, onlyModules)
    : [
        ...(await collectGraphWikiCandidates(input.cwd, generatedAt, limit, null)),
        ...(await collectHealthWikiCandidates(input.cwd, generatedAt)),
        ...(await collectTestingWikiCandidates(input.cwd, generatedAt)),
      ];

  for (const candidate of candidates) {
    pages.push(await writeCollectedPage(input.cwd, candidate, force));
  }

  const index = await wikiGenerateIndex(input.cwd);
  // AFC-08 (flow 236 T8): `recordProvenance` stamps the CURRENT commit as the
  // revision gdwiki was synced at. Run over a graph built six commits ago that
  // is the same forged freshness `wiki refresh` was stamping onto pages: `keryx
  // sync` would then report gdwiki as current when its content came from an
  // older source. When the source is not demonstrably fresh the record is
  // skipped, so the previous (older, or absent) provenance stands and sync
  // under-claims instead of over-claiming — the failure direction that leads
  // someone to rebuild rather than to trust.
  // `HEAD_NOT_REQUESTED`, said explicitly: this path reads the graph's age to
  // decide whether to record gdwiki provenance and never writes `VerifiedAt`
  // on a page, so it has no revision at stake either way (AFC-22, T13).
  const sourceGate = await resolveWikiSourceGate(input.cwd, HEAD_NOT_REQUESTED);
  if (sourceGate.status === "fresh") {
    const { recordProvenance } = await import("../sync/provenance");
    await recordProvenance(input.cwd, "gdwiki", generatedAt);
  }
  return {
    generatedAt,
    created: pages.filter((page) => page.action === "created").length,
    updated: pages.filter((page) => page.action === "updated").length,
    skipped: pages.filter((page) => page.action === "skipped").length,
    pages,
    index,
  };
}

export interface WikiPruneResult {
  // Orphan pages (module no longer in the graph) that were unmodified generated
  // drafts and got deleted.
  pruned: string[];
  // Orphan pages a human had accepted/edited — NOT deleted (their prose is
  // theirs to keep or remove); reported so the caller can decide.
  orphanedAccepted: string[];
}

// Remove wiki component pages whose module no longer exists in the current
// graph. Conservative: only auto-deletes unmodified generated drafts; accepted
// or hand-edited orphans are reported, never silently destroyed. Run AFTER the
// graph is rebuilt so the "valid modules" set is current.
export async function wikiPruneOrphans(cwd: string): Promise<WikiPruneResult> {
  const componentsDir = path.join(wikiRootPath(cwd), "components");
  if (!(await pathExists(componentsDir))) {
    return { pruned: [], orphanedAccepted: [] };
  }
  const at = new Date().toISOString();
  const candidates = await collectGraphWikiCandidates(cwd, at, DEFAULT_COLLECT_LIMIT, null);
  const validSlugs = new Set(
    candidates.filter((candidate) => candidate.type === "component").map((candidate) => candidate.slug),
  );

  const pruned: string[] = [];
  const orphanedAccepted: string[] = [];
  for (const entry of await readdir(componentsDir)) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const slug = entry.slice(0, -3);
    if (validSlugs.has(slug)) {
      continue;
    }
    const filePath = path.join(componentsDir, entry);
    const current = await readFile(filePath, "utf8");
    const isUnmodifiedDraft =
      /\nStatus:\s*draft\s*\n/.test(current) && current.includes("Generated by `keryx wiki collect`");
    if (isUnmodifiedDraft) {
      await rm(filePath);
      pruned.push(path.relative(cwd, filePath));
    } else {
      orphanedAccepted.push(path.relative(cwd, filePath));
    }
  }
  return { pruned, orphanedAccepted };
}

/**
 * RP-13 FR3+FR4 (flow 168, Phase 2): the SAME "valid modules" set
 * `wikiPruneOrphans` already derives from the current graph (`nodes.jsonl`,
 * grouped via `moduleNameFromProjectPath` exactly as `collectGraphWikiCandidates`
 * does for its own `moduleFiles` map) — extracted as its own, smaller,
 * additive read so a second consumer (the SAC lifecycle flag, `src/sac/
 * lifecycle-flag.ts`) never re-derives module grouping with a second,
 * possibly-drifting implementation, and never needs the edges/deps
 * computation `collectGraphWikiCandidates` also does for the wiki-collect
 * enrichment feature, which this consumer has no use for.
 *
 * `undefined` (not an empty `Set`) when the graph has not been built yet —
 * an empty set would make every scoped piece of content look orphaned,
 * which is the opposite of this package's report-only, conservative
 * posture. The caller must treat "graph unavailable" as "nothing to flag
 * yet," not as "everything is invalid."
 */
export async function validModuleNames(cwd: string): Promise<Set<string> | undefined> {
  const nodesPath = path.join(cwd, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl");
  if (!(await pathExists(nodesPath))) {
    return undefined;
  }
  const modules = new Set<string>();
  for (const node of parseJsonl(await readFile(nodesPath, "utf8"))) {
    if (node.kind === "asset") continue;
    const nodePath = String(node.path ?? node.id ?? "unknown");
    modules.add(moduleNameFromProjectPath(nodePath));
  }
  return modules;
}

// AFC-W04 (flow 235, phase 3, T12) — the evidence surface.
//
// `wikiAsk` stays the ONE retrieval implementation (wiki-specification.md §8:
// "перевести wiki search adapters на evidence envelope ... без второй
// retrieval реализации"). This function does not re-rank and does not
// re-search: it takes the citations that live path already produced, resolves
// each one's section identity, and renders the agreed
// `wiki-evidence.schema.json` envelope around it. The index it builds is the
// same in-memory projection `wikiCandidates` builds, from the same bytes.
//
// Nothing here writes. The section registry is read; `syncSectionRegistry` —
// the one write in the identity lane — is not called, because a search that
// mutates state is the AC4 defect this phase removed from `wikiAsk`.
export type WikiEvidenceInput = {
  cwd: string;
  question: string;
  k?: number | undefined;
  /** Whole-package token budget. The required set fits, or the call fails. */
  budgetTokens?: number | undefined;
  /** Maximum items in the package; the required set is never trimmed to it. */
  maxItems?: number | undefined;
  asOf?: string | undefined;
  scope?: Partial<EvidenceScope> | undefined;
  /**
   * sectionRef → snapshot version from a real freshness run. Only a supplied,
   * verified snapshot can make a section `fresh`; absent one, every section
   * reports `unknown` ("not verified"), which is the honest state.
   */
  verified?: Readonly<Record<string, string>> | undefined;
};

const DEFAULT_EVIDENCE_BUDGET_TOKENS = 4000;
const DEFAULT_EVIDENCE_MAX_ITEMS = 8;

export async function wikiEvidence(input: WikiEvidenceInput): Promise<EvidencePackage> {
  const ask = await wikiAsk({
    cwd: input.cwd,
    question: input.question,
    ...(input.k === undefined ? {} : { k: input.k }),
    ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
  });

  // A non-`ok` retrieval outcome is passed through with its own code, not
  // re-spelled and not upgraded into an empty envelope that reads like an
  // answer. `wikiAsk` already distinguishes no-match from
  // insufficient-evidence; a second vocabulary here would lose that.
  if (ask.status !== undefined && ask.status !== "ok") {
    return {
      status: ask.status,
      reason: ask.reason ?? "the wiki returned no usable evidence for this question.",
      items: [],
      refused: [],
      omittedOptional: [],
      partial: false,
      overflow: null,
      suggestion: "",
    };
  }

  const pages = await collectPages(input.cwd);
  const index = buildSectionIndex(
    await Promise.all(
      pages.map(async (page) => ({
        page,
        content: await readFile(page.absolutePath, "utf8").catch(() => ""),
      })),
    ),
  );
  const registry = await readSectionRegistryState(input.cwd);

  const pageStatus: Record<string, string | null> = {};
  for (const page of pages) {
    pageStatus[page.relativePath] = page.status;
  }

  const seeds: EvidenceSeed[] = [];
  const historicalRefs: string[] = [];
  const preOmitted: string[] = [];
  ask.citations.forEach((citation, rank) => {
    if (citation.sectionRef === undefined) {
      // A memory citation carries no wiki section identity, so it cannot be
      // rendered as wiki evidence. Named in the loss manifest rather than
      // dropped: an omission the caller cannot see is the same defect class.
      preOmitted.push(citation.path);
      return;
    }
    seeds.push({ sectionRef: citation.sectionRef, rank });
    if (citation.historical === true) {
      historicalRefs.push(citation.sectionRef);
    }
  });

  return assembleEvidencePackage({
    index,
    registry,
    scope: resolveEvidenceScope(input.cwd, input.scope),
    seeds,
    pageStatus,
    historicalRefs,
    ...(input.verified ? { verified: input.verified } : {}),
    maxItems: input.maxItems && input.maxItems > 0 ? input.maxItems : DEFAULT_EVIDENCE_MAX_ITEMS,
    maxTokens:
      input.budgetTokens && input.budgetTokens > 0
        ? input.budgetTokens
        : DEFAULT_EVIDENCE_BUDGET_TOKENS,
    preOmitted,
  });
}

/**
 * The envelope's `scope`, derived rather than invented.
 *
 * `checkoutId` is a digest of this checkout's absolute path: it identifies the
 * working copy an evidence item was read from, which is what a continuation
 * bound to a `sourceVersion` will later have to be compared against. A caller
 * that has richer identity (a workspace, a task) supplies it.
 */
function resolveEvidenceScope(
  cwd: string,
  override: Partial<EvidenceScope> | undefined,
): EvidenceScope {
  const absolute = path.resolve(cwd);
  return {
    projectId: override?.projectId ?? (path.basename(absolute) || "project"),
    checkoutId:
      override?.checkoutId ??
      `checkout:${createHash("sha256").update(absolute).digest("hex").slice(0, 16)}`,
    ...(override?.workspaceId ? { workspaceId: override.workspaceId } : {}),
    ...(override?.taskId ? { taskId: override.taskId } : {}),
  };
}

/**
 * The service object MCP's `wiki.ask` and the CLI build.
 *
 * Widened here rather than in `./types.ts` (another lane owns that file this
 * phase): `GdWikiEvidenceService` is a superset, so every existing consumer
 * typed as `GdWikiService` is unaffected.
 */
export type GdWikiEvidenceService = GdWikiService & {
  evidence(input: WikiEvidenceInput): Promise<EvidencePackage>;
};

/**
 * The one producer that mints wiki pages, described by everything it does.
 *
 * Each field is checked, because each one alone is trivial to reproduce by
 * hand and the combination is not something an author arrives at by accident.
 * All four come from `src/sac/wiki-owner-writer.ts`, which writes the page,
 * chooses the path, and stamps the provenance block.
 */
const WIKI_PAGE_PRODUCERS = [
  {
    source: "sac-proposal",
    pageType: "decision",
    /**
     * The path it mints into. `wiki-owner-writer.ts` builds
     * `decisions/sac-<proposalId>.md` and passes the id through untouched, and
     * the id's prefix depends on which call site created the proposal:
     * `proposal-<16 hex>` from the three interactive ones, `wrapup-<32 hex>`
     * from the automated wrap-up. The first version of this pattern hard-coded
     * `sac-proposal-`, so pages written by the automated path — the only fully
     * unattended producer, and the one whose output most needs the exemption —
     * were accused of failing a Decision template they never claimed. Seven
     * fabricated findings per page, on a validation gate.
     *
     * So the shape is the producer's naming convention rather than one call
     * site's prefix: a lowercase kind and a hex id. The exemption stays narrow
     * because the page type and the hash-identified evidence link are checked
     * alongside it.
     */
    path: /^decisions\/sac-[a-z]+-[0-9a-f]+\.md$/,
  },
] as const;

/** A `- Source: x` line under the page's provenance, if it has one. */
function declaredSource(content: string): string | null {
  const match = /^-[ \t]+Source:[ \t]*(.+?)[ \t]*$/m.exec(content);
  return match === null ? null : (match[1] as string).trim();
}

/**
 * Whether a producer wrote this page, by the whole shape of what it writes.
 *
 * Deliberately NOT a single self-declared line: an independent review forged
 * that one by appending three lines to a hand-written page. The evidence link
 * is required as well as the source name, because the producer always writes a
 * hash-identified link and a page claiming machine provenance without pointing
 * at any evidence is claiming something it cannot support.
 */
function isMachineAuthoredPage(pageType: string, relativePath: string, content: string): boolean {
  const source = declaredSource(content);
  if (source === null) {
    return false;
  }
  const normalised = relativePath.split(path.sep).join("/").replace(/^wiki\//, "");
  return WIKI_PAGE_PRODUCERS.some(
    (producer) =>
      producer.source === source &&
      producer.pageType === pageType &&
      producer.path.test(normalised) &&
      /^-[ \t]+Link:.*\bsha256\b/m.test(content),
  );
}

export function createGdWikiService(): GdWikiEvidenceService {
  return {
    status: (input) => wikiStatus(input.cwd),
    createPage: (input) => wikiCreatePage(input),
    generateIndex: (input) => wikiGenerateIndex(input.cwd),
    checkLinks: (input) => wikiCheckLinks(input.cwd),
    validate: (input) => wikiValidate(input.cwd),
    collect: (input) => wikiCollect(input),
    ask: (input) => wikiAsk(input),
    evidence: (input) => wikiEvidence(input),
  };
}

type WikiCollectCandidate = {
  type: WikiPageType;
  slug: string;
  title: string;
  source: WikiCollectedPage["source"];
  content: string;
};

/**
 * Exported for `wiki refresh` (LWG-11, flow 227), which regenerates a page's
 * managed Reference block. It calls THIS function and lifts the Reference
 * section out of the candidate it returns, rather than extracting or copying
 * the renderer above: one renderer means a change to the Reference format
 * reaches `refresh` automatically instead of drifting away from it. Same rule
 * that made `validModuleNames` a shared read.
 */
export async function collectGraphWikiCandidates(
  cwd: string,
  generatedAt: string,
  limit: number,
  onlyModules: Set<string> | null,
): Promise<WikiCollectCandidate[]> {
  const nodesPath = path.join(cwd, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl");
  const edgesPath = path.join(cwd, ".metaproject", "data", "gdgraph", "storage", "edges.jsonl");
  if (!(await pathExists(nodesPath)) || !(await pathExists(edgesPath))) {
    return [];
  }

  const fileToModule = new Map<string, string>();
  const moduleFiles = new Map<string, string[]>();
  let nodes = 0;
  let files = 0;
  let assets = 0;
  for (const node of parseJsonl(await readFile(nodesPath, "utf8"))) {
    nodes += 1;
    const nodePath = String(node.path ?? node.id ?? "unknown");
    if (node.kind === "asset") {
      assets += 1;
      continue;
    }
    files += 1;
    const moduleName = moduleNameFromProjectPath(nodePath);
    fileToModule.set(nodePath, moduleName);
    const list = moduleFiles.get(moduleName) ?? [];
    list.push(nodePath);
    moduleFiles.set(moduleName, list);
  }

  const fileIn = new Map<string, number>();
  const fileOut = new Map<string, number>();
  const moduleDeps = new Map<string, Map<string, number>>();
  const moduleDependents = new Map<string, Map<string, number>>();
  let edges = 0;
  let imports = 0;
  let unresolved = 0;
  for (const edge of parseJsonl(await readFile(edgesPath, "utf8"))) {
    edges += 1;
    const kind = String(edge.kind ?? "");
    if (kind === "unresolved") {
      unresolved += 1;
      continue;
    }
    if (kind === "imports") {
      imports += 1;
    }
    const from = String(edge.from ?? "");
    const to = String(edge.to ?? "");
    fileOut.set(from, (fileOut.get(from) ?? 0) + 1);
    fileIn.set(to, (fileIn.get(to) ?? 0) + 1);
    const fromModule = fileToModule.get(from) ?? moduleNameFromProjectPath(from);
    const toModule = fileToModule.get(to) ?? moduleNameFromProjectPath(to);
    if (fromModule && toModule && fromModule !== toModule) {
      bumpNestedCount(moduleDeps, fromModule, toModule);
      bumpNestedCount(moduleDependents, toModule, fromModule);
    }
  }

  const topModules = [...moduleFiles.entries()]
    .map(([name, list]) => ({ name, files: list.length, edges: sumCounts(moduleDeps.get(name)) }))
    .filter((module) => module.files >= MIN_MODULE_FILES)
    .sort((a, b) => b.files - a.files || b.edges - a.edges)
    .slice(0, limit)
    .filter((module) => onlyModules === null || onlyModules.has(module.name));

  const architecture: WikiCollectCandidate = {
    type: "architecture",
    slug: "project-map",
    title: "Project Map",
    source: "gdgraph",
    content: renderCollectedPage({
      title: "Project Map",
      type: "architecture",
      generatedAt,
      summary: "Deterministic map of " + files + " code files, " + assets + " assets, and "
        + edges + " import edges across " + moduleFiles.size + " top-level modules. "
        + "Enrich each module page with the gdwiki skill.",
      sections: [
        ["Graph snapshot", [
          "- Nodes: " + nodes,
          "- Code files: " + files,
          "- Assets: " + assets,
          "- Edges: " + edges,
          "- Imports: " + imports,
          "- Unresolved edges: " + unresolved,
        ]],
        ["Largest modules", topModules.length > 0
          ? topModules.map((item) => "- `" + item.name + "` - " + item.files + " files, " + item.edges + " cross-module imports")
          : ["- No module stats available."]],
        ["Module dependencies", topModules.length > 0
          ? topModules.map((item) => {
              const deps = topCounts(moduleDeps.get(item.name), 5);
              return "- `" + item.name + "` -> " + (deps.length > 0
                ? deps.map(([target]) => "`" + target + "`").join(", ")
                : "(no cross-module imports)");
            })
          : ["- No dependency edges available."]],
      ],
    }),
  };

  const moduleCandidates: WikiCollectCandidate[] = [];
  // Only these modules get a wiki page - link Related Wiki to them so slugs are
  // always valid (no guessed/broken links from the enrich step).
  const pageModules = new Set(topModules.map((entry) => entry.name));
  for (const item of topModules) {
    const moduleName = item.name;
    const moduleFileList = moduleFiles.get(moduleName) ?? [];
    const keyFiles = moduleFileList
      .map((file) => ({
        file,
        incoming: fileIn.get(file) ?? 0,
        outgoing: fileOut.get(file) ?? 0,
      }))
      .sort((a, b) => (b.incoming + b.outgoing) - (a.incoming + a.outgoing))
      .slice(0, 6);
    const entryFiles = moduleFileList.filter((file) => /(^|\/)index\.[jt]sx?$/.test(file)).slice(0, 4);
    const deps = topCounts(moduleDeps.get(moduleName), 6);
    const dependents = topCounts(moduleDependents.get(moduleName), 6);
    const readme = await readModuleReadme(cwd, moduleName);
    const exportsFrom = entryFiles.length > 0 ? entryFiles : keyFiles.slice(0, 2).map((entry) => entry.file);
    const exportApi = await extractModuleApi(cwd, exportsFrom);

    const reference: string[] = [];
    const pushRef = (heading: string, lines: string[]): void => {
      if (lines.length === 0) {
        return;
      }
      reference.push("### " + heading, "", ...lines, "");
    };
    pushRef("Public API", exportApi.map((entry) => "- " + entry));
    pushRef(
      "Key files",
      keyFiles.map((entry) => "- `" + entry.file + "` - imported by " + entry.incoming + ", imports " + entry.outgoing),
    );
    pushRef("Depends on", deps.map(([target, count]) => "- `" + target + "` - " + count + " import(s)"));
    pushRef("Depended on by", dependents.map(([source, count]) => "- `" + source + "` - " + count + " import(s)"));
    pushRef("Entry points", entryFiles.map((file) => "- `" + file + "`"));
    if (readme) {
      pushRef("Module README", [readme]);
    }
    pushRef("Graph signals", ["- Files: " + item.files, "- Cross-module imports: " + item.edges]);

    const summaryParts = ["`" + moduleName + "` groups " + item.files + " file(s)."];
    if (deps.length > 0) {
      summaryParts.push("Depends on " + deps.slice(0, 3).map(([target]) => "`" + target + "`").join(", ") + ".");
    }
    if (exportApi.length > 0) {
      summaryParts.push("Exposes " + exportApi.length + " public symbol(s).");
    }

    const relatedNames: string[] = [];
    const seenRelated = new Set<string>([moduleName]);
    for (const [name] of [...deps, ...dependents]) {
      if (!seenRelated.has(name) && pageModules.has(name)) {
        seenRelated.add(name);
        relatedNames.push(name);
      }
    }
    const related = relatedNames
      .slice(0, 8)
      .map((name) => ({ name, slug: slugifyPath(name) }));

    moduleCandidates.push({
      type: "component",
      slug: slugifyPath(moduleName),
      title: "Module " + moduleName,
      source: "gdgraph",
      content: renderModuleWikiPage({
        moduleName,
        generatedAt,
        summary: summaryParts.join(" "),
        reference,
        related,
      }),
    });
  }

  return [architecture, ...moduleCandidates];
}

function bumpNestedCount(map: Map<string, Map<string, number>>, key: string, inner: string): void {
  const bucket = map.get(key) ?? new Map<string, number>();
  bucket.set(inner, (bucket.get(inner) ?? 0) + 1);
  map.set(key, bucket);
}

function sumCounts(bucket: Map<string, number> | undefined): number {
  if (!bucket) {
    return 0;
  }
  let total = 0;
  for (const value of bucket.values()) {
    total += value;
  }
  return total;
}

function topCounts(bucket: Map<string, number> | undefined, limit: number): Array<[string, number]> {
  if (!bucket) {
    return [];
  }
  return [...bucket.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

async function readModuleReadme(cwd: string, moduleName: string): Promise<string | null> {
  const readmePath = path.join(cwd, ...moduleName.split("/"), "README.md");
  if (!(await pathExists(readmePath))) {
    return null;
  }
  try {
    const content = await readFile(readmePath, "utf8");
    const paragraph = content
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .find((block) => block.length > 0 && !block.startsWith("#"));
    if (!paragraph) {
      return null;
    }
    const normalized = paragraph.replace(/\s+/g, " ").slice(0, 400);
    return "- " + normalized + " (from module README)";
  } catch {
    return null;
  }
}

async function extractModuleExports(cwd: string, files: string[]): Promise<string[]> {
  const names = new Set<string>();
  const declRe = /export\s+(?:async\s+)?(?:default\s+)?(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
  const braceRe = /export\s*\{([^}]+)\}/g;
  for (const file of files.slice(0, 4)) {
    const filePath = path.join(cwd, ...file.split("/"));
    if (!(await pathExists(filePath))) {
      continue;
    }
    try {
      const content = (await readFile(filePath, "utf8")).slice(0, 40_000);
      let match: RegExpExecArray | null;
      while ((match = declRe.exec(content)) !== null) {
        if (match[1]) {
          names.add(match[1]);
        }
      }
      let brace: RegExpExecArray | null;
      while ((brace = braceRe.exec(content)) !== null) {
        for (const part of (brace[1] ?? "").split(",")) {
          const raw = part.trim().split(/\s+as\s+/).pop();
          const name = raw?.trim();
          if (name && /^[A-Za-z_$][\w$]*$/.test(name) && name !== "default") {
            names.add(name);
          }
        }
      }
    } catch {
      // ignore unreadable entry files
    }
    if (names.size > 30) {
      break;
    }
  }
  return [...names].slice(0, 20);
}

// Public API entries for a module's Reference section. Starts from the exported
// names (regex, cheap) and — when the gdgraph symbol layer is present — annotates
// each with its real kind (function/class/interface/method) from `symbols.jsonl`,
// so the scaffold carries `\`build\` (function)` instead of a bare name. Degrades
// to plain names when the symbol layer is absent (golden-rule floor).
export async function extractModuleApi(cwd: string, files: string[]): Promise<string[]> {
  const names = await extractModuleExports(cwd, files);
  const symbolsPath = path.join(cwd, ".metaproject", "data", "gdgraph", "storage", "symbols.jsonl");
  if (names.length === 0 || !(await pathExists(symbolsPath))) {
    return names.map((name) => "`" + name + "`");
  }

  const fileSet = new Set(files);
  const kindByName = new Map<string, string>();
  try {
    for (const raw of parseJsonl(await readFile(symbolsPath, "utf8"))) {
      const symbol = raw as { name?: string; kind?: string; container?: string | null; path?: string };
      // Top-level declarations only (container === null) in this module's files.
      if (!symbol.name || !symbol.path || symbol.container != null) continue;
      if (!fileSet.has(symbol.path)) continue;
      if (!kindByName.has(symbol.name) && symbol.kind) {
        kindByName.set(symbol.name, symbol.kind);
      }
    }
  } catch {
    return names.map((name) => "`" + name + "`");
  }

  return names.map((name) => {
    const kind = kindByName.get(name);
    return "`" + name + "`" + (kind ? " (" + kind + ")" : "");
  });
}

async function collectHealthWikiCandidates(
  cwd: string,
  generatedAt: string,
): Promise<WikiCollectCandidate[]> {
  const healthPath = path.join(cwd, ".metaproject", "data", "health", "artifacts", "latest.json");
  if (!(await pathExists(healthPath))) {
    return [];
  }

  const report = JSON.parse(await readFile(healthPath, "utf8")) as {
    gate?: { status?: unknown; reasons?: unknown };
    sources?: Array<Record<string, unknown>>;
    metrics?: Array<Record<string, unknown>>;
  };
  const metrics = Array.isArray(report.metrics) ? report.metrics : [];
  const project = metrics.find((metric) => metric.key === "project") ?? {};
  const counts = (project.findingCounts ?? {}) as { total?: unknown; byPriority?: Record<string, unknown>; bySource?: Record<string, unknown> };
  const byPriority = counts.byPriority ?? {};
  const bySource = counts.bySource ?? {};

  return [{
    type: "architecture",
    slug: "quality-map",
    title: "Quality Map",
    source: "health",
    content: renderCollectedPage({
      title: "Quality Map",
      type: "architecture",
      generatedAt,
      summary: `Generated from Code Health: gate ${String(report.gate?.status ?? "unknown")}, score ${numberOrDash(project.health_score)}, ${numberValue(counts.total)} findings.`,
      sections: [
        ["Gate", [
          `- Status: ${String(report.gate?.status ?? "unknown")}`,
          ...arrayValue(report.gate?.reasons).map((reason) => `- Reason: ${String(reason)}`),
        ]],
        ["Project Score", [
          `- Health score: ${numberOrDash(project.health_score)}`,
          `- Risk score: ${numberOrDash(project.risk_score)}`,
          `- Findings: ${numberValue(counts.total)}`,
          `- P0/P1/P2/P3: ${numberValue(byPriority.P0)}/${numberValue(byPriority.P1)}/${numberValue(byPriority.P2)}/${numberValue(byPriority.P3)}`,
        ]],
        ["Findings By Source", Object.keys(bySource).length > 0
          ? Object.entries(bySource).map(([source, count]) => `- ${source}: ${numberValue(count)}`)
          : ["- No source finding breakdown."]],
        ["Sources", (report.sources ?? []).map((source) => `- ${String(source.source ?? "unknown")}: ${String(source.status ?? "unknown")} (${numberValue(source.findings)} findings)`)],
        ["Related Reports", [
          "- `.metaproject/data/health/artifacts/latest.md`",
          "- `.metaproject/data/health/artifacts/latest.json`",
        ]],
      ],
    }),
  }];
}

async function collectTestingWikiCandidates(
  cwd: string,
  generatedAt: string,
): Promise<WikiCollectCandidate[]> {
  const contextPath = path.join(cwd, ".metaproject", "data", "testing", "context.md");
  if (!(await pathExists(contextPath))) {
    return [];
  }
  const context = await readFile(contextPath, "utf8");
  const summary = firstMeaningfulLine(context) ?? "Generated from testing context.";

  return [{
    type: "architecture",
    slug: "testing-map",
    title: "Testing Map",
    source: "testing",
    content: renderCollectedPage({
      title: "Testing Map",
      type: "architecture",
      generatedAt,
      summary,
      sections: [
        ["Testing Context", excerptMarkdown(context, 18)],
        ["Related Reports", [
          "- `.metaproject/data/testing/context.md`",
          "- `.metaproject/data/testing/artifacts/latest.md`",
        ]],
      ],
    }),
  }];
}

async function writeCollectedPage(
  cwd: string,
  candidate: WikiCollectCandidate,
  force: boolean,
): Promise<WikiCollectedPage> {
  const folder = WIKI_PAGE_TYPES.find((entry) => entry.type === candidate.type)?.folder;
  if (!folder) {
    throw new Error(`Unsupported collected wiki type: ${candidate.type}`);
  }

  const filePath = path.join(wikiRootPath(cwd), folder, `${candidate.slug}.md`);
  const relativePath = path.relative(cwd, filePath);
  const exists = await pathExists(filePath);
  if (exists && !force) {
    return { path: relativePath, type: candidate.type, source: candidate.source, action: "skipped" };
  }
  // Even with --force, only regenerate pages that are still unmodified generated
  // drafts. Once a human accepts (`Status:` other than draft) or edits away the
  // generated marker, the page is theirs and is left untouched.
  if (exists && force) {
    const current = await readFile(filePath, "utf8");
    const isUnmodifiedDraft =
      /\nStatus:\s*draft\s*\n/.test(current) && current.includes("Generated by `keryx wiki collect`");
    if (!isUnmodifiedDraft) {
      return { path: relativePath, type: candidate.type, source: candidate.source, action: "skipped" };
    }
  }

  // Security write seam (§11): gate the draft page before publishing it.
  // Advisory reports only and the write proceeds unchanged; enforced/ci may
  // suppress the write and record the reason.
  const guard = await guardOutput({
    cwd,
    content: candidate.content,
    target: "wiki",
    source: "generated",
  });
  const output = prepareOutputForPersistence(guard, candidate.content);
  if (!output.allowed) {
    return {
      path: relativePath,
      type: candidate.type,
      source: candidate.source,
      action: "skipped",
      securityReason: output.reason,
    };
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, output.content, "utf8");
  return {
    path: relativePath,
    type: candidate.type,
    source: candidate.source,
    action: exists ? "updated" : "created",
  };
}

// Wiki pages that reference `targetRepoPath` (a repo-relative file, posix or
// native) — the "documented in" reverse lookup. Shared by `wiki backlinks` and
// the gdgraph code→wiki tie-in. Best-effort: returns [] when the wiki is empty.
export async function wikiPagesForFile(cwd: string, targetRepoPath: string): Promise<string[]> {
  const pages = await collectPages(cwd);
  const refs = await Promise.all(
    pages.map(async (page) => ({
      repoPath: path.relative(cwd, page.absolutePath).split(path.sep).join("/"),
      content: await readFile(page.absolutePath, "utf8"),
    })),
  );
  return backlinksFor(buildBacklinkIndex(refs), targetRepoPath);
}

// The module path a component page documents (title is "Module <path>").
function moduleTitlePath(page: WikiPage): string {
  return page.title.startsWith("Module ") ? page.title.slice("Module ".length) : page.relativePath;
}

// Render component pages as a nesting TREE by module path (src → pipelines →
// store / features/…) so the index reflects the graph hierarchy, not a flat list.
function renderComponentTree(pages: WikiPage[]): string[] {
  const entries = pages
    .map((page) => ({ path: moduleTitlePath(page), page }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return entries.map(({ path: modulePath, page }) => {
    const depth = Math.max(0, modulePath.split("/").length - 2);
    const indent = "  ".repeat(depth);
    return `${indent}- [${modulePath}](${page.relativePath}) (${page.status ?? "draft"})`;
  });
}

function renderIndexBody(pages: WikiPage[], generatedAt: string): string {
  const lines = [`<!-- generated: ${generatedAt} | pages: ${pages.length} -->`, ""];

  for (const { type } of WIKI_PAGE_TYPES) {
    const typed = pages.filter((page) => page.pageType === type);
    lines.push(`### ${titleCase(type)}`, "");
    if (typed.length === 0) {
      lines.push("_No pages yet._", "");
      continue;
    }
    if (type === "component") {
      lines.push(...renderComponentTree(typed), "");
      continue;
    }
    for (const page of typed) {
      const summary = page.summary ? ` - ${page.summary}` : "";
      lines.push(
        `- [${page.title}](${page.relativePath}) (${page.status ?? "draft"})${summary}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

async function isIndexStale(cwd: string, pages: WikiPage[]): Promise<boolean> {
  const indexPath = path.join(wikiRootPath(cwd), "index.md");
  if (!(await pathExists(indexPath))) {
    return true;
  }

  const content = await readFile(indexPath, "utf8");
  const managed = content.match(
    new RegExp(
      `${escapeRegExp(WIKI_INDEX_BEGIN)}([\\s\\S]*?)${escapeRegExp(WIKI_INDEX_END)}`,
    ),
  );
  if (!managed?.[1]) {
    return true;
  }

  return stripStamp(managed[1]) !== stripStamp(renderIndexBody(pages, ""));
}

function stripStamp(body: string): string {
  return body
    .replace(/<!--\s*generated:[^>]*-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function walkMarkdown(root: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkMarkdown(absolutePath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(absolutePath);
    }
  }

  return results.sort();
}

function extractLinkTargets(content: string): string[] {
  const targets: string[] = [];
  const pattern = /\[[^\]]*\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const raw = match[1]?.trim();
    if (raw && raw.length > 0) {
      // Drop optional link titles: `(path "title")`.
      targets.push(raw.split(/\s+/)[0] ?? raw);
    }
  }

  return targets;
}

function renderLinkCheckReport({
  generatedAt,
  checkedPages,
  checkedLinks,
  skippedExternal,
  broken,
}: {
  generatedAt: string;
  checkedPages: number;
  checkedLinks: number;
  skippedExternal: number;
  broken: WikiBrokenLink[];
}): string {
  const brokenSection =
    broken.length > 0
      ? broken
          .map((item) => `- ${item.page} -> ${item.target} (${item.reason})`)
          .join("\n")
      : "- none";

  const state: WikiLinkCheckState & { skippedExternal: number } = {
    generatedAt,
    broken: broken.length,
    checkedPages,
    checkedLinks,
    skippedExternal,
  };

  return `# gdwiki link check

Generated: ${generatedAt}
Checked pages: ${checkedPages}
Checked internal links: ${checkedLinks}
Skipped external links: ${skippedExternal}
Broken links: ${broken.length}

## Broken Links

${brokenSection}

## Metadata

\`\`\`json
${JSON.stringify(state, null, 2)}
\`\`\`
`;
}

async function readIndexGeneratedAt(cwd: string): Promise<string | null> {
  const indexPath = path.join(wikiRootPath(cwd), "index.md");
  if (!(await pathExists(indexPath))) {
    return null;
  }

  const content = await readFile(indexPath, "utf8");
  const match = content.match(/<!--\s*generated:\s*([^|]+?)\s*\|/);
  const value = match?.[1]?.trim();
  return value && value !== "never" ? value : null;
}

async function readLinkCheckState(
  cwd: string,
): Promise<WikiLinkCheckState | null> {
  const reportPath = linkCheckReportPath(cwd);
  if (!(await pathExists(reportPath))) {
    return null;
  }

  const content = await readFile(reportPath, "utf8");
  const matches = [...content.matchAll(/```json\n([\s\S]*?)```/g)];
  const last = matches.at(-1);
  if (!last?.[1]) {
    return null;
  }

  try {
    const parsed = JSON.parse(last[1]) as WikiLinkCheckState;
    return {
      generatedAt: parsed.generatedAt,
      broken: parsed.broken,
      checkedPages: parsed.checkedPages,
      checkedLinks: parsed.checkedLinks,
    };
  } catch {
    return null;
  }
}

function slugToTitle(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function titleCase(type: string): string {
  return type
    .split("-")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function renderModuleWikiPage({
  moduleName,
  generatedAt,
  summary,
  reference,
  related,
}: {
  moduleName: string;
  generatedAt: string;
  summary: string;
  reference: string[];
  related: Array<{ name: string; slug: string }>;
}): string {
  // Prose sections lead (agent/human-owned, filled by the gdwiki enrich
  // workflow); graph-derived facts live under Reference and are regenerated by
  // `wiki collect --force`. A wiki explains what is inside a module - the graph
  // already provides the raw lists.
  return `# Module ${moduleName}

Version: 0.1.0
Type: component
Status: draft

## Summary

${summary}

## Overview

_Draft - enrich with the gdwiki skill. In 2-4 sentences: what this module owns and its purpose in the app._

## How it works

_Draft - the internal architecture in prose: the layers and key abstractions and how they relate. Read the Key files under Reference below._

## Key concepts

_Draft - the domain vocabulary and core objects this module introduces, and how they relate._

## Main flows

_Draft - trace 1-3 concrete flows (e.g. a request from API to store to UI) through the Key files below._

---

## Reference (from code graph)

Extracted deterministically by \`keryx wiki collect\`; regenerated by
\`--force\`. The prose sections above are the agent/human-owned part.

${reference.join("\n")}
## Related Wiki

Graph-derived - regenerated by \`keryx wiki collect --force\`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
${related.map((entry) => "- [Module " + entry.name + "](" + entry.slug + ".md)").join("\n")}

## Changelog

- 0.1.0 - Generated by \`keryx wiki collect\` at ${generatedAt}. Prose sections are drafts for the gdwiki enrich workflow.
`;
}

function renderCollectedPage({
  title,
  type,
  generatedAt,
  summary,
  sections,
}: {
  title: string;
  type: WikiPageType;
  generatedAt: string;
  summary: string;
  sections: Array<[string, string[]]>;
}): string {
  const body = sections
    .map(([heading, lines]) => {
      const content = lines.length > 0 ? lines.join("\n") : "- none";
      return `## ${heading}\n\n${content}`;
    })
    .join("\n\n");

  return `# ${title}

Version: 0.1.0
Type: ${type}
Status: draft

## Summary

${summary}

${body}

## Related Wiki

- [Wiki Index](../index.md)

## Changelog

- 0.1.0 - Generated by \`keryx wiki collect\` at ${generatedAt}.
`;
}

function parseJsonl(content: string): Array<Record<string, unknown>> {
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

async function changedModules(cwd: string, since: string | undefined): Promise<Set<string> | null> {
  const base = since && since.length > 0 ? since : "HEAD";
  const files = await gitDiffNames(cwd, base);
  if (files === null) {
    return null;
  }
  const modules = new Set<string>();
  for (const file of files) {
    if (file.length > 0) {
      modules.add(moduleNameFromProjectPath(file));
    }
  }
  return modules;
}

function gitDiffNames(cwd: string, base: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["diff", "--name-only", base], { cwd });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(out.split("\n").map((line) => line.trim()).filter((line) => line.length > 0));
    });
  });
}

// A "module" is the directory that directly owns a file — at its natural depth,
// not flattened to a top-level bucket. So the wiki walks the WHOLE graph tree
// (`src/pipelines`, `src/pipelines/store`, `src/pipelines/features/pipeline-variables`
// all become distinct modules) rather than only the top ~12. A file directly in
// a root dir keeps that root as its module.
export function moduleNameFromProjectPath(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return "root";
  }
  return parts.slice(0, -1).join("/");
}

function slugifyPath(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "root";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numberOrDash(value: unknown): number | string {
  return typeof value === "number" && Number.isFinite(value) ? value : "-";
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstMeaningfulLine(content: string): string | undefined {
  return content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
}

function excerptMarkdown(content: string, maxLines: number): string[] {
  const lines = content
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, maxLines);
  return lines.length > 0 ? lines : ["- No testing context content."];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Managed-block, describe-target and changelog rules (LWG-14, flow 227).
 *
 * A damaged page is reported, never repaired: `validate` says what is wrong,
 * and `refresh`/`migrate-markers` are the things allowed to change a file.
 */
async function validateStructure(
  cwd: string,
  pages: readonly WikiPage[],
  issues: WikiValidateIssue[],
): Promise<void> {
  const { findManagedBlock } = await import("./managed-block");
  const { NOT_CODE_SCOPED, parseDescribesField } = await import("./describes");
  const { validateTemplateStructure } = await import("./template-structure");
  const { templateKindForPageType } =
    await import("./templates");

  for (const page of pages) {
    let content: string;
    try {
      content = await readFile(page.absolutePath, "utf8");
    } catch {
      continue;
    }

    const block = findManagedBlock(content);
    if (block.kind === "malformed") {
      issues.push({
        page: page.relativePath,
        kind: "managed-block",
        message: `managed Reference block is malformed: ${block.reason}`,
      });
    } else if (block.kind === "present" && block.block.handEdited) {
      // Not an error — a legitimate state a person may choose — but it means
      // `refresh` will refuse this page until someone decides, so it belongs
      // in the report rather than as a surprise later.
      issues.push({
        page: page.relativePath,
        kind: "managed-block",
        message: "managed Reference block was edited by hand; `wiki refresh` will refuse it without --force",
      });
    }

    for (const pattern of parseDescribesField(content)) {
      if (pattern === NOT_CODE_SCOPED) {
        // `Describes: none` is a declaration that the page is not scoped to
        // code, not a path. Checking it as one reported four false defects
        // and failed the gate on the very change that introduced the
        // sentinel — the resolver learned about it and the validator did not.
        continue;
      }
      if (pattern.includes("*")) {
        continue;
      }
      if (!(await pathExists(path.join(cwd, pattern)))) {
        issues.push({
          page: page.relativePath,
          kind: "describes",
          message: `Describes names a path that does not exist: ${pattern}`,
        });
      }
    }

    // AFC-W02 (flow 235) AC8 — the explanation-template contract, wired.
    //
    // `validateTemplateStructure` shipped with a test as its only consumer, so
    // until this call a `business-rule`/`decision`/`user-scenario` page could
    // fill every mandatory heading, record no per-question verdict at all, and
    // `keryx wiki validate` still printed "All checks passed." at exit 0 —
    // measured on a temp wiki before this change, with the validator called
    // directly on the same bytes returning `coverage-record-missing`.
    //
    // NAMED SCOPING DECISION, not a silent exemption. The template is an
    // AUTHORING contract: wiki-specification.md §4 fixes the questions a page
    // must close BEFORE the page is written ("До написания страницы
    // фиксируются вопросы, которые она должна закрыть"). So it is applied to
    // pages actually written to it, detected by the page carrying at least ONE
    // of that template's own headings (or the coverage heading). The
    // machine-written SAC provenance record —
    // `.metaproject/wiki/decisions/sac-proposal-*.md`, a Summary / Details /
    // Provenance shape produced by the SAC owner-writer — claims none of them,
    // and reporting six missing Decision headings against it would be the
    // validator accusing a page of failing a shape it never claimed.
    //
    // The scope is what the page DECLARES ITSELF TO BE, not which headings it
    // happens to carry.
    //
    // The first wiring scoped by heading presence — a page was held to the
    // template if it carried at least one of the template's headings. That is
    // a contract you escape by writing less: measured on a temp wiki, a
    // `business-rule` page with every heading deleted drew no template finding
    // at all, while the same page with four of them drew five. A guard that
    // stops applying when a page stops trying is not a guard.
    //
    // Scoping it on a line in the page body then replaced that with "escape by
    // writing one more line": an independent review forged the exemption onto a
    // hand-written `business-rule` page by appending a `## Provenance` block
    // with `- Source: sac-proposal`, and it drew zero template findings.
    //
    // So the exemption is now everything the producer does that an author does
    // not do by accident: the page type it mints (`decision`), the path it
    // mints into (`decisions/sac-proposal-<id>.md`), and the provenance block
    // it writes, which carries a hash-identified evidence link and not only a
    // source name. A page missing any one of those is held to the contract.
    //
    // This is a CONVENTION check and not authentication, and it is worth being
    // exact about what it does and does not buy. The producer's real proof is
    // the receipt it writes, which lives in the workspace tree rather than
    // beside the page, so this validator cannot reach it. Someone determined to
    // evade the contract can still write a file into the producer's own
    // namespace with a fabricated evidence link. What this stops is the case
    // that actually happens: an author taking the easy way out of an authoring
    // contract, who would now have to impersonate a producer's output path,
    // page type and evidence reference to do it — which is deliberate rather
    // than lazy, and legible to anyone reading the diff.
    const templateKind = templateKindForPageType(page.pageType);
    if (templateKind !== null) {
      if (!isMachineAuthoredPage(page.pageType, page.relativePath, content)) {
        for (const issue of validateTemplateStructure(page.pageType, content)) {
          issues.push({
            page: page.relativePath,
            // The validator's own kind, carried through rather than collapsed
            // to one generic "structure" label: `coverage-basis-missing` and
            // `field-empty` are different defects and a caller must be able to
            // branch on which one fired.
            kind: issue.kind,
            message: issue.message,
          });
        }
      }
    }

    const versions = [...content.matchAll(/^-\s+(\d+\.\d+\.\d+)\s+-/gm)].map((match) => match[1] as string);
    for (let index = 1; index < versions.length; index += 1) {
      if (compareSemver(versions[index - 1] as string, versions[index] as string) < 0) {
        issues.push({
          page: page.relativePath,
          kind: "changelog",
          message: `changelog versions are not newest-first: ${versions[index - 1]} appears above ${versions[index]}`,
        });
        break;
      }
    }
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
