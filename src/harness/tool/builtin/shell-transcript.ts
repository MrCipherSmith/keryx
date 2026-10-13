// Flow 393 AC11: what `shell_exec` keeps of a command's output beyond its inline cap.
//
// Before, a transcript over 20 KB was cut at its first 20 KB: the tail was lost, and because stderr
// is appended after stdout, the error a failing command printed last was the first thing to go.
// Now the full transcript is kept (and saved to the session's spill directory by the agent loop),
// and the model sees the head, the tail, the counts, the path and, always, the tail of stderr.

/** Characters of a shell result the model sees inline. Over this, the view below replaces the text. */
export const SHELL_INLINE_CAP = 20_000;
/** Share of the inline cap given to the head of the transcript. */
const HEAD_CHARS = 8_000;
/** Share given to the tail of the whole transcript. */
const TAIL_CHARS = 6_000;
/** Trailing characters of stderr kept whatever else is dropped. */
export const STDERR_TAIL_CHARS = 4_000;
/** Most characters of a transcript held for saving; the counts keep going past it. */
export const SHELL_TRANSCRIPT_MAX_CHARS = 16 * 1024 * 1024;

export interface ShellTranscript {
  /** The whole transcript in arrival order (stdout then stderr for a synchronous run). */
  full: string;
  /** True when `full` stopped growing at {@link SHELL_TRANSCRIPT_MAX_CHARS}. */
  fullTruncated: boolean;
  stdoutBytes: number;
  stdoutLines: number;
  stderrBytes: number;
  stderrLines: number;
  /** The last {@link STDERR_TAIL_CHARS} characters of stderr. */
  stderrTail: string;
}

/** Accumulates a transcript chunk by chunk, keeping stdout and stderr tallied apart. */
export class TranscriptRecorder {
  private full = "";
  private fullTruncated = false;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private stdoutNewlines = 0;
  private stderrNewlines = 0;
  private stdoutOpenLine = false;
  private stderrOpenLine = false;
  private stderrTail = "";

  push(chunk: string, stream: "stdout" | "stderr"): void {
    if (chunk.length === 0) return;
    if (this.full.length < SHELL_TRANSCRIPT_MAX_CHARS) {
      this.full += chunk.length > SHELL_TRANSCRIPT_MAX_CHARS - this.full.length ? chunk.slice(0, SHELL_TRANSCRIPT_MAX_CHARS - this.full.length) : chunk;
      if (this.full.length >= SHELL_TRANSCRIPT_MAX_CHARS) this.fullTruncated = true;
    } else {
      this.fullTruncated = true;
    }
    const bytes = Buffer.byteLength(chunk, "utf8");
    let newlines = 0;
    for (let i = chunk.indexOf("\n"); i !== -1; i = chunk.indexOf("\n", i + 1)) newlines += 1;
    const open = !chunk.endsWith("\n");
    if (stream === "stdout") {
      this.stdoutBytes += bytes;
      this.stdoutNewlines += newlines;
      this.stdoutOpenLine = open;
    } else {
      this.stderrBytes += bytes;
      this.stderrNewlines += newlines;
      this.stderrOpenLine = open;
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    }
  }

  snapshot(): ShellTranscript {
    return {
      full: this.full,
      fullTruncated: this.fullTruncated,
      stdoutBytes: this.stdoutBytes,
      stdoutLines: this.stdoutNewlines + (this.stdoutOpenLine ? 1 : 0),
      stderrBytes: this.stderrBytes,
      stderrLines: this.stderrNewlines + (this.stderrOpenLine ? 1 : 0),
      stderrTail: this.stderrTail,
    };
  }
}

/** A transcript from two finished streams (the synchronous runner): stdout, then stderr. */
export function transcriptFromStreams(stdout: string, stderr: string): ShellTranscript {
  const out = new TranscriptRecorder();
  out.push(stdout, "stdout");
  const err = new TranscriptRecorder();
  err.push(stderr, "stderr");
  const o = out.snapshot();
  const e = err.snapshot();
  // The old `${stdout}\n${stderr}` join, so a short result reads exactly as it did.
  const full = stdout.length > 0 && stderr.length > 0 ? `${stdout}\n${stderr}` : `${stdout}${stderr}`;
  return {
    full: full.length > SHELL_TRANSCRIPT_MAX_CHARS ? full.slice(0, SHELL_TRANSCRIPT_MAX_CHARS) : full,
    fullTruncated: full.length > SHELL_TRANSCRIPT_MAX_CHARS,
    stdoutBytes: o.stdoutBytes,
    stdoutLines: o.stdoutLines,
    stderrBytes: e.stderrBytes,
    stderrLines: e.stderrLines,
    stderrTail: e.stderrTail,
  };
}

/** True when the transcript, trimmed, is longer than the inline cap. */
export function overInlineCap(t: ShellTranscript): boolean {
  return t.full.trim().length > SHELL_INLINE_CAP;
}

function snapHeadToLine(head: string): string {
  const cut = head.lastIndexOf("\n");
  return cut > 0 ? head.slice(0, cut) : head;
}

function snapTailToLine(tail: string): string {
  const cut = tail.indexOf("\n");
  return cut !== -1 && cut < tail.length - 1 ? tail.slice(cut + 1) : tail;
}

/**
 * What the model reads for a transcript over the cap: the head, the tail, the tail of stderr when
 * the tail above does not already hold it, one line of counts and, when the caller saved the whole
 * transcript, the path it can read it from. `path` is `undefined` when nothing was saved.
 */
export function renderShellOutput(t: ShellTranscript, savedTo: string | undefined): string {
  const text = t.full.trim();
  if (text.length <= SHELL_INLINE_CAP) return text;
  const head = snapHeadToLine(text.slice(0, HEAD_CHARS));
  const tailStart = Math.max(HEAD_CHARS, text.length - TAIL_CHARS);
  const tail = snapTailToLine(text.slice(tailStart));
  const omitted = text.length - head.length - tail.length;
  const stderrTail = t.stderrTail.trim();
  const stderrShown = stderrTail.length === 0 || tail.includes(stderrTail);
  const parts: string[] = [head, `[… ${omitted} characters omitted …]`, tail];
  if (!stderrShown) {
    parts.push(`[stderr, last ${stderrTail.length} of ${t.stderrBytes} bytes:]`, stderrTail);
  }
  const counts =
    `stdout ${t.stdoutLines} lines, ${t.stdoutBytes} bytes; stderr ${t.stderrLines} lines, ${t.stderrBytes} bytes`;
  const where =
    savedTo === undefined
      ? t.fullTruncated
        ? "the transcript is longer than the shell keeps and was not saved"
        : "it was not saved (no session directory)"
      : `full output saved to ${savedTo} — read it with read_file {"path": ${JSON.stringify(savedTo)}, "start_line": <line>} ` +
        `(each call returns up to 20000 characters and names the next start_line), ` +
        `or search it with search_code {"pattern": "<regex>", "path": ${JSON.stringify(savedTo)}}` +
        (t.fullTruncated ? "; the file stops where the shell stopped keeping output" : "");
  parts.push(`[output truncated: ${counts}; ${where}]`);
  return parts.join("\n");
}
