import type { FwkReadResult } from "./fwk-service";
import type { ContextOverflow } from "../ctx/assembly";

function isOverflow(result: FwkReadResult): result is ContextOverflow {
  return "code" in result;
}

/**
 * Human trace of a SAC FWK result. Used by `keryx workspace overview|read
 * --explain` so an operator can see Facts / Work / Know-how owners without
 * parsing the receipt JSON. Does not invent content the manifest omitted.
 */
export function formatFwkExplain(result: FwkReadResult): string {
  if (isOverflow(result)) {
    return [`SAC explain: context_overflow (${result.code})`, "No successful manifest/receipt. Shrink the scope or raise the budget."].join("\n");
  }
  const facts = Array.isArray(result.manifest.facts) ? result.manifest.facts : [];
  const knowHow = Array.isArray(result.manifest.knowHow) ? result.manifest.knowHow : [];
  const work = result.manifest.work as { state?: string; flowRef?: { uri?: string; snapshot?: string; revision?: string }; completed?: string[]; next?: string[]; blocked?: string[] } | undefined;
  const byKind = { wiki: 0, memory: 0, skill: 0, other: 0 };
  const knowHowLines = knowHow.map((item) => {
    const row = item as { kind?: string; uri?: string; revision?: string; status?: string };
    const kind = row.kind === "wiki" || row.kind === "memory" || row.kind === "skill" ? row.kind : "other";
    byKind[kind] += 1;
    return `    - ${kind} ${row.uri ?? "?"}  revision=${row.revision ?? "?"}  status=${row.status ?? "?"}`;
  });
  const workState = work?.state ?? "unbound";
  const lines = [
    "SAC explain (FWK — Facts / Work / Know-how)",
    `  freshness: ${result.manifest.freshness}`,
    `  receipt: ${result.receipt.id}  decision=${result.receipt.decision}`,
    `  Facts (${facts.length}) — evidence-linked, task-local; not durable knowledge`,
    ...facts.map((fact) => {
      const row = fact as { statement?: string; evidence?: Array<{ uri?: string; revision?: string }>; freshness?: string };
      const ev = row.evidence?.[0];
      return `    - ${row.statement ?? "(no statement)"}  uri=${ev?.uri ?? "?"}  revision=${ev?.revision ?? "?"}  freshness=${row.freshness ?? "?"}`;
    }),
    `  Work (${workState}) — Flow projection only; SAC does not write flow.json`,
    ...(workState === "bound"
      ? [
          `    - flow=${work?.flowRef?.uri ?? "?"}  snapshot=${work?.flowRef?.snapshot ?? "?"}  revision=${work?.flowRef?.revision ?? "?"}`,
          `    - completed=${(work?.completed ?? []).join(",") || "(none)"}  next=${(work?.next ?? []).join(",") || "(none)"}  blocked=${(work?.blocked ?? []).join(",") || "(none)"}`,
        ]
      : ["    - no flow resource bound on this workspace"]),
    `  Know-how (${knowHow.length}: wiki=${byKind.wiki} memory=${byKind.memory} skill=${byKind.skill}) — references to owning stores, not SAC copies`,
    ...(knowHowLines.length > 0 ? knowHowLines : ["    - (none accepted/visible in this budget)"]),
    "  Not written here: graph nodes/edges (navigation only), session transcripts, hidden reasoning.",
  ];
  if (result.partial) lines.push(`  partial: omitted optional ${result.omittedOptional.join(", ") || "(none)"}`);
  return lines.join("\n");
}
