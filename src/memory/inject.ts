// Procedural-memory prompt injection (C3 — spec §7.3, §8.2; AC-C8). Renders the
// accepted/current/procedural memory for a task scope into a Markdown block that
// flow / task-implementer prompt assembly splices in. Deterministic and
// side-effect free: it never reads the network and never mutates the store.
//
// Empty scope (no eligible memory) ⇒ `renderProceduralBlock([])` returns "" so
// the assembled prompt is byte-for-byte unchanged (AC-C8).

import { loadMemoryConfig } from "./config";
import { clipAutomaticRecallText, isCurrentMemory, proceduralMemoryForScope, type SkillScope } from "./relevant";
import type { MemoryEntry } from "./types";

export const PROCEDURAL_BLOCK_HEADING = "## Procedural Memory";

// Render eligible procedural memory as a stable Markdown block. Returns "" when
// there is nothing to inject (so callers can concatenate unconditionally).
export function renderProceduralBlock(entries: MemoryEntry[]): string {
  if (entries.length === 0) {
    return "";
  }
  const lines = [
    PROCEDURAL_BLOCK_HEADING,
    "",
    "Accepted, current procedural memory for this scope — follow it; do not contradict it.",
    "",
  ];
  for (const entry of entries) {
    const summary = entry.summary ? ` — ${clipAutomaticRecallText(entry.summary)}` : "";
    lines.push(
      `- [${entry.type}] ${clipAutomaticRecallText(entry.title, 200)}${summary} (\`${clipAutomaticRecallText(entry.relativePath, 200)}\`)`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// Fetch + render in one call, honoring the module's `typing` config (inject
// classes + limit). Returns "" when no eligible memory is in scope.
export async function renderProceduralMemoryForScope(
  cwd: string,
  scope: SkillScope,
  now: Date = new Date(),
): Promise<string> {
  const config = await loadMemoryConfig(cwd);
  const entries = await proceduralMemoryForScope(
    cwd,
    scope,
    config.typing.injectLimit,
    config.typing.injectClasses,
    now,
  );
  // Keep the shared temporal helper explicit at this boundary as well: a
  // future caller cannot accidentally render an entry selected outside the
  // accepted/current contract.
  return renderProceduralBlock(entries.filter((entry) => isCurrentMemory(entry, now)));
}
