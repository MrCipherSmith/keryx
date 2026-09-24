// Flow 308 (W8 Design part A, Lane A) — `runHarnessAudit`, the entry point
// for `keryx security audit-harness`. Read-only: never writes to disk (see
// `proposals.ts#applyAuditProposal` and `baseline.ts#addBaselineEntry` for
// the only two writing paths in this surface).

import { createHash } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { isPathInside, pathExists } from "../../lib/fs";
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
  checkHookRemoteExec,
  checkHookSilentSuppression,
  checkHookSilentSuppressionInScript,
  checkInjectionInText,
  checkMcpManifest,
  checkMissingDenyList,
  checkOverPermissiveAllowlist,
  checkRemoteExecInText,
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
  CheckId,
  CoverageStatus,
  ImportedBundleEntryKind,
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

async function safeReadBuffer(absolute: string): Promise<Buffer | undefined> {
  try {
    return await readFile(absolute);
  } catch {
    return undefined;
  }
}

/**
 * R1-F6/R1-F8 (flow 313 W4 review round 1): whether `buffer` is text content
 * a bundle `skill` entry's checks can run against. Node's `Buffer#toString
 * ("utf8")` is NEVER fatal — it silently replaces invalid byte sequences
 * with U+FFFD — so a binary payload (an actual binary, or bytes crafted to
 * dodge the secret/injection/auto-run regexes as raw bytes) used to decode
 * to *something* and pass straight through the text checks. Decode with a
 * FATAL `TextDecoder` instead: any invalid UTF-8 byte sequence throws. A NUL
 * byte is refused separately — valid one-byte UTF-8, but never legitimate in
 * a markdown/script skill file, and a NUL is exactly the kind of "make the
 * later text checks misbehave" payload this guards against.
 */
