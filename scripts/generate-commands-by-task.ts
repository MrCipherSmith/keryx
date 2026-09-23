#!/usr/bin/env bun
// Regenerate docs/docs/commands-by-task.md from src/standard/help-groups.ts
// (flow 303, AC9). Deterministic: the same HELP_GROUPS table `keryx help`
// and the TUI's `/help` modal render from, as Markdown.
//
// `src/standard/commands-by-task.test.ts` fails when the checked-in page
// differs from what this script would write, so a HELP_GROUPS edit that
// forgets to regenerate the page is caught rather than shipped stale.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { renderCommandsByTaskMarkdown } from "../src/standard/service";

const OUT = path.resolve(import.meta.dir, "../docs/docs/commands-by-task.md");

writeFileSync(OUT, renderCommandsByTaskMarkdown());
console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
