// Offline preparation only: never loads models or claims measured quality.
import { createHash } from "node:crypto";
type Row = Record<string, unknown>;
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("expected object");
  return value as Row;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw Error("expected nonempty string");
  return value;
}
function rows(value: unknown): Row[] {
  if (!Array.isArray(value)) throw Error("expected array");
  return value.map(object);
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function prepareEvidenceEvaluation(raw: string) {
  const data = object(JSON.parse(raw));
  if (data.version !== 1 || data.synthetic !== true || data.status !== "exploratory-smoke-only") {
    throw Error("unsupported dataset");
  }
  const sources = rows(data.sources), queries = rows(data.queries);
  if (!sources.length || !queries.length) throw Error("empty dataset");
  const ids = new Map<string, Row>(), projects = new Map<string, string>(), sessions = new Map<string, string>();
  function scope(row: Row) {
    const split = text(row.split);
    if (!["dev", "held-out", "distractor"].includes(split)) throw Error("invalid split");
    for (const [key, map] of [["project", projects], ["session", sessions]] as const) {
      const id = text(row[key]);
      if (map.has(id) && map.get(id) !== split) throw Error("split leakage");
      map.set(id, split);
    }
  }
  for (const source of sources) {
    const id = text(source.id); scope(source); text(source.text);
    if (ids.has(id)) throw Error("duplicate source");
    if (!["active", "superseded", "revoked", "deleted"].includes(text(source.state)) ||
        !Number.isSafeInteger(source.version) || (source.version as number) < 1) throw Error("invalid source");
    ids.set(id, source);
  }
  function span(value: unknown, query: Row) {
    const label = object(value), id = text(label.source), quote = text(label.quote), source = ids.get(id);
    if (!source || source.state !== "active" || source.project !== query.project || source.split !== query.split) {
      throw Error("ineligible source");
    }
    const body = text(source.text), offset = body.indexOf(quote);
    if (offset < 0 || body.indexOf(quote, offset + 1) >= 0) throw Error("missing or ambiguous quote");
    const startByte = Buffer.byteLength(body.slice(0, offset));
    return { source: id, version: source.version, sourceHash: hash(body), quoteHash: hash(quote),
      startByte, endByte: startByte + Buffer.byteLength(quote) };
  }
  const seen = new Set<string>();
  const compiled = queries.map(query => {
    const id = text(query.id), kind = text(query.class); scope(query); text(query.text);
    if (seen.has(id)) throw Error("duplicate query"); seen.add(id);
    if (!["answerable", "unanswerable", "conflicting", "paraphrased", "current-visible", "compacted-out",
      "rewritten-cross-project", "revoked", "instruction-shaped"].includes(kind)) throw Error("unknown scenario");
    const relevant = rows(query.relevant).map(label => span(label, query));
    const keys = relevant.map(label => JSON.stringify(label));
    if (new Set(keys).size !== keys.length) throw Error("duplicate label");
    if (["unanswerable", "revoked"].includes(kind) ? relevant.length !== 0 : relevant.length === 0) {
      throw Error("class and labels disagree");
    }
    const forbidden = query.forbiddenSources === undefined ? [] : query.forbiddenSources;
    if (!Array.isArray(forbidden)) throw Error("invalid forbidden sources");
    const forbiddenIds = forbidden.map(text);
    if (new Set(forbiddenIds).size !== forbiddenIds.length || forbiddenIds.some(id => !ids.has(id)) ||
        relevant.some(label => forbiddenIds.includes(label.source))) throw Error("invalid forbidden labels");
    const forbiddenRows = forbiddenIds.map(id => ids.get(id)!);
    if (kind === "revoked" && !forbiddenRows.some(source => source.state === "revoked" &&
        source.project === query.project && source.split === query.split)) throw Error("missing revoked source");
    if (kind === "rewritten-cross-project" &&
        (!forbiddenRows.some(source => source.state === "superseded" && source.project === query.project &&
          source.split === query.split) ||
         !forbiddenRows.some(source => source.project !== query.project && source.state === "active"))) {
      throw Error("missing rewrite or cross-project distractor");
    }
    let visibility: unknown = null;
    if (query.visibility !== undefined) {
      const visible = object(query.visibility);
      if (visible.kind === "exact-final-request") {
        const resolved = span(visible, query);
        if (!keys.includes(JSON.stringify(resolved))) throw Error("visible span not relevant");
        visibility = { kind: visible.kind, span: resolved, proofStatus: "not-run" };
      } else if (visible.kind === "summary-only") {
        visibility = { kind: visible.kind, summaryHash: hash(text(visible.text)), proofStatus: "not-run" };
      } else throw Error("unknown visibility");
    }
    if ((kind === "current-visible" && object(query.visibility).kind !== "exact-final-request") ||
        (kind === "compacted-out" && object(query.visibility).kind !== "summary-only")) throw Error("missing visibility");
    return { id, split: query.split, project: query.project, session: query.session, kind,
      queryHash: hash(text(query.text)), relevant, forbiddenSources: forbiddenIds, visibility, scenarioStatus: "not-run" };
  });
  return { version: 1, status: "preparation-only", datasetHash: hash(raw), offsetUnit: "utf8-bytes-half-open",
    sources: sources.map(source => ({ id: source.id, version: source.version, state: source.state,
      sourceHash: hash(text(source.text)) })), queries: compiled,
    missingCoverage: sources.some(source => source.state === "deleted") ? [] : ["deleted-source"],
    arms: ["A", "B", "C", "D", "E"].map(arm => ({ arm, status: "not-run" })), metrics: null, rolloutDecision: null,
    limitations: ["No retrieval, lifecycle or visibility scenarios executed", "No embeddings, timing or blinded judgments",
      "Exploratory smoke corpus, not frozen holdout"] };
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1) throw Error("expected one dataset path");
    console.log(JSON.stringify(prepareEvidenceEvaluation(await Bun.file(args[0]!).text()), null, 2));
  } catch {
    console.error("Evidence evaluation preparation refused: invalid dataset or invocation");
    process.exitCode = 1;
  }
}
