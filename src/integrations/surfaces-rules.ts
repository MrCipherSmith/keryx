// Flow 313 (W4 portability), T9: the `rules-export` surface — one per
// harness, OPT-IN (`optIn: true`) — that renders the canonical
// `.metaproject/rules/**` library into that harness's own instruction file as
// a managed `<!-- keryx:rules -->` block (index only: path + description per
// rule, never rule bodies). Spec:
// docs/requirements/keryx-agent-platform-expansion/workstreams/W4-portability.md
// "Canonical instructions → per-harness instruction files".
//
// Distinct from `SUBSYSTEM_INSTRUCTIONS`'s `markdown-block.ts` surfaces
// (gemini-cli/kiro/github-copilot-agent's `keryx:instructions` pointer): this
// surface uses `markdown-block.ts`'s parameterised `ManagedBlockSpec`
// (`RULES_BLOCK_START_MARKER`/`RULES_BLOCK_END_MARKER` from
// `../rules/export-render`) so a file already carrying a `keryx:instructions`
// block (GEMINI.md, `.github/copilot-instructions.md`) keeps that OTHER block
// byte-for-byte untouched when this surface installs/uninstalls its own.
//
// `optIn: true` on every surface below means `keryx integrations install
// --runtime <id>` with no `--surface` is completely unchanged by this file's
// existence — only `--surface rules-export` (or `--surface instructions`,
// its flag) reaches these, same discipline `surfaces-agents.ts`'s `agents`
// surfaces already use.

import path from "node:path";
import { collectCanonicalRules, renderRulesBlockBody, RULES_BLOCK_END_MARKER, RULES_BLOCK_START_MARKER } from "../rules/export-render";
import {
  inspectMarkdownBlock,
  installMarkdownBlock,
  probeMarkdownBlock,
  uninstallMarkdownBlock,
  type ManagedBlockSpec,
} from "./markdown-block";
import { SUBSYSTEM_RULES_EXPORT, type Confidence, type SurfaceAdapter } from "./types";

export const LAST_VERIFIED_RULES_EXPORT = "2026-09-24";

/** Builds this call's `ManagedBlockSpec` by collecting+rendering the CURRENT rule set — never cached, so a rule added/removed since the last install is reflected on the next one. */
async function rulesSpec(root: string): Promise<ManagedBlockSpec> {
  const rules = await collectCanonicalRules(root);
  const body = renderRulesBlockBody(rules);
  return { startMarker: RULES_BLOCK_START_MARKER, endMarker: RULES_BLOCK_END_MARKER, render: () => body };
}

async function installRulesExport(root: string, relativePath: string, frontMatter?: string): Promise<string[]> {
  return installMarkdownBlock(root, relativePath, frontMatter, await rulesSpec(root));
}

async function uninstallRulesExport(root: string, relativePath: string, frontMatter?: string): Promise<boolean> {
  return uninstallMarkdownBlock(root, relativePath, frontMatter, await rulesSpec(root));
}

async function probeRulesExport(root: string, relativePath: string): Promise<string[]> {
  return probeMarkdownBlock(root, relativePath, await rulesSpec(root));
}

async function inspectRulesExport(root: string, relativePath: string) {
  return inspectMarkdownBlock(root, relativePath, await rulesSpec(root));
}

interface RulesExportParams {
  readonly relativePath: string;
  readonly frontMatter?: string;
  readonly confidence: Confidence;
  readonly sourceDocs: readonly string[];
  readonly riskNotes?: readonly string[];
}

function rulesExportSurface(params: RulesExportParams): SurfaceAdapter {
  const { relativePath, frontMatter, confidence, sourceDocs, riskNotes } = params;
  return {
    id: "rules-export",
    flag: "instructions",
    subsystem: SUBSYSTEM_RULES_EXPORT,
    sentinel: "keryx:rules",
    confidence,
    ...(riskNotes !== undefined ? { riskNotes } : {}),
    sourceDocs,
    optIn: true,
    settingsFile: (root) => path.join(root, ...relativePath.split("/")),
    relativePath,
    label: relativePath,
    slots: [],
    customInstall: (root) => installRulesExport(root, relativePath, frontMatter),
    customUninstall: (root) => uninstallRulesExport(root, relativePath, frontMatter),
    probe: (root) => probeRulesExport(root, relativePath),
    inspect: (root) => inspectRulesExport(root, relativePath),
  };
}

/**
 * Claude Code — CLAUDE.md is Keryx's own primary entrypoint file (this very
 * repository's own `CLAUDE.md` bootstrap block, `agent-entrypoint-blocks.ts`)
 * — VERIFIED that Claude Code reads it end-to-end, not merely third-party
 * reported.
 */
export const RULES_EXPORT_CLAUDE: SurfaceAdapter = rulesExportSurface({
  relativePath: "CLAUDE.md",
  confidence: "verified",
  sourceDocs: ["https://code.claude.com/docs/en/memory"],
});

