// Fixture-replay tests for `fixtures/mcp-client/codex/*` (flow 182, T13).
// Package: docs/requirements/keryx-mcp-client specification.md §5.3, §10.
//
// See `fixtures/mcp-client/codex/manifest.json`'s "provenance" note for full
// detail. Summary: T5's own live probe genuinely happened but its raw wire
// bytes were not preserved anywhere in this flow's bookkeeping, so T13 ran
// its OWN fresh live probe against a real `codex mcp-server` (codex-cli
// 0.147.0) using this package's own `connectCodexMcpClient` — the module
// under test — and reconstructed the literal wire JSON-RPC envelopes
// losslessly from the parsed values observed (`approve.jsonl`, `deny.jsonl`,
// `timeout.jsonl`: `captured: true`). `malformed-empty-content.SYNTHETIC.jsonl`
// and `missing-codex-call-id.SYNTHETIC.jsonl` remain hand-authored
// (`captured: false`) because those specific shapes could not be provoked
// against a compliant, real codex-cli 0.147.0 process — see their own
// caveats in the manifest. This file proves the PARSER (`wire.ts`) and the
// ELICITATION LOGIC (`elicitation.ts`) handle exactly these message shapes,
// live-captured ones included. AC3's "verified against the live process"
// clause is covered separately (and additionally) by the flag-gated
// `live-elicitation.smoke.test.ts`, not by this offline replay file.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { correlateElicitation, buildElicitationResponse, classifyElicitationRisk, toPendingElicitation } from "./elicitation";
import { parseCodexEventNotification, parseElicitationCreateRequest } from "./wire";
import type { RawCodexEventNotification } from "./types";

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "mcp-client",
  "codex",
);

