// Pure Anthropic Messages-API SSE parser (flow 018, W14 / RP-01).
//
// A deterministic, stateful, side-effect-free incremental parser over raw
// `text/event-stream` bytes fed at ANY chunk boundary. It surfaces complete
// `{ event?, data }` records (matching the Anthropic wire format
// `event: <type>\ndata: <json>\n\n`, multi-line `data:` fields joined with
// `\n`, `:`-prefixed comment lines dropped). It is intentionally unopinionated
// about semantics: `normalize`/`AnthropicProvider` decide what each record
// means and whether a torn `flush()` record is a truncated/malformed stream.
//
// Pure / deterministic: no `Date.now`, no `Math.random`, no network, no fs — a
// stateful fold over strings only.

/** A single parsed SSE record. `event` is absent when no `event:` line appeared. */
export interface AnthropicSSEEvent {
  event?: string;
  data: string;
}

/**
 * Incremental SSE parser. Feed raw stream text via {@link push} (any chunking);
 * it returns every record whose terminating blank line has arrived. Call
 * {@link flush} at EOF to surface a trailing record that never received its
 * blank line (a torn stream), which the normalizer maps to `malformed`.
 */
export class AnthropicSSEParser {
  /** Bytes received but not yet terminated by a newline. */
  private buffer = "";
  /** `event:` value for the record currently being assembled. */
  private curEvent: string | undefined = undefined;
  /** Accumulated `data:` field values for the current record. */
  private curData: string[] = [];
  /** Whether the current record has received at least one field line. */
  private curHasField = false;

  /** Feed a chunk; return every record whose blank-line terminator has arrived. */
  push(chunk: string): AnthropicSSEEvent[] {
    this.buffer += chunk;
    const out: AnthropicSSEEvent[] = [];
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "") {
        // Blank line terminates the current record.
        if (this.curHasField) {
          out.push(this.buildRecord());
        }
        this.resetCurrent();
      } else if (!line.startsWith(":")) {
        // A `:`-prefixed line is a comment and is ignored entirely.
        this.processField(line);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
    return out;
  }

  /**
   * At EOF: process any unterminated trailing line, then surface a still-open
   * record (torn stream) if one is pending. Returns `[]` when nothing is
   * pending.
   */
  flush(): AnthropicSSEEvent[] {
    if (this.buffer.length > 0) {
      const rawLine = this.buffer;
      this.buffer = "";
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line !== "" && !line.startsWith(":")) {
        this.processField(line);
      }
    }
    if (this.curHasField) {
      const record = this.buildRecord();
      this.resetCurrent();
      return [record];
    }
    return [];
  }

  private processField(line: string): void {
    const colon = line.indexOf(":");
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      // Per the SSE spec, a single leading space after the colon is stripped.
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }
    }
    if (field === "event") {
      this.curEvent = value;
    } else if (field === "data") {
      this.curData.push(value);
    }
    // Other fields (id/retry) are accepted but carry no meaning here.
    this.curHasField = true;
  }

  private buildRecord(): AnthropicSSEEvent {
    const data = this.curData.join("\n");
    return this.curEvent !== undefined ? { event: this.curEvent, data } : { data };
  }

  private resetCurrent(): void {
    this.curEvent = undefined;
    this.curData = [];
    this.curHasField = false;
  }
}
