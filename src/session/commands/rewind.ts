import { createHash } from "node:crypto";
import { applyRewind, type RewindMode } from "../../rewind/apply";
import { rewindConversation } from "../../rewind/history";
import { verifyNativeRewindEntry, type NativeRewindCapture } from "../../rewind/manifest";
import type { RewindRecorder } from "../../rewind/recorder";
import type { NormalizedMessage } from "../../harness/provider/types";
import { validateArguments, type Control } from "../../remote-control/protocol";
import type { NativeCommandContribution } from "./handlers";
import type { SessionCommandInspection } from "./effects";
import { redactSensitiveText } from "../../security/service";

export type NativeRewindOwnership = NativeRewindCapture;
export interface RewindEffectInput { paths: string[]; previewDigest: string; snapshotSeq: number; workspaceBaseline: string }
export interface NativeRewindEffect {
  runId: string; turnId: string; signal: AbortSignal;
  beforeAction(action: { kind: "tool"; toolName: string; signal: AbortSignal }): Promise<void>;
  rewind?<T>(input: RewindEffectInput, write: () => Promise<T>): Promise<T>;
}
export interface NativeRewindArguments { seq: number; mode: RewindMode; expectedHistoryVersion: number }
export interface NativeRewindApplyArguments extends NativeRewindArguments { previewDigest: string; workspaceBaseline: string }
export interface NativeRewindPreview { seq: number; mode: RewindMode; previewDigest: string; snapshotDigest: string; workspaceBaseline: string; historyVersion: number; paths: string[]; messagesRemoved: number }
export type NativeRewindResult = { ok: true; status: "listed"; data: { seq: number; kind: string; at: string; prompt: string; supported: boolean }[] }
  | { ok: true; status: "preview"; data: NativeRewindPreview }
  | { ok: true; status: "applied"; data: { filesRestored: boolean; historyRewound: boolean; historyVersion: number; partial: false } }
  | { ok: false; error: { code: string; message: string }; partial: boolean; recoveryRequired: boolean };
