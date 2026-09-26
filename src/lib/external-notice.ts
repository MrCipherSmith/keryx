// Flow 346, design §5 — the one-time consent notice: the first time a Jev
// step actually sends data BECAUSE OF the default-on behaviour (not an
// explicit per-project opt-in), a caller shows one line and records that it
// did, per project, so the line is never repeated for that project.
//
// Storage mirrors `src/harness/routing/trust.ts`'s `RoutingTrustStore`
// exactly: a small user-global JSON file under the keryx config dir, keyed
// by the resolved (absolute) project root — the same "operator-owned state
// about a project, kept out of the project's own tree" shape that file
// already established, rather than a new pattern.
import path from "node:path";
import { ensureKeryxConfigDir, keryxConfigDir, readConfigFile, writeOwnerOnlyFileAtomic } from "./config-dir";

/** The exact line shown (design §5) — TUI transcript/sidebar, and CLI stderr. */
export const EXTERNAL_DEFAULT_NOTICE_TEXT = "Jev is on here: redacted code/CI snippets go to OpenRouter/TypeSafe. Turn off: /external off";

export function externalNoticeFile(configDir?: string): string {
  return path.join(keryxConfigDir(configDir), "external-notice.json");
}

/** The key a project is recorded under — the resolved absolute path, same normalization `routingTrustKey` uses. */
export function externalNoticeKey(cwd: string): string {
  return path.resolve(cwd);
}

interface ExternalNoticeStore {
  shown?: Record<string, boolean>;
}

function loadExternalNoticeStore(configDir?: string): Record<string, boolean> {
  const read = readConfigFile(externalNoticeFile(configDir));
  if (!read.ok) return {};
  try {
    const parsed = JSON.parse(read.text) as ExternalNoticeStore;
    const shown = parsed.shown;
    if (shown === undefined || typeof shown !== "object" || shown === null) return {};
    const clean: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(shown)) {
      if (value === true) clean[key] = true;
    }
    return clean;
  } catch {
    // A store that cannot be read/parsed has recorded nothing readable — the
    // safest reading is "not shown yet" (the notice may repeat once, which
    // is far better than never showing it because of a corrupt file).
    return {};
  }
}

/** Has the default-on consent notice already been shown for this project? */
export function hasShownExternalDefaultNotice(cwd: string, configDir?: string): boolean {
  return loadExternalNoticeStore(configDir)[externalNoticeKey(cwd)] === true;
}

/** Record that it has now been shown for this project. Best-effort — a write failure never blocks the caller that is about to print the line anyway. */
export function recordExternalDefaultNoticeShown(cwd: string, configDir?: string): void {
  try {
    const file = externalNoticeFile(configDir);
    const shown = loadExternalNoticeStore(configDir);
    shown[externalNoticeKey(cwd)] = true;
    ensureKeryxConfigDir(configDir);
    writeOwnerOnlyFileAtomic(file, `${JSON.stringify({ shown }, null, 2)}\n`);
  } catch {
    // Best-effort, like every other config-dir writer in this codebase.
  }
}

/**
 * The one call every caller needs: `true` exactly once per project — the
 * first call after which the caller should print {@link
 * EXTERNAL_DEFAULT_NOTICE_TEXT} — and `false` on every call after that (for
 * this project), including a call whose OWN write above failed (so a
 * persistently-unwritable store degrades to "show it every time" rather
 * than "never record, so multiple co-running processes could all show it
 * once each" — the annoyance is bounded and visible, the alternative
 * silently loses the notice's own guarantee).
 */
export function shouldShowExternalDefaultNotice(cwd: string, configDir?: string): boolean {
  if (hasShownExternalDefaultNotice(cwd, configDir)) return false;
  recordExternalDefaultNoticeShown(cwd, configDir);
  return true;
}
