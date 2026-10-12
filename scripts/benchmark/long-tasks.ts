// Long-session tasks for the mutating-ablation family (flow 387 T22a).
//
// Why they exist: the three MUTATING_TASKS finish in 3-4 model requests, so none of flow
// 387's token-economy mechanisms ever fires on them (prune outside the newest 40K
// tool-output tokens in >=20K batches, collapse of old tool exchanges, reasoning replay kept
// on the newest 3 rounds, compaction at 85% of the window, spill past 2000 lines / 50 KB).
// "No quality loss" (AC11) measured on those runs only shows no regression on trivial work.
// These tasks cannot be finished without accumulating ~90-110K tokens of tool output, and
// one of them is a late-recall probe: a fact read at the START of the session is needed
// 22 reads later, after prune/collapse has replaced it in the request.
//
// Design rules shared by both tasks:
//   - the corpus is GENERATED, deterministically, from fixed seeds and written into the
//     isolated worktree under `bench-long/` before the agent runs. Nothing depends on the
//     real repo's source, so a task keeps its meaning as the repo changes;
//   - success is a pure function of the files in the worktree after the turn (`check`),
//     never the agent's own claim, with an exact expected value per cell;
//   - every file is below read_file's 20,000-character cap, so one read returns a whole file
//     and the volume is real tool output rather than paging noise;
//   - this file IS the answer key (generator + expected values), so it is a gold artifact:
//     every producer strips it (and its test) from the worktree and asserts the strip.
//     See LONG_GOLD_ARTIFACT_PATHS.

export const LONG_GOLD_ARTIFACT_PATHS: readonly string[] = [
  "scripts/benchmark/long-tasks.ts",
  "scripts/benchmark/long-tasks.test.ts",
];

/** Worktree-relative directory every seeded corpus lives under. */
export const LONG_SEED_ROOT = "bench-long";

export type SeedFile = { readonly path: string; readonly content: string };

export type LongOracleResult = {
  readonly success: boolean;
  /** Fraction of cells (shards / files) that are exactly right, 0..1. */
  readonly score: number;
  readonly correct: number;
  readonly total: number;
  /** One short line per wrong cell (capped), for the run log. */
  readonly failures: readonly string[];
  /** Task-specific counters, e.g. missed/over-edited lines. */
  readonly counters: Readonly<Record<string, number>>;
};

/** Reads a worktree-relative path; `undefined` when the file does not exist. */
export type ReadWorktreeFile = (relPath: string) => string | undefined;

export type LongCase = {
  readonly seedFiles: readonly SeedFile[];
  readonly check: (read: ReadWorktreeFile) => LongOracleResult;
};

export type LongTask = {
  readonly name: string;
  /** The task ask with no harness-specific tool instructions. */
  readonly description: string;
  /** Prompt for keryx's own agent (description + shell_exec instructions). */
  readonly prompt: string;
  /** Prompt for third-party CLI harnesses (description + "use your own tools"). */
  readonly cliPromptText: string;
  /**
   * Worktree-relative path prefix whose files the task is about. A volume probe counts
   * read_file calls on distinct paths under it.
   */
  readonly volumePathPrefix: string;
  /** Distinct files under the prefix a faithful run reads (the volume check threshold is 80% of it). */
  readonly expectedDistinctReads: number;
  /** Lower bound of the tool-output tokens a faithful run produces; documented, used by the volume check. */
  readonly expectedToolOutputTokens: number;
  readonly build: () => LongCase;
};

/* ------------------------------------------------------------------ helpers */

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const int = (r: Rand, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const hex = (r: Rand, n: number): string => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(r() * 16)]).join("");
const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/** CRLF -> LF and trailing whitespace at the very end removed, so only content is compared. */
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+$/u, "");
}

/* ==========================================================================
 * Task 1: registry-recall — late recall across 22 shard reads
 * ======================================================================== */

