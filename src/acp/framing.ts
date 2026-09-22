// Newline-delimited JSON framing over stdio for the ACP agent server
// (flow 285, T6).
//
// WHICH FRAMING, AND WHY IT MATTERS
//
// ACP is NOT LSP-framed. The v1 transport page is explicit: "Messages are
// delimited by newlines (`\n`), and **MUST NOT** contain embedded newlines."
// There is no `Content-Length` header, no `\r\n\r\n` separator and no header
// block at all. Getting this backwards is the single cheapest way to produce an
// agent that no client can talk to, so it is stated here once, in the file that
// implements it, rather than inferred from a sibling protocol.
//
// The client launches the agent as a subprocess: the agent reads messages from
// `stdin` and writes them to `stdout`. `stdout` carries protocol traffic and
// nothing else — a stray `console.log` corrupts the stream. `stderr` is the
// only legal place for logging, and the client may capture, forward or ignore
// it.
//
// WHAT A DECODER HAS TO SURVIVE
//
// A pipe hands over BYTES, not messages. One read can carry half a message, two
// whole messages, or a multi-byte UTF-8 character split down the middle. All
// three are ordinary, none is an error, and a decoder that assumes one read is
// one message works on a laptop and fails under load. `AcpLineFramer` is the
// piece that absorbs that, which is why it is a stateful object and not a
// function.
//
// Pure: importing this reads nothing and spawns nothing.

import { parseError, type JsonRpcErrorObject, type JsonRpcMessage } from "./jsonrpc";

/** The one delimiter ACP uses. */
export const ACP_MESSAGE_DELIMITER = "\n";

/**
 * How much may sit in the buffer without a delimiter before the framer gives
 * up.
 *
 * A peer that streams megabytes with no newline is either broken or hostile,
 * and either way the honest answer is to fail loudly rather than grow a buffer
 * until the process dies with an allocation error nobody can attribute.
 */
export const ACP_DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

export class AcpFramingError extends Error {
  readonly bufferedBytes: number;

  constructor(message: string, bufferedBytes: number) {
    super(message);
    this.name = "AcpFramingError";
    this.bufferedBytes = bufferedBytes;
  }
}

/**
 * Serialises one message into a wire line, delimiter included.
 *
 * `JSON.stringify` escapes newlines inside strings, so the MUST NOT clause is
 * satisfied by construction and the delimiter check below is UNREACHABLE
 * today — stated plainly rather than dressed up as coverage. It is kept because
 * the thing it guards is a protocol requirement and not a local invariant: the
 * day this serialiser is replaced (a faster writer, a streaming encoder, a
 * pre-serialised payload passed through), the guarantee leaves with it, and a
 * one-scan assertion is cheaper than the class of bug it catches — a frame that
 * splits into two unparseable halves at the peer.
 */
export function encodeAcpMessage(message: JsonRpcMessage): string {
  // `JSON.stringify` is typed as returning `string`, but it really returns
  // `undefined` for a value that serialises to nothing. The annotation keeps
  // that possibility in the type system instead of in a comment.
  const json: string | undefined = JSON.stringify(message);
  if (json === undefined) {
    throw new AcpFramingError("message is not JSON-serialisable", 0);
  }
  if (json.includes("\n") || json.includes("\r")) {
    throw new AcpFramingError("encoded message contains an embedded newline", json.length);
  }
  return `${json}${ACP_MESSAGE_DELIMITER}`;
}

export interface AcpLineFramerOptions {
  readonly maxLineBytes?: number;
}

/**
 * Turns a stream of arbitrary chunks into whole newline-delimited lines.
 *
 * Feed it whatever a read gives you — a string, a `Uint8Array`, a fragment, two
 * messages at once — and it returns the lines that are now complete, keeping
 * the remainder for next time.
 */
export class AcpLineFramer {
  private buffer = "";
  private readonly decoder = new TextDecoder("utf-8");
  private readonly maxLineBytes: number;

  constructor(options: AcpLineFramerOptions = {}) {
    this.maxLineBytes = options.maxLineBytes ?? ACP_DEFAULT_MAX_LINE_BYTES;
  }

  /** Bytes (approximated as UTF-16 units) held back waiting for a delimiter. */
  get buffered(): number {
    return this.buffer.length;
  }

  /**
   * Appends a chunk and returns every line it completed, in order.
   *
   * Bytes are decoded with `stream: true`, which holds back a trailing partial
   * UTF-8 sequence instead of emitting a replacement character. Without that, a
   * multi-byte character straddling a read boundary silently becomes U+FFFD and
   * the JSON either fails to parse or — worse — parses with corrupted text.
   */
  push(chunk: string | Uint8Array): string[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    if (text === "") {
      this.assertWithinLimit();
      return [];
    }

    this.buffer += text;
    const parts = this.buffer.split(ACP_MESSAGE_DELIMITER);
    // The last element is whatever follows the final delimiter: "" when the
    // chunk ended exactly on one, otherwise a partial message to keep.
    this.buffer = parts.pop() ?? "";
    this.assertWithinLimit();

    const lines: string[] = [];
    for (const part of parts) {
      const line = normaliseLine(part);
      if (line !== "") {
        lines.push(line);
      }
    }
    return lines;
  }

  /**
   * Flushes what is left when the stream ends.
   *
   * A peer that exits after writing a message without a trailing newline has
   * still sent that message. Returning it here rather than discarding it is the
   * difference between a clean shutdown and a lost final response.
   */
  flush(): string[] {
    this.buffer += this.decoder.decode();
    const line = normaliseLine(this.buffer);
    this.buffer = "";
    return line === "" ? [] : [line];
  }

  private assertWithinLimit(): void {
    if (this.buffer.length > this.maxLineBytes) {
      const buffered = this.buffer.length;
      this.buffer = "";
      throw new AcpFramingError(
        `no message delimiter within ${this.maxLineBytes} bytes; dropped the buffer`,
        buffered,
      );
    }
  }
}

/**
 * Trims a line's trailing carriage return and surrounding whitespace.
 *
 * ACP specifies `\n`, but a client on Windows, or one piping through a tool
 * that rewrites line endings, can deliver `\r\n`. Accepting the `\r` costs
 * nothing and refusing it produces a parse error whose real cause is invisible.
 * Blank lines are dropped: they carry no message and answering them with a
 * parse error would be noise.
 */
function normaliseLine(part: string): string {
  return part.replace(/\r$/, "").trim();
}

export type AcpDecodedLine =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: JsonRpcErrorObject };

/**
 * Parses one framed line.
 *
 * Never throws: malformed JSON from a peer is an expected event on a public
 * wire, and it has a defined answer (`-32700`, id `null`). A throw here would
 * make that answer depend on every caller remembering a try/catch.
 */
export function decodeAcpLine(line: string): AcpDecodedLine {
  try {
    return { ok: true, value: JSON.parse(line) as unknown };
  } catch (error) {
    return {
      ok: false,
      error: parseError({
        reason: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}