function isTextContent(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * R2-F12: a small, explicitly documented magic-bytes allowlist of common
 * BINARY asset types a skill can legitimately carry (an icon, a screenshot in
 * its docs, a bundled font) — `isTextContent` above already refuses any
 * OTHER binary payload outright (reason: binary-content, surface `error`,
 * import fails closed). An allowlisted asset is instead recorded as `scanned`
 * (its bytes are already hashed/checksummed by the bundle manifest layer)
 * with a coverage NOTE that it was not text-scanned — that note never fails
 * the W8 gate (`auditGate` only looks at severity counts), it only keeps
 * `coverage.status` honest about what was and was not scanned.
 * Deliberately excludes ZIP-based container formats (docx/pptx/xlsx and
 * plain .zip all share the `PK\x03\x04` magic) — those can smuggle arbitrary
 * nested content and stay unscanned-binary refused, same as before this fix.
 */
function knownBinaryAssetType(buffer: Buffer): string | undefined {
  const ascii = (start: number, end: number): string => (buffer.length >= end ? buffer.toString("latin1", start, end) : "");
  if (buffer.length >= 8 && buffer[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "gif";
  if (buffer.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (buffer.length >= 4 && buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) return "ico";
  if (buffer.length >= 4 && ascii(0, 4) === "%PDF") return "pdf";
  if (buffer.length >= 4 && ascii(0, 4) === "wOFF") return "woff";
  if (buffer.length >= 4 && ascii(0, 4) === "wOF2") return "woff2";
  return undefined;
}

type JsonRecord = Record<string, unknown>;

/**
 * R2-F3: shell-quotes a single argv element for the PATTERN-MATCHING string
 * this walker builds — never a real shell command (the hook runtime spawns
 * `argv` directly, per `hook-config.schema.json`, exactly to avoid shell
 * interpolation). An element with no shell metacharacters is left bare; an
 * element that needs one is single-quoted, with any single quote inside it
 * escaped the POSIX way (`'\''`), so the joined string always parses the way
 * a shell actually would and a payload's own quotes can't break out of it.
 */
function shellQuoteForMatching(arg: string): string {
  if (/^[A-Za-z0-9_\-./:@=]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * R2-F3: the hook-config schema `plan.ts:245-262` enforces requires
 * `command: {argv: [...]}` (an object, never a bare string) — this walker
 * used to look ONLY for a string `command`, so every schema-valid hook the
 * import path actually accepts got zero checks, and the remote-exec/
 * injection/exfiltration/suppression checks below were dead code on that
 * path (`R2-F3`). An argv array is joined into one shell-quoted string (so
 * the existing text-shaped checks — which look for `curl ... | sh`-style
 * SHAPES, not individual tokens — still fire on the reconstructed command,
 * e.g. `["sh","-c","curl ... | sh"]` still reads as `sh -c 'curl ... | sh'`)
 * AND each element is also pushed on its own, at its own pointer, so a
 * directive smuggled into a single argv element (rather than assembled only
 * once joined) is still caught and still gets its own precise pointer.
 * The legacy bare-string `command` shape (the live `hooks`/`securityHooks`/
 * `unmigratedHooks` settings-surface shape, unrelated to this schema) is
 * still read exactly as before — this is additive, not a replacement.
 */
function collectHookCommands(value: unknown, pointer: string, out: Array<{ command: string; pointer: string }>): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectHookCommands(item, `${pointer}/${index}`, out));
    return;
  }
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    if (typeof record.command === "string") {
      out.push({ command: record.command, pointer: `${pointer}/command` });
    } else if (record.command && typeof record.command === "object" && !Array.isArray(record.command)) {
      const rawArgv: unknown = (record.command as JsonRecord).argv;
      if (Array.isArray(rawArgv) && rawArgv.every((v): v is string => typeof v === "string")) {
        const argv = rawArgv;
        out.push({ command: argv.map(shellQuoteForMatching).join(" "), pointer: `${pointer}/command/argv` });
        argv.forEach((element, index) => {
          out.push({ command: element, pointer: `${pointer}/command/argv/${index}` });
        });
      }
    }
    for (const [key, nested] of Object.entries(record)) {
      if (key === "command") continue;
      collectHookCommands(nested, `${pointer}/${key}`, out);
    }
  }
}

/** R2-F11: every string value in a parsed JSON document, depth-first — used so a `learned-pattern` bundle entry's checks run against the DECODED string content (an escaped `\n` becomes a real newline) rather than the raw serialized JSON text, which hid an auto-run directive inside a JSON string literal from the line-oriented `[^.\n]`-bounded check patterns. */
function collectJsonStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectJsonStrings(item, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as JsonRecord)) {
      collectJsonStrings(nested, out);
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

// --- imported-bundles (Flow 313, W4 portability, T7) ------------------------
//
// `keryx bundle import` (W4) stages a bundle's to-be-written files into a
// temp dir AT THEIR BUNDLE PATHS and passes that dir as `root` plus a manifest
// of `{path, kind}` entries via `options.importedBundle`. Every check above
// already knows how to scan its own native surface (`instructions`, `skills`,
// `agent-definitions`, `hooks`) — rather than duplicating that detection
// logic, the functions below call the EXISTING check with its own surface/
// check-id arguments (never behaviour-changing) and then rewrite the returned
// findings' `surface`/`check` onto the `imported-bundles` surface and its
// `bundle-*` check id, per W8-harness-security-audit.md's `bundle-*` row
// ("every check above, run against staged bundle contents ... inherits
// per-check severity" — the severity on each RawFinding is left untouched).

/** Rewrites `surface`→"imported-bundles" and `check`→`bundleCheck` on every finding, leaving severity/confidence/message/evidence/location exactly as the underlying check produced them. */
function asBundleFindings(findings: RawFinding[], bundleCheck: CheckId): RawFinding[] {
  return findings.map((f) => ({ ...f, surface: "imported-bundles", check: bundleCheck }));
}

/**
 * A staged bundle entry's `path` is attacker-influenced (it comes from the
 * bundle manifest, before any content is trusted). Refuse anything that could
 * resolve outside `root`: absolute paths, `..` segments, and backslashes
 * (which `path.join` on POSIX would otherwise treat as a literal filename
 * character, silently hiding a Windows-style traversal attempt from the `..`
 * check). Such an entry is reported `unreadable`, never read.
 */
function isSafeBundleEntryPath(relativePath: string): boolean {
  if (relativePath.length === 0) return false;
  if (path.isAbsolute(relativePath)) return false;
  if (relativePath.includes("\\")) return false;
  return !relativePath.split("/").some((segment) => segment === "..");
}

async function scanImportedBundle(
  root: string,
  entries: ReadonlyArray<{ path: string; kind: ImportedBundleEntryKind }>,
): Promise<{ raw: RawFinding[]; surface: SurfaceResult; notes: string[] }> {
  const raw: RawFinding[] = [];
  const scanned: string[] = [];
  const unreadable: string[] = [];
  const notes: string[] = [];
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const entry of sorted) {
    if (!isSafeBundleEntryPath(entry.path)) {
      unreadable.push(entry.path);
      continue;
    }
    const absolute = path.join(root, entry.path);
    if (!isPathInside(root, absolute)) {
      unreadable.push(entry.path);
      continue;
    }

    if (entry.kind === "hook-config") {
      const content = await safeReadText(absolute);
      if (content === undefined) {
        unreadable.push(entry.path);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        unreadable.push(entry.path);
        continue;
      }
      scanned.push(entry.path);
      const commands: Array<{ command: string; pointer: string }> = [];
      collectHookCommands(parsed, "", commands);
      for (const { command, pointer } of commands) {
        raw.push(...asBundleFindings(checkHookCommandInjection(entry.path, command, pointer), "bundle-hook-command-injection"));
        raw.push(...asBundleFindings(checkHookExfiltrationShape(entry.path, command, pointer), "bundle-hook-exfiltration-shape"));
        raw.push(...asBundleFindings(checkHookSilentSuppression(entry.path, command, pointer), "bundle-hook-silent-suppression"));
        raw.push(...asBundleFindings(checkHookRemoteExec(entry.path, command, pointer), "bundle-hook-remote-exec"));
      }
      continue;
    }

    // R1-F6/R1-F8: a `skill` entry used to only be text-decoded via
    // `safeReadText`, which never fails (Node's utf8 decode replaces invalid
    // bytes rather than throwing), and only its EXACT-CASE `SKILL.md`
    // basename got the auto-run/injection-in-instructions checks — so a
    // `skill.md`/`Skill.MD` case variant (identical file on a case-
    // insensitive filesystem), or any other file in the skill (a
    // `reference.md`, a `notes.txt`), evaded both checks entirely. Every
    // file of kind `skill` is now read as raw bytes first: a binary payload
    // is refused outright (reason: binary-content) so the surface reports
    // `error` and the caller (`bundle/audit.ts#auditBundlePlan`) fails
    // closed rather than silently skipping unscanned content; every TEXT
    // file — any name, any extension — gets the full check set, not just a
    // canonically-cased `SKILL.md`.
    if (entry.kind === "skill") {
      const buffer = await safeReadBuffer(absolute);
      if (buffer === undefined) {
        unreadable.push(entry.path);
        continue;
      }
      if (!isTextContent(buffer)) {
        const binaryType = knownBinaryAssetType(buffer);
        if (binaryType !== undefined) {
          scanned.push(entry.path);
          notes.push(`${entry.path}: recorded as hashed but not text-scanned (binary asset: ${binaryType})`);
          continue;
        }
        unreadable.push(entry.path);
        continue;
      }
      const content = buffer.toString("utf8");
      scanned.push(entry.path);
      raw.push(
        ...asBundleFindings(
          checkSecretsInText("skills", "skill-script-secret", entry.path, content, "high"),
          "bundle-skill-script-secret",
        ),
      );
      raw.push(
        ...asBundleFindings(
          checkInjectionInText("skills", "skill-script-injection", entry.path, content, "high"),
          "bundle-skill-script-injection",
        ),
      );
      raw.push(...asBundleFindings(checkAutoRunDirective("skills", entry.path, content), "bundle-auto-run-directive"));
      raw.push(
        ...asBundleFindings(
          checkInjectionInText("instructions", "prompt-injection-in-instructions", entry.path, content, "high"),
          "bundle-prompt-injection-in-instructions",
        ),
      );
      raw.push(...asBundleFindings(checkRemoteExecInText("skills", entry.path, content), "bundle-hook-remote-exec"));
      continue;
    }

    const content = await safeReadText(absolute);
    if (content === undefined) {
      unreadable.push(entry.path);
      continue;
    }
    scanned.push(entry.path);

    switch (entry.kind) {
      case "rule": {
        raw.push(
          ...asBundleFindings(
            checkSecretsInText("instructions", "secret-in-instructions", entry.path, content, "critical"),
            "bundle-secret-in-instructions",
          ),
        );
        raw.push(
          ...asBundleFindings(
            checkInjectionInText("instructions", "prompt-injection-in-instructions", entry.path, content, "high"),
            "bundle-prompt-injection-in-instructions",
          ),
        );
        raw.push(...asBundleFindings(checkAutoRunDirective("instructions", entry.path, content), "bundle-auto-run-directive"));
        break;
      }
      case "agent": {
        raw.push(...asBundleFindings(checkAgentUnrestrictedTools(entry.path, content), "bundle-agent-unrestricted-tools"));
        raw.push(...asBundleFindings(checkAgentMissingModelTier(entry.path, content), "bundle-agent-missing-model-tier"));
        raw.push(
          ...asBundleFindings(checkAutoRunDirective("agent-definitions", entry.path, content), "bundle-auto-run-directive"),
        );
        break;
      }
      case "learned-pattern": {
        // R2-F11: `learned-pattern` content is a JSON record (the same
        // `learnedPatternSchemaJson` shape `plan.ts` validates), not free
        // text — checking the raw SERIALIZED text meant a directive inside a
        // JSON string value survived as its ESCAPED form (`\n` stayed the two
        // characters `\` and `n`, never a real newline), which is enough to
        // dodge the `[^.\n]{0,N}`-bounded auto-run/injection patterns above.
        // Parsed and every string value re-joined (one per line) so the
        // checks see the DECODED text a consumer of the pattern actually
        // reads. A parse failure (plan.ts already refuses this before import
        // reaches here — R1-F12 — so this is defense in depth only) falls
        // back to the raw text rather than scanning nothing.
        let decoded = content;
        try {
          const parsedJson: unknown = JSON.parse(content);
          const strings: string[] = [];
          collectJsonStrings(parsedJson, strings);
          if (strings.length > 0) decoded = strings.join("\n");
        } catch {
          // not valid JSON — scan the raw text as a fallback.
        }
        raw.push(
          ...asBundleFindings(
            checkSecretsInText("instructions", "secret-in-instructions", entry.path, decoded, "critical"),
            "bundle-secret-in-instructions",
          ),
        );
        raw.push(
          ...asBundleFindings(
            checkInjectionInText("instructions", "prompt-injection-in-instructions", entry.path, decoded, "high"),
            "bundle-prompt-injection-in-instructions",
          ),
        );
        raw.push(...asBundleFindings(checkAutoRunDirective("instructions", entry.path, decoded), "bundle-auto-run-directive"));
        break;
      }
      case "memory-entry": {
        // Memory entries are markdown (see `src/memory/store.ts`), not JSON
        // — scanned as plain text, unchanged.
        raw.push(
          ...asBundleFindings(
            checkSecretsInText("instructions", "secret-in-instructions", entry.path, content, "critical"),
            "bundle-secret-in-instructions",
          ),
        );
        raw.push(
          ...asBundleFindings(
            checkInjectionInText("instructions", "prompt-injection-in-instructions", entry.path, content, "high"),
            "bundle-prompt-injection-in-instructions",
          ),
        );
        // R1-F8: a learned pattern or memory entry is loaded into agent
        // context exactly like a rule/skill/agent file — it previously got
        // no `checkAutoRunDirective` at all, so an auto-run directive
        // smuggled in through learning/memory import evaded every check.
        raw.push(...asBundleFindings(checkAutoRunDirective("instructions", entry.path, content), "bundle-auto-run-directive"));
        break;
      }
    }
  }

  return { raw, surface: surfaceResult("imported-bundles", scanned, unreadable), notes };
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
        raw.push(...checkHookRemoteExec(relativePath, command, pointer));
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
  if (options.importedBundle) {
    const { raw: bundleRaw, surface: bundleSurface, notes: bundleNotes } = await scanImportedBundle(root, options.importedBundle.entries);
    raw.push(...bundleRaw);
    surfaces.push(bundleSurface);
    coverageReasons.push(...bundleNotes);
  } else {
    surfaces.push({ surface: "imported-bundles", status: "not-applicable", pathsScanned: [] });
  }

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
