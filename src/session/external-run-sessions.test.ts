// Flow 300 AC9: a session written by `keryx agents external run` (provider
// `acp:<agent>`) is listed and searchable, but `-c` continues the latest
// session of the shell's OWN kind — never the external run's record.

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession, isExternalRunSession, latestSession, listSessions, openSession, persistHistory } from "./index";
import { openLeasedSession, releaseSessionLease } from "./lease";

function backdate(dir: string, iso: string): void {
  const file = path.join(dir, "summary.json");
  const summary = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...summary, updatedAt: iso }), "utf8");
}

function fixture(): { dataDir: string; cwd: string; nativeId: string; acpId: string; cleanup(): void } {
  const dataDir = mkdtempSync(path.join(tmpdir(), "keryx-extsess-data-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "keryx-extsess-proj-"));
  const native = createSession({ cwd, dataDir, provider: "anthropic", model: "claude-x" });
  persistHistory(native, [{ role: "user", content: "native conversation", provenance: "project" }]);
  backdate(native.dir, "2026-09-01T00:00:00.000Z");
  // Newer: an external agent run's record, exactly how `persistAcpRun` creates it.
  const acp = createSession({ cwd, dataDir, provider: "acp:claude", title: "ACP claude: completed" });
  persistHistory(acp, [{ role: "user", content: "delegated task", provenance: "trusted" }], { title: "ACP claude: completed" });
  return {
    dataDir,
    cwd,
    nativeId: native.summary.id,
    acpId: acp.summary.id,
    cleanup: () => {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

test("AC9: the external run is newest and still listed — but latestSession() skips it", () => {
  const f = fixture();
  try {
    const listed = listSessions(f.cwd, f.dataDir);
    expect(listed[0]?.id).toBe(f.acpId);
    expect(isExternalRunSession(listed[0]!)).toBe(true);
    expect(latestSession(f.cwd, f.dataDir)?.id).toBe(f.nativeId);
  } finally {
    f.cleanup();
  }
});

test("AC9: `-c` (openSession continueLast) resumes the native session, not the ACP record", () => {
  const f = fixture();
  try {
    const opened = openSession({ cwd: f.cwd, dataDir: f.dataDir, continueLast: true });
    expect(opened.resumed).toBe(true);
    expect(opened.handle.summary.id).toBe(f.nativeId);
  } finally {
    f.cleanup();
  }
});

test("AC9: `-c` through the lease path (the shells' real entry) resumes the native session too", () => {
  const f = fixture();
  try {
    const opened = openLeasedSession({ cwd: f.cwd, dataDir: f.dataDir, continueLast: true });
    try {
      expect(opened.handle.summary.id).toBe(f.nativeId);
    } finally {
      releaseSessionLease(opened.lease);
    }
  } finally {
    f.cleanup();
  }
});

test("AC9: with ONLY an external run on disk, `-c` starts a new session instead of continuing it", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "keryx-extsess-data-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "keryx-extsess-proj-"));
  try {
    const acp = createSession({ cwd, dataDir, provider: "acp:codex" });
    const opened = openSession({ cwd, dataDir, continueLast: true });
    expect(opened.resumed).toBe(false);
    expect(opened.handle.summary.id).not.toBe(acp.summary.id);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