export const REGISTRY_DIR = `${LONG_SEED_ROOT}/registry`;
export const REGISTRY_SHARD_COUNT = 22;
const ZONE_COUNT = 12;
const ZONES: readonly string[] = Array.from({ length: ZONE_COUNT }, (_, i) => `Z-${pad(i + 1, 2)}`);
const TOKEN_WORDS: readonly string[] = [
  "amber", "basalt", "cobalt", "dune", "ember", "fjord", "garnet", "harbor", "indigo", "jasper", "kelp", "lumen",
];
const REGISTRY_DUMP_LINES = 2100;
const REGISTRY_TABLE_AT = 1000;
const REGISTRY_REVISION_AT = 1500;

const SVCS = ["ledger-sync", "edge-proxy", "billing-core", "auth-gate", "queue-worker", "geo-index", "cache-warm", "mail-relay"] as const;
const LEVELS = ["INFO", "INFO", "INFO", "DEBUG", "WARN"] as const;
const PHRASES = [
  "heartbeat accepted", "batch flushed", "lease renewed", "snapshot written", "compaction skipped",
  "retry scheduled", "connection pooled", "checksum verified", "backlog drained", "token refreshed",
  "index rebuilt", "gc pause observed", "partition rebalanced", "quota recomputed",
] as const;
const REASONS = ["capacity", "maintenance window", "failover drill", "operator request", "latency budget", "audit"] as const;

type ZoneEventKind = "switch" | "rollback" | "draft";
type ZoneEvent = { readonly kind: ZoneEventKind; readonly zone?: string };

/** Final zone of a shard: SWITCH pushes, ROLLBACK pops back to the previous zone, DRAFT is ignored. */
export function finalZone(initial: string, events: readonly ZoneEvent[]): string {
  const stack: string[] = [initial];
  for (const e of events) {
    if (e.kind === "switch" && e.zone !== undefined) stack.push(e.zone);
    else if (e.kind === "rollback" && stack.length > 1) stack.pop();
  }
  return stack[stack.length - 1] as string;
}

type RegistryModel = {
  readonly vault: ReadonlyMap<string, string>;
  readonly stale: ReadonlyMap<string, string>;
  readonly revised: ReadonlyMap<string, string>;
};

function buildRegistryModel(): RegistryModel {
  const r = rng(7001);
  const vault = new Map<string, string>();
  const stale = new Map<string, string>();
  const revised = new Map<string, string>();
  ZONES.forEach((zone, i) => {
    const word = TOKEN_WORDS[i] as string;
    vault.set(zone, `${word}-${int(r, 1000, 9999)}`);
    stale.set(zone, `${word}-${int(r, 1000, 9999)}`);
  });
  for (const i of [2, 5, 8, 10]) {
    revised.set(ZONES[i] as string, `${TOKEN_WORDS[i] as string}-r${int(r, 100, 999)}`);
  }
  return { vault, stale, revised };
}

/** The current vault token of a zone: a later REVISED line replaces the table entry. */
export function effectiveToken(model: Pick<RegistryModel, "vault" | "revised">, zone: string): string {
  return model.revised.get(zone) ?? (model.vault.get(zone) as string);
}

function registryDump(model: RegistryModel): string {
  const r = rng(7002);
  const verbs = ["bumped", "pruned", "migrated", "reindexed", "rotated", "archived", "tuned", "audited"] as const;
  const nouns = ["lease table", "route cache", "ingest queue", "key ring", "shard map", "retry policy", "metrics sink"] as const;
  const areas = ["eu-west", "us-east", "ap-south", "core", "edge", "batch"] as const;
  const lines: string[] = [];
  const insert = new Map<number, string[]>();
  const table: string[] = [];
  for (const zone of ZONES) {
    table.push(`ZONE-VAULT-OLD ${zone} token=${model.stale.get(zone) as string}`);
    table.push(`ZONE-VAULT ${zone} token=${model.vault.get(zone) as string}`);
  }
  insert.set(REGISTRY_TABLE_AT, table);
  const rev: string[] = [];
  for (const [zone, token] of model.revised) rev.push(`ZONE-VAULT-REVISED ${zone} token=${token}`);
  insert.set(REGISTRY_REVISION_AT, rev);
  for (let n = 1; n <= REGISTRY_DUMP_LINES; n += 1) {
    const extra = insert.get(n);
    if (extra !== undefined) lines.push(...extra);
    lines.push(`changelog ${pad(n, 4)} ${pick(r, verbs)} ${pick(r, nouns)} in ${pick(r, areas)} (rev ${hex(r, 7)})`);
  }
  return `${lines.join("\n")}\n`;
}

