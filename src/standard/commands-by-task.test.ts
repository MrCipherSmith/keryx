// Flow 303 (AC9): `docs/docs/commands-by-task.md` is GENERATED from
// `HELP_GROUPS`. This is the agreement test: it fails when the checked-in
// page differs from what the table would generate — the guard against
// hand-editing the page, or editing HELP_GROUPS and forgetting to
// regenerate it (`bun scripts/generate-commands-by-task.ts`).
//
// This file reads `docs/docs/**` with `node:fs`, outside `src/`, which is a
// plain file read, not an import — it has no bearing on `import-policy.ts`'s
// zone scan (which only walks `src/`).

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { renderCommandsByTaskMarkdown } from "./help-groups";

const DOCS_PAGE = path.join(import.meta.dir, "../../docs/docs/commands-by-task.md");
const MKDOCS = path.join(import.meta.dir, "../../mkdocs.yml");

describe("AC9: docs/docs/commands-by-task.md agrees with HELP_GROUPS", () => {
  test("the checked-in page equals what the table generates", () => {
    const onDisk = readFileSync(DOCS_PAGE, "utf8");
    const generated = renderCommandsByTaskMarkdown();
    expect(onDisk).toBe(generated);
  });

  test("the page is linked in the mkdocs nav", () => {
    const nav = readFileSync(MKDOCS, "utf8");
    expect(nav).toMatch(/commands-by-task\.md/);
  });

  test("the generated page names every onboarding group and is non-trivial", () => {
    const generated = renderCommandsByTaskMarkdown();
    expect(generated).toContain("# Commands by task");
    expect(generated.length).toBeGreaterThan(1000);
    for (const group of [
      "Start here",
      "Connect a model provider",
      "Look and feel",
      "Working in keryx shell",
      "Project knowledge",
      "Managed work",
      "Automation",
      "External agents, ACP and MCP",
      "Maintenance and diagnostics",
    ]) {
      expect(generated).toContain(`## ${group}`);
    }
  });
});
