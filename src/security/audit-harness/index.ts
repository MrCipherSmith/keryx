// Flow 308 (W8 Design part A, Lane A) — `runHarnessAudit`, the entry point
// for `keryx security audit-harness`. Read-only: never writes to disk (see
// `proposals.ts#applyAuditProposal` and `baseline.ts#addBaselineEntry` for
// the only two writing paths in this surface).

import { createHash } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathExists } from "../../lib/fs";
import { readJsonObjectFile } from "../../lib/json";
import { parseCodexToml } from "./codex-toml";
import { securityDataRoot } from "../config";
import {
  discoverAgentDefinitions,
  discoverHookSurfaceFiles,
  discoverInstructions,
  discoverMcpConfigCandidates,
  discoverSettings,
  discoverSkillScripts,
} from "./surfaces";
import {
  checkAgentMissingModelTier,
  checkAgentUnrestrictedTools,
  checkAutoRunDirective,
  checkBypassFlagPresent,
  checkHookCommandInjection,
  checkHookExfiltrationShape,
  checkHookSilentSuppression,
  checkHookSilentSuppressionInScript,
  checkInjectionInText,
  checkMcpManifest,
  checkMissingDenyList,
  checkOverPermissiveAllowlist,
  checkSecretsInText,
  checkUnpinnedMcpLauncher,
} from "./checks";
import {
  addBaselineEntry as addBaselineEntryImpl,
  defaultBaselinePath,
  applySuppression,
  indefiniteSuppressionFindings,
  readBaseline,
} from "./baseline";
import { scoreFindings } from "./score";
import type {
  AuditFinding,
  AuditReport,
  BaselineState,
  CoverageStatus,
  InternalProposal,
  RawFinding,
  RunAuditOptions,
  SurfaceResult,
} from "./types";
import { severityRank } from "./types";

export { defaultBaselinePath } from "./baseline";
export { applyAuditProposal } from "./proposals";
export { addBaselineEntryImpl as addBaselineEntry };

function findingId(f: RawFinding): string {
  const pointerOrLine = f.location?.pointer ?? (f.location?.line !== undefined ? `line:${f.location.line}` : "");
  // F10: `policyId` and `matchedToken` are two DIFFERENT signals (e.g. an MCP
  // poisoning policy id vs. the tool name it matched on) — folding them into
  // one slot with `??` meant two distinct poisoning policies matching the
  // same tool on the same manifest collided onto one id, silently dropping
  // one finding as a "duplicate". Both are always included now, even when
  // one of the two is absent (as an empty segment, so the key shape stays
  // stable either way).
  const policyId = f.evidence.policyId ?? "";
  const matchedToken = f.evidence.matchedToken ?? "";
  const key = `${f.surface}|${f.check}|${f.path ?? ""}|${policyId}|${matchedToken}|${pointerOrLine}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * F3: the proposal id embedded in a `<id>.applied.json` marker filename used
 * to be `${findingId}-${internalProposal.proposal.id}`, and several checks'
 * internal proposal ids are built directly from ATTACKER-CONTROLLED JSON
 * content (an MCP server name, an allow-list entry string) — e.g. an
 * `mcpServers` key of `../../../../tmp/evil` flowed straight into the marker
 * path `proposals.ts#applyAuditProposal` builds and writes to, a path
 * traversal. The proposal id exposed in the report (and required by `apply
 * --proposal <id>`) is now always a hash — no attacker-controlled substring
 * survives into it — and `proposals.ts` additionally validates the format and
 * asserts every write path stays inside root, defense in depth.
 */
function proposalId(findingIdValue: string, internalId: string): string {
  const hash = createHash("sha256").update(`${findingIdValue}|${internalId}`).digest("hex").slice(0, 16);
  return `p-${hash}`;
}

function compareFindings(a: AuditFinding, b: AuditFinding): number {
  if (a.surface !== b.surface) return a.surface < b.surface ? -1 : 1;
  if (a.check !== b.check) return a.check < b.check ? -1 : 1;
  const pathA = a.path ?? "";
  const pathB = b.path ?? "";
  if (pathA !== pathB) return pathA < pathB ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function safeReadText(absolute: string): Promise<string | undefined> {
  try {
    return await readFile(absolute, "utf8");
  } catch {
    return undefined;
  }
}

type JsonRecord = Record<string, unknown>;

function collectHookCommands(value: unknown, pointer: string, out: Array<{ command: string; pointer: string }>): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectHookCommands(item, `${pointer}/${index}`, out));
    return;
  }
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    if (typeof record.command === "string") {
      out.push({ command: record.command, pointer: `${pointer}/command` });
    }
    for (const [key, nested] of Object.entries(record)) {
      if (key === "command") continue;
      collectHookCommands(nested, `${pointer}/${key}`, out);
    }
  }
}