/**
 * Codex — AGENTS.md is the cross-tool convention Codex documents reading
 * (https://agents.md/) and this repo's own `AGENTS.md` entrypoint already
 * relies on — VERIFIED.
 */
export const RULES_EXPORT_CODEX: SurfaceAdapter = rulesExportSurface({
  relativePath: "AGENTS.md",
  confidence: "verified",
  sourceDocs: ["https://agents.md/", "https://developers.openai.com/codex/"],
});

/**
 * gemini-cli — GEMINI.md, same file and same doc `INSTRUCTIONS_GEMINI_CLI`
 * (`surfaces-w5b.ts`) already cites — EXPERIMENTAL, same caveat: whether
 * Gemini CLI reads it end-to-end beyond the documented `context.fileName`
 * option is not independently confirmed here.
 */
export const RULES_EXPORT_GEMINI_CLI: SurfaceAdapter = rulesExportSurface({
  relativePath: "GEMINI.md",
  confidence: "experimental",
  sourceDocs: ["https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md"],
  riskNotes: [
    "Whether Gemini CLI actually reads GEMINI.md end-to-end (beyond the documented context.fileName option) is not independently confirmed here.",
  ],
});

/**
 * github-copilot-agent — `.github/copilot-instructions.md`, same file and
 * docs `INSTRUCTIONS_GITHUB_COPILOT_AGENT` (`surfaces-w5b.ts`) cites —
 * EXPERIMENTAL: whether the Copilot CODING AGENT (as opposed to the Copilot
 * CLI/IDE chat) reads this file the same way is not independently confirmed.
 * The rules-export block is appended into the existing file with NO front
 * matter (the file's documented shape carries none).
 */
export const RULES_EXPORT_GITHUB_COPILOT_AGENT: SurfaceAdapter = rulesExportSurface({
  relativePath: ".github/copilot-instructions.md",
  confidence: "experimental",
  sourceDocs: [
    "https://docs.github.com/en/copilot/how-tos/configure-custom-instructions-in-your-ide/add-repository-instructions-in-your-ide",
    "https://github.blog/changelog/2025-08-28-copilot-coding-agent-now-supports-agents-md-custom-instructions/",
  ],
  riskNotes: [
    "Whether the Copilot coding agent (as opposed to the Copilot CLI/IDE chat) reads .github/copilot-instructions.md the same way is not independently confirmed here.",
  ],
});

const CURSOR_RULES_FRONT_MATTER = "---\ndescription: Keryx canonical project rules index\nalwaysApply: true\n---\n\n";

/**
 * Cursor — project rules live under `.cursor/rules/*.mdc` with a YAML front
 * matter carrying `description`/`alwaysApply` (among other documented
 * fields) — EXPERIMENTAL here: the exact set of front-matter keys Cursor
 * tolerates on an unknown/extra key is not independently confirmed.
 */
export const RULES_EXPORT_CURSOR: SurfaceAdapter = rulesExportSurface({
  relativePath: ".cursor/rules/keryx-rules.mdc",
  frontMatter: CURSOR_RULES_FRONT_MATTER,
  confidence: "experimental",
  sourceDocs: ["https://docs.cursor.com/context/rules"],
  riskNotes: [
    "Cursor's exact tolerance for extra/unknown .mdc front-matter keys alongside description/alwaysApply is not independently confirmed here — verify on a live install.",
  ],
});

const KIRO_RULES_FRONT_MATTER = "---\ninclusion: always\n---\n\n";

/**
 * Kiro — steering files, same directory `INSTRUCTIONS_KIRO` (`surfaces-w5b.ts`)
 * already writes into, with `inclusion: always` front matter —
 * EXPERIMENTAL, same caveat: open Kiro issues report `inclusion` modes are
 * not always honoured.
 */
export const RULES_EXPORT_KIRO: SurfaceAdapter = rulesExportSurface({
  relativePath: ".kiro/steering/keryx-rules.md",
  frontMatter: KIRO_RULES_FRONT_MATTER,
  confidence: "experimental",
  sourceDocs: ["https://kiro.dev/docs/steering/"],
  riskNotes: ["Open Kiro issues report that steering file `inclusion` modes are not always honoured, even with `inclusion: always` set — verify on a live install."],
});

const WINDSURF_RULES_FRONT_MATTER = "---\ntrigger: always_on\n---\n\n";

/**
 * Windsurf — workspace rules under `.windsurf/rules/*.md`, `trigger:
 * always_on` front matter always applies the rule with no manual/glob
 * condition — EXPERIMENTAL: not independently confirmed against a live
 * install here.
 */
export const RULES_EXPORT_WINDSURF: SurfaceAdapter = rulesExportSurface({
  relativePath: ".windsurf/rules/keryx-rules.md",
  frontMatter: WINDSURF_RULES_FRONT_MATTER,
  confidence: "experimental",
  sourceDocs: ["https://docs.windsurf.com/windsurf/cascade/memories"],
  riskNotes: ["Windsurf's exact handling of an unrecognised trigger value or extra front-matter keys is not independently confirmed here — verify on a live install."],
});