export interface NativeRewindPortOptions {
  cwd: string; recorder: RewindRecorder; history: NormalizedMessage[]; archive: NormalizedMessage[];
  ownership(): NativeRewindOwnership;
  canPersist(): boolean;
  persist(history: readonly NormalizedMessage[], archive: readonly NormalizedMessage[]): void;
  afterHistoryRewind(): void;
  assertCurrent(expectedBaseline: string, signal: AbortSignal): Promise<void>;
}
export interface NativeRewindPort {
  list(inspection: SessionCommandInspection): Promise<NativeRewindResult>;
  preview(args: NativeRewindArguments, inspection: SessionCommandInspection): Promise<NativeRewindResult>;
  apply(args: NativeRewindApplyArguments, effect: NativeRewindEffect): Promise<NativeRewindResult>;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const failure = (code: string, partial = false): NativeRewindResult => ({ ok: false, error: { code, message: "The rewind was refused or could not be completed safely." }, partial, recoveryRequired: partial });
const bounded = (result: NativeRewindResult): NativeRewindResult => Buffer.byteLength(JSON.stringify(result)) <= 30000 ? result : failure("quota-exceeded");
/** One adapter over the actual local recorder/apply/history services. Public projections never include native nonce/provenance. */
export function createNativeRewindPort(options: NativeRewindPortOptions): NativeRewindPort {
  const inspect = async (args: NativeRewindArguments, signal: AbortSignal): Promise<NativeRewindPreview> => {
    signal.throwIfAborted();
    const owner = options.ownership();
    if (!options.canPersist() || owner.historyVersion !== args.expectedHistoryVersion) throw new Error("ownership-conflict");
    await options.assertCurrent(owner.workspaceBaseline, signal);
    const entry = options.recorder.entries().find(row => row.seq === args.seq);
    if (entry === undefined) throw new Error("not-found");
    if (!verifyNativeRewindEntry(entry, owner)) throw new Error("unsupported-snapshot");
    let messagesRemoved = 0;
    if (args.mode !== "files") {
      if (entry.archiveIndex === null) throw new Error("unsupported-snapshot");
      const next = rewindConversation({ history: options.history, archive: options.archive, archiveIndex: entry.archiveIndex });
      if (!next.ok) throw new Error("unsupported-snapshot"); messagesRemoved = next.removed;
    }
    const plan = args.mode === "history" ? undefined : await options.recorder.previewRestore?.(args.seq, signal);
    if (args.mode !== "history" && plan === undefined) throw new Error("setup-required");
    const paths = plan?.paths ?? [];
    const base = { seq: args.seq, mode: args.mode, snapshotDigest: digest(entry), workspaceBaseline: owner.workspaceBaseline,
      historyVersion: owner.historyVersion, paths, messagesRemoved };
    const result = { ...base, previewDigest: digest({ ...base, planDigest: plan?.digest ?? null, historyDigest: digest({ history: options.history, archive: options.archive }) }) };
    if (Buffer.byteLength(JSON.stringify(result)) > 29000) throw new Error("quota-exceeded");
    return result;
  };
  return {
    async list(inspection) {
      try { await inspection.beforeAction("rewind_list"); inspection.signal.throwIfAborted(); const owner = options.ownership();
        if (!options.canPersist()) return failure("ownership-conflict");
        const rows = options.recorder.entries(); if (rows.length > 100) return failure("quota-exceeded");
        return bounded({ ok: true, status: "listed", data: rows.map(entry => ({ seq: entry.seq, kind: entry.kind, at: entry.at,
          prompt: redactSensitiveText(entry.prompt), supported: verifyNativeRewindEntry(entry, owner) })) });
      } catch { return failure(inspection.signal.aborted ? "cancelled" : "ownership-conflict"); }
    },
    async preview(args, inspection) {
      if (!validArgs(args)) return failure("invalid-arguments");
      try { await inspection.beforeAction("rewind_preview"); return { ok: true, status: "preview", data: await inspect(args, inspection.signal) }; }
      catch (error) { return failure(inspection.signal.aborted ? "cancelled" : safeCode(error)); }
    },
    async apply(args, effect) {
      if (!validArgs(args) || !/^[a-f0-9]{64}$/.test(args.previewDigest) || !/^[a-f0-9]{64}$/.test(args.workspaceBaseline)) return failure("invalid-arguments");
      if (!effect.runId || !effect.turnId || effect.rewind === undefined) return failure("setup-required");
      let begun = false; let historyChanged = false;
      try {
        await effect.beforeAction({ kind: "tool", toolName: "rewind_restore", signal: effect.signal });
        const current = await inspect(args, effect.signal);
        if (current.previewDigest !== args.previewDigest || current.workspaceBaseline !== args.workspaceBaseline) return failure("stale-preview");
        const plan = args.mode === "history" ? undefined : await options.recorder.previewRestore?.(args.seq, effect.signal);
        const result = await effect.rewind({ paths: current.paths, previewDigest: current.previewDigest, snapshotSeq: args.seq, workspaceBaseline: current.workspaceBaseline }, async () => {
          await options.assertCurrent(args.workspaceBaseline, effect.signal); effect.signal.throwIfAborted(); begun = true;
          const outcome = await applyRewind({ recorder: options.recorder, seq: args.seq, mode: args.mode, history: options.history, archive: options.archive,
            canPersist: options.canPersist, persist: options.persist, strict: { signal: effect.signal, ...(plan === undefined ? {} : { planDigest: plan.digest }) } });
          historyChanged = outcome.historyRewound;
          if (historyChanged) options.afterHistoryRewind();
          if (!outcome.ok || outcome.partial) throw new Error("restore-incomplete");
          if (historyChanged && options.ownership().historyVersion <= args.expectedHistoryVersion) throw new Error("history-version-not-advanced");
          return outcome;
        });
        return { ok: true, status: "applied", data: { filesRestored: result.filesRestored, historyRewound: result.historyRewound, historyVersion: options.ownership().historyVersion, partial: false } };
      } catch (error) { return failure(effect.signal.aborted ? "cancelled" : begun ? "recovery-required" : safeCode(error), begun || historyChanged); }
    },
  };
}
function safeCode(error: unknown): string { return error instanceof Error && ["not-found", "unsupported-snapshot", "ownership-conflict", "setup-required", "quota-exceeded"].includes(error.message) ? error.message : "unsupported-snapshot"; }
function validArgs(args: NativeRewindArguments): boolean { return Number.isSafeInteger(args.seq) && args.seq > 0 && Number.isSafeInteger(args.expectedHistoryVersion) && args.expectedHistoryVersion > 0 && ["files", "history", "both"].includes(args.mode); }
const number: Control["ArgumentSchema"] = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const base = { seq: number, mode: { type: "string", maxLength: 10, enum: ["files", "history", "both"] } as Control["ArgumentSchema"], expectedHistoryVersion: number };
export function rewindCommands(enabled = false): NativeCommandContribution[] {
  return ["rewind", "rewind.preview", "rewind.apply"].map(commandName => ({
    entry: { commandName, summary: "Inspect or restore an exact owned native checkpoint", handlerId: `native.${commandName}`,
      inputSchema: { type: "object", properties: commandName === "rewind" ? {} : commandName === "rewind.preview" ? base : { ...base, previewDigest: { type: "string", maxLength: 64 }, workspaceBaseline: { type: "string", maxLength: 64 } },
        required: commandName === "rewind" ? [] : commandName === "rewind.preview" ? Object.keys(base) : [...Object.keys(base), "previewDigest", "workspaceBaseline"], additionalProperties: false },
      resultSchema: { type: "string", maxLength: 32768 }, mutationClass: commandName === "rewind.apply" ? "workspace" : "read", states: commandName === "rewind.apply" ? ["idle"] : ["idle", "busy", "paused"],
      busyPolicy: commandName === "rewind.apply" ? "reject" : "read-only", confirmation: commandName === "rewind.apply" ? "human" : "none", availability: enabled ? "available" : "setup-required", reason: enabled ? "actual-owned-rewind-service" : "owned-native-rewind-port-required" },
    async execute(context, request) {
      const entry = rewindCommands(enabled).find(row => row.entry.commandName === request.commandName)!.entry;
      if (!validateArguments(entry.inputSchema, request.arguments).ok) return failure("invalid-arguments");
      const port = (context as typeof context & { rewind?: NativeRewindPort }).rewind;
      if (port === undefined) return failure("setup-required");
      if (commandName === "rewind.apply") return context.effect === undefined ? failure("setup-required") : port.apply(request.arguments as unknown as NativeRewindApplyArguments, context.effect);
      if (context.inspection === undefined) return failure("setup-required");
      return commandName === "rewind" ? port.list(context.inspection) : port.preview(request.arguments as unknown as NativeRewindArguments, context.inspection);
    },
  }));
}
