import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEvidenceRuntime } from "../../src/evidence/runtime";
import { prepareEvidenceEvaluation } from "./prepare-evidence-evaluation";
import type { EvaluationAdapter } from "./run-evidence-evaluation";
import type { EvaluationSpan } from "./evidence-evaluation-metrics";

const scenarios = ["answerable", "unanswerable", "conflicting", "paraphrased", "instruction-shaped"];
type Runtime = Extract<Awaited<ReturnType<typeof createEvidenceRuntime>>, { ok: true }>["runtime"];
interface Source { id: string; project: string; split: string; state: string; version: number; text: string }

/** Static file retrieval only; no fake lifecycle, visibility, scanners or embeddings. */
export async function createLexicalEvaluationAdapter(raw: string) {
  const prepared = prepareEvidenceEvaluation(raw);
  const data = JSON.parse(raw) as { sources: Source[]; queries: { id: string; text: string }[] };
  const queries = new Map(data.queries.map(query => [query.id, query.text]));
  const metadata = new Map(prepared.sources.map(source => [source.id, source]));
  const base = await mkdtemp(path.join(tmpdir(), "keryx-lexical-evaluation-"));
  const contexts = new Map<string, { runtime: Runtime; files: Map<string, Source> }>();
  const key = (project: unknown, split: unknown) => JSON.stringify([project, split]);
  let closed = false, active = false;
  let pending: Promise<void> = Promise.resolve();
  let cleanup: Promise<void> | undefined;
  function close() {
    if (cleanup) return cleanup;
    closed = true;
    cleanup = (async () => {
      // Cancellation is cooperative; never delete files below an unfinished search.
      await pending;
      try { for (const context of contexts.values()) context.runtime.close(); }
      finally { await rm(base, { recursive: true, force: true }); }
    })();
    return cleanup;
  }
  try {
    for (const query of prepared.queries) {
      if (!scenarios.includes(query.kind)) continue;
      const scope = key(query.project, query.split);
      if (contexts.has(scope)) continue;
      // Dataset identifiers never become paths; use generated ordinals only.
      const root = path.join(base, String(contexts.size));
      await mkdir(path.join(root, "docs"), { recursive: true });
      await mkdir(path.join(root, ".metaproject"));
      await writeFile(path.join(root, ".metaproject/metaproject.json"),
        JSON.stringify({ modules: { security: { enabled: true } } }));
      const files = new Map<string, Source>();
      for (const source of data.sources) {
        if (source.state !== "active" || source.project !== query.project || source.split !== query.split) continue;
        const relative = `docs/${files.size}.txt`;
        await writeFile(path.join(root, relative), source.text);
        files.set(relative, source);
      }
      const loaded = await createEvidenceRuntime({ projectRoot: root,
        config: { schemaVersion: 1, enabled: true, roots: ["docs"] } });
      if (!loaded.ok) throw Error("lexical runtime unavailable");
      const context = { runtime: loaded.runtime, files };
      contexts.set(scope, context);
      const built = await context.runtime.buildConfiguredFiles();
      if (built.code !== "ok") throw Error("lexical build failed");
    }
  } catch (error) { await close(); throw error; }
  const adapter: EvaluationAdapter = {
    revision: "production-lexical-static-files-v1", scenarios,
    async run(request) {
      if (closed || active || request.signal.aborted || request.datasetHash !== prepared.datasetHash) return { status: "failed" };
      const query = prepared.queries.find(query => query.id === request.queryId);
      if (!query || query.queryHash !== request.queryHash) return { status: "failed" };
      if (!scenarios.includes(query.kind)) return { status: "unsupported" };
      const context = contexts.get(key(query.project, query.split));
      const text = queries.get(query.id);
      if (!context || text === undefined) return { status: "failed" };
      active = true;
      let release!: () => void;
      pending = new Promise<void>(resolve => { release = resolve; });
      try {
        return await context.runtime.search(text, result => {
          if (result.code !== "ok") return { status: "failed" as const };
          const ranking: EvaluationSpan[] = [];
          for (const item of result.items) {
            const source = context.files.get(item.sourcePath);
            const meta = source && metadata.get(source.id);
            if (!source || !meta || item.versionHash !== meta.sourceHash ||
                !("locator" in item) || !("redaction" in item) || !item.locator ||
                item.locator.kind !== "file" || item.redaction !== "not-needed") {
              // A redacted envelope does not prove retrieval of every original byte.
              return { status: "failed" as const };
            }
            ranking.push({ source: source.id, version: source.version, sourceHash: meta.sourceHash,
              startByte: item.locator.startByte, endByte: item.locator.endByte });
          }
          return { status: "ok" as const, ranking };
        }, request.signal);
      } finally { active = false; release(); }
    },
  };
  return { adapter, close, preparation: {
    runtime: "production-lexical", corpus: "synthetic-active-files", projectCount: contexts.size,
    timing: "successful-search-only percentiles; build excluded; three sequential repetitions without warmup",
    limits: { timeoutMs: 1000, maxResults: 10, maxTokens: 2000, mode: "lexical" },
    limitations: ["No session archive ingestion", "No lifecycle or visibility proofs",
      "Scanner-modified envelopes fail closed rather than receiving full-span recall credit"],
  } };
}
