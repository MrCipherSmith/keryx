// Flow 487: `/diag`, the operator's on-demand dump of what the tool-call diagnostics know.
//
// A parent turn that sits on one tool call for hours leaves nothing behind unless something was
// recording. `callDiagnostics` records always (in memory) and writes to disk only on a stall or
// when asked; this command asks. It prints a short summary and writes the full snapshot to the
// session's diagnostics file, so a bug report can attach it.

import { callDiagnostics } from "../lib/call-diagnostics";

export const DIAG_COMMAND = "/diag";
export const DIAG_SUMMARY = `Dump the tool-call diagnostics (in-flight calls, stage ages, dock queue) to a file: ${DIAG_COMMAND}`;

export function isDiagCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === DIAG_COMMAND;
}

function age(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** The text to print for `/diag`. Never throws. */
export function runDiagCommand(): string {
  try {
    const snap = callDiagnostics.dump("operator /diag");
    const where = callDiagnostics.dumpPath();
    const calls = snap?.calls ?? callDiagnostics.snapshot("operator /diag").calls;
    const lines = [`Diagnostics: ${calls.length} tool call${calls.length === 1 ? "" : "s"} in flight`];
    for (const c of calls.slice(0, 20)) {
      lines.push(`  ${c.id} ${c.name} stage=${c.stage} running ${age(c.ageMs)} (in stage ${age(c.stageAgeMs)})`);
    }
    if (calls.length > 20) lines.push(`  ... +${calls.length - 20} more`);
    lines.push(
      snap === undefined
        ? "Snapshot not written (the diagnostics sink refused or is not started)."
        : `Snapshot written${where === undefined ? "" : ` to ${where}`}.`,
    );
    lines.push("");
    return lines.join("\n");
  } catch (error) {
    return `${DIAG_COMMAND}: ${error instanceof Error ? error.message : String(error)}\n`;
  }
}

/** A call this long in one stage, or this long in flight, makes an operator interrupt worth a dump. */
export const INTERRUPT_DUMP_STAGE_MS = 60_000;
export const INTERRUPT_DUMP_CALL_MS = 5 * 60_000;

/**
 * The operator is about to cancel the turn (Ctrl+C or /interrupt). When a tool call has been waiting
 * long — the state a hang leaves behind — write the diagnostics snapshot first, because cancelling
 * unwinds the very calls the snapshot describes. Returns the line to print, or undefined when
 * nothing was waiting long or the sink wrote nothing. Never throws, so it can never block the cancel.
 */
export function maybeDumpOnInterrupt(
  limits: { stageMs?: number; callMs?: number } = {},
): string | undefined {
  try {
    const stageMs = limits.stageMs ?? INTERRUPT_DUMP_STAGE_MS;
    const callMs = limits.callMs ?? INTERRUPT_DUMP_CALL_MS;
    const calls = callDiagnostics.snapshot("operator interrupt").calls;
    const slow = calls.filter((c) => c.stageAgeMs >= stageMs || c.ageMs >= callMs);
    if (slow.length === 0) return undefined;
    const snap = callDiagnostics.dump("operator interrupt after long wait");
    if (snap === undefined) return undefined;
    const worst = slow.reduce((a, b) => (b.stageAgeMs > a.stageAgeMs ? b : a));
    const where = callDiagnostics.dumpPath();
    return `◇ diagnostics saved before interrupt: ${slow.length} call${slow.length === 1 ? "" : "s"} waiting (longest ${worst.name} in ${worst.stage} for ${age(worst.stageAgeMs)})${where === undefined ? "" : ` -> ${where}`}\n`;
  } catch {
    return undefined;
  }
}

