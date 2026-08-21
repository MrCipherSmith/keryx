// Pure logic for interpreting `keryx status` output and deciding whether to
// prompt the user to run `keryx init --yes`. Zero `vscode` import so this is
// unit-testable with `bun test` — there is no VS Code test harness available
// in this environment (no `code` CLI, no verified-installable
// `@vscode/test-electron`), so as much behavior as possible lives here rather
// than in `extension.ts`'s thin `vscode`-calling shell.
//
// Contract mirrored from `src/commands/status.ts:20-57` (read in full before
// writing this): the CLI prints one of exactly three first lines —
// "Metaproject: not initialized", "Metaproject: incomplete", or
// "Metaproject: ready" — plus follow-up lines this module does not need.

export type KeryxStatusState = "not-initialized" | "incomplete" | "ready";

/**
 * Parse `keryx status`'s stdout into one of the three canonical states.
 * Unrecognised output (a stale/incompatible keryx binary, a crash, empty
 * output) is treated as "incomplete" — the safe default that still offers to
 * fix things rather than silently doing nothing or crashing the extension.
 */
export function interpretStatus(statusOutput: string): KeryxStatusState {
  const firstLine = statusOutput.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine === "Metaproject: not initialized") return "not-initialized";
  if (firstLine === "Metaproject: ready") return "ready";
  // "Metaproject: incomplete" and anything unrecognised both land here.
  return "incomplete";
}

/**
 * AC1: not-initialized and incomplete both prompt; ready does not.
 * Pure decision, no side effect — `extension.ts` is responsible for actually
 * showing the notification and NEVER auto-running `keryx init --yes` without
 * the user clicking the offered action (never-silent requirement).
 */
export function shouldPromptInit(state: KeryxStatusState): boolean {
  return state === "not-initialized" || state === "incomplete";
}

/** The message shown in the init-prompt notification, keyed by state. */
export function initPromptMessage(state: KeryxStatusState): string {
  if (state === "not-initialized") {
    return "Keryx is not initialized in this workspace. Run `keryx init` to set it up?";
  }
  return "Keryx's Metaproject workspace looks incomplete. Run `keryx init` to repair it?";
}

/** AC2: whether a just-finished `keryx init --yes` run should trigger tree-view reveal. */
export function shouldRevealAfterInit(initExitCode: number, statusAfterInit: KeryxStatusState): boolean {
  return initExitCode === 0 && statusAfterInit === "ready";
}

/**
 * The message shown when `keryx init --yes` exits 0 but the workspace still
 * isn't "ready" afterwards (e.g. still "incomplete" — a module needs a
 * follow-up step init doesn't fully automate, or the run only partially
 * completed). This is neither the reveal-success path nor the exit-code
 * failure path, so without an explicit message here the user would get zero
 * feedback after clicking "Run keryx init" — never allowed (never-silent
 * requirement).
 */
export function initSucceededButNotReadyMessage(statusAfterInit: KeryxStatusState): string {
  return `keryx init completed, but the workspace is still "${statusAfterInit}". Run \`keryx status\` for details.`;
}
