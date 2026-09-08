import {
  wikiCheckLinks,
  wikiCollect,
  wikiCreatePage,
  wikiGenerateIndex,
  wikiStatus,
  wikiValidate,
} from "../wiki/service";
import { wikiAsk } from "../wiki/ask";
import { renderMarkdown, runFreshness } from "../wiki/freshness/run";
import { migrateMarkers, refreshPages, verifyPages } from "../wiki/refresh";
import { resolveGitHead } from "../sync/provenance";
import { describeHead } from "../wiki/staleness";
import { optionValue } from "../lib/args";
import type { RemovalHistory } from "../wiki/section-tombstone";
import { TemporalValidationError } from "../memory/temporal";

export async function wikiCommand(args: string[]): Promise<void> {
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  // `--help` anywhere in the argv prints usage instead of running. Without
  // this, `keryx wiki refresh --help` REGENERATED 37 pages: the subcommand
  // never inspected the flag, so asking what a command does performed it. A
  // help flag that mutates the working tree is the one flag that must never
  // reach the body.
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  if (command === "status") {
    await runStatus();
    return;
  }

  if (command === "new") {
    await runNew(args.slice(1));
    return;
  }

  if (command === "index") {
    await runIndex();
    return;
  }

  if (command === "collect") {
    await runCollect(args.slice(1));
    return;
  }

  if (command === "check-links") {
    await runCheckLinks();
    return;
  }

  if (command === "validate") {
    await runValidate();
    return;
  }

  if (command === "freshness") {
    await runFreshnessCommand(args.slice(1));
    return;
  }

  if (command === "refresh") {
    await runRefreshCommand(args.slice(1));
    return;
  }

  if (command === "verify") {
    await runVerifyCommand(args.slice(1));
    return;
  }

  if (command === "migrate-markers") {
    await runMigrateMarkersCommand(args.slice(1));
    return;
  }

  if (command === "ask") {
    await runAsk(args.slice(1));
    return;
  }

  if (command === "sections") {
    await runSections(args.slice(1));
    return;
  }

  if (command === "enrich") {
    await runEnrich(args.slice(1));
    return;
  }

  if (command === "context") {
    const { wikiContext } = await import("../ctx/orient");
    console.log(await wikiContext(process.cwd()));
    return;
  }

  if (command === "backlinks") {
    await runBacklinks(args.slice(1));
    return;
  }

  console.error(`Unknown wiki command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

async function runStatus(): Promise<void> {
  const status = await wikiStatus(process.cwd());

  console.log("# gdwiki status");
  console.log("");
  console.log(`enabled: ${status.enabled ? "yes" : "no"}`);
  console.log(`wiki root: ${status.wikiRoot}`);
  console.log(`total pages: ${status.totalPages}`);
  console.log("");
  console.log("## Pages by type");
  for (const entry of status.countsByType) {
    console.log(`- ${entry.type}: ${entry.count}`);
  }
  console.log("");
  console.log(
    `last index generated: ${status.lastIndexGeneratedAt ?? "never"}`,
  );
  if (status.lastLinkCheck) {
    console.log(
      `last link check: ${status.lastLinkCheck.generatedAt} (${status.lastLinkCheck.broken} broken)`,
    );
  } else {
    console.log("last link check: never");
  }
}

async function runNew(args: string[]): Promise<void> {
  const type = args[0];
  const slug = args[1];
  if (!type || !slug) {
    console.error(
      'Usage: keryx wiki new <type> <slug> --title "<title>" [--force]',
    );
    process.exitCode = 1;
    return;
  }

  const result = await wikiCreatePage({
    cwd: process.cwd(),
    type,
    slug,
    title: optionValue(args, "--title"),
    force: args.includes("--force"),
  });

  console.log(`Created ${result.type} page: ${result.path}`);
}

async function runIndex(): Promise<void> {
  const result = await wikiGenerateIndex(process.cwd());
  console.log(`Generated ${result.path} (${result.pageCount} pages).`);
}

async function runCollect(args: string[]): Promise<void> {
  const limitValue = optionValue(args, "--limit");
  const limit = limitValue ? Number.parseInt(limitValue, 10) : undefined;
  if (limitValue && (!Number.isFinite(limit) || (limit ?? 0) < 1)) {
    console.error("Usage: keryx wiki collect [--force] [--changed [--since <ref>]] [--limit <n>]");
    process.exitCode = 1;
    return;
  }

  const since = optionValue(args, "--since");
  const result = await wikiCollect({
    cwd: process.cwd(),
    force: args.includes("--force"),
    changed: args.includes("--changed"),
    ...(since ? { since } : {}),
    ...(limit ? { limit } : {}),
  });

  console.log("# gdwiki collect");
  console.log("");
  console.log(`created: ${result.created}`);
  console.log(`updated: ${result.updated}`);
  console.log(`skipped: ${result.skipped}`);
  console.log(`index: ${result.index.path}`);
  console.log("");
  for (const page of result.pages) {
    console.log(`- ${page.action}: ${page.path} (${page.source})`);
  }

  // Enrichment work-front: component pages still in draft (prose not written).
  // This is what the gdwiki enrichment pass (and the post-commit hook) should target.
  const { collectPages } = await import("../wiki/collect");
  const drafts = (await collectPages(process.cwd())).filter(
    (page) => page.pageType === "component" && (page.status ?? "draft") === "draft",
  );
  console.log("");
  console.log(`enrichment needed: ${drafts.length} component page(s) still Status: draft`);
  if (drafts.length > 0) {
    console.log("→ enrich prose via the gdwiki skill (cheap model, 1 subagent per page).");
    for (const page of drafts.slice(0, 10)) {
      console.log(`  - ${page.relativePath}`);
    }
    if (drafts.length > 10) console.log(`  - … +${drafts.length - 10} more`);
  }
}

async function runCheckLinks(): Promise<void> {
  const result = await wikiCheckLinks(process.cwd());

  console.log("# gdwiki check-links");
  console.log("");
  console.log(`checked pages: ${result.checkedPages}`);
  console.log(`checked internal links: ${result.checkedLinks}`);
  console.log(`skipped external links: ${result.skippedExternal}`);
  console.log(`broken links: ${result.broken.length}`);
  console.log("");

  if (result.broken.length > 0) {
    console.log("## Broken");
    for (const broken of result.broken) {
      console.log(`- ${broken.page} -> ${broken.target} (${broken.reason})`);
    }
    console.log("");
  }

  console.log(`report: ${result.reportPath}`);
  process.exitCode = result.broken.length > 0 ? 1 : 0;
}

async function runValidate(): Promise<void> {
  const cwd = process.cwd();
  const result = await wikiValidate(cwd);

  // AFC-W01 (flow 235) T5: "Дубликат ID внутри owner namespace — validation
  // error." Reported here rather than only from `keryx wiki sections`, because
  // this is the command a project already runs — a validator nobody invokes
  // catches nothing.
  const { collectPages } = await import("../wiki/collect");
  const { buildSectionIndex } = await import("../wiki/section-index");
  const { readFile } = await import("node:fs/promises");
  const pages = await collectPages(cwd);
  const index = buildSectionIndex(
    await Promise.all(
      pages.map(async (page) => ({
        page,
        content: await readFile(page.absolutePath, "utf8").catch(() => ""),
      })),
    ),
  );

  console.log("# gdwiki validate");
  console.log("");
  if (result.ok && index.issues.length === 0) {
    console.log("All checks passed.");
    return;
  }

  console.log(`issues: ${result.issues.length + index.issues.length}`);
  console.log("");
  for (const issue of result.issues) {
    console.log(`- [${issue.kind}] ${issue.page}: ${issue.message}`);
  }
  for (const issue of index.issues) {
    console.log(`- [section-identity/${issue.kind}] ${issue.page}:${issue.line}: ${issue.message}`);
  }
  process.exitCode = 1;
}

// AFC-06 (flow 234) T22: `--as-of` is spelled identically to memory's
// (`keryx memory search ... --as-of <YYYY-MM-DD>`, `runSearch` below) rather
// than a second historical-mode idiom, and its errors are reported through
// the SAME `TemporalValidationError` memory's `--as-of` already throws
// (`../memory/temporal.ts`) -- one validator, one error shape, two callers.
async function runAsk(args: string[]): Promise<void> {
  const question = args.find((arg) => !arg.startsWith("--"));
  if (!question) {
    console.error('Usage: keryx wiki ask "<question>" [--k <n>] [--rerank] [--as-of <YYYY-MM-DD>] [--json]');
    process.exitCode = 1;
    return;
  }
  const kValue = optionValue(args, "--k");
  const asOf = optionValue(args, "--as-of");

  let result;
  try {
    result = await wikiAsk({
      cwd: process.cwd(),
      question,
      ...(kValue ? { k: Number.parseInt(kValue, 10) } : {}),
      ...(args.includes("--rerank") ? { rerank: true } : {}),
      ...(asOf ? { asOf } : {}),
    });
  } catch (error) {
    if (error instanceof TemporalValidationError) {
      printWikiValidationError(error, args.includes("--json"));
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(result.answerMarkdown);
}

function printWikiValidationError(error: TemporalValidationError, json: boolean): void {
  const payload = { code: error.code, field: error.field, message: error.message, action: error.action };
  if (json) {
    console.log(JSON.stringify({ error: payload }, null, 2));
  } else {
    console.error(`[${payload.code}] ${payload.field}: ${payload.message} Action: ${payload.action}`);
  }
}

/**
 * `keryx wiki sections` — AFC-W01's identity surface (flow 235, T5).
 *
 *   list      what the retrieval index actually contains, and how far each
 *             address can be trusted
 *   resolve   an address → the section, a tombstone, a stale locator, or
 *             unknown. Never a same-named substitute: a deleted id resolving to
 *             whatever now occupies that position is the defect the criterion
 *             names, and a plausible answer is worse than a refusal.
 *   sync      record the current stable ids and tombstone the ones that
 *             disappeared. The ONLY write on this path; retrieval never
 *             performs it, because a pure search must not write history.
 *   migrate   insert identity markers, preview first, CAS-guarded, and
 *             byte-for-byte content preserving.
 *
 * Flow 242 (forgetting), lane B — the three answers this surface used to
 * collapse into the others, and how each exits.
 *
 *   registry-unreadable  exit 2. Not 1: 1 says "this identity is not live",
 *                        which is a claim, and an unreadable history supports
 *                        no claim at all. `sync` refuses outright rather than
 *                        writing an empty history over the one it could not
 *                        read.
 *   reoccupied           exit 1 from both `resolve` and `sync`. A tombstone and
 *                        a live document claiming one address is a
 *                        contradiction on disk, not a completed sync.
 *   pending-tombstone    exit 1. The identity is registered and gone from the
 *                        index; the deletion happened and `sync` has not.
 */
/**
 * A live identity that was once removed says so.
 *
 * Printed on `found` rather than folded away, because "this section has always
 * been here" and "this section was deleted and came back" are different facts
 * and the second is the one a reader needs when the content surprises them.
 *
 * And "it came back" is itself two facts. A byte-identical restoration and an
 * operator-accepted substitution of a wholly different document both end here,
 * and before this they printed the same two lines: removed at T, restored at T'.
 * The registry knew the difference and this renderer discarded it. The basis is
 * now printed, and a substitution is labelled as one on the first line rather
 * than left to be inferred from a paragraph a reader may not reach.
 */
function printRemovalHistory(history: RemovalHistory | null): void {
  if (!history) {
    return;
  }
  const lines = [`  history: removed ${history.removedAt} — ${history.reason}`];
  if (history.restoredAt === null) {
    lines.push(
      "  restored with byte-identical content; the tombstone is still on disk (run `keryx wiki sections sync`).",
    );
  } else {
    const evidence = history.restoredEvidence ?? "unrecorded";
    const label =
      evidence === "byte-identical"
        ? "restoration — the content that came back IS the content that was removed"
        : evidence === "accepted-substitution"
          ? "SUBSTITUTION accepted by an operator — this is NOT the content that was removed"
          : "basis NOT RECORDED — whether this is the same content cannot be told from the registry";
    lines.push(
      `  restored ${history.restoredAt} [${evidence}]: ${label}; ` +
        "the tombstone is retained in the registry's lifted record.",
    );
  }
  if (history.restoredReason) {
    lines.push(`  basis: ${history.restoredReason}`);
  }
  console.log(lines.join("\n"));
}

async function runSections(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const json = args.includes("--json");
  const sub = args.find((arg) => !arg.startsWith("--")) ?? "list";

  const { collectPages } = await import("../wiki/collect");
  const { buildSectionIndex } = await import("../wiki/section-index");
  const { migrateSectionMarkers } = await import("../wiki/section-marker");
  const { readSectionRegistryState, resolveSectionIdentity, syncSectionRegistry } = await import(
    "../wiki/section-tombstone"
  );
  const { wikiPageIdFor } = await import("../gdgraph/wiki-layer");
  const { readFile } = await import("node:fs/promises");

  if (sub === "migrate") {
    const page = optionValue(args, "--page");
    const result = await migrateSectionMarkers(cwd, {
      dryRun: args.includes("--dry-run"),
      ...(page ? { page } : {}),
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const dry = result.dryRun ? " (dry run — nothing written)" : "";
    console.log(
      `migrated ${result.migrated}, already marked ${result.already}, conflicts ${result.conflicts}${dry}`,
    );
    for (const entry of result.pages) {
      if (entry.action === "migrated") {
        console.log(`  migrated  ${entry.page} -> ${(entry.authoredIds ?? []).join(", ")}`);
      } else if (entry.action === "conflict") {
        console.log(`  CONFLICT  ${entry.page}: ${entry.reason}`);
      }
    }
    process.exitCode = result.conflicts > 0 ? 1 : 0;
    return;
  }

  const pages = await collectPages(cwd);
  const index = buildSectionIndex(
    await Promise.all(
      pages.map(async (page) => ({
        page,
        content: await readFile(page.absolutePath, "utf8").catch(() => ""),
      })),
    ),
  );

  if (sub === "sync") {
    const accepted = optionValue(args, "--accept-reoccupation");
    const sync = await syncSectionRegistry(cwd, index, {
      dryRun: args.includes("--dry-run"),
      ...(accepted ? { acceptReoccupation: accepted.split(",").map((ref) => ref.trim()) } : {}),
    });
    if (json) {
      console.log(JSON.stringify(sync, null, 2));
      // A refusal must not exit 0 next to a completed sync: a caller that only
      // checks the status code would otherwise read "the history was destroyed"
      // as "the history is up to date".
      process.exitCode = sync.status === "refused" ? 1 : 0;
      return;
    }
    if (sync.status === "refused") {
      console.error(`REFUSED: ${sync.reason}`);
      console.error("Nothing was written.");
      process.exitCode = 1;
      return;
    }
    const dry = sync.dryRun ? " (dry run — nothing written)" : "";
    console.log(
      `registered ${sync.next.entries.length}, added ${sync.added.length}, ` +
        `tombstoned ${sync.tombstoned.length}, revived ${sync.revived.length}, ` +
        `reoccupied ${sync.reoccupied.length}${dry}`,
    );
    for (const entry of sync.tombstoned) {
      console.log(`  TOMBSTONE ${entry.ref}: ${entry.reason}`);
    }
    for (const entry of sync.reoccupied) {
      console.log(`  REOCCUPIED ${entry.ref} [${entry.evidence}]: ${entry.reason}`);
    }
    // A reoccupied identity is an unresolved contradiction on disk — the
    // tombstone and a live document claim the same address — so it is not
    // reported as a clean sync.
    process.exitCode = sync.reoccupied.length > 0 ? 1 : 0;
    return;
  }

  if (sub === "resolve") {
    const ref = args.find((arg, i) => !arg.startsWith("--") && i > args.indexOf("resolve"));
    if (!ref) {
      console.error('Usage: keryx wiki sections resolve "<pageId>#<sectionId>" [--json]');
      process.exitCode = 1;
      return;
    }
    const registry = await readSectionRegistryState(cwd);
    const resolution = resolveSectionIdentity(index, registry, ref);
    if (json) {
      console.log(JSON.stringify({ ref, resolution }, null, 2));
    } else if (resolution.kind === "found") {
      console.log(
        `found: ${resolution.section.pageRelativePath} "${resolution.section.title}" ` +
          `(lines ${resolution.section.bodyRange.startLine}-${resolution.section.bodyRange.endLine}, ` +
          `${resolution.section.stability})`,
      );
      printRemovalHistory(resolution.history);
    } else if (resolution.kind === "page-found") {
      console.log(`found page: ${resolution.page}`);
      printRemovalHistory(resolution.history);
    } else if (resolution.kind === "tombstoned") {
      console.log(
        `tombstoned: removed ${resolution.tombstone.removedAt} — ${resolution.tombstone.reason}\n` +
          "  There is no redirect. A section with the same heading elsewhere is NOT this one.",
      );
    } else if (resolution.kind === "reoccupied") {
      console.log(`reoccupied [${resolution.evidence}]: ${resolution.reason}`);
    } else if (resolution.kind === "pending-tombstone") {
      console.log(`pending-tombstone: ${resolution.reason}`);
    } else if (resolution.kind === "registry-unreadable") {
      console.error(`registry-unreadable: ${resolution.reason}`);
    } else if (resolution.kind === "stale-locator") {
      console.log(`stale-locator: ${resolution.reason}`);
    } else {
      console.log(`unknown: ${resolution.reason}`);
    }
    // A dead address must not exit 0 alongside a live one — and "I cannot tell"
    // must not exit alongside either. 2 is reserved for the answer that is
    // neither a live identity nor a claim about a dead one: a script that treats
    // 1 as "gone" would otherwise read an unreadable registry as a deletion.
    process.exitCode =
      resolution.kind === "found" || resolution.kind === "page-found"
        ? 0
        : resolution.kind === "registry-unreadable"
          ? 2
          : 1;
    return;
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          parserVersion: index.parserVersion,
          rankingProfileVersion: index.rankingProfileVersion,
          sections: index.sections.map((section) => ({
            ref: section.sectionRef,
            page: section.pageRelativePath,
            title: section.title,
            domain: section.domain,
            stability: section.stability,
            contentClass: section.contentClass,
            language: section.language,
            startLine: section.bodyRange.startLine,
            endLine: section.bodyRange.endLine,
          })),
          issues: index.issues,
        },
        null,
        2,
      ),
    );
    process.exitCode = index.issues.length > 0 ? 1 : 0;
    return;
  }

  const stable = index.sections.filter((section) => section.stability === "stable").length;
  console.log("# gdwiki sections");
  console.log("");
  console.log(`indexed sections: ${index.sections.length}`);
  console.log(`stable ids: ${stable}`);
  console.log(`provisional (version-bound) locators: ${index.sections.length - stable}`);
  console.log("");
  for (const page of pages) {
    // Resolved through the GRAPH layer's own entry point, so the identity an
    // agent reads here and the one the wiki graph layer would use are one rule
    // rather than two implementations that can drift apart.
    const identity = wikiPageIdFor(
      page.relativePath,
      await readFile(page.absolutePath, "utf8").catch(() => ""),
    );
    const note =
      identity.stability === "stable"
        ? "stable — survives a file rename"
        : "path-derived — a rename produces a different id; run `keryx wiki sections migrate`";
    console.log(`- ${page.relativePath}: ${identity.pageId} (${note})`);
  }
  if (index.issues.length > 0) {
    console.log("");
    console.log(`## Issues (${index.issues.length})`);
    for (const issue of index.issues) {
      console.log(`- [${issue.kind}] ${issue.page}:${issue.line}: ${issue.message}`);
    }
    process.exitCode = 1;
  }
}