type ShardModel = { readonly index: number; readonly initial: string; readonly events: readonly ZoneEvent[]; readonly text: string };

function buildShard(index: number): ShardModel {
  const r = rng(1000 + index);
  const nn = pad(index, 2);
  const initial = pick(r, ZONES);
  // Event plan: always at least one switch and one draft; rollback only when there is something to roll back.
  const count = int(r, 3, 5);
  const events: ZoneEvent[] = [];
  let depth = 1;
  for (let i = 0; i < count; i += 1) {
    const roll = r();
    if (i === 0) {
      events.push({ kind: "switch", zone: pick(r, ZONES) });
      depth += 1;
    } else if (i === 1) {
      events.push({ kind: "draft", zone: pick(r, ZONES) });
    } else if (roll < 0.3 && depth > 1) {
      events.push({ kind: "rollback" });
      depth -= 1;
    } else if (roll < 0.75) {
      events.push({ kind: "switch", zone: pick(r, ZONES) });
      depth += 1;
    } else {
      events.push({ kind: "draft", zone: pick(r, ZONES) });
    }
  }
  const lineCount = 182;
  const positions = new Set<number>();
  while (positions.size < events.length) positions.add(int(r, 8, lineCount - 6));
  const sortedPositions = [...positions].sort((a, b) => a - b);
  const eventAt = new Map<number, ZoneEvent>();
  sortedPositions.forEach((p, i) => eventAt.set(p, events[i] as ZoneEvent));

  const lines: string[] = [`# shard ${nn} initial-zone=${initial}`];
  let second = int(r, 0, 20);
  for (let i = 1; i <= lineCount; i += 1) {
    second += int(r, 1, 17);
    const ts = `2031-0${int(r, 1, 9)}-${pad(int(r, 1, 28), 2)}T${pad(int(r, 0, 23), 2)}:${pad(Math.floor(second / 60) % 60, 2)}:${pad(second % 60, 2)}Z`;
    const ev = eventAt.get(i);
    if (ev !== undefined) {
      const reason = `reason="${pick(r, REASONS)}"`;
      if (ev.kind === "switch") lines.push(`${ts} shard=${nn} lvl=WARN svc=router ZONE-SWITCH active-zone=${ev.zone as string} ${reason}`);
      else if (ev.kind === "rollback") lines.push(`${ts} shard=${nn} lvl=WARN svc=router ZONE-SWITCH-ROLLBACK ${reason}`);
      else lines.push(`${ts} shard=${nn} lvl=INFO svc=router ZONE-SWITCH-DRAFT active-zone=${ev.zone as string} reason="not committed"`);
      continue;
    }
    // Plain noise, with look-alike decoys that must not count as a switch.
    const decoy = r() < 0.06;
    const msg = decoy
      ? `zone-check ok zone=${pick(r, ZONES)} ${hex(r, 6)}`
      : `${pick(r, PHRASES)} ${hex(r, 8)}`;
    lines.push(`${ts} shard=${nn} lvl=${pick(r, LEVELS)} svc=${pick(r, SVCS)} msg="${msg}" lat=${int(r, 1, 480)}ms`);
  }
  return { index, initial, events, text: `${lines.join("\n")}\n` };
}

export type RegistryExpectation = { readonly answer: Readonly<Record<string, string>>; readonly files: readonly SeedFile[]; readonly shards: readonly ShardModel[] };

