// herdr-core status reporter. The herdr-core runtime reads a program's status only
// from an OSC 7501 sequence the program prints to its own terminal:
//
//   ESC ] 7501 ; state=<word> [:kind=..][:progress=..][:app=..][:title=<b64>][:msg=<b64>] ESC \
//
// Provenance: the field set and order follow `hc --skill` and the upstream herdr-core
// encoder as read on 2026-11-02; the bytes were confirmed live against hc 0.1.16 (`hc get`
// decoded every state, kind and msg this module sends; flow 481 live/README.md). herdr-core
// is preview (0.x), so the encoder test pins the exact bytes.
//
// Pure encoder + state mapper + a best-effort reporter. Inert unless the pane was
// launched by herdr-core (`HC_TERMINAL_ID` set). Never throws into the shell.

import { redactSensitiveText } from "../security/service";
import { debugEvent } from "./debug-log";
import type { FleetWorkerStatus } from "./worker-fleet";

export type HerdrCoreState = "idle" | "working" | "done" | "blocked" | "error" | "clear";
export type HerdrCoreKind = "permission" | "question" | "auth";

export interface HerdrCoreReport {
  state: HerdrCoreState;
  /** Only valid with `state: "blocked"`. */
  kind?: HerdrCoreKind;
  /** Integer 0..100. */
  progress?: number;
  title?: string;
  msg?: string;
}

const STATES: readonly string[] = ["idle", "working", "done", "blocked", "error", "clear"];
const KINDS: readonly string[] = ["permission", "question", "auth"];
const APP_RE = /^[a-z0-9-]+$/;
const MSG_MAX_CHARS = 200;

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

/** Encode one OSC 7501 status sequence, terminated by ST (`ESC \`). */
export function encodeOsc7501(report: HerdrCoreReport, app = "keryx"): string {
  if (!STATES.includes(report.state)) {
    throw new Error(`herdr-core: unknown state "${String(report.state)}"`);
  }
  if (app !== "" && !APP_RE.test(app)) {
    throw new Error(`herdr-core: app "${app}" must match [a-z0-9-]`);
  }
  if (report.kind !== undefined) {
    if (!KINDS.includes(report.kind)) {
      throw new Error(`herdr-core: unknown kind "${String(report.kind)}"`);
    }
    if (report.state !== "blocked") {
      throw new Error("herdr-core: kind is only allowed with state=blocked");
    }
  }
  if (report.progress !== undefined) {
    if (!Number.isInteger(report.progress) || report.progress < 0 || report.progress > 100) {
      throw new Error("herdr-core: progress must be an integer 0..100");
    }
  }
  const fields: string[] = [`state=${report.state}`];
  if (report.kind !== undefined) fields.push(`kind=${report.kind}`);
  if (report.progress !== undefined) fields.push(`progress=${report.progress}`);
  if (app !== "") fields.push(`app=${app}`);
  if (report.title) fields.push(`title=${b64(report.title)}`);
  if (report.msg) fields.push(`msg=${b64(report.msg)}`);
  return `\x1b]7501;${fields.join(":")}\x1b\\`;
}

/** The report that removes the status (shell exit). */
export const HERDR_CORE_CLEAR: HerdrCoreReport = { state: "clear" };

export interface HerdrCoreAttention {
  kind: HerdrCoreKind;
  text: string;
}

/** Map the TUI's `setMainAgent` status vocabulary onto herdr-core's states. */
export function herdrCoreStateFor(
  status: FleetWorkerStatus,
  attention?: HerdrCoreAttention,
): HerdrCoreReport {
  switch (status) {
    case "running":
      return { state: "working" };
    case "done":
      return { state: "done" };
    case "failed":
      return { state: "error" };
    case "blocked":
      return {
        state: "blocked",
        kind: attention?.kind ?? "permission",
        ...(attention !== undefined ? { msg: attention.text } : {}),
      };
    case "queued":
      return { state: "idle" };
    default: {
      // A new FleetWorkerStatus fails typecheck here instead of reporting idle unnoticed;
      // at runtime an unknown value still reads as idle, so the reporter never throws.
      const unmapped: never = status;
      debugEvent("herdr-core-unmapped-status", { status: String(unmapped) });
      return { state: "idle" };
    }
  }
}

