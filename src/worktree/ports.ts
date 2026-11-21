// Stable per-worktree ports (spec §3, §7.3). One journal per clone records which
// live checkout holds which port; a record whose checkout label no longer exists
// (the worktree was removed) counts as released. The whole allocation runs under
// the file lock in one synchronous section so two worktrees never pick the same
// port.

import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "../lib/file-lock";
import { resolveGitCommonDir } from "../lib/git-worktrees";
import { ensureCheckout, keryxDirIn, listLiveCheckoutIdsSync } from "./checkout";
import type { WorktreeConfig } from "./config";
import { gitDirOf } from "./git";

export interface PortRecord {
  checkoutId: string;
  name: string;
  port: number;
  at: string;
}

export interface AllocatePortsOptions {
  cwd: string;
  config: Pick<WorktreeConfig, "ports">;
  now?: () => Date;
  /** Synchronous bind probe; defaults to binding 127.0.0.1 and closing at once. */
  isPortFree?: (port: number) => boolean;
}

export interface AllocatedPorts {
  checkoutId: string;
  /** Port by configured name, e.g. `{ web: 5201 }`. */
  ports: Record<string, number>;
  /** Port by environment variable name, e.g. `{ PORT: "5201" }`; what `worktree.env` holds. */
  env: Record<string, string>;
}

const PORTS_LOCK_TIMEOUT_MS = 15_000;

export function portsJournalPath(commonDir: string): string {
  return path.join(commonDir, "keryx", "worktree-ports.jsonl");
}

export function worktreeEnvPath(gitDir: string): string {
  return path.join(keryxDirIn(gitDir), "worktree.env");
}

/** True when 127.0.0.1:`port` can be bound right now. */
export function defaultIsPortFree(port: number): boolean {
  try {
    const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    listener.stop(true);
    return true;
  } catch {
    return false;
  }
}

function parseRecords(text: string): PortRecord[] {
  const records: PortRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const raw = JSON.parse(line) as Partial<PortRecord>;
      if (
        typeof raw.checkoutId === "string" &&
        typeof raw.name === "string" &&
        typeof raw.port === "number" &&
        Number.isInteger(raw.port) &&
        typeof raw.at === "string"
      ) {
        records.push({ checkoutId: raw.checkoutId, name: raw.name, port: raw.port, at: raw.at });
      }
    } catch {
      // A torn or foreign line is dropped; the journal heals on the next write.
    }
  }
  return records;
}

function readRecordsSync(file: string): PortRecord[] {
  try {
    return parseRecords(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function serialize(records: readonly PortRecord[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

function lockedOrThrow<T>(lockPath: string, fn: () => T): T {
  const result = withFileLock(lockPath, fn, { timeoutMs: PORTS_LOCK_TIMEOUT_MS });
  if (result === null) {
    throw new Error(`could not take the worktree ports lock: ${lockPath}`);
  }
  return result;
}

async function commonDirOf(cwd: string): Promise<string> {
  const common = await resolveGitCommonDir(cwd);
  if (common === undefined) throw new Error(`not a git repository: ${cwd}`);
  return common;
}

/**
 * Give the worktree at `cwd` one port per configured name and write
 * `<worktree-git-dir>/keryx/worktree.env`. Idempotent: a name the checkout
 * already holds in range keeps its port. Throws when a range is exhausted, or
 * when `cwd` is the main checkout (it has no label to hold ports under).
 */
export async function allocatePorts(opts: AllocatePortsOptions): Promise<AllocatedPorts> {
  const checkout = await ensureCheckout(opts.cwd, opts.now === undefined ? {} : { now: opts.now });
  if (checkout === undefined) {
    throw new Error("the main checkout has no ports: run this inside a linked worktree");
  }
  const [commonDir, gitDir] = await Promise.all([commonDirOf(opts.cwd), gitDirOf(opts.cwd)]);
  const isPortFree = opts.isPortFree ?? defaultIsPortFree;
  const journal = portsJournalPath(commonDir);
  const at = (opts.now?.() ?? new Date()).toISOString();

  const ports = lockedOrThrow(`${journal}.lock`, () => {
    // Records of removed worktrees are released. The live set is read here, under the lock:
    // a worktree labelled after an earlier read must not have its record dropped.
    const live = new Set(listLiveCheckoutIdsSync(commonDir));
    const records = readRecordsSync(journal).filter((record) => live.has(record.checkoutId));
    const held = new Set(records.filter((record) => record.checkoutId !== checkout.checkoutId).map((record) => record.port));
    const mine = new Map(records.filter((record) => record.checkoutId === checkout.checkoutId).map((record) => [record.name, record]));
    const next = records.filter((record) => record.checkoutId !== checkout.checkoutId);
    const result: Record<string, number> = {};
    const used = new Set<number>();

    // First keep every port this checkout already holds in range, so a name picking a
    // new port can never take the port another of its names is about to keep.
    for (const [name, config] of Object.entries(opts.config.ports)) {
      const [lo, hi] = config.range;
      const existing = mine.get(name);
      if (existing !== undefined && existing.port >= lo && existing.port <= hi && !held.has(existing.port) && !used.has(existing.port)) {
        result[name] = existing.port;
        used.add(existing.port);
      }
    }
    for (const [name, config] of Object.entries(opts.config.ports)) {
      const [lo, hi] = config.range;
      let port = result[name];
      if (port === undefined) {
        for (let candidate = lo; candidate <= hi; candidate += 1) {
          if (held.has(candidate) || used.has(candidate)) continue;
          if (isPortFree(candidate)) {
            port = candidate;
            break;
          }
        }
      }
      if (port === undefined) {
        throw new Error(`no free port for "${name}" in range ${lo}-${hi}: every port is held or in use`);
      }
      result[name] = port;
      used.add(port);
      const existing = mine.get(name);
      next.push({ checkoutId: checkout.checkoutId, name, port, at: existing?.port === port ? existing.at : at });
    }

    // Names no longer configured drop out of the journal here (withFileLock made its directory).
    writeFileSync(journal, serialize(next), "utf8");
    return result;
  });

  const env: Record<string, string> = {};
  for (const [name, config] of Object.entries(opts.config.ports)) {
    env[config.env] = String(ports[name]);
  }
  await mkdir(keryxDirIn(gitDir), { recursive: true });
  const envFile = worktreeEnvPath(gitDir);
  const temp = `${envFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, Object.entries(env).map(([key, value]) => `${key}=${value}\n`).join(""), "utf8");
  await rename(temp, envFile);
  return { checkoutId: checkout.checkoutId, ports, env };
}

/** Drop every journal record of `checkoutId`; a missing journal is fine. */
export async function releasePorts(commonDir: string, checkoutId: string): Promise<void> {
  const journal = portsJournalPath(commonDir);
  try {
    await readFile(journal, "utf8");
  } catch {
    return;
  }
  lockedOrThrow(`${journal}.lock`, () => {
    const records = readRecordsSync(journal);
    const kept = records.filter((record) => record.checkoutId !== checkoutId);
    if (kept.length !== records.length) writeFileSync(journal, serialize(kept), "utf8");
  });
}

/** The `KEY=value` pairs of this worktree's `worktree.env`; empty when there is none. */
export async function readWorktreeEnv(cwd: string): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(worktreeEnvPath(await gitDirOf(cwd)), "utf8");
  } catch {
    return {};
  }
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match !== null) env[match[1] as string] = match[2] as string;
  }
  return env;
}