function surfaceResult(
  surface: SurfaceResult["surface"],
  scanned: string[],
  unreadable: string[],
): SurfaceResult {
  if (scanned.length === 0 && unreadable.length === 0) {
    return { surface, status: "not-applicable", pathsScanned: [] };
  }
  if (unreadable.length > 0) {
    return {
      surface,
      status: "error",
      pathsScanned: scanned,
      pathsUnreadable: unreadable,
      error: `${unreadable.length} path(s) under "${surface}" could not be read/parsed and were not scanned.`,
    };
  }
  return { surface, status: "scanned", pathsScanned: scanned };
}

async function mcpBaselineTools(root: string): Promise<{ tools: Record<string, string>; state: "absent" | "ok" | "unreadable" }> {
  const file = path.join(securityDataRoot(root), "mcp-baseline.json");
  if (!(await pathExists(file))) {
    return { tools: {}, state: "absent" };
  }
  const read = await readJsonObjectFile(file);
  if (read.state !== "object" || typeof read.value.tools !== "object" || read.value.tools === null) {
    return { tools: {}, state: "unreadable" };
  }
  return { tools: read.value.tools as Record<string, string>, state: "ok" };
}

/**
 * Runs the audit and returns BOTH the public report and the internal
 * proposal-id → structured-edit map `proposals.ts#applyAuditProposal` needs.
 * The map is never serialized: `runHarnessAudit` (below) returns only the
 * report.
 */
