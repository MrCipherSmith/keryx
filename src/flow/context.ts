import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { loadMemoryConfig } from "../memory/config";
import { searchEntries } from "../memory/search";
import { collectEntries } from "../memory/store";
import type { TrackerAdapter, TrackerRef } from "./types";

// Deterministic context collection for `flow init` (spec section 5, D7).
// The flow-init skill layers cognitive work (formalization, brainstorm,
// interview) on top of this.

export async function collectContext(input: {
  cwd: string;
  title: string;
  issueRef: TrackerRef | null;
  issueUrl: string | null;
  tracker: TrackerAdapter | null;
  now: Date;
}): Promise<{ markdown: string; notes: string[]; issueTitle: string | null }> {
  const { cwd, title, issueRef, issueUrl, tracker, now } = input;
  const notes: string[] = [];
  const sections: string[] = [];
  let issueTitle: string | null = null;

  // 1. Issue body via tracker adapter.
  if (issueRef && tracker) {
    const issue = await tracker.fetchIssue(issueRef);
    if (issue) {
      issueTitle = issue.title || null;
      sections.push(
        `## Source Issue\n\n${issueUrl}\n\n### ${issue.title}\n\n${issue.body || "(empty body)"}`,
      );
      notes.push(`issue fetched: ${issueRef.repo}#${issueRef.number}`);
    } else {
      sections.push(`## Source Issue\n\n${issueUrl}\n\n_(could not fetch issue body)_`);
      notes.push("issue fetch failed; add the body manually");
    }
  } else if (issueUrl) {
    sections.push(`## Source Issue\n\n${issueUrl}\n\n_(tracker unavailable; add the body manually)_`);
    notes.push("tracker unavailable (gh missing or unauthenticated)");
  }

  // 2. Related memory (accepted first, deterministic ranking).
  try {
    const config = await loadMemoryConfig(cwd);
    const entries = await collectEntries(cwd);
    const results = searchEntries(entries, title, { limit: 5 }, config, now);
    if (results.length > 0) {
      sections.push(
        `## Related Memory\n\n${results
          .map(
            (item) =>
              `- [${item.entry.status}/${item.entry.type}] ${item.entry.title} - \`.metaproject/memory/${item.entry.relativePath}\``,
          )
          .join("\n")}`,
      );
      notes.push(`memory: ${results.length} related entries`);
    }
  } catch {
    // memory module absent - fine
  }

  // 3. gdgraph artifacts.
  const graphRefs: string[] = [];
  for (const rel of [
    ".metaproject/data/gdgraph/artifacts/summary.md",
    ".metaproject/data/gdgraph/artifacts/module-map.json",
  ]) {
    if (await pathExists(path.join(cwd, rel))) {
      graphRefs.push(`- \`${rel}\``);
    }
  }
  if (graphRefs.length > 0) {
    sections.push(`## Code Graph\n\n${graphRefs.join("\n")}\n\nUse \`gd-metapro gdgraph affected <file>\` for blast radius.`);
  }

  // 4. Health status.
  const healthLatest = path.join(cwd, ".metaproject", "data", "health", "artifacts", "latest.json");
  if (await pathExists(healthLatest)) {
    try {
      const report = JSON.parse(await readFile(healthLatest, "utf8")) as {
        gate?: { status?: string };
        generatedAt?: string;
      };
      sections.push(
        `## Code Health\n\n- gate: ${report.gate?.status ?? "unknown"} (as of ${report.generatedAt ?? "?"})\n- refresh: \`gd-metapro health run\``,
      );
    } catch {
      // ignore corrupt report
    }
  }

  // 5. Enabled modules.
  const manifestPath = path.join(cwd, ".metaproject", "metaproject.json");
  if (await pathExists(manifestPath)) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        modules?: Record<string, { enabled?: boolean }>;
      };
      const enabled = Object.entries(manifest.modules ?? {})
        .filter(([, config]) => config?.enabled)
        .map(([name]) => name);
      if (enabled.length > 0) {
        sections.push(`## Enabled Metaproject Modules\n\n${enabled.map((name) => `- ${name}`).join("\n")}`);
      }
    } catch {
      // ignore
    }
  }

  const markdown = `# Context

Collected deterministically by \`gd-metapro flow init\` at ${now.toISOString()}.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

${sections.join("\n\n") || "_No deterministic context available yet._"}

## Agent Findings

_(flow-init skill appends here)_
`;

  return { markdown, notes, issueTitle };
}
