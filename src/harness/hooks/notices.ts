// Session-start text for hook config load results (R700-01, flow 319, lane A).
//
// "Never auto-trust, never prompt outside `keryx hooks trust`" (D6) only
// closes the hole if the operator can SEE that something did not run. A
// runtime that silently drops untrusted hooks is quieter than one that runs
// them, not safer — the operator has no way to notice the file changed
// under them, or that a hook they expect never fires. This module turns a
// `LoadHookConfigResult` into the lines every surface (TUI, readline, ACP,
// serve, trigger-dispatch/-agent-task) prints, so the wording lives in one
// place instead of drifting per call site.
import { terminalSafe } from "../../lib/terminal-safe";
import type { HookConfigDiagnostic, LoadHookConfigResult } from "./config";

export type HookNoticeSurface = "terminal" | "headless";

function pluralHooks(n: number): string {
  return n === 1 ? "hook" : "hooks";
}

// R1-02 (flow 319 review round 1): `h.id` comes from a hooks file. The `id`
// schema pattern (`^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$`) already excludes
// control/bidi/zero-width characters today, but `terminalSafe` is applied
// here too as a defence that does not depend on that schema never loosening
// — the notice is the one place EVERY surface (TUI, readline, ACP, serve,
// trigger-dispatch) shows the same text, so getting it right once covers
// them all.
function describeIds(hooks: readonly { id: string; event: string; runsIn: "sandbox" | "unsandboxed" }[]): string {
  return hooks
    .map((h) => `${terminalSafe(h.id).text} (${h.event}${h.runsIn === "unsandboxed" ? ", unsandboxed" : ""})`)
    .join(", ");
}

function trustHint(surface: HookNoticeSurface, projectRoot: string): string {
  return surface === "terminal"
    ? "  Review every command and trust them with: keryx hooks trust"
    : `  This session cannot ask. Trust them from a terminal in ${projectRoot} with: keryx hooks trust`;
}

/**
 * The lines to show at session start (or any other point a caller re-checks
 * the load result) for one `LoadHookConfigResult`. Order: load failure (if
 * any — terminal, nothing else applies), trust notice, warnings, then
 * gate-off banners. Empty array when there is nothing to say (typical case:
 * a valid, trusted-or-hookless config).
 */
export function formatHookLoadNotices(
  result: LoadHookConfigResult,
  opts: { projectRoot: string; userFile: string; surface: HookNoticeSurface },
): string[] {
  if (!result.ok) {
    return [formatLoadFailure(result.diagnostics)];
  }

  const lines: string[] = [];
  const { projectHooks } = result;
  const enabledHooks = projectHooks.hooks.filter((h) => h.enabled);
  if (projectHooks.state === "untrusted" && enabledHooks.length > 0) {
    lines.push(
      `keryx hooks: ${projectHooks.filePath} defines ${enabledHooks.length} command ${pluralHooks(
        enabledHooks.length,
      )} that did not run because this project's hooks are not trusted: ${describeIds(enabledHooks)}`,
    );
    lines.push(trustHint(opts.surface, opts.projectRoot));
  } else if (projectHooks.state === "changed" && enabledHooks.length > 0) {
    lines.push(
      `keryx hooks: ${projectHooks.filePath} changed since you trusted it, so its ${
        enabledHooks.length
      } command ${pluralHooks(enabledHooks.length)} did not run: ${enabledHooks.map((h) => h.id).join(", ")}`,
    );
    lines.push(trustHint(opts.surface, opts.projectRoot));
  }

  // R1-04 (flow 319 review round 1): a USER-scope hook needs no trust — "the
  // operator wrote that file themselves, on this machine" — but an
  // unsandboxed one still runs with full user permissions at every session
  // start, and until now nothing said so unless it also happened to disable
  // a built-in gate. Listed once per session, alongside the trust/warning
  // lines above, so it stays visible even though there is nothing to trust.
  const unsandboxedUserHooks = result.registrations.filter(
    (r) => r.scope === "user" && r.runsIn === "unsandboxed" && r.enabled,
  );
  if (unsandboxedUserHooks.length > 0) {
    lines.push(
      `keryx hooks: ${unsandboxedUserHooks.length} user hook(s) from ${opts.userFile} run UNSANDBOXED: ${unsandboxedUserHooks
        .map((h) => terminalSafe(h.id).text)
        .join(", ")}.`,
    );
  }

  for (const w of result.warnings) {
    // `w.message` is already the full, final text (§3) — config.ts builds it
    // with its own "keryx hooks: " prefix, so this loop does not add a
    // second one.
    lines.push(w.message);
  }
  for (const gate of result.disabledBuiltinGates) {
    lines.push(
      `keryx hooks: built-in gate ${gate.id} is OFF (disabled in ${gate.file}). Turn it back on with: keryx hooks enable ${gate.id} --user`,
    );
  }
  return lines;
}

function formatLoadFailure(diagnostics: readonly HookConfigDiagnostic[]): string {
  const first = diagnostics[0];
  const firstMessage = first?.message ?? "unknown error";
  const extra = diagnostics.length > 1 ? ` (and ${diagnostics.length - 1} more)` : "";
  return `keryx hooks: the hook config did not load, so every tool call and prompt is refused until it is fixed: ${firstMessage}${extra}. Check it with: keryx hooks validate`;
}
