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
 * R4-F(R3-F1 final, flow 313 W4 final surgical pass, lane F-B): every byte
 * string a bundle `skill` entry carries is scanned as text — there is no
 * binary/text classification left to bypass. A previous version FATAL-
 * decoded as UTF-8 and refused (`unreadable`, surface `error`) anything that
 * was not valid UTF-8, then grew a magic-bytes + extension + structural-
 * trailer allowlist so common binary assets (an icon, a screenshot, a font)
 * would not hard-fail an otherwise-clean skill. Round 3 (R3-F1) showed that
 * allowlist is itself the vulnerability: a polyglot file (real GIF/PDF/PNG/
 * WEBP bytes with an embedded `curl | sh` line or an injection directive
 * appended before the format's own trailer) satisfies every one of those
 * checks and skips the text scan entirely — SKILL.md instructing "run `sh
 * assets/logo.gif`" then imports with ZERO findings. There is no format,
 * extension or trailer check that can distinguish a real image from a
 * polyglot carrying one, so the fix removes the classification step rather
 * than trying to harden it further: EVERY skill-kind file is lossy-decoded
 * (invalid UTF-8 byte sequences become U+FFFD, never thrown) and run through
 * the full check set, exactly like a `.md`/`.sh` file always was.
 *
 * Trade-off, accepted and documented here rather than suppressed in code: a
 * real, non-malicious image/font asset can decode to noise that coincidental-
 * ly matches a low-confidence heuristic (an injection phrase, a secret-shaped
 * run of base64-ish bytes) and produce a false-positive finding. That is
 * strictly preferable to the zero-finding false negative above — a spurious
 * `medium`/`high` finding on a genuine icon is reviewable and suppressible
 * through the normal baseline path; content that imports with NO finding at
 * all cannot be caught by any downstream step. No bundle content is skipped,
 * and nothing here decides "this looks like a real image, skip it" ever
 * again.
 */
function lossyDecodeBytes(buffer: Buffer): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
}

/**
 * R2-F12 residual (flow 313 W4 review round 2/3): a UTF-16 file (a BOM-
 * marked `.md`/`.txt` from a Windows-authored skill, for instance) contains
 * a NUL byte after every ASCII character by construction — a plain lossy
 * UTF-8 decode of those bytes is mostly replacement characters, which would
 * bury the real content under noise even though nothing here refuses it
 * outright any more (see `lossyDecodeBytes` above). A leading UTF-16 BOM
 * (`FF FE` little-endian, `FE FF` big-endian) is decoded and returned as
 * ordinary text instead, so this content gets the full check set against its
 * REAL text, not a wall of U+FFFD; a non-BOM-marked buffer falls through to
 * the plain lossy UTF-8 decode below (bare UTF-16 with no BOM is
 * indistinguishable from arbitrary bytes without a declared encoding, and is
 * scanned as whatever that lossy decode produces, same as any other file).
 *
 * R6-F(R5-F2 residual) (review round 6): this used to decode with
 * `{fatal: true}` and return `undefined` on any decode error, so a file that
 * IS genuinely UTF-16 with a BOM — real content, not an ASCII file wearing a
 * BOM prefix — but carries one lone surrogate (an unpaired `00 D8`/`D8 00`
 * code unit) or one odd trailing byte lost its BOM-decoded variant entirely.
 * `contentVariants` then fell back to ONLY the lossy UTF-8 view, which for
 * genuine UTF-16 bytes is NUL-interleaved noise that no text check matches —
 * the exact zero-finding gap this dual-decode rule exists to close. A BOM is
 * a strong, deliberate declaration of encoding; once one is present, the
 * UTF-16 view is decoded LOSSILY (`fatal: false`, same as `lossyDecodeBytes`
 * above) instead of being dropped on any single malformed code unit, so it
 * always joins `contentVariants` whenever a BOM is present. The dual scan and
 * finding union below are unchanged.
 */
function decodeUtf16WithBom(buffer: Buffer): string | undefined {
  if (buffer.length < 2) return undefined;
  const isLittleEndianBom = buffer[0] === 0xff && buffer[1] === 0xfe;
  const isBigEndianBom = buffer[0] === 0xfe && buffer[1] === 0xff;
  if (!isLittleEndianBom && !isBigEndianBom) return undefined;
  return new TextDecoder(isLittleEndianBom ? "utf-16le" : "utf-16be", { fatal: false }).decode(buffer.subarray(2));
}

/**
 * R7-F1 (flow 313 W4, review round 7): the BOM-aware dual decode above used
 * to exist ONLY on the `skill` entry path — every other imported-bundle kind
 * (`rule`, `agent`, `memory-entry`, `learned-pattern`, `hook-config`) was
 * still read with `safeReadText`, a plain UTF-8 decode. A genuine UTF-16
 * `rule` or `memory-entry` file (real `FF FE`/`FE FF` bytes, NUL-interleaved
 * content) carrying an injection directive decoded to noise no text check
 * matched, and imported with ZERO findings — the exact class `decodeUtf16WithBom`
 * exists to close, just at a sibling site the original fix's scope missed.
 * This is the ONE shared helper every scanned text kind now goes through
 * (never a per-kind copy): a BOM-marked buffer yields BOTH the BOM-decoded
 * view and the plain lossy UTF-8 view of the same bytes; a non-BOM buffer
 * yields only the lossy view. Callers run their checks against every variant
 * and union the findings, deduplicated by `findingId` (see
 * `unionFindingsById` below), exactly like the skill path already did.
 */
function decodeTextVariants(buffer: Buffer): string[] {
  const bomDecoded = decodeUtf16WithBom(buffer);
  const lossyDecoded = lossyDecodeBytes(buffer);
  return bomDecoded !== undefined ? [bomDecoded, lossyDecoded] : [lossyDecoded];
}

/**
 * Shared dedup step for a per-variant finding scan: several decode variants
 * of the same file can trip the same check at the same pointer (a genuine
 * UTF-16 file whose lossy NUL-interleaved decode happens to also match), and
 * this collapses those to one finding per `findingId`, same rule the `skill`
 * path already applied inline.
 */
function unionFindingsById(variantFindings: ReadonlyArray<RawFinding[]>): RawFinding[] {
  const seen = new Set<string>();
  const result: RawFinding[] = [];
  for (const findings of variantFindings) {
    for (const finding of findings) {
      const id = findingId(finding);
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(finding);
    }
  }
  return result;
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
      const commandRecord = record.command as JsonRecord;
      const rawArgv: unknown = commandRecord.argv;
      if (Array.isArray(rawArgv) && rawArgv.every((v): v is string => typeof v === "string")) {
        const argv = rawArgv;
        out.push({ command: argv.map(shellQuoteForMatching).join(" "), pointer: `${pointer}/command/argv` });
        argv.forEach((element, index) => {
          out.push({ command: element, pointer: `${pointer}/command/argv/${index}` });
        });
      }
      // R2-F3 (env-var indirection): the hook-config schema also allows
      // `command.env`, a map of environment-variable name -> value, applied
      // to the spawned process. A remote-exec/injection payload placed in an
      // env value (rather than argv) used to get zero checks — the argv walk
      // above never looked at `env` at all. Each env value is pushed at its
      // own pointer, same as an argv element; the walk below also descends
      // into `env` generically (it is not named "command"), so this is
      // belt-and-suspenders for any future nested shape, but the explicit
      // push keeps today's flat `{VAR: "value"}` shape checked even if a
      // value under it happened to be a non-string that the generic walk
      // would otherwise skip.
      const rawEnv: unknown = commandRecord.env;
      if (rawEnv && typeof rawEnv === "object" && !Array.isArray(rawEnv)) {
        for (const [envKey, envValue] of Object.entries(rawEnv as JsonRecord)) {
          if (typeof envValue === "string") {
            out.push({ command: envValue, pointer: `${pointer}/command/env/${envKey}` });
          }
        }
      }
      if (typeof commandRecord.cwd === "string") {
        out.push({ command: commandRecord.cwd, pointer: `${pointer}/command/cwd` });
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
      // R7-F1: a hook-config is JSON, so it is parsed AFTER decoding rather
      // than scanned as free text. The BOM-decoded variant (when a BOM is
      // present) is tried first; the plain lossy-UTF-8 variant is tried
      // next. A variant that fails `JSON.parse` contributes no findings —
      // there is no JSON structure to walk `collectHookCommands` over — but
      // this never goes silently clean: if EVERY variant fails to parse, the
      // entry fails closed as `unreadable`, same as before this fix. If any
      // variant parses, its hook commands are checked and unioned with any
      // other parseable variant's, deduplicated by `findingId`.
      const buffer = await safeReadBuffer(absolute);
      if (buffer === undefined) {
        unreadable.push(entry.path);
        continue;
      }
      const contentVariants = decodeTextVariants(buffer);
      const parsedVariants: unknown[] = [];
      for (const content of contentVariants) {
        try {
          parsedVariants.push(JSON.parse(content));
        } catch {
          // this variant does not parse as JSON — try the next one.
        }
      }
      if (parsedVariants.length === 0) {
        unreadable.push(entry.path);
        continue;
      }
      scanned.push(entry.path);
      const perVariantFindings: RawFinding[][] = parsedVariants.map((parsed) => {
        const commands: Array<{ command: string; pointer: string }> = [];
        collectHookCommands(parsed, "", commands);
        const findings: RawFinding[] = [];
        for (const { command, pointer } of commands) {
          findings.push(...asBundleFindings(checkHookCommandInjection(entry.path, command, pointer), "bundle-hook-command-injection"));
          findings.push(...asBundleFindings(checkHookExfiltrationShape(entry.path, command, pointer), "bundle-hook-exfiltration-shape"));
          findings.push(...asBundleFindings(checkHookSilentSuppression(entry.path, command, pointer), "bundle-hook-silent-suppression"));
          findings.push(...asBundleFindings(checkHookRemoteExec(entry.path, command, pointer), "bundle-hook-remote-exec"));
        }
        return findings;
      });
      raw.push(...unionFindingsById(perVariantFindings));
      continue;
    }

    // R1-F6/R1-F8: a `skill` entry used to only be text-decoded via
    // `safeReadText`, and only its EXACT-CASE `SKILL.md` basename got the
    // auto-run/injection-in-instructions checks — so a `skill.md`/`Skill.MD`
    // case variant (identical file on a case-insensitive filesystem), or any
    // other file in the skill (a `reference.md`, a `notes.txt`), evaded both
    // checks entirely. Every file of kind `skill` is now read as raw bytes
    // and every TEXT file — any name, any extension — gets the full check
    // set, not just a canonically-cased `SKILL.md`.
    //
    // R3-F1 (final pass, lane F-B): there is deliberately no binary/text
    // classification step here any more — see `lossyDecodeBytes` above for
    // why an allowlist of "known binary formats" was itself the hole (a
    // format-valid polyglot skipped the text scan entirely). Every skill
    // file is scanned; only a genuine filesystem read failure (permissions,
    // a symlink race) lands in `unreadable`.
    //
    // R5-F2 (review round 5): a leading UTF-16 BOM used to SELECT exactly one
    // decode (`decodeUtf16WithBom(buffer) ?? lossyDecodeBytes(buffer)`) — a
    // file that starts with `FF FE`/`FE FF` and is otherwise plain ASCII (a
    // BOM prefix glued onto an ASCII script/markdown file, not a real UTF-16
    // document) decodes under UTF-16 to CJK noise with no surrogate errors,
    // so the fatal decode never falls through to the lossy branch and every
    // check below only ever saw the noise, never the real ASCII content. A
    // file with a valid BOM decode is now scanned under BOTH the BOM-decoded
    // text AND the plain lossy decode of the same bytes — a genuine UTF-16
    // file is still caught via its real decode, and an ASCII file wearing a
    // BOM prefix is caught via the lossy decode of its actual bytes. Findings
    // from the two passes are unioned, deduplicated by `findingId` (so a
    // genuine UTF-16 file whose lossy NUL-interleaved decode happens to also
    // trip the same check at the same pointer isn't reported twice).
    if (entry.kind === "skill") {
      const buffer = await safeReadBuffer(absolute);
      if (buffer === undefined) {
        unreadable.push(entry.path);
        continue;
      }
      const contentVariants = decodeTextVariants(buffer);
      scanned.push(entry.path);
      const skillVariantFindings: RawFinding[][] = contentVariants.map((content) => [
        ...asBundleFindings(
          checkSecretsInText("skills", "skill-script-secret", entry.path, content, "high"),
          "bundle-skill-script-secret",
        ),
        ...asBundleFindings(
          checkInjectionInText("skills", "skill-script-injection", entry.path, content, "high"),
          "bundle-skill-script-injection",
        ),
        ...asBundleFindings(checkAutoRunDirective("skills", entry.path, content), "bundle-auto-run-directive"),
        ...asBundleFindings(
          checkInjectionInText("instructions", "prompt-injection-in-instructions", entry.path, content, "high"),
          "bundle-prompt-injection-in-instructions",
        ),
        ...asBundleFindings(checkRemoteExecInText("skills", entry.path, content), "bundle-hook-remote-exec"),
      ]);
      raw.push(...unionFindingsById(skillVariantFindings));
      continue;
    }

    // R7-F1: `rule`, `agent`, `learned-pattern` and `memory-entry` used to be
    // read with `safeReadText` — a plain UTF-8 decode with no BOM awareness
    // — the exact gap the skill path's `decodeUtf16WithBom` dual decode
    // exists to close, just left open at this sibling site. Every one of
    // these kinds is now read as raw bytes and scanned through the SAME
    // shared `decodeTextVariants` helper the skill path uses, with findings
    // from every variant unioned and deduplicated by `findingId`.
    const buffer = await safeReadBuffer(absolute);
    if (buffer === undefined) {
      unreadable.push(entry.path);
      continue;
    }
    scanned.push(entry.path);
    const contentVariants = decodeTextVariants(buffer);

    const otherKindVariantFindings: RawFinding[][] = contentVariants.map((content) => {
      switch (entry.kind) {
        case "rule": {
          return [
            ...asBundleFindings(
              checkSecretsInText("instructions", "secret-in-instructions", entry.path, content, "critical"),
              "bundle-secret-in-instructions",
            ),
            ...asBundleFindings(
              checkInjectionInText("instructions", "prompt-injection-in-instructions", entry.path, content, "high"),
              "bundle-prompt-injection-in-instructions",
            ),
            ...asBundleFindings(checkAutoRunDirective("instructions", entry.path, content), "bundle-auto-run-directive"),
          ];
        }
        case "agent": {
          return [
            ...asBundleFindings(checkAgentUnrestrictedTools(entry.path, content), "bundle-agent-unrestricted-tools"),
            ...asBundleFindings(checkAgentMissingModelTier(entry.path, content), "bundle-agent-missing-model-tier"),
            ...asBundleFindings(checkAutoRunDirective("agent-definitions", entry.path, content), "bundle-auto-run-directive"),
          ];
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
          // back to the raw text rather than scanning nothing — R7-F1: this
          // fallback is what keeps an unparseable variant from going silently
          // clean, matching the hook-config fail-closed contract at the JSON
          // level with a text-check floor instead.
          let decoded = content;
          try {
            const parsedJson: unknown = JSON.parse(content);
            const strings: string[] = [];
            collectJsonStrings(parsedJson, strings);
            if (strings.length > 0) decoded = strings.join("\n");
          } catch {
            // not valid JSON — scan the raw text as a fallback.
          }
          return [
            ...asBundleFindings(
              checkSecretsInText("instructions", "secret-in-instructions", entry.path, decoded, "critical"),
              "bundle-secret-in-instructions",
            ),
            ...asBundleFindings(
              checkInjectionInText("instructions", "prompt-injection-in-instructions", entry.path, decoded, "high"),
              "bundle-prompt-injection-in-instructions",
            ),
            ...asBundleFindings(checkAutoRunDirective("instructions", entry.path, decoded), "bundle-auto-run-directive"),
          ];
        }
        case "memory-entry": {
          // Memory entries are markdown (see `src/memory/store.ts`), not JSON
          // — scanned as plain text, unchanged.
          return [
            ...asBundleFindings(
              checkSecretsInText("instructions", "secret-in-instructions", entry.path, content, "critical"),
              "bundle-secret-in-instructions",
            ),
            ...asBundleFindings(
              checkInjectionInText("instructions", "prompt-injection-in-instructions", entry.path, content, "high"),
              "bundle-prompt-injection-in-instructions",
            ),
            // R1-F8: a learned pattern or memory entry is loaded into agent
            // context exactly like a rule/skill/agent file — it previously got
            // no `checkAutoRunDirective` at all, so an auto-run directive
            // smuggled in through learning/memory import evaded every check.
            ...asBundleFindings(checkAutoRunDirective("instructions", entry.path, content), "bundle-auto-run-directive"),
          ];
        }
        default:
          return [];
      }
    });
    raw.push(...unionFindingsById(otherKindVariantFindings));
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