/**
 * How much of the one-line text the redactor sees. Far above the 200 kept, so a secret
 * that straddles the 200-character cut is still whole when it is redacted; bounded, so a
 * multi-megabyte approval command is not scanned in full for 200 characters of status.
 */
export const MSG_REDACT_WINDOW_CHARS = 4096;

/**
 * Prepare a blocked-report message: collapse whitespace to one line, redact secrets,
 * cut to 200 characters on a code-point boundary. Base64 happens in the encoder.
 *
 * Redactor choice: `redactSensitiveText` is the codebase's general-purpose
 * free-text scrubber (secrets + PII + exfil + entropy) used for tool output headed
 * to the provider; an approval command is exactly that kind of text.
 */
export function prepareStatusMessage(
  text: string,
  redact: (s: string) => string = redactSensitiveText,
): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  // Redact BEFORE the 200-character cut so a secret straddling it is never half-kept,
  // but only over a bounded window (see MSG_REDACT_WINDOW_CHARS).
  const window = oneLine.length <= MSG_REDACT_WINDOW_CHARS ? oneLine : oneLine.slice(0, MSG_REDACT_WINDOW_CHARS);
  const redacted = redact(window).replace(/\s+/g, " ").trim();
  const points = Array.from(redacted);
  return points.length <= MSG_MAX_CHARS ? redacted : points.slice(0, MSG_MAX_CHARS).join("");
}

export interface HerdrCoreReporter {
  report(report: HerdrCoreReport): void;
  clear(): void;
}

const INERT: HerdrCoreReporter = { report: () => {}, clear: () => {} };

export interface HerdrCoreReporterOptions {
  env?: Record<string, string | undefined>;
  write: (bytes: string) => void;
  redact?: (s: string) => string;
}

/** Build the reporter. No writes at all unless `HC_TERMINAL_ID` is non-empty. */
export function createHerdrCoreReporter(opts: HerdrCoreReporterOptions): HerdrCoreReporter {
  const env = opts.env ?? process.env;
  const id = env.HC_TERMINAL_ID;
  if (typeof id !== "string" || id === "") return INERT;
  const redact = opts.redact ?? redactSensitiveText;

  let last: string | undefined;
  const emit = (report: HerdrCoreReport): void => {
    try {
      const prepared: HerdrCoreReport =
        report.msg !== undefined ? { ...report, msg: prepareStatusMessage(report.msg, redact) } : report;
      const bytes = encodeOsc7501(prepared);
      if (bytes === last) return;
      debugEvent("herdr-core.report", { state: report.state });
      opts.write(bytes);
      // Only a write that went through is remembered: a failed one is retried by the next
      // identical report instead of being suppressed as a duplicate.
      last = bytes;
    } catch {
      // best-effort: a status line must never take the shell down.
    }
  };

  return {
    report: emit,
    clear() {
      emit(HERDR_CORE_CLEAR);
      last = undefined;
    },
  };
}

/**
 * Structural guard for OpenTUI's CliRenderer `writeOut(chunk)`. It is declared
 * `private` in renderer.d.ts, so a typed call is impossible; we check the shape at
 * runtime instead of casting. At runtime it takes a string chunk (sync, ordered
 * with frame output when the native output thread runs).
 */
function hasWriteOut(x: unknown): x is { writeOut(chunk: string): unknown } {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as Record<string, unknown>).writeOut === "function"
  );
}

/** Writer that goes through the live renderer's `writeOut`, else stdout. */
export function createStatusWriter(
  getRenderer: () => unknown,
  stdoutWrite: (s: string) => void = (s: string) => {
    process.stdout.write(s);
  },
): (bytes: string) => void {
  return (bytes) => {
    const renderer = getRenderer();
    if (hasWriteOut(renderer)) {
      renderer.writeOut(bytes);
      return;
    }
    stdoutWrite(bytes);
  };
}