async function readJsonl(file: string): Promise<unknown[]> {
  const content = await readFile(path.join(FIXTURES_DIR, file), "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

describe("fixture manifest", () => {
  test("every fixture file listed in manifest.json exists and is valid JSONL", async () => {
    const manifestRaw = await readFile(path.join(FIXTURES_DIR, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as {
      agent: { "codex-cli": { fixtures: Record<string, { captured: boolean }> } };
    };
    const names = Object.keys(manifest.agent["codex-cli"].fixtures);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const messages = await readJsonl(name);
      expect(messages.length).toBeGreaterThan(0);
      // Honesty check: a `.SYNTHETIC.` filename must be marked captured:false,
      // and a plain `.jsonl` filename (no `.SYNTHETIC.`) must be captured:true
      // — the filename and the manifest's own claim must never disagree.
      const captured = manifest.agent["codex-cli"].fixtures[name]?.captured;
      expect(captured).toBe(!name.includes(".SYNTHETIC."));
    }
  });
});

describe("approve.jsonl — live-captured (AC2, AC3 replay half)", () => {
  test("parses to a correlated approve, matching the recorded response", async () => {
    const [notification, request, response] = await readJsonl("approve.jsonl");

    const CALL_ID = "call_tVcU5dnyLmvB3T757lTPjhMx"; // the real call_id captured live in this task's own T13 probe

    const event = parseCodexEventNotification(notification);
    expect(event).toBeDefined();
    expect(event?.callId).toBe(CALL_ID);
    expect(event?.availableDecisions).toEqual(["approved", "abort"]);

    const raw = parseElicitationCreateRequest(request);
    expect(raw).toBeDefined();
    expect(raw?.vendor.codex_call_id).toBe(CALL_ID);
    expect(raw?.requestedSchema).toEqual({ type: "object", properties: {} });

    const pending = toPendingElicitation(raw!);
    const recentEvents = new Map<string, RawCodexEventNotification>([[CALL_ID, event!]]);
    const correlation = correlateElicitation(pending.callId, recentEvents);
    expect(correlation).toEqual({ kind: "correlated", availableDecisions: ["approved", "abort"] });

    const built = buildElicitationResponse("approve", correlation);
    expect(built).toEqual({ action: "accept", decision: "approved" });
    // The parser's output matches the fixture's own recorded wire response.
    expect((response as { result: unknown }).result).toEqual(built);
  });
});

describe("deny.jsonl — live-captured (AC2, AC3 replay half)", () => {
  test("parses to a correlated deny preferring abort over denied, matching the recorded response", async () => {
    const [notification, request, response] = await readJsonl("deny.jsonl");

    const event = parseCodexEventNotification(notification);
    const raw = parseElicitationCreateRequest(request);
    const pending = toPendingElicitation(raw!);
    const recentEvents = new Map<string, RawCodexEventNotification>([[event!.callId!, event!]]);
    const correlation = correlateElicitation(pending.callId, recentEvents);

    const built = buildElicitationResponse("deny", correlation);
    expect(built).toEqual({ action: "decline", decision: "abort" });
    expect((response as { result: unknown }).result).toEqual(built);
  });
});

describe("timeout.jsonl — live-captured (AC4)", () => {
  test("parses codex's own self-abort notification (turn_aborted, reason: interrupted) reproducing openai/codex#11816's condition", async () => {
    const messages = await readJsonl("timeout.jsonl");
    const abortNotification = messages[2];
    const event = parseCodexEventNotification(abortNotification);
    expect(event).toBeDefined();
    expect(event?.msgType).toBe("turn_aborted");
    expect((event?.raw as { reason?: unknown }).reason).toBe("interrupted");
  });
});

describe("malformed-empty-content.SYNTHETIC.jsonl (AC5)", () => {
  test("an elicitation with no sibling codex/event correlates as uncorrelated and declines without a decision", async () => {
    const [request, response] = await readJsonl("malformed-empty-content.SYNTHETIC.jsonl");
    const raw = parseElicitationCreateRequest(request);
    expect(raw).toBeDefined();
    // T5's finding: requestedSchema is always the trivial empty object — not
    // itself a malformed-content signal.
    expect(raw?.requestedSchema).toEqual({ type: "object", properties: {} });

    const pending = toPendingElicitation(raw!);
    const correlation = correlateElicitation(pending.callId, new Map());
    expect(correlation).toEqual({ kind: "uncorrelated" });

    const built = buildElicitationResponse("approve", correlation);
    expect(built).toEqual({ action: "decline" });
    expect((response as { result: unknown }).result).toEqual(built);
  });
});

describe("missing-codex-call-id.SYNTHETIC.jsonl (PRD Requirement 5 version-skew)", () => {
  test("an elicitation with no codex_call_id at all degrades to a safe uncorrelated deny, never throws", async () => {
    const [request, response] = await readJsonl("missing-codex-call-id.SYNTHETIC.jsonl");
    const raw = parseElicitationCreateRequest(request);
    expect(raw).toBeDefined();
    expect(raw?.vendor.codex_call_id).toBeUndefined();

    expect(() => {
      const pending = toPendingElicitation(raw!);
      expect(pending.callId).toBeUndefined();
      const correlation = correlateElicitation(pending.callId, new Map());
      expect(correlation).toEqual({ kind: "uncorrelated" });
      const built = buildElicitationResponse("approve", correlation);
      expect(built).toEqual({ action: "decline" });
      expect((response as { result: unknown }).result).toEqual(built);
    }).not.toThrow();
  });
});

describe("classifyElicitationRisk against fixture payloads (AC9 cross-check)", () => {
  test("approve.jsonl's real captured `touch` command classifies as non-destructive/non-credential — a real payload correctly NOT escalated", async () => {
    const [, request] = await readJsonl("approve.jsonl");
    const raw = parseElicitationCreateRequest(request);
    const pending = toPendingElicitation(raw!);
    const result = classifyElicitationRisk(pending);
    expect(result).toEqual({ destructive: false, credentials: false, reasons: [] });
  });

  // AC9's own literal requirement (destructive:true/credentials:true reachable) is
  // proven by dedicated, hand-authored payloads in elicitation.test.ts
  // ("classifyElicitationRisk (T9, AC9)") — every fixture this task could
  // actually capture live used a harmless `touch`, so this cross-check proves
  // the classifier reads a REAL captured vendor payload correctly rather than
  // duplicating elicitation.test.ts's escalation coverage.
  test("a patch-approval variant built from a live-captured vendor payload (codex_elicitation swapped in) still escalates destructive:true", async () => {
    const [, request] = await readJsonl("approve.jsonl");
    const raw = parseElicitationCreateRequest(request);
    const pending = toPendingElicitation({ ...raw!, vendor: { ...raw!.vendor, codex_elicitation: "patch-approval" } });
    const result = classifyElicitationRisk(pending);
    expect(result.destructive).toBe(true);
  });
});
