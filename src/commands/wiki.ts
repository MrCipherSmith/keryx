import {
  wikiCheckLinks,
  wikiCollect,
  wikiCreatePage,
  wikiGenerateIndex,
  wikiStatus,
  wikiValidate,
} from "../wiki/service";
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
      'Usage: gd-metapro wiki new <type> <slug> --title "<title>" [--force]',
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
    console.error("Usage: gd-metapro wiki collect [--force] [--limit <n>]");
    process.exitCode = 1;
    return;
  }

  const result = await wikiCollect({
    cwd: process.cwd(),
    force: args.includes("--force"),
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

function printHelp(): void {
  console.log(`gd-metapro wiki

Usage:
  gd-metapro wiki status
  gd-metapro wiki new <type> <slug> --title "<title>" [--force]
  gd-metapro wiki collect [--force] [--limit <n>]
  gd-metapro wiki index
  gd-metapro wiki check-links
  gd-metapro wiki validate

Page types:
  architecture, domain-model, business-rule, user-scenario,
  component, service, integration, decision
`);
}
