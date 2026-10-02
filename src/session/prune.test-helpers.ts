// Shared fixtures for the prune tests (flow 387 review r2 F-029): the temp-directory
// bookkeeping and the user/tool-pair message builders were copied into each prune test file.

import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NormalizedMessage } from "../harness/provider/types";

/** Registers cleanup with the calling test file and returns a `tmp()` that makes a tracked dir. */
export function useTempDirs(prefix: string): () => string {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });
  return () => {
    const d = mkdtempSync(path.join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  };
}

export function user(content: string): NormalizedMessage {
  return { role: "user", content, provenance: "project" };
}

/** An assistant `read_file` call plus its result, `chars` long. */
export function pair(id: string, chars: number, extra: Partial<NormalizedMessage> = {}): NormalizedMessage[] {
  return [
    { role: "assistant", content: "", provenance: "model", toolCalls: [{ id, name: "read_file", arguments: "{}" }] },
    { role: "tool", content: `${id}:`.padEnd(chars, "x"), provenance: "tool", toolCallId: id, ...extra },
  ];
}

export function toolsOf(history: readonly NormalizedMessage[]): NormalizedMessage[] {
  return history.filter((m) => m.role === "tool");
}
