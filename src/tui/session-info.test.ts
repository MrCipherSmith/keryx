// Flow 155 — session-info inspector (AC3–AC8). Pure snapshot + text dump +
// command tokens. TUI chrome is asserted only as an openModal call shape.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SESSION_INFO_COMMANDS,
  buildSessionInfoSnapshot,
  formatSessionInfoText,
  isSessionInfoCommand,
  presentSessionInfo,
  sessionBlockCopyText,
  sessionIdCopyText,
  type OpenModalFn,
} from "./session-info";

const SUMMARY = {
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  title: "Inspect me",
  projectPath: "/tmp/keryx-project",
  createdAt: "2026-08-15T18:55:26.945Z",
  updatedAt: "2026-08-15T19:00:00.000Z",
  messageCount: 4,
  archiveMessageCount: 10,
  compactCount: 1,
  provider: "ollama",
  model: "stale-model",
};

test("isSessionInfoCommand accepts the three tokens and ignores others", () => {
  expect(SESSION_INFO_COMMANDS).toEqual(["/session-info", "/status", "/info"]);
  expect(isSessionInfoCommand("/session-info")).toBe(true);
  expect(isSessionInfoCommand("  /status extra")).toBe(true);
  expect(isSessionInfoCommand("/info")).toBe(true);
  expect(isSessionInfoCommand("/sessions")).toBe(false);
  expect(isSessionInfoCommand("/help")).toBe(false);
  expect(isSessionInfoCommand("session-info")).toBe(false);
});

test("AC3: live selection wins over summary provider/model", () => {
  const snap = buildSessionInfoSnapshot({
    summary: SUMMARY,
    selection: { provider: "openrouter", model: "kimi" },
    version: "0.2.35",
  });
  expect(row(snap.sessionRows, "Session id")).toBe(SUMMARY.id);
  expect(row(snap.sessionRows, "Project")).toBe(SUMMARY.projectPath);
  expect(row(snap.sessionRows, "Provider")).toBe("openrouter");
  expect(row(snap.sessionRows, "Model")).toBe("kimi");
});

test("AC3: missing provider/model paint — not a guessed backend", () => {
  const snap = buildSessionInfoSnapshot({
    summary: { id: "id-only", projectPath: "/p" },
    version: "1.0.0",
  });
  expect(row(snap.sessionRows, "Provider")).toBe("—");
  expect(row(snap.sessionRows, "Model")).toBe("—");
  expect(row(snap.sessionRows, "Title")).toBe("—");
});

test("AC4: Parent row only when the session is a fork", () => {
  const fork = buildSessionInfoSnapshot({
    summary: { ...SUMMARY, parentSessionId: "parent-session-id" },
  });
  expect(row(fork.sessionRows, "Parent")).toBe("parent-session-id");

  const root = buildSessionInfoSnapshot({ summary: SUMMARY });
  expect(root.sessionRows.some((r) => r.label === "Parent")).toBe(false);
});

test("AC5: c copies the exact id; y copies a multi-line block that includes it", () => {
  const snap = buildSessionInfoSnapshot({ summary: SUMMARY, version: "0.2.35" });
  expect(sessionIdCopyText(snap)).toBe(SUMMARY.id);
  const block = sessionBlockCopyText(snap);
  expect(block).toContain(SUMMARY.id);
  expect(block).toContain("\n");
  expect(block).toBe(formatSessionInfoText(snap));
});

test("AC8: estimated context is labelled estimate, never billed tokens", () => {
  const estimated = buildSessionInfoSnapshot({
    summary: SUMMARY,
    estimateTokens: 42,
  });
  expect(row(estimated.sessionRows, "Context")).toMatch(/42/);
  expect(row(estimated.sessionRows, "Context").toLowerCase()).toContain("estimate");
  expect(row(estimated.usageRows, "Context estimate").toLowerCase()).toContain("estimate");

  const billed = buildSessionInfoSnapshot({
    summary: SUMMARY,
    usage: { inputTokens: 12, outputTokens: 3 },
    estimateTokens: 99,
  });
  expect(row(billed.sessionRows, "Context").toLowerCase()).not.toContain("estimate");
  expect(row(billed.usageRows, "Last turn input")).toBe("12");
  expect(row(billed.usageRows, "Last turn output")).toBe("3");
  expect(row(billed.usageRows, "Context estimate").toLowerCase()).toContain("estimate");
});

