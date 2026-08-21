// Output channel owner (spec.md §2.5, T8). Two writers into one real
// `vscode.OutputChannel`:
//   (a) an SSE pipe of `GET /v1/turns/{id}/events` for an in-flight turn
//       (`pipeTurnEvents`), resumable via `Last-Event-ID` per the real route
//       contract in `src/lib/serve-server.ts:571-615` (confirmed by reading
//       the handler, not guessed);
//   (b) a mandatory structured audit-log line for every mutating action
//       (`audit`), reusing the ALREADY-EXISTING `formatAuditLine` from
//       `audit-log.ts` rather than reimplementing line formatting.
//
// All SSE-parsing and outcome-classification logic lives in the pure sibling
// `output-channel-logic.ts` — this file is the thin `vscode`/`fetch`-calling
// shell, per the file-splitting convention established by
// `status-logic.ts`/`extension.ts` and `version-logic.ts`/`extension.ts`.

import * as vscode from "vscode";
import { formatAuditLine, type AuditActor, type AuditEvent } from "./audit-log";
import { buildAuditEvent, formatTurnEventLine, highestSeq, parseSseBody } from "./output-channel-logic";

export class KeryxOutputChannel implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;

  constructor(channel: vscode.OutputChannel) {
    this.channel = channel;
  }

  dispose(): void {
    this.channel.dispose();
  }

  /**
   * AC6: write exactly one audit-log line for one mutating action. Callers
   * (e.g. `extension.ts`'s `keryx.init` command handler) must call this
   * exactly once per action — including on a failure path, which is still an
   * outcome worth one line, never zero and never a silent skip.
   */
  audit(actor: AuditActor, action: string, exitCode: number, detail?: string): void {
    const event: AuditEvent = {
      ...buildAuditEvent(actor, action, exitCode, detail),
      timestamp: new Date().toISOString(),
    };
    this.channel.appendLine(formatAuditLine(event));
  }

  /** Write a raw line (diagnostics, non-audit informational output). */
  appendLine(line: string): void {
    this.channel.appendLine(line);
  }

  show(): void {
    this.channel.show(true);
  }

  /**
   * Fetch and pipe one turn's SSE event stream into the output channel.
   * `afterSeq` (the last `seq` this caller has already rendered) is sent as
   * the `Last-Event-ID` header so a re-attach after a dropped connection
   * replays only what was missed, never the whole history again — matching
   * the server's own resume contract. Returns the highest `seq` rendered (or
   * `afterSeq` unchanged if the fetch produced no new events), so a caller
   * can persist it for the next resume.
   *
   * KNOWN GAP (recorded honestly, not silently left unexplained): this
   * method is fully implemented and unit-tested at the parsing/formatting
   * level (`output-channel-logic.test.ts`), but as of this PR has ZERO
   * production call sites — nothing in `extension.ts` ever invokes it.
   * Wiring it up needs a concrete answer to "when is a turn considered
   * in-flight from this extension's perspective?" (spec.md's turn-event SSE
   * pipe assumes a turn concept this scaffold doesn't yet originate or track
   * anywhere), and that trigger was not resolved in this flow. Do not invent
   * a fake "active turn" concept just to give this a call site — leave it
   * unwired until a real trigger exists, and treat this comment as the
   * record of that decision for the next flow that picks it up.
   */
  async pipeTurnEvents(baseUrl: string, turnId: string, afterSeq?: number): Promise<number | undefined> {
    const headers: Record<string, string> = {};
    if (afterSeq !== undefined) {
      headers["Last-Event-ID"] = String(afterSeq);
    }

    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/turns/${encodeURIComponent(turnId)}/events`, {
      headers,
    });

    if (!response.ok) {
      this.appendLine(`[turn ${turnId}] events fetch failed: HTTP ${response.status}`);
      return afterSeq;
    }

    const body = await response.text();
    const events = parseSseBody(body);
    for (const event of events) {
      this.appendLine(formatTurnEventLine(event));
    }

    const seenMax = highestSeq(events);
    return seenMax !== undefined ? seenMax : afterSeq;
  }
}

/** Construct the extension's single output channel wrapper. Call once from `activate()`. */
export function createKeryxOutputChannel(): KeryxOutputChannel {
  return new KeryxOutputChannel(vscode.window.createOutputChannel("Keryx"));
}