export async function computeAuditInternal(
  root: string,
  options: RunAuditOptions = {},
): Promise<{ report: AuditReport; proposalsById: Map<string, InternalProposal> }> {
  const now = options.now ? options.now() : new Date();
  const raw: RawFinding[] = [];
  const surfaces: SurfaceResult[] = [];
  const coverageReasons: string[] = [];

  // --- instructions ---------------------------------------------------------
  {
    const files = await discoverInstructions(root);
    const unreadable: string[] = [];
    for (const relativePath of files) {
      const content = await safeReadText(path.join(root, relativePath));
      if (content === undefined) {
        unreadable.push(relativePath);
        continue;
      }
      raw.push(...checkSecretsInText("instructions", "secret-in-instructions", relativePath, content, "critical"));
      raw.push(...checkInjectionInText("instructions", "prompt-injection-in-instructions", relativePath, content, "high"));
      raw.push(...checkAutoRunDirective("instructions", relativePath, content));
    }
    surfaces.push(surfaceResult("instructions", files, unreadable));
  }

  // --- settings --------------------------------------------------------------
  const settingsJsonByPath = new Map<string, JsonRecord>();
  {
    const files = await discoverSettings(root);
    const scanned: string[] = [];
    const unreadable: string[] = [];
    for (const relativePath of files) {
      // F16: a `.codex/config.toml` is not JSON at all — it is discovered
      // (for the mcp-configs surface, which parses and checks it below) but
      // no settings check ever runs on it here. It used to still land in
      // `pathsScanned` for the SETTINGS surface anyway (via the unfiltered
      // `files` list), which is a false claim of coverage. It is listed only
      // under `mcp-configs`, never here.
      if (relativePath.endsWith(".toml")) {
        continue;
      }
      const read = await readJsonObjectFile(path.join(root, relativePath));
      if (read.state !== "object") {
        unreadable.push(relativePath);
        continue;
      }
      settingsJsonByPath.set(relativePath, read.value);
      scanned.push(relativePath);
      raw.push(...checkOverPermissiveAllowlist(relativePath, read.value));
      raw.push(...checkMissingDenyList(relativePath, read.value));
      raw.push(...checkBypassFlagPresent(relativePath, read.value));
    }
    surfaces.push(surfaceResult("settings", scanned, unreadable));
  }

  // --- mcp-configs -------------------------------------------------------------
  {
    const { standalone, settingsFiles } = await discoverMcpConfigCandidates(root);
    const candidateFiles = [...standalone];
    for (const relativePath of settingsFiles) {
      const parsed = settingsJsonByPath.get(relativePath);
      if (parsed && "mcpServers" in parsed) {
        candidateFiles.push(relativePath);
      }
    }
    const uniqueFiles = [...new Set(candidateFiles)].sort();
    const unreadable: string[] = [];
    let sawMcpConfig = false;
    const { tools: baselineTools, state: baselineState } = await mcpBaselineTools(root);
    for (const relativePath of uniqueFiles) {
      if (relativePath.endsWith(".toml")) {
        // `.codex/config.toml`'s `[mcp_servers.<name>]` tables, via the
        // dependency-free reader in `./codex-toml` (kept out of
        // `mcp-servers/compat.ts` on purpose — see that module's header). A
        // file with ANY unreadable line is reported unreadable wholesale
        // rather than partially scanned: a partly-parsed launcher config
        // that comes back "clean" is worse than one flagged as not scanned
        // at all.
        const content = await safeReadText(path.join(root, relativePath));
        if (content === undefined) {
          unreadable.push(relativePath);
          continue;
        }
        const parsedToml = parseCodexToml(content);
        if (!parsedToml.ok) {
          unreadable.push(relativePath);
          continue;
        }
        sawMcpConfig = true;
        for (const server of parsedToml.servers) {
          if (server.command.length === 0) continue;
          raw.push(
            ...checkUnpinnedMcpLauncher(relativePath, server.name, server.command, [...server.args], {
              line: server.line,
            }),
          );
        }
        continue;
      }
      let record: JsonRecord | undefined = settingsJsonByPath.get(relativePath);
      if (record === undefined) {
        const read = await readJsonObjectFile(path.join(root, relativePath));
        record = read.state === "object" ? read.value : undefined;
      }
      if (!record) {
        unreadable.push(relativePath);
        continue;
      }
      sawMcpConfig = true;
      const mcpServers = (record as JsonRecord).mcpServers;
      if (mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers)) {
        for (const [name, def] of Object.entries(mcpServers as JsonRecord)) {
          if (!def || typeof def !== "object") continue;
          const command = typeof (def as JsonRecord).command === "string" ? ((def as JsonRecord).command as string) : "";
          const args = Array.isArray((def as JsonRecord).args)
            ? ((def as JsonRecord).args as unknown[]).filter((a): a is string => typeof a === "string")
            : [];
          if (command) {
            raw.push(...checkUnpinnedMcpLauncher(relativePath, name, command, args, { pointer: `/mcpServers/${name}` }));
          }
        }
      }
      const tools = (record as JsonRecord).tools;
      if (Array.isArray(tools) || (tools && typeof tools === "object")) {
        raw.push(...checkMcpManifest(relativePath, record, baselineState === "ok" ? baselineTools : undefined));
      }
    }
    if (sawMcpConfig && baselineState === "absent") {
      coverageReasons.push("mcp-rug-pull: not-established (no scan-mcp --pin baseline)");
    }
    if (baselineState === "unreadable") {
      coverageReasons.push("mcp-rug-pull: pinned baseline exists but could not be read");
    }
    surfaces.push(surfaceResult("mcp-configs", uniqueFiles, unreadable));
  }

  // --- hooks -------------------------------------------------------------------
  {
    const nonJsonFiles = await discoverHookSurfaceFiles(root);
    const scanned: string[] = [];
    const unreadable: string[] = [];
    for (const [relativePath, parsed] of settingsJsonByPath.entries()) {
      // Every top-level key a JSON surface can carry a hook `command` under:
      // `hooks` (Claude's nested `hooks.<Event>[].hooks[].command`, and
      // Cursor/Windsurf's flat `hooks.<event>[].command` — both land under
      // `settings.hooks` via `mergeIntoHookArray`, so the one recursive walk
      // below already covers both shapes), `securityHooks` (the flat
      // `{on, command}` entries the security surfaces install), and
      // `unmigratedHooks` (whatever a pre-existing legacy `hooks` array held
      // before it was moved aside — `settings-json.ts#mergeIntoHookArray`).
      // Missing either of the latter two meant a command hiding in one of
      // them was never checked for injection/exfiltration/suppression at all.
      const sections: Array<{ key: string; value: unknown }> = [
        { key: "hooks", value: parsed.hooks },
        { key: "securityHooks", value: parsed.securityHooks },
        { key: "unmigratedHooks", value: parsed.unmigratedHooks },
      ];
      const commands: Array<{ command: string; pointer: string }> = [];
      let sawAnySection = false;
      for (const { key, value } of sections) {
        if (value === undefined) continue;
        sawAnySection = true;
        collectHookCommands(value, `/${key}`, commands);
      }
      if (!sawAnySection) continue;
      scanned.push(relativePath);
      for (const { command, pointer } of commands) {
        raw.push(...checkHookCommandInjection(relativePath, command, pointer));
        raw.push(...checkHookExfiltrationShape(relativePath, command, pointer));
        raw.push(...checkHookSilentSuppression(relativePath, command, pointer));
      }
    }
    for (const relativePath of nonJsonFiles) {
      const content = await safeReadText(path.join(root, relativePath));
      if (content === undefined) {
        unreadable.push(relativePath);
        continue;
      }
      scanned.push(relativePath);
      raw.push(...checkHookSilentSuppressionInScript(relativePath, content));
    }
    surfaces.push(surfaceResult("hooks", [...new Set(scanned)].sort(), unreadable));
  }

  // --- agent-definitions -------------------------------------------------------
  {
    // F7: `discoverAgentDefinitions` now distinguishes "no such directory"
    // (genuinely not-applicable) from "the directory exists but could not be
    // listed" (a coverage gap) — the latter comes back as `unreadable` and
    // must count toward this surface's `pathsUnreadable`, not disappear.
    const { found: files, unreadable: discoveryUnreadable } = await discoverAgentDefinitions(root);
    const unreadable: string[] = [...discoveryUnreadable];
    for (const relativePath of files) {
      const content = await safeReadText(path.join(root, relativePath));
      if (content === undefined) {
        unreadable.push(relativePath);
        continue;
      }
      raw.push(...checkAgentUnrestrictedTools(relativePath, content));
      raw.push(...checkAgentMissingModelTier(relativePath, content));
      raw.push(...checkAutoRunDirective("agent-definitions", relativePath, content));
    }
    surfaces.push(surfaceResult("agent-definitions", files, unreadable));
  }

  // --- skills ------------------------------------------------------------------
  {
    const { found: files, unreadable: discoveryUnreadable, reasons: skillReasons } = await discoverSkillScripts(root);
    const unreadable: string[] = [...discoveryUnreadable];
    for (const relativePath of files) {
      const content = await safeReadText(path.join(root, relativePath));
      if (content === undefined) {
        unreadable.push(relativePath);
        continue;
      }
      raw.push(...checkSecretsInText("skills", "skill-script-secret", relativePath, content, "high"));
      raw.push(...checkInjectionInText("skills", "skill-script-injection", relativePath, content, "high"));
    }
    surfaces.push(surfaceResult("skills", files, unreadable));
    // N3: a depth-cap truncation is not tied to one path (everything below
    // the cut is unscanned), so it is not an `unreadable` entry — it reports
    // as a top-level coverage reason instead, the same channel the
    // `mcp-rug-pull: not-established` gap already uses.
    coverageReasons.push(...skillReasons);
  }

  // --- imported-bundles ----------------------------------------------------------
  surfaces.push({ surface: "imported-bundles", status: "not-applicable", pathsScanned: [] });

  // --- assign ids, dedupe --------------------------------------------------------
  const proposalsById = new Map<string, InternalProposal>();
  const withIds: AuditFinding[] = raw.map((f) => {
    const id = findingId(f);
    let fixProposal: AuditFinding["fixProposal"];
    if (f.internalProposal) {
      const scopedId = proposalId(id, f.internalProposal.proposal.id);
      const proposal = { ...f.internalProposal.proposal, id: scopedId };
      proposalsById.set(scopedId, { proposal, edit: f.internalProposal.edit });
      fixProposal = options.fixProposals ? proposal : null;
    }
    const finding: AuditFinding = {
      id,
      surface: f.surface,
      check: f.check,
      severity: f.severity,
      confidence: f.confidence,
      ...(f.path !== undefined ? { path: f.path } : {}),
      ...(f.location !== undefined ? { location: f.location } : {}),
      message: f.message,
      evidence: f.evidence,
      ...(fixProposal !== undefined ? { fixProposal } : {}),
      suppressed: { value: false, baselineEntryId: null },
    };
    return finding;
  });

  // --- baseline --------------------------------------------------------------
  const baselinePath = options.baselinePath ?? defaultBaselinePath(root);
  const loaded = await readBaseline(baselinePath);
  let baseline: BaselineState | null = null;
  let allFindings = withIds;
  if (loaded) {
    baseline = loaded.state;
    allFindings = applySuppression(allFindings, loaded.applicableEntries, now);
    allFindings = [...allFindings, ...indefiniteSuppressionFindings(loaded.applicableEntries)];
  }
  allFindings = [...allFindings].sort(compareFindings);

  // F6: `--severity-floor` is a DISPLAY/listing filter only — it used to
  // filter `findings` before the score/gate were computed from it, so
  // `--ci --severity-floor critical` silently hid an unsuppressed `high`
  // finding from both the score and the pass/fail gate ("passing" a report
  // that has one). The summary (score, grade, countsBySeverity) and
  // `totalFindings` are always computed from the COMPLETE unsuppressed set,
  // regardless of the floor; `auditGate` reads `report.summary`, not
  // `report.findings`, for exactly this reason. The floor only trims which
  // findings are actually listed in the returned/printed `findings` array.
  const unsuppressed = allFindings.filter((f) => !f.suppressed.value);
  const summary = scoreFindings(unsuppressed, allFindings.length);

  const floor = options.severityFloor;
  const findings = floor ? allFindings.filter((f) => severityRank(f.severity) >= severityRank(floor)) : allFindings;

  const coverage: CoverageStatus = {
    status: surfaces.some((s) => s.status === "error") || coverageReasons.length > 0 ? "incomplete" : "complete",
    ...(coverageReasons.length > 0 || surfaces.some((s) => s.status === "error")
      ? {
          reasons: [
            ...coverageReasons,
            ...surfaces.filter((s) => s.status === "error").map((s) => s.error ?? `${s.surface}: unreadable`),
          ],
        }
      : {}),
  };

  const report: AuditReport = {
    schemaVersion: "1.0.0",
    generatedAt: now.toISOString(),
    root,
    cliArgs: {
      fixProposals: options.fixProposals === true,
      ci: options.ci === true,
      baselinePath: options.baselinePath ?? null,
      ...(floor ? { severityFloor: floor } : {}),
    },
    surfaces,
    findings,
    summary,
    coverage,
    baseline,
  };

  return { report, proposalsById };
}