test("Usage tab always exists; missing usage is —; no invented window", () => {
  const snap = buildSessionInfoSnapshot({ summary: SUMMARY });
  expect(row(snap.usageRows, "Last turn input")).toBe("—");
  expect(row(snap.usageRows, "Last turn output")).toBe("—");
  const painted = formatSessionInfoText(snap);
  expect(painted.toLowerCase()).not.toContain("128k");
  expect(painted.toLowerCase()).not.toContain("sandbox");
  expect(painted.toLowerCase()).not.toContain("oauth");
  expect(painted.toLowerCase()).not.toContain("super grok");
});

test("AC6: text dump is a fixed-width block with the same rows", () => {
  const snap = buildSessionInfoSnapshot({
    summary: { ...SUMMARY, parentSessionId: "parent-1" },
    selection: { provider: "fake", model: "fixture" },
    version: "0.2.35",
    usage: { inputTokens: 8, outputTokens: 2 },
    estimateTokens: 20,
  });
  const text = formatSessionInfoText(snap);
  expect(text).toContain("Session");
  expect(text).toContain("Usage");
  expect(text).toContain("Title");
  expect(text).toContain("Inspect me");
  expect(text).toContain("Version");
  expect(text).toContain("0.2.35");
  expect(text).toContain(SUMMARY.id);
  expect(text).toContain("/tmp/keryx-project");
  expect(text).toContain("fake");
  expect(text).toContain("fixture");
  expect(text).toContain("parent-1");
  expect(text).toContain("UTC");
  expect(text).toContain("Messages");
  expect(text).toContain("Compactions");
});

test("AC5: presentSessionInfo c copies id and y copies the block via the host clipboard path", () => {
  const snap = buildSessionInfoSnapshot({ summary: SUMMARY, version: "0.2.35" });
  const copied: string[] = [];
  const toasts: string[] = [];
  let keyHandler: ((key: { name: string; sequence: string }) => void) | undefined;
  presentSessionInfo(
    (_otui, _chrome, input) => ({
      close: () => input.onClose?.(),
      setTab: () => {},
      activeTab: () => "session",
    }),
    {},
    {},
    {
      snapshot: snap,
      copyText: (text) => copied.push(text),
      toast: (message) => toasts.push(message),
      onKeypress: (handler) => {
        keyHandler = handler;
        return () => {
          keyHandler = undefined;
        };
      },
    },
  );
  expect(keyHandler).toBeDefined();
  keyHandler?.({ name: "c", sequence: "c" });
  keyHandler?.({ name: "y", sequence: "y" });
  expect(copied[0]).toBe(SUMMARY.id);
  expect(copied[1]).toContain(SUMMARY.id);
  expect(copied[1]).toContain("\n");
  expect(toasts).toEqual(["Copied to clipboard", "Copied to clipboard"]);
});

test("AC2: presentSessionInfo calls host openModal with Session + Usage tabs", () => {
  const snap = buildSessionInfoSnapshot({ summary: SUMMARY, version: "0.2.35" });
  const calls: unknown[] = [];
  const openModal: OpenModalFn = (_otui, _chrome, input) => {
    calls.push(input);
    return { close: () => {}, setTab: () => {}, activeTab: () => input.initialTab ?? input.tabs[0]?.id ?? "" };
  };
  presentSessionInfo(openModal, {}, {}, { snapshot: snap, copyText: () => {}, toast: () => {} });
  expect(calls).toHaveLength(1);
  const input = calls[0] as { title: string; tabs: { id: string; label: string }[]; initialTab?: string };
  expect(input.title).toBe("Session");
  expect(input.tabs.map((t) => t.id)).toEqual(["session", "usage"]);
  expect(input.initialTab).toBe("session");
});

test("AC2: TUI call sites import openModal from the host and do not fork overlayBox", () => {
  const hostImport = /openModal[\s\S]*from\s*["']\.\/modal-host["']|from\s*["']\.\/modal-host["'][\s\S]*openModal/;
  const tui = readFileSync(join(import.meta.dir, "tui-shell.ts"), "utf8");
  const chat = readFileSync(join(import.meta.dir, "chat-shell.ts"), "utf8");
  const local = readFileSync(join(import.meta.dir, "session-info.ts"), "utf8");
  expect(local).toMatch(hostImport);
  expect(`${tui}\n${chat}`).toMatch(/openSessionInfo/);
  expect(local).not.toMatch(/overlayBox/);
  expect(tui).not.toMatch(/overlayBox\([^)]*session-info/);
});

function row(rows: { label: string; value: string }[], label: string): string {
  const found = rows.find((r) => r.label === label);
  expect(found).toBeDefined();
  return found?.value ?? "";
}