export function buildRegistryCase(): RegistryExpectation {
  const model = buildRegistryModel();
  const shards = Array.from({ length: REGISTRY_SHARD_COUNT }, (_, i) => buildShard(i + 1));
  const answer: Record<string, string> = {};
  const files: SeedFile[] = [
    { path: `${REGISTRY_DIR}/registry-dump.txt`, content: registryDump(model) },
    { path: `${REGISTRY_DIR}/show-registry.sh`, content: `#!/bin/sh\ncat "$(dirname "$0")/registry-dump.txt"\n` },
  ];
  for (const shard of shards) {
    const key = `shard-${pad(shard.index, 2)}`;
    answer[key] = effectiveToken(model, finalZone(shard.initial, shard.events));
    files.push({ path: `${REGISTRY_DIR}/shards/${key}.log`, content: shard.text });
  }
  return { answer, files, shards };
}

/** Pure oracle for the registry task: exact token per shard in `answer.json`. */
export function checkRegistryAnswer(expected: Readonly<Record<string, string>>, answerText: string | undefined): LongOracleResult {
  const keys = Object.keys(expected);
  const fail = (why: string): LongOracleResult => ({ success: false, score: 0, correct: 0, total: keys.length, failures: [why], counters: { missing: keys.length, wrong: 0 } });
  if (answerText === undefined) return fail("answer.json was not written");
  let parsed: unknown;
  try {
    parsed = JSON.parse(answerText);
  } catch {
    return fail("answer.json is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return fail("answer.json is not a JSON object");
  const got = parsed as Record<string, unknown>;
  let correct = 0;
  let missing = 0;
  let wrong = 0;
  const failures: string[] = [];
  for (const key of keys) {
    const value = got[key];
    if (value === undefined) {
      missing += 1;
      if (failures.length < 12) failures.push(`${key}: missing`);
    } else if (value === expected[key]) {
      correct += 1;
    } else {
      wrong += 1;
      if (failures.length < 12) failures.push(`${key}: expected ${expected[key] as string}, got ${String(value)}`);
    }
  }
  return { success: correct === keys.length, score: keys.length === 0 ? 0 : correct / keys.length, correct, total: keys.length, failures, counters: { missing, wrong } };
}

const REGISTRY_DESCRIPTION =
  `In this repository, the directory ${REGISTRY_DIR}/ holds a zone registry and ${REGISTRY_SHARD_COUNT} shard logs ` +
  `(${REGISTRY_DIR}/shards/shard-01.log ... shard-${REGISTRY_SHARD_COUNT}.log). For EVERY shard, find the zone the shard ends ` +
  `in and the CURRENT vault token of that zone, then write ${REGISTRY_DIR}/answer.json: one JSON object whose keys are ` +
  `"shard-01" ... "shard-${REGISTRY_SHARD_COUNT}" and whose values are that shard's token string (for example {"shard-01": "amber-1234", ...}). ` +
  `Rules. A shard's first line is "# shard NN initial-zone=Z-xx". Each ZONE-SWITCH line moves the shard to the zone in ` +
  `its active-zone field. A ZONE-SWITCH-ROLLBACK line moves it back to the zone it was in before the most recent switch that has not ` +
  `been rolled back. ZONE-SWITCH-DRAFT lines are never committed and are ignored, and so is any other line that merely mentions a zone. ` +
  `The vault tokens come from the registry: run \`sh ${REGISTRY_DIR}/show-registry.sh\` exactly ONCE, with no pipe and no filter. ` +
  `Its output is long and is saved to a file, which you read with read_file and its start_line argument. A ZONE-VAULT line is a zone's ` +
  `token, a ZONE-VAULT-OLD line is stale and ignored, and a ZONE-VAULT-REVISED line for a zone replaces that zone's ZONE-VAULT token ` +
  `wherever it appears in the output. Do this in order: registry first, then read each shard completely with read_file, one file per ` +
  `call, shard-01 first. Do not run search_code, grep or any shell filter over the shards or the registry: the exercise is reading them. ` +
  `Do not write answer.json until you have read every shard.`;

const SHELL_INSTRUCTIONS_LONG =
  "You have a real shell via the shell_exec tool; use it to run the script and, at the end, to write the answer file " +
  "with a heredoc, e.g.: cat > path/to/file <<'KERYX_EOF'\n<content>\nKERYX_EOF\n" +
  "When the file is written, reply with exactly: DONE";

const CLI_INSTRUCTIONS_LONG = "Use your own file-reading, file-editing and shell tools directly. When you are done, reply with exactly: DONE";

/* ==========================================================================
 * Task 2: rename-twist — a per-file-judgement rename across 22 modules
 * ======================================================================== */

export const RENAME_DIR = `${LONG_SEED_ROOT}/svc`;
export const RENAME_FILE_COUNT = 22;
const OLD_NAME = "fetchRecord";
const NEW_NAME = "loadRecord";

type Block = { readonly before: string; readonly after: string };
const same = (text: string): Block => ({ before: text, after: text });
// Whole-word only: `fetchRecords` is a different identifier and must survive the rename.
const renamed = (before: string): Block => ({ before, after: before.replace(new RegExp(`\\b${OLD_NAME}\\b`, "g"), NEW_NAME) });

const FILLER_VERBS = ["summarize", "collect", "merge", "reduce", "scan", "tally", "group", "rank", "trim", "sample"] as const;
const FILLER_NOUNS = ["Batches", "Windows", "Entries", "Lanes", "Buckets", "Spans", "Frames", "Digests"] as const;
const FILLER_PROPS = ["weight", "age", "depth", "score", "hits", "span"] as const;
const FILLER_COMMENTS = [
  "keep this loop allocation-free; it runs on every tick",
  "ordering here matches the dashboard, do not sort",
  "the limit is advisory, callers clamp it again",
  "stale entries are filtered by the caller",
  "this mirrors the legacy aggregation, including its rounding",
] as const;

function fillerBlock(r: Rand, id: string): Block {
  const fn = `${pick(r, FILLER_VERBS)}${pick(r, FILLER_NOUNS)}${id}`;
  const prop = pick(r, FILLER_PROPS);
  const prop2 = pick(r, FILLER_PROPS);
  const n = int(r, 3, 90);
  const m = int(r, 2, 9);
  return same(
    [
      `export function ${fn}(items: readonly Rec[], limit = ${n}): Summary {`,
      `  const out: Summary = { count: 0, ids: [], total: 0 };`,
      `  for (const item of items) {`,
      `    if (out.count >= limit) break;`,
      `    // ${pick(r, FILLER_COMMENTS)}`,
      `    if (item.${prop} > ${m} && item.${prop2} !== ${n}) {`,
      `      out.ids.push(item.id);`,
      `      out.count += ${int(r, 1, 3)};`,
      `      out.total += item.${prop} * ${m};`,
      `    } else if (item.${prop2} < ${m}) {`,
      `      out.total -= ${int(r, 1, 5)};`,
      `    }`,
      `  }`,
      `  const spread = out.ids.length === 0 ? 0 : out.total / out.ids.length;`,
      `  out.total = Math.round(spread * ${m}) + ${int(r, 0, 40)};`,
      `  return out;`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const realNamed = (k: string): Block =>
  renamed(
    [
      `export async function hydrate${k}(id: string): Promise<Rec> {`,
      `  const rec = await ${OLD_NAME}(id);`,
      `  return { ...rec, hydrated: true };`,
      `}`,
      ``,
    ].join("\n"),
  );

const realNamespace = (k: string): Block =>
  renamed(
    [
      `export async function resolve${k}(id: string): Promise<Rec> {`,
      `  const rec = await store.${OLD_NAME}(id);`,
      `  return { ...rec, resolvedBy: "store" };`,
      `}`,
      ``,
    ].join("\n"),
  );

const aliasUse = (k: string): Block =>
  same(
    [
      `export async function warm${k}(id: string): Promise<Rec> {`,
      `  const rec = await fr(id);`,
      `  return { ...rec, warm: true };`,
      `}`,
      ``,
    ].join("\n"),
  );

const commentDecoy = (k: string): Block =>
  same(`// NOTE(${k}): ${OLD_NAME}(id) used to retry on 503 here; the retry now lives in the transport.\n`);

const stringDecoy = (k: string): Block =>
  same(
    [
      `export function report${k}(id: string): void {`,
      `  logger.warn("${OLD_NAME} failed for " + id);`,
      `}`,
      ``,
    ].join("\n"),
  );

const clientDecoy = (k: string): Block =>
  same(
    [
      `export async function remote${k}(client: RemoteClient, id: string): Promise<Rec> {`,
      `  const remote = await client.${OLD_NAME}(id);`,
      `  return remote;`,
      `}`,
      ``,
    ].join("\n"),
  );

const shadowDecoy = (k: string): Block =>
  same(
    [
      `export function memo${k}(cache: Map<string, Rec>, key: string): Rec | undefined {`,
      `  const ${OLD_NAME} = (k: string) => cache.get(k);`,
      `  return ${OLD_NAME}(key);`,
      `}`,
      ``,
    ].join("\n"),
  );

const pluralDecoy = (k: string): Block =>
  same(
    [
      `export async function bulk${k}(ids: string[]): Promise<Rec[]> {`,
      `  return await ${OLD_NAME}s(ids);`,
      `}`,
      ``,
    ].join("\n"),
  );

type ImportKind = "named" | "alias" | "namespace" | "none";
const IMPORT_KINDS: readonly ImportKind[] = ["named", "alias", "namespace", "none"];

function importHeader(kind: ImportKind): Block {
  switch (kind) {
    case "named":
      return renamed(`import { ${OLD_NAME} } from "./mod-00";\n`);
    case "alias":
      return renamed(`import { ${OLD_NAME} as fr } from "./mod-00";\n`);
    case "namespace":
      return same(`import * as store from "./mod-00";\n`);
    case "none":
      return same("");
  }
}

function assemble(blocks: readonly Block[]): { before: string; after: string } {
  return { before: blocks.map((b) => b.before).join("\n"), after: blocks.map((b) => b.after).join("\n") };
}

const TARGET_FILE_CHARS = 16_500;

function buildRenameFile(index: number): { before: string; after: string } {
  const r = rng(4000 + index);
  const k = pad(index, 2);
  const header: Block[] = [same(`import type { Rec, Summary, RemoteClient } from "./types";\n`)];
  const special: Block[] = [];
  if (index === 0) {
    special.push(
      same(`// The record loader. Every other module in this directory goes through it.\n`),
      renamed(
        [
          `export async function ${OLD_NAME}(id: string): Promise<Rec> {`,
          `  const res = await transport.get("/records/" + id);`,
          `  if (res.status === 503) return ${OLD_NAME}(id);`,
          `  return res.body as Rec;`,
          `}`,
          ``,
        ].join("\n"),
      ),
      renamed(
        [
          `export async function ${OLD_NAME}s(ids: string[]): Promise<Rec[]> {`,
          `  return Promise.all(ids.map((id) => ${OLD_NAME}(id))).then((all) => all);`,
          `}`,
          ``,
        ].join("\n"),
      ),
    );
  } else {
    const kind = IMPORT_KINDS[index % IMPORT_KINDS.length] as ImportKind;
    header.push(importHeader(kind));
    if (kind === "named") special.push(realNamed(`${k}a`), realNamed(`${k}b`), shadowDecoy(k), commentDecoy(k));
    else if (kind === "alias") special.push(aliasUse(`${k}a`), aliasUse(`${k}b`), commentDecoy(k), pluralDecoy(k));
    else if (kind === "namespace") special.push(realNamespace(`${k}a`), realNamespace(`${k}b`), clientDecoy(k), stringDecoy(k));
    else special.push(clientDecoy(k), stringDecoy(k), shadowDecoy(k), commentDecoy(k), pluralDecoy(k));
    // A few files mix in a second kind of decoy so no file is trivially "all real" or "all decoy".
    if (index % 5 === 0) special.push(shadowDecoy(`${k}x`), commentDecoy(`${k}x`));
  }
  const filler: Block[] = [];
  let size = [...header, ...special].reduce((n, b) => n + b.before.length, 0);
  let i = 0;
  while (size < TARGET_FILE_CHARS) {
    const block = fillerBlock(r, `${k}${i}`);
    filler.push(block);
    size += block.before.length + 1;
    i += 1;
  }
  // Scatter the specials among the filler at seeded positions (ascending, stable).
  const body: Block[] = [...filler];
  for (const block of special) {
    body.splice(int(r, 0, body.length), 0, block);
  }
  return assemble([...header, ...body]);
}

export type RenameExpectation = { readonly before: ReadonlyMap<string, string>; readonly after: ReadonlyMap<string, string>; readonly files: readonly SeedFile[] };

export function buildRenameCase(): RenameExpectation {
  const before = new Map<string, string>();
  const after = new Map<string, string>();
  const files: SeedFile[] = [
    {
      path: `${RENAME_DIR}/types.ts`,
      content:
        `export type Rec = { id: string; weight: number; age: number; depth: number; score: number; hits: number; span: number };\n` +
        `export type Summary = { count: number; ids: string[]; total: number };\n` +
        `export type RemoteClient = { ${OLD_NAME}(id: string): Promise<Rec> };\n`,
    },
  ];
  for (let i = 0; i < RENAME_FILE_COUNT; i += 1) {
    const rel = `${RENAME_DIR}/mod-${pad(i, 2)}.ts`;
    const built = buildRenameFile(i);
    before.set(rel, built.before);
    after.set(rel, built.after);
    files.push({ path: rel, content: built.before });
  }
  return { before, after, files };
}

/**
 * Pure oracle for the rename task: every module must equal its expected "after" text exactly.
 * A mismatching line is classed as `missedEdits` (a real occurrence left as it was), `overEdits`
 * (a decoy or filler line that was changed) or `otherDiffs` (anything else, e.g. different line count).
 */
export function checkRenameTree(exp: Pick<RenameExpectation, "before" | "after">, read: ReadWorktreeFile): LongOracleResult {
  let correct = 0;
  let missedEdits = 0;
  let overEdits = 0;
  let otherDiffs = 0;
  let missingFiles = 0;
  const failures: string[] = [];
  for (const [rel, expectedAfter] of exp.after) {
    const actualRaw = read(rel);
    if (actualRaw === undefined) {
      missingFiles += 1;
      if (failures.length < 12) failures.push(`${rel}: file missing`);
      continue;
    }
    const actual = normalize(actualRaw);
    const want = normalize(expectedAfter);
    if (actual === want) {
      correct += 1;
      continue;
    }
    const beforeLines = normalize(exp.before.get(rel) as string).split("\n");
    const wantLines = want.split("\n");
    const gotLines = actual.split("\n");
    let firstBad = 0;
    if (gotLines.length !== wantLines.length) {
      otherDiffs += 1;
      firstBad = Math.min(gotLines.length, wantLines.length);
    } else {
      for (let i = 0; i < wantLines.length; i += 1) {
        if (gotLines[i] === wantLines[i]) continue;
        if (firstBad === 0) firstBad = i + 1;
        if (wantLines[i] !== beforeLines[i] && gotLines[i] === beforeLines[i]) missedEdits += 1;
        else if (wantLines[i] === beforeLines[i]) overEdits += 1;
        else otherDiffs += 1;
      }
    }
    if (failures.length < 12) failures.push(`${rel}: first difference near line ${firstBad === 0 ? 1 : firstBad}`);
  }
  const total = exp.after.size;
  return {
    success: correct === total,
    score: total === 0 ? 0 : correct / total,
    correct,
    total,
    failures,
    counters: { missedEdits, overEdits, otherDiffs, missingFiles },
  };
}

const RENAME_DESCRIPTION =
  `In this repository, ${RENAME_DIR}/ holds ${RENAME_FILE_COUNT} TypeScript modules, mod-00.ts ... mod-${pad(RENAME_FILE_COUNT - 1, 2)}.ts. ` +
  `mod-00.ts exports the async function ${OLD_NAME}. Rename that function to ${NEW_NAME} everywhere it IS that function: ` +
  `its definition, calls to it, and every import of it. For \`import { ${OLD_NAME} as fr }\` rename only the imported name and ` +
  `keep the alias \`fr\` and every call through it as they are; for a namespace import such as \`import * as store\` the call ` +
  `\`store.${OLD_NAME}(...)\` is a use of the function and is renamed. Leave everything else exactly as it is: mentions in comments and ` +
  `in string literals, the method \`client.${OLD_NAME}(...)\` of the unrelated RemoteClient, any local variable, parameter or function ` +
  `that happens to be called ${OLD_NAME} (a shadowing declaration) together with the uses it covers, and different identifiers such as ` +
  `${OLD_NAME}s. You must judge every occurrence in its context, so read each module completely with read_file, one file per call, ` +
  `before you change it. Do not use search_code, grep, or a project-wide sed/replace: they cannot tell these cases apart. Edit the ` +
  `files in place; do not create, rename or delete files, and change nothing outside ${RENAME_DIR}/.`;

const SHELL_INSTRUCTIONS_RENAME =
  "You have a real shell via the shell_exec tool; use it for edits, one targeted command per change, for example " +
  "`perl -pi -e 's/\\bfetchRecord\\(/loadRecord(/ if $. == 41' bench-long/svc/mod-03.ts` (the line number is the line you read), " +
  "or rewrite a file with a heredoc: cat > path <<'KERYX_EOF'\n<full file>\nKERYX_EOF\n" +
  "When every module is done, reply with exactly: DONE";

/* ------------------------------------------------------------------ catalog */

export const LONG_TASKS: readonly LongTask[] = [
  {
    name: "registry-recall",
    description: REGISTRY_DESCRIPTION,
    prompt: `${REGISTRY_DESCRIPTION} ${SHELL_INSTRUCTIONS_LONG}`,
    cliPromptText: `${REGISTRY_DESCRIPTION} ${CLI_INSTRUCTIONS_LONG}`,
    volumePathPrefix: `${REGISTRY_DIR}/shards/`,
    expectedDistinctReads: REGISTRY_SHARD_COUNT,
    // 22 shards x ~4.4K tokens + ~4 spill pages of the registry dump (~16K) + the one tool result of the script run.
    expectedToolOutputTokens: 100_000,
    build: () => {
      const exp = buildRegistryCase();
      return {
        seedFiles: exp.files,
        check: (read) => checkRegistryAnswer(exp.answer, read(`${REGISTRY_DIR}/answer.json`)),
      };
    },
  },
  {
    name: "rename-twist",
    description: RENAME_DESCRIPTION,
    prompt: `${RENAME_DESCRIPTION} ${SHELL_INSTRUCTIONS_RENAME}`,
    cliPromptText: `${RENAME_DESCRIPTION} ${CLI_INSTRUCTIONS_LONG}`,
    volumePathPrefix: `${RENAME_DIR}/`,
    expectedDistinctReads: RENAME_FILE_COUNT,
    // 22 modules x ~4.1K tokens, plus the edit calls' small outputs.
    expectedToolOutputTokens: 85_000,
    build: () => {
      const exp = buildRenameCase();
      return { seedFiles: exp.files, check: (read) => checkRenameTree(exp, read) };
    },
  },
];

/** Resolve `--tasks`: "long" (every long task) or a comma-separated list of names. */
export function selectLongTasks(spec: string): readonly LongTask[] {
  if (spec === "long" || spec === "all") return LONG_TASKS;
  const wanted = spec.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const out: LongTask[] = [];
  for (const name of wanted) {
    const task = LONG_TASKS.find((t) => t.name === name);
    if (task === undefined) throw new Error(`unknown long task "${name}" (known: ${LONG_TASKS.map((t) => t.name).join(", ")})`);
    out.push(task);
  }
  if (out.length === 0) throw new Error("--tasks selected no task");
  return out;
}