async function runEnrich(args: string[]): Promise<void> {
  const { defaultEnrichProgress, planWikiEnrich, wikiEnrich } = await import("../wiki/enrich");
  const prompt = optionValue(args, "--prompt");
  const provider = optionValue(args, "--provider");
  const model = optionValue(args, "--model");
  const limitRaw = optionValue(args, "--limit");
  const concurrencyRaw = optionValue(args, "--concurrency");
  const maxTokensRaw = optionValue(args, "--max-tokens");
  const force = args.includes("--force");
  const listOnly = args.includes("--list");
  const resume = args.includes("--resume");
  const refreshGraph = args.includes("--refresh-graph");
  const dryRun = args.includes("--dry-run");
  const noValidate = args.includes("--no-validate");
  // Positional page = first bare token that is neither a flag nor a flag's value.
  const valueFlags = new Set([
    "--page",
    "--prompt",
    "--provider",
    "--model",
    "--limit",
    "--concurrency",
    "--max-tokens",
  ]);
  const page = args.find(
    (arg, i) => !arg.startsWith("--") && !(i > 0 && valueFlags.has(args[i - 1] as string)),
  );

  if (listOnly) {
    const plan = await planWikiEnrich(process.cwd());
    if (args.includes("--json")) {
      console.log(
        JSON.stringify(
          {
            drafts: plan.drafts.map((p) => ({ path: p.relativePath, status: p.status ?? "draft" })),
            accepted: plan.accepted.map((p) => ({ path: p.relativePath, status: p.status ?? "accepted" })),
            other: plan.other.map((p) => ({ path: p.relativePath, status: p.status ?? "unknown" })),
            defaultCount: plan.defaultTargets.length,
            forceCount: plan.forceTargets.length,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log("# gdwiki enrich — plan");
    console.log("");
    console.log(`drafts (default batch): ${plan.drafts.length}`);
    console.log(`accepted (need --force): ${plan.accepted.length}`);
    console.log(`other status: ${plan.other.length}`);
    console.log(`with --force: ${plan.forceTargets.length} page(s)`);
    console.log("");
    if (plan.drafts.length > 0) {
      console.log("## Drafts");
      for (const p of plan.drafts) {
        console.log(`- ${p.relativePath}`);
      }
      console.log("");
    }
    if (plan.accepted.length > 0) {
      console.log("## Accepted (skipped unless --force)");
      for (const p of plan.accepted) {
        console.log(`- ${p.relativePath}`);
      }
      console.log("");
    }
    if (plan.drafts.length === 0 && plan.accepted.length === 0) {
      console.log("- no wiki pages found");
    } else {
      console.log("Run:");
      console.log("  keryx wiki enrich --all                         # drafts only (provider/model from auth.json)");
      console.log("  keryx wiki enrich --all --force                 # drafts + accepted");
      console.log("  keryx wiki enrich --all --concurrency 4         # parallel page workers");
      console.log("  keryx wiki enrich --all --resume --limit 10     # continue, 10 pages");
      console.log("  keryx wiki enrich --all --refresh-graph         # gdgraph build first");
      console.log("  keryx wiki enrich <page>                        # one page (any status)");
    }
    return;
  }

  const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : undefined;
  const concurrency = concurrencyRaw !== undefined ? Number.parseInt(concurrencyRaw, 10) : undefined;
  const maxOutputTokens = maxTokensRaw !== undefined ? Number.parseInt(maxTokensRaw, 10) : undefined;

  const result = await wikiEnrich({
    cwd: process.cwd(),
    ...(page ? { page } : {}),
    all: args.includes("--all"),
    force,
    resume,
    refreshGraph,
    dryRun,
    validate: !noValidate,
    ...(prompt ? { prompt } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(typeof limit === "number" && Number.isFinite(limit) ? { limit } : {}),
    ...(typeof concurrency === "number" && Number.isFinite(concurrency) ? { concurrency } : {}),
    ...(typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens)
      ? { maxOutputTokens }
      : {}),
    onPage: defaultEnrichProgress,
  });

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.failed > 0 ? 1 : 0;
    return;
  }

  console.log("# gdwiki enrich");
  console.log("");
  console.log(`provider: ${result.provider} (${result.model})`);
  console.log(`credential available: ${result.credentialAvailable ? "yes" : "no"}`);
  console.log(`concurrency: ${result.concurrency}`);
  console.log(
    `mode: ${page ? `page ${page}` : force ? "batch --force (all statuses)" : "batch drafts only"}` +
      (resume ? " +resume" : "") +
      (refreshGraph ? " +refresh-graph" : ""),
  );
  console.log(
    `enriched: ${result.enriched}  dry-run: ${result.dryRun}  skipped: ${result.skipped}  failed: ${result.failed}`,
  );
  console.log("");
  for (const entry of result.pages) {
    const note = entry.reason ? ` — ${entry.reason}` : "";
    console.log(`- ${entry.action}: ${entry.path}${note}`);
  }
  if (result.pages.length === 0) {
    console.log(
      force
        ? "- no wiki pages to enrich"
        : "- no draft pages to enrich (use --force for accepted, or --page <slug> for one page)",
    );
  }
  process.exitCode = result.failed > 0 ? 1 : 0;
}

async function runBacklinks(args: string[]): Promise<void> {
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    console.error('Usage: keryx wiki backlinks <wiki-page-or-code-file>');
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const pathMod = (await import("node:path")).default;
  const { wikiPagesForFile } = await import("../wiki/service");

  // Normalize the query to a repo-relative posix path (accept a wiki path or a
  // code file path relative to the repo root).
  const targetRel = pathMod.relative(cwd, pathMod.resolve(cwd, target)).split(pathMod.sep).join("/");
  const wikiBacklinks = await wikiPagesForFile(cwd, targetRel);

  console.log(`# backlinks: ${targetRel}`);
  console.log("");
  console.log(`## Wiki pages linking here (${wikiBacklinks.length})`);
  if (wikiBacklinks.length === 0) console.log("- none");
  for (const from of wikiBacklinks) console.log(`- ${from}`);

  // Graph tie-in: if the target is a code file in the graph, also show the code
  // that depends on it — unifying the wiki knowledge graph with gdgraph.
  const { loadGraph } = await import("../gdgraph/query");
  const graph = await loadGraph(cwd);
  const node = graph.nodes.find((n) => n.kind === "file" && n.path === targetRel);
  if (node) {
    const dependents = graph.edges.filter((e) => e.to === node.id).map((e) => e.from).sort();
    console.log("");
    console.log(`## Code that imports this file (${dependents.length}, via gdgraph)`);
    if (dependents.length === 0) console.log("- none");
    for (const dep of dependents.slice(0, 40)) console.log(`- ${dep}`);
    if (dependents.length > 40) console.log(`- … +${dependents.length - 40} more`);
  }
}

function printHelp(): void {
  console.log(`keryx wiki

Usage:
  keryx wiki status
  keryx wiki new <type> <slug> --title "<title>" [--force]
  keryx wiki collect [--force] [--changed [--since <ref>]] [--limit <n>]
  keryx wiki index
  keryx wiki check-links
  keryx wiki validate
  keryx wiki ask "<question>" [--k <n>] [--rerank] [--as-of <YYYY-MM-DD>] [--json]
                         # --as-of admits non-current wiki pages/memory entries
                         # too, each marked HISTORICAL with its lifecycle state
                         # and reason; without it, only current items are cited
  keryx wiki enrich [<page>|--all] [--force] [--list] [--resume] [--limit N] [--concurrency N]
                    [--refresh-graph] [--max-tokens N] [--no-validate]
                    [--prompt "<i>"] [--provider <p>] [--model <m>] [--dry-run] [--json]
                         # defaults: drafts only; provider/model from auth.json; validate on;
                         # concurrency 1 (raise for parallel page swarm)
                         # rewrites prose only — Status is always left exactly as it was
                         # before the run; enrich can never itself accept a page (issue #391)
  keryx wiki sections [--json]
  keryx wiki sections resolve "<pageId>#<sectionId>" [--json]
  keryx wiki sections sync [--dry-run] [--accept-reoccupation <ref>[,<ref>…]] [--json]
  keryx wiki sections migrate [--page <path>] [--dry-run] [--json]
                         # sections are the retrieval unit: a term in Details,
                         # Main flows or Constraints is findable, and each one
                         # has an address. 'resolve' never redirects a removed
                         # id to a same-named section; 'sync' is the only write.
                         # 'migrate' inserts identity markers and changes
                         # nothing else, byte for byte.
                         # --accept-reoccupation is the ONLY exit from a
                         # reoccupied identity (a removed id whose address now
                         # holds a different document). It lifts those
                         # tombstones and records, permanently, that the
                         # content was SUBSTITUTED and not restored — which
                         # 'sections resolve' then prints on every read.
                         # Accepting a page ref accepts its sections too.
  keryx wiki context
  keryx wiki backlinks <wiki-page-or-code-file>
  keryx wiki freshness [--since <rev>] [--all] [--json]
                                  # which pages the code moved under. WRITES, despite being a
                                  # report: it overwrites data/wiki/freshness/latest.json and
                                  # latest.md, and it CONSUMES the accumulated backlog —
                                  # data/wiki/freshness-queue.jsonl is deleted once the report
                                  # is on disk. Pass --since <rev> to report a range without
                                  # touching the queue. The read-only way to ask the same
                                  # question is the wiki_freshness agent op, which reads the
                                  # last report and writes nothing.
  keryx wiki refresh [--page <p>] [--force] [--dry-run] [--json]
                                  # regenerate managed ## Reference blocks (WRITES pages).
                                  # --dry-run reports what would change and writes nothing.
                                  # Stamps VerifiedAt only when the code graph is current:
                                  # a stale graph refreshes the block but advances no stamp,
                                  # and a graph whose state cannot be determined leaves the
                                  # block untouched.
  keryx wiki verify --page <path> | --baseline
                                  # stamp provenance; refuses to stamp the corpus silently
  keryx wiki migrate-markers      # one-off: wrap existing Reference sections in markers

Page types:
  architecture, domain-model, business-rule, user-scenario,
  component, service, integration, decision
`);
}


/**
 * `keryx wiki freshness` — the drift backlog (LWG-10, flow 226).
 *
 * Always exits 0. This is a report, not a gate: a blocking freshness check
 * invites updating a page so CI passes, which manufactures filler faster than
 * drift manufactures staleness. The gate decision belongs to a project, in
 * `ci-protocol.md`, not to this command.
 *
 * CORRECTION (flow 236 T8): this comment and the `--help` line above it both
 * called the command a "read-only backlog" for three flows. It is not, and has
 * never been. `runFreshness` (`wiki/freshness/run.ts`) persists `latest.json`
 * and `latest.md`, and — when it drained anything — calls `clearQueue`, which
 * DELETES `freshness-queue.jsonl`. A phase-4 inventory pass deliberately did
 * not run this command for exactly that reason: a real queue existed in the
 * tree and the "read-only" command would have consumed it. That is the same
 * defect class this programme already found once, in a command that declared
 * itself non-mutating and wrote the user's query to disk. The declaration is
 * now the true one; the behaviour is unchanged, because the queue drain IS
 * the intended semantics (the backlog is consumed by being reported) and
 * silently retaining it would break the "report the range since you last
 * looked" contract in the other direction.
 */
async function runFreshnessCommand(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const since = optionValue(args, "--since");
  const report = await runFreshness({ cwd, ...(since ? { since } : {}) });

  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(renderMarkdown(report, { all: args.includes("--all") }));
}

/**
 * What git can say about HEAD — never a fabricated sha, and never "no git"
 * for a repository that is present but broken.
 *
 * AFC-22 (flow 236 T13, F236-02): this returned `string | undefined`, and
 * `undefined` was printed downstream as "(no git; scope hash only)" and read
 * by `verifyPages`/`refreshPages` as "the supported git-free project". Both
 * were wrong for a repository whose git had failed, which is the case where
 * the freshness guards matter most. `resolveGitHead` separates the four
 * outcomes; this command layer only forwards them.
 */
const currentHead = resolveGitHead;

/**
 * `keryx wiki refresh` (LWG-11) — deterministic, model-free regeneration of
 * managed Reference blocks. Prose is never touched.
 */
async function runRefreshCommand(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const page = optionValue(args, "--page");
  const head = await currentHead(cwd);
  const result = await refreshPages({
    cwd,
    ...(page ? { page } : {}),
    force: args.includes("--force"),
    dryRun: args.includes("--dry-run"),
    head,
  });

  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const dry = args.includes("--dry-run") ? " (dry run)" : "";
  process.stdout.write(
    `refreshed ${result.refreshed}, unchanged ${result.unchanged}, conflicts ${result.conflicts}` +
      `, stale source ${result.staleSource}${dry}\n`,
  );
  for (const entry of result.pages) {
    if (entry.action === "refreshed") {
      process.stdout.write(`  refreshed  ${entry.path} -> ${entry.version}\n`);
    } else if (entry.action === "conflict") {
      process.stdout.write(`  CONFLICT   ${entry.path}: ${entry.reason}\n`);
    } else if (entry.action === "stale-source") {
      process.stdout.write(`  PRESERVED  ${entry.path}: ${entry.reason}\n`);
    }
  }
  if (result.conflicts > 0) {
    process.stdout.write(
      "\nA conflict means the block was edited by hand. Review it, then pass --force to overwrite.\n",
    );
  }
  // AFC-08: the run's own input condition, stated every time it is not fresh.
  // A refresh over a stale graph is legitimate work — the block it writes is
  // what that graph says — but the operator has to be told, because the only
  // other trace of it is a `VerifiedAt` line that did NOT appear.
  if (head.kind === "failed") {
    // Never silently reported as "no git": a repository is present here and
    // could not answer, which is a fault to repair rather than a project
    // configuration to accommodate (AFC-22, flow 236 T13).
    process.stdout.write(`\ngit: this is a git repository, but git could not answer — ${head.detail}\n`);
  }
  if (result.source.status !== "fresh") {
    process.stdout.write(
      `\nsource: ${result.source.status} — VerifiedAt was not stamped on any page.\n`,
    );
    for (const reason of result.source.reasons) {
      process.stdout.write(`  - ${reason}\n`);
    }
    process.stdout.write("Run `keryx gdgraph build` to refresh the source, then re-run.\n");
  }
}

/**
 * `keryx wiki verify` — stamp provenance without touching content. This is
 * what turns the freshness report from all-`unknown` into a real backlog, and
 * it deliberately regenerates nothing: verification and repair are different
 * claims about a page.
 */
async function runVerifyCommand(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const page = optionValue(args, "--page");
  const head = await currentHead(cwd);
  let stamped;
  try {
    stamped = await verifyPages({
      cwd,
      ...(page ? { page } : {}),
      head,
      baseline: args.includes("--baseline"),
    });
  } catch (error) {
    process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return;
  }

  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(stamped, null, 2)}\n`);
    return;
  }
  const what = args.includes("--baseline") ? "baselined" : "verified";
  // `describeHead` — never a bare `head ? ... : "(no git; scope hash only)"`,
  // which printed an absence of git that had not been established.
  process.stdout.write(`${what} ${stamped.length} page(s) ${describeHead(head)}\n`);
  if (args.includes("--baseline")) {
    process.stdout.write(
      "  (a baseline is a measurement starting line, not a claim that these pages were read)\n",
    );
  }
  for (const entry of stamped) {
    process.stdout.write(`  ${entry.path}\n`);
  }
}

/** `keryx wiki migrate-markers` — one-off, idempotent, authors no content. */
async function runMigrateMarkersCommand(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const result = await migrateMarkers(cwd, { dryRun: args.includes("--dry-run") });

  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const dry = args.includes("--dry-run") ? " (dry run)" : "";
  process.stdout.write(
    `migrated ${result.migrated.length}, already ${result.alreadyMigrated.length}, ` +
      `no Reference section ${result.skippedNoSection.length}, malformed ${result.malformed.length}${dry}\n`,
  );
  for (const entry of result.malformed) {
    process.stdout.write(`  MALFORMED  ${entry.path}: ${entry.reason}\n`);
  }
  for (const entry of result.skippedNoSection) {
    process.stdout.write(`  no section ${entry}\n`);
  }
}