export async function runHarnessAudit(root: string, options: RunAuditOptions = {}): Promise<AuditReport> {
  const { report } = await computeAuditInternal(root, options);
  return report;
}

/**
 * `pass`/`fail` gate over a completed report: fails on any unsuppressed
 * critical/high finding, or a configured baseline whose `tamperState` is not
 * `ok`. Mirrors `security.ts`'s `isPassGate` allowlist shape (T7 wires this
 * into the same vocabulary once `isPassGate` is exported from `./security`).
 *
 * F6: reads `report.summary.countsBySeverity`, never `report.findings` —
 * `findings` can be trimmed by `--severity-floor` (a display filter, see
 * `computeAuditInternal` above), but `summary` is always computed over the
 * COMPLETE unsuppressed set, so the gate (and the CI exit code derived from
 * it) cannot be bypassed by a floor that hides the blocking finding from the
 * listing.
 */
export function auditGate(report: AuditReport): "pass" | "fail" {
  const hasBlockingFinding = report.summary.countsBySeverity.critical > 0 || report.summary.countsBySeverity.high > 0;
  const baselineTampered = report.baseline !== null && report.baseline.tamperState !== "ok";
  return hasBlockingFinding || baselineTampered ? "fail" : "pass";
}

export * from "./types";
export * from "./checks";
export * from "./score";
export * from "./surfaces";
