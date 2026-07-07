import path from "node:path";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { pathExists } from "../lib/fs";
import { securityDataRoot } from "./config";
import type { IncidentEntry } from "./types";

// Incident trail (§14). Append-only JSONL under data/security/incidents/, so a
// downgrade or checksum mismatch leaves a durable, auditable record. Incident
// entries carry no secret/PII values (only policy-level metadata).

function incidentsDir(cwd: string): string {
  return path.join(securityDataRoot(cwd), "incidents");
}

function incidentsFile(cwd: string): string {
  return path.join(incidentsDir(cwd), "incidents.jsonl");
}

export async function appendIncident(cwd: string, entry: IncidentEntry): Promise<void> {
  const dir = incidentsDir(cwd);
  await mkdir(dir, { recursive: true });
  await appendFile(incidentsFile(cwd), `${JSON.stringify(entry)}\n`, "utf8");
}

export async function appendIncidents(cwd: string, entries: IncidentEntry[]): Promise<void> {
  for (const entry of entries) {
    await appendIncident(cwd, entry);
  }
}

export async function listIncidents(cwd: string, limit?: number): Promise<IncidentEntry[]> {
  const file = incidentsFile(cwd);
  if (!(await pathExists(file))) {
    return [];
  }
  const raw = await readFile(file, "utf8");
  const entries: IncidentEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      entries.push(JSON.parse(trimmed) as IncidentEntry);
    } catch {
      // Skip a malformed line rather than fail the whole listing.
    }
  }
  const ordered = entries.reverse();
  return limit !== undefined ? ordered.slice(0, limit) : ordered;
}
