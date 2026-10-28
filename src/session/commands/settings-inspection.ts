import type { Control } from "../../remote-control/protocol";
import { validateArguments } from "../../remote-control/protocol";
import { loadProjectContextStatus } from "../../gdskills/project-context-status";
import { buildSettingsRows, type SettingsSnapshot } from "../../tui/settings-model";
import type { PermissionsView } from "../../commands/permissions-command";
import type { NativeCommandContribution } from "./handlers";
import { redactSensitiveText } from "../../security/service";
import type { SearchProviderController } from "../../harness/search";
import type { SessionRestriction } from "./plan";

/** Locally constructed safe readers. Remote arguments never identify a config file or credential store. */
export interface SettingsInspectionPort {
  /** The actual loadSettingsSnapshot result; the local owner supplies only live state it really implements. */
  snapshot(): Promise<SettingsSnapshot>;
  permissions?(): PermissionsView;
  search?: Pick<SearchProviderController, "configurable" | "selectable" | "active">;
}
export interface SettingsInspectionContext { cwd: string; config: Control["SessionConfig"]; restriction?: () => SessionRestriction }
export type SettingsInspectionResult = { ok: true; data: unknown } | { ok: false; error: { code: "invalid-arguments" | "setup-required" | "read-failed" | "quota-exceeded"; message: string } };
const names = ["settings", "mode", "guard", "route", "editguard", "projectctx", "projectctx.refs", "external", "external-agents", "jevprofile", "permissions", "search-provider", "search-connect"] as const;
const empty: Control["ArgumentSchema"] = { type: "object", properties: {}, required: [], additionalProperties: false };
function failure(code: Extract<SettingsInspectionResult, { ok: false }>["error"]["code"], message: string): SettingsInspectionResult { return { ok: false, error: { code, message } }; }
function bounded(context: SettingsInspectionContext, data: unknown): SettingsInspectionResult {
  const json = redactSensitiveText(JSON.stringify(data).replaceAll(context.cwd, "."));
  return Buffer.byteLength(json) > 30000 ? failure("quota-exceeded", "The settings result exceeds its remote quota.") : { ok: true, data: JSON.parse(json) };
}
function safeSnapshot(snapshot: SettingsSnapshot) {
  return {
    permissionMode: snapshot.permissionMode, projectPermissionMode: snapshot.projectPermissionMode ?? null,
    plan: snapshot.plan, guard: snapshot.guard, editGuard: snapshot.editGuard, routing: snapshot.routing,
    projectContext: { enforcement: snapshot.projectContext.enforcement, maxBytes: snapshot.projectContext.maxBytes, configInvalid: snapshot.projectContext.configError === true },
    externalPrivacy: { value: snapshot.externalPrivacy.value, source: snapshot.externalPrivacy.source },
    reasoning: { effort: snapshot.reasoning.effort, source: snapshot.reasoning.source, envWinsOnRestart: snapshot.reasoning.envWinsOnRestart === true },
    thinkDisplay: snapshot.thinkDisplay, theme: snapshot.theme,
    jevProfile: { on: snapshot.jevProfile.on, total: snapshot.jevProfile.total },
    externalAgents: { on: snapshot.externalAgents.on, reason: snapshot.externalAgents.reason ?? null },
    rendering: { mode: snapshot.rendering.mode, saveable: snapshot.rendering.saveable },
    telegram: snapshot.telegram?.posture === undefined ? null : {
      defaultMode: snapshot.telegram.posture.defaultMode, runTimeoutMs: snapshot.telegram.posture.runTimeoutMs,
      approvalTimeoutMs: snapshot.telegram.posture.approvalTimeoutMs, savedRules: snapshot.telegram.posture.savedRules,
    },
  };
}
/** Uses the existing settings snapshot/row domain, with effective native configuration separately identified. */
export async function executeSettingsInspection(context: SettingsInspectionContext, port: SettingsInspectionPort | undefined, command: string, input: unknown): Promise<SettingsInspectionResult> {
  if (!(names as readonly string[]).includes(command) || !validateArguments(empty, input).ok) return failure("invalid-arguments", "This read command accepts no mutation fields.");
  try {
    if (command === "projectctx" || command === "projectctx.refs") {
      const actual = await loadProjectContextStatus(context.cwd);
      return bounded(context, {
        enforcement: actual.enforcement, enforcementSource: actual.enforcementSource, maxBytes: actual.maxBytes, maxBytesSource: actual.maxBytesSource,
        ruleCount: actual.ruleCount, linkedCount: actual.linkedCount, configInvalid: actual.configError !== undefined,
        lastResolveState: actual.lastError !== undefined ? "invalid" : actual.last !== undefined ? "recorded" : "absent",
        references: actual.references === undefined ? { state: "absent" } : actual.references.state === "invalid"
          ? { state: "invalid", errorCount: actual.references.errors.length }
          : { state: "declared", declarationCount: actual.references.declarations.length, findingCount: actual.references.findings.length },
      });
    }
    if (command === "permissions") {
      if (port?.permissions === undefined) return failure("setup-required", "A locally owned safe permission reader is unavailable.");
      const view = port.permissions();
      return bounded(context, { rows: view.rows.map(row => ({ kind: row.kind, pattern: row.pattern })) });
    }
    if (command === "search-provider" || command === "search-connect") {
      if (port?.search === undefined) return failure("setup-required", "A locally owned search-provider reader is unavailable.");
      const actual = port.search;
      return bounded(context, { selected: actual.active()?.id ?? null,
        ...(command === "search-provider" ? { configurable: actual.configurable().map(provider => provider.id) } : {}),
        selectable: actual.selectable().map(provider => provider.id) });
    }
    if (port === undefined) return failure("setup-required", "The actual local saved/live settings reader is unavailable.");
    const snapshot = await port.snapshot();
    // The current permission mode is a session-settings read; changing it (trust/auto/save/clear) stays a dedicated local-security workflow.
    if (command === "mode") return bounded(context, { observed: { permissionMode: snapshot.permissionMode, projectPermissionMode: snapshot.projectPermissionMode ?? null }, source: "actual-local-settings-snapshot" });
    const observed = safeSnapshot(snapshot);
    if (command !== "settings") {
      const field = command === "guard" ? observed.guard : command === "route" ? observed.routing : command === "editguard" ? observed.editGuard : command === "external" ? observed.externalPrivacy : command === "external-agents" ? observed.externalAgents : observed.jevProfile;
      return bounded(context, { observed: field, source: "actual-local-settings-snapshot" });
    }
    const restriction = context.restriction?.();
    return bounded(context, {
      effective: {
        configVersion: context.config.configVersion, baselineCandidateId: context.config.baselineCandidateId,
        reasoningEffort: context.config.reasoningEffort, routing: { enabled: context.config.routing.enabled, profileId: context.config.routing.profileId, candidateIds: [...context.config.routing.candidateIds], fallbackCandidateId: context.config.routing.fallbackCandidateId },
        policyDigest: context.config.policyDigest, capabilityDigest: context.config.capabilityDigest,
        readonlyRestriction: restriction === undefined ? null : { enabled: restriction.enabled, configVersion: restriction.configVersion,
          effectiveFromTurnOrdinal: restriction.effectiveFromTurnOrdinal, restrictionDigest: restriction.restrictionDigest },
      }, observed,
      rows: buildSettingsRows(snapshot).map(row => ({ id: row.id, label: row.label, value: row.value, scope: row.scope, detail: row.detail ?? null })),
    });
  } catch { return failure("read-failed", "The actual settings state could not be inspected."); }
}
export function settingsInspectionCommands(options: { port?: SettingsInspectionPort; readiness?: { snapshot?: boolean; permissions?: boolean; search?: boolean } } = {}): NativeCommandContribution[] {
  return names.map(commandName => ({
    entry: { commandName, summary: "Inspect actual saved/live settings without applying a change", handlerId: `native.settings-read.${commandName}`, inputSchema: empty, resultSchema: { type: "string", maxLength: 32768 },
      mutationClass: "read", states: ["idle", "busy", "paused"], busyPolicy: "read-only", confirmation: "none",
      availability: commandName.startsWith("projectctx") || (commandName === "permissions" ? (options.port?.permissions !== undefined || options.readiness?.permissions === true) : commandName === "search-provider" || commandName === "search-connect" ? (options.port?.search !== undefined || options.readiness?.search === true) : options.port !== undefined || options.readiness?.snapshot === true) ? "available" : "setup-required",
      reason: "actual-safe-settings-domain-reader" },
    execute: (context, request) => executeSettingsInspection({ cwd: context.cwd, config: context.record.config, ...(context.restriction === undefined ? {} : { restriction: context.restriction }) }, options.port, commandName, request.arguments),
  }));
}
