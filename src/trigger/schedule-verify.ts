// Flow 295 (M1/L1): the checks that decide whether a STORED schedule is still exactly
// what the operator confirmed. `keryx trigger run` runs them before any model call, and
// resume (CLI and TUI) runs them before it re-enables a timer, so a paused entry that
// was edited, or whose granted binary was swapped, is never switched back on.

import { timingSafeEqual } from "node:crypto";
import { scheduleContentCanonical, type AgentTaskAction, type TriggerEntry } from "./config";
import { grantedToolSpec } from "./granted-tools";
import { verifyGrantedBinary, type VerifiedFile } from "./granted-binary";
import type { DispatchRefusalCode } from "./record";
import { configDirInsideProjectReason, readScheduleKey, scheduleMac } from "./schedule-key";
import { readScheduleStore } from "./store";

/**
 * Flow 295 (F1d/N2/N6): every granted program must still be exactly what the operator
 * confirmed: the binary, or for a `#!` wrapper the script and its interpreter (resolved
 * on the runtime PATH). See `../trigger/granted-binary.ts`. Returns the verified realpath
 * per program, and the files whose identity is re-checked before every exec.
 */
export async function verifyGrantedBinaries(
  projectRoot: string,
  action: AgentTaskAction,
  pathEnv: string | undefined = process.env["PATH"],
): Promise<
  | { readonly ok: true; readonly realpaths: Record<string, string>; readonly stats: Record<string, readonly VerifiedFile[]> }
  | { readonly ok: false; readonly reason: string }
> {
  const realpaths: Record<string, string> = {};
  const stats: Record<string, readonly VerifiedFile[]> = {};
  for (const [program, bin] of Object.entries(action.grants.bins)) {
    const pin = action.grants.binDigests[program];
    if (pin === undefined) return { ok: false, reason: `granted binary "${bin}" has no recorded digest — recreate the schedule` };
    const verified = await verifyGrantedBinary(program, bin, pin, projectRoot, pathEnv);
    if (!verified.ok) return verified;
    realpaths[program] = verified.realpath;
    stats[program] = verified.files;
  }
  for (const id of action.grants.tools) {
    const program = grantedToolSpec(id)?.program;
    if (program !== undefined && realpaths[program] === undefined) {
      return { ok: false, reason: `granted tool ${id} has no confirmed binary for "${program}"` };
    }
  }
  return { ok: true, realpaths, stats };
}

/**
 * AC5 / F1a: does the STORED entry still carry this machine's signature (an HMAC keyed
 * by the per-machine schedule key) over exactly the content the operator confirmed?
 */
export async function confirmedContentProblem(
  projectRoot: string,
  entry: TriggerEntry,
): Promise<{ readonly code: DispatchRefusalCode; readonly reason: string } | undefined> {
  const inside = configDirInsideProjectReason(projectRoot);
  if (inside !== undefined) return { code: "schedule-key-unavailable", reason: `no stored schedule runs: ${inside}` };
  const key = readScheduleKey();
  if (!key.ok) return { code: "schedule-key-unavailable", reason: `no stored schedule runs: ${key.reason}` };
  const reason = await signatureProblem(projectRoot, entry, key.key);
  return reason === undefined ? undefined : { code: "grants-changed", reason };
}

async function signatureProblem(projectRoot: string, entry: TriggerEntry, key: Buffer): Promise<string | undefined> {
  if (entry.source !== "store" || entry.confirmedHash === undefined) {
    return `schedule "${entry.name}" was never confirmed by an operator (no confirmed content hash) — create it with \`keryx schedule add\``;
  }
  let raw: Record<string, unknown> | undefined;
  try {
    raw = (await readScheduleStore(projectRoot)).find((e) => e["name"] === entry.name);
  } catch (error) {
    return `the schedule store could not be read (${error instanceof Error ? error.message : String(error)})`;
  }
  if (raw === undefined) return `schedule "${entry.name}" is no longer in the schedule store`;
  const { confirmedHash, enabled: _enabled, ...content } = raw;
  const actual = Buffer.from(scheduleMac(key, scheduleContentCanonical(content)), "hex");
  const claimed = typeof confirmedHash === "string" && /^[0-9a-f]{64}$/.test(confirmedHash) ? Buffer.from(confirmedHash, "hex") : Buffer.alloc(0);
  if (claimed.length !== actual.length || !timingSafeEqual(claimed, actual) || confirmedHash !== entry.confirmedHash) {
    return (
      `schedule "${entry.name}" changed after the operator confirmed it (prompt, cadence, runner or grants) — ` +
      "refusing to run content nobody confirmed. Remove it and create it again with `keryx schedule add`."
    );
  }
  return undefined;
}

/**
 * Flow 295 (L1): the whole verification a stored schedule must pass before it may run
 * or be resumed: this machine's key, the MAC over the confirmed content, and every
 * granted binary's pin.
 */
export async function verifyStoredSchedule(
  projectRoot: string,
  entry: TriggerEntry,
  pathEnv: string | undefined = process.env["PATH"],
): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: DispatchRefusalCode; readonly reason: string }> {
  const changed = await confirmedContentProblem(projectRoot, entry);
  if (changed !== undefined) return { ok: false, ...changed };
  if (entry.action.kind !== "agent-task") return { ok: true };
  const binaries = await verifyGrantedBinaries(projectRoot, entry.action, pathEnv);
  if (!binaries.ok) return { ok: false, code: "grants-changed", reason: binaries.reason };
  return { ok: true };
}
