// Bitemporal supersede write (C2 — spec §8.1; AC-C6). NON-DESTRUCTIVE: it sets
// the OLD entry's `Valid-To` + `Superseded-By` + `Status: superseded` (and
// appends a `## Changelog` note) and the NEW entry's `Supersedes` + `Valid-From`
// (if unset) + `Recorded-At`. BOTH files stay on disk. Every write passes the
// existing `guardOutput` security seam before landing (XP4). Plain Markdown
// only — no database, git-diffable, reproducible.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { guardOutput } from "../security/guard";
import { memoryRoot } from "./store";
import type { MemorySupersedeInput, MemorySupersedeResult } from "./types";

export async function supersedeEntry(
  input: MemorySupersedeInput,
  now: Date,
): Promise<MemorySupersedeResult> {
  const date = input.date ?? now.toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  const oldResolved = await resolveEntryPath(input.cwd, input.oldPath);
  const newResolved = await resolveEntryPath(input.cwd, input.newPath);
  if (!oldResolved) {
    throw new Error(`Superseded entry not found: ${input.oldPath}`);
  }
  if (!newResolved) {
    throw new Error(`Superseding entry not found: ${input.newPath}`);
  }

  const oldContent = await readFile(oldResolved.absolute, "utf8");
  const newContent = await readFile(newResolved.absolute, "utf8");

  // Idempotent: already superseded by this exact target ⇒ no-op.
  if (
    headerValue(oldContent, "Superseded-By") === newResolved.relative &&
    headerValue(newContent, "Supersedes") === oldResolved.relative
  ) {
    return {
      superseded: oldResolved.relative,
      supersededBy: newResolved.relative,
      changed: false,
    };
  }

  // Build the OLD entry: close its validity interval + record the supersession.
  let nextOld = setHeaderField(oldContent, "Status", "superseded");
  nextOld = setHeaderField(nextOld, "Valid-To", date);
  nextOld = setHeaderField(nextOld, "Superseded-By", newResolved.relative);
  nextOld = appendChangelog(
    nextOld,
    `- Superseded by ${newResolved.relative} on ${date}.`,
  );

  // Build the NEW entry: point back + open its validity interval.
  let nextNew = setHeaderField(newContent, "Supersedes", oldResolved.relative);
  if (!headerValue(newContent, "Valid-From")) {
    nextNew = setHeaderField(nextNew, "Valid-From", date);
  }
  nextNew = setHeaderField(nextNew, "Recorded-At", today);

  // Both writes pass the security seam. In enforced/ci mode a blocked write is
  // reported and skipped rather than landing (leak-safe).
  const oldGuard = await guardOutput({
    cwd: input.cwd,
    content: nextOld,
    target: "memory",
    source: "tool-output",
  });
  const newGuard = await guardOutput({
    cwd: input.cwd,
    content: nextNew,
    target: "memory",
    source: "tool-output",
  });
  if (!oldGuard.allowed || !newGuard.allowed) {
    return {
      superseded: oldResolved.relative,
      supersededBy: newResolved.relative,
      changed: false,
      securitySkipped: oldGuard.allowed ? newResolved.relative : oldResolved.relative,
    };
  }

  await writeFile(oldResolved.absolute, nextOld, "utf8");
  await writeFile(newResolved.absolute, nextNew, "utf8");

  return {
    superseded: oldResolved.relative,
    supersededBy: newResolved.relative,
    changed: true,
  };
}

type ResolvedEntry = { absolute: string; relative: string };

// Accept an absolute path, a cwd-relative path, or a memory-root-relative path
// (e.g. `decisions/foo.md`). `relative` is always memory-root-relative so it
// matches the `relativePath` written by `collectEntries`.
async function resolveEntryPath(
  cwd: string,
  raw: string,
): Promise<ResolvedEntry | null> {
  const root = memoryRoot(cwd);
  const candidates = [
    path.resolve(cwd, raw),
    path.resolve(root, raw),
    path.isAbsolute(raw) ? raw : path.join(cwd, raw),
  ];
  for (const absolute of candidates) {
    if (await pathExists(absolute)) {
      return { absolute, relative: toPosix(path.relative(root, absolute)) };
    }
  }
  return null;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

// --- Markdown header-field editing (top `Key: value` block, above the first
// `##` section). Sets-or-inserts a field, replacing an existing (even empty)
// line. Insertion lands after the last existing header line so the block stays
// contiguous and git-diffable. ---

function headerValue(content: string, key: string): string | null {
  const pattern = new RegExp(`^${escapeRe(key)}:\\s*(.*)$`, "im");
  const match = content.match(pattern);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

function setHeaderField(content: string, key: string, value: string): string {
  const lines = content.split("\n");
  const linePattern = new RegExp(`^${escapeRe(key)}:\\s*.*$`, "i");
  const idx = lines.findIndex((line) => linePattern.test(line));
  if (idx >= 0) {
    lines[idx] = `${key}: ${value}`;
    return lines.join("\n");
  }
  // Insert after the last contiguous header line (a `Key:` line before the
  // first `##` section), else after the title, else at the top.
  let insertAt = 0;
  let sawHeader = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^##\s/.test(line)) {
      break;
    }
    if (/^[A-Za-z][A-Za-z-]*:\s*.*$/.test(line)) {
      insertAt = i + 1;
      sawHeader = true;
    } else if (!sawHeader && line.startsWith("# ")) {
      insertAt = i + 1;
    }
  }
  lines.splice(insertAt, 0, `${key}: ${value}`);
  return lines.join("\n");
}

function appendChangelog(content: string, note: string): string {
  if (content.includes(note)) {
    return content;
  }
  const marker = /^##\s+Changelog\s*$/im;
  if (marker.test(content)) {
    return content.replace(marker, (heading) => `${heading}\n\n${note}`);
  }
  return `${content.trimEnd()}\n\n## Changelog\n\n${note}\n`;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
