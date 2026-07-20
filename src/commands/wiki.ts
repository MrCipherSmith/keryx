import {
  wikiCheckLinks,
  wikiCollect,
  wikiCreatePage,
  wikiGenerateIndex,
  wikiStatus,
  wikiValidate,
} from "../wiki/service";
import { wikiAsk } from "../wiki/ask";
import { optionValue } from "../lib/args";

export async function wikiCommand(args: string[]): Promise<void> {
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
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

  if (command === "ask") {
    await runAsk(args.slice(1));
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
  const { collectPages } = await import("../wiki/service");
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
  const result = await wikiValidate(process.cwd());

  console.log("# gdwiki validate");
  console.log("");
  if (result.ok) {
    console.log("All checks passed.");
    return;
  }

  console.log(`issues: ${result.issues.length}`);
  console.log("");
  for (const issue of result.issues) {
    console.log(`- [${issue.kind}] ${issue.page}: ${issue.message}`);
  }
  process.exitCode = 1;
}

async function runAsk(args: string[]): Promise<void> {
  const question = args.find((arg) => !arg.startsWith("--"));
  if (!question) {
    console.error('Usage: keryx wiki ask "<question>" [--k <n>] [--rerank]');
    process.exitCode = 1;
    return;
  }
  const kValue = optionValue(args, "--k");
  const result = await wikiAsk({
    cwd: process.cwd(),
    question,
    ...(kValue ? { k: Number.parseInt(kValue, 10) } : {}),
    ...(args.includes("--rerank") ? { rerank: true } : {}),
  });

  console.log(result.answerMarkdown);
}

async function runEnrich(args: string[]): Promise<void> {
  const { planWikiEnrich, wikiEnrich } = await import("../wiki/enrich");
  const prompt = optionValue(args, "--prompt");
  const provider = optionValue(args, "--provider");
  const model = optionValue(args, "--model");
  const force = args.includes("--force");
  const listOnly = args.includes("--list");
  // Positional page = first bare token that is neither a flag nor a flag's value.
  const valueFlags = new Set(["--page", "--prompt", "--provider", "--model"]);
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
      console.log("  keryx wiki enrich --all                  # drafts only");
      console.log("  keryx wiki enrich --all --force          # drafts + accepted");
      console.log("  keryx wiki enrich <page>                 # one page (any status)");
    }
    return;
  }

  const result = await wikiEnrich({
    cwd: process.cwd(),
    ...(page ? { page } : {}),
    all: args.includes("--all"),
    force,
    ...(prompt ? { prompt } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    dryRun: args.includes("--dry-run"),
    onPage: (info) => {
      console.error(`[enrich] ${info.index}/${info.total} ${info.path} (${info.status})`);
    },
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
  console.log(`mode: ${page ? `page ${page}` : force ? "batch --force (all statuses)" : "batch drafts only"}`);
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
  keryx wiki ask "<question>" [--k <n>] [--rerank]
  keryx wiki enrich [<page>|--all] [--force] [--list] [--prompt "<i>"] [--provider <p>] [--model <m>] [--dry-run] [--json]
                         # default batch: draft only; --force includes accepted; --list plans without calling the model
  keryx wiki context
  keryx wiki backlinks <wiki-page-or-code-file>

Page types:
  architecture, domain-model, business-rule, user-scenario,
  component, service, integration, decision
`);
}
