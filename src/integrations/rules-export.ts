// Flow 313 (W4 portability), T9: the API `keryx bundle import --render-for`
// (T10, a later task in this same flow) drives to render the canonical
// `.metaproject/rules/**` library into one or more harnesses' own instruction
// files. Thin wrapper over the existing `rules-export` surfaces
// (`surfaces-rules.ts`) and the general installer core (`installer.ts`) —
// install-state for a rendered harness is recorded exactly like any other
// surface install, so `installedRulesExportHarnesses` can read it back
// through the ordinary W5-b install-state files rather than a second,
// bespoke bookkeeping layer.

import { readFile } from "node:fs/promises";
import { pathExists } from "../lib/fs";
import { readInstallState } from "./install-state";
import { installIntegration } from "./installer";
import { HARNESS_ADAPTERS, getHarnessAdapter } from "./registry";
import type { SurfaceAdapter } from "./types";

const RULES_EXPORT_SURFACE_ID = "rules-export";

function rulesExportSurfaceFor(harnessId: string): SurfaceAdapter | undefined {
  return getHarnessAdapter(harnessId)?.surfaces.find((s) => s.id === RULES_EXPORT_SURFACE_ID);
}

/**
 * Orchestrator note (final surgical pass): `pathExists` only asks "is there
 * an entry at this path", not "is it a regular file" — a DIRECTORY sitting
 * where a harness's rules-export target should be (e.g. something else
 * created `CLAUDE.md/` as a directory) passes `pathExists` and then throws an
 * unhandled EISDIR out of `readFile`. Before this fix that crashed the whole
 * `renderRulesForHarnesses` call for EVERY harness in the batch, not just the
 * one with the bad path — defeating this function's own documented promise
 * ("one bad id in a batch does not abort the rest"). Wrapping the read turns
 * it into a named, per-harness `"failed"` result instead, with the path in
 * the message.
 */
async function readTargetFileSafely(file: string): Promise<{ ok: true; content: string } | { ok: false; message: string }> {
  try {
    return { ok: true, content: await readFile(file, "utf8") };
  } catch (error) {
    return { ok: false, message: `${file}: cannot read (${error instanceof Error ? error.message : String(error)})` };
  }
}

export interface RulesExportResult {
  readonly harness: string;
  readonly status: "installed" | "unchanged" | "failed" | "unsupported";
  /** Project-relative path this harness's rules-export surface writes, when it has one. */
  readonly file?: string;
  readonly messages: string[];
}

/**
 * Render (install) the `rules-export` surface for each of `harnessIds`.
 * `"unsupported"` for a harness id that is unknown or that registers no
 * `rules-export` surface at all (never thrown — this call reports per
 * harness, so one bad id in a batch does not abort the rest). `"unchanged"`
 * when the target file's bytes are identical before and after (an install
 * that only re-wrote the SAME managed-block content, e.g. re-running with no
 * rule change) — distinguished by comparing the file's raw content, since
 * `installIntegration` itself always reports `installed` for a successful
 * custom-surface install regardless of whether anything on disk actually
 * changed (`markdown-block.ts`'s `installMarkdownBlock` only writes when the
 * computed content differs from what's on disk). `opts.dryRun` skips this
 * before/after comparison (nothing is written) and always reports
 * `"installed"` for a surface that resolved successfully.
 */
export async function renderRulesForHarnesses(
  root: string,
  harnessIds: readonly string[],
  opts: { readonly dryRun?: boolean } = {},
): Promise<RulesExportResult[]> {
  const results: RulesExportResult[] = [];

  for (const harnessId of harnessIds) {
    const surface = rulesExportSurfaceFor(harnessId);
    if (!surface) {
      results.push({
        harness: harnessId,
        status: "unsupported",
        messages: [`"${harnessId}" has no rules-export surface`],
      });
      continue;
    }

    const file = surface.settingsFile ? surface.settingsFile(root) : undefined;
    let before: string | undefined;
    if (!opts.dryRun && file && (await pathExists(file))) {
      const read = await readTargetFileSafely(file);
      if (!read.ok) {
        results.push({
          harness: harnessId,
          status: "failed",
          ...(surface.relativePath ? { file: surface.relativePath } : {}),
          messages: [read.message],
        });
        continue;
      }
      before = read.content;
    }

    const installResult = await installIntegration(root, harnessId, {
      surfaces: [RULES_EXPORT_SURFACE_ID],
      ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
    });

    if (installResult.errors.length > 0) {
      results.push({
        harness: harnessId,
        status: "failed",
        ...(surface.relativePath ? { file: surface.relativePath } : {}),
        messages: installResult.errors,
      });
      continue;
    }

    const surfaceResult = installResult.results.find((r) => r.surfaceId === RULES_EXPORT_SURFACE_ID);
    if (!surfaceResult || surfaceResult.status === "failed") {
      results.push({
        harness: harnessId,
        status: "failed",
        ...(surface.relativePath ? { file: surface.relativePath } : {}),
        messages: surfaceResult?.errors ?? [`no rules-export result recorded for "${harnessId}"`],
      });
      continue;
    }

    let status: RulesExportResult["status"] = "installed";
    if (!opts.dryRun && file) {
      let after: string | undefined;
      if (await pathExists(file)) {
        const read = await readTargetFileSafely(file);
        if (!read.ok) {
          results.push({
            harness: harnessId,
            status: "failed",
            ...(surface.relativePath ? { file: surface.relativePath } : {}),
            messages: [read.message],
          });
          continue;
        }
        after = read.content;
      }
      status = after === before ? "unchanged" : "installed";
    }

    results.push({
      harness: harnessId,
      status,
      ...(surface.relativePath ? { file: surface.relativePath } : {}),
      messages: surfaceResult.warnings,
    });
  }

  return results;
}

/**
 * Harness ids whose `rules-export` surface is currently installed, read back
 * from W5-b install-state (`.metaproject/data/integrations/install-state/<runtime>.json`)
 * — never a filesystem probe, so this answers "did keryx install it" rather
 * than "does a plausibly-similar file happen to exist". Sorted for
 * deterministic output.
 */
export async function installedRulesExportHarnesses(root: string): Promise<string[]> {
  const harnessIds: string[] = [];
  for (const adapter of HARNESS_ADAPTERS) {
    if (!adapter.surfaces.some((s) => s.id === RULES_EXPORT_SURFACE_ID)) continue;
    const state = await readInstallState(root, adapter.id);
    if (state?.installedModules.some((r) => r.moduleId === RULES_EXPORT_SURFACE_ID)) {
      harnessIds.push(adapter.id);
    }
  }
  return harnessIds.sort();
}
