# Wiki draft review - 2026-09-16 (base 93805ac0)

Per-page verification of draft component pages against source (read-only checker
agents; parent applied). Statuses were NOT flipped en masse: every ACCEPT verdict
is ACCEPT-WITH-EDITS listed below; accepting before the edits land would publish
known-false claims. Enrich prose (structure, links) passed; these are the prose
corrections each page needs, plus the systematic root cause.

## Cross-cutting generator defect (root cause of most false claims)

Graph-derived "Depends on" module edges count TEST-ONLY imports (e.g.
*.test.ts -> src/contracts/validator). Enrich prose then narrates those edges as
production couplings. Observed in: evidence, context, flow, monitor, session,
eval, forgetting, retention, anthropic, ollama. Fix belongs in keryx wiki
collect (exclude test-file edges from module-level Depends-on); future batches
will keep repeating this until then.

## ACCEPT-with-edits (20)

harness/core (checker g1):
- src-harness-branch.md: delete invented "first-class concept" framing; real
  concepts: append-only branch_metadata marker + BranchMetadata, compaction
  marker + CompactionEntry. branch.ts has no non-test importer; session/store
  forkSession deliberately does NOT use forkBranch; mergeBranches is no-merge-v1
  (always rejected); deterministic via injected clock/idSeq.
- src-harness-budget.md: FALSE "uses values from src/harness/context"
  (reconcileBudget is pure over its input; context import is type-only).
  State fail-closed rules and ReconcileBudgetResult as discriminated union.
- src-harness-context.md: FALSE "especially src/harness/budget uses those
  limits" (consumers: src/harness/startup.ts); manifest.ts imports only
  node:crypto. available -> reliability exact + trustedAsPolicy + sha256;
  unavailable recorded with reliability unknown + skipReason; tokens=ceil/4;
  2 MiB / 200000 constants.
- src-harness-evidence.md: contracts edge test-only. redactForPersistence with
  injected deps.scan; flagged -> [redacted:category] preview; scanFailed blocks.
- src-harness-extension.md: FALSE flow: dispatchExtension does not evaluate
  grants (fails closed on registration.ok===false, bounds allowed_actions to
  grant); evaluateExtensionGrant is separate. bound-wave builds planning-time
  evidence (extension-dispatch-planned).
- src-harness-flow.md: FALSE "src/flow may reference this module" (parity.ts
  has NO non-test consumer; port never writes flow.json).
- src-harness-monitor.md: reduce-state.ts is a SEPARATE event-sourced fold
  (flow 095), not behavior of the snapshot types; contracts edge test-only.

session/job (checker g4):
- src-harness-session.md: contracts edge test-only; add injected clock/idSeq,
  deep-frozen entries, SHA-256 content-key append idempotency, migrateSession
  rejects schemaVersion>1.
- src-harness-web.md: FALSE Flow 3: search uses transport.request() which does
  NOT sanitize (allows http://localhost for local-search capability); only
  fetchPage() sanitizes. ANOMALY: frontmatter 0.2.0/draft while its 0.2.0
  changelog claims "promoted to accepted" - human check.
- src-session.md: store core is paths/store/compact; slate*.ts is a separate
  layer; transcript is context.jsonl+archive.jsonl (transcript.jsonl legacy);
  compaction deterministic, no LLM.
- src-job.md: flows -> createJobService(deps){init,status,step,document,
  complete,list}, defaultPlan(intent), jobs/<name>/state.json vs
  state.schema.json; CLI is the only writer.
- src-contracts.md: FALSE (twice): validation does NOT consult
  detectPii/detectSecrets (export-audit.ts only); validator imports ./resolver.
- src-eval.md: FALSE "Health integration" (health/testing imports are
  test-only); EvalCase comes from src/security/eval, not this module.

providers/search/codec (checkers wf3/wf4):
- src-harness-external-codec.md: sole outward import ../types; sole production
  consumer runtime.ts getExternalCodec; externalCodecIds/EXTERNAL_CODECS
  export-only; unknown id -> undefined, never a default.
- src-harness-provider-compat.md: anthropic edge = generic AnthropicSSEParser
  reuse only; real gates isLoopbackHost/isPrivateEgressHost/isPrivateLanHost +
  redactSensitiveText; OpenAiCompatIdentity is the whole per-gateway surface.
- src-harness-provider-gemini.md: mutation edge = isPrivateEgressHost SSRF
  guard only; delete grant/mutation bullet; thin generateContent adapter,
  systemInstruction top-level, tool result role user.
- src-harness-provider-ollama.md: mutation AND contracts edges TEST-ONLY; the
  4 non-class symbols are type aliases of compat types; wrapper pins
  localhost:11434 / llama3.1:latest.
- src-harness-provider-openai.md: native Responses API adapter (POST
  /v1/responses, instructions + flat input[]), not chat-completions;
  context_length_exceeded -> context_overflow; vision false.
- src-harness-search.md: connectedProviderIds is a FUNCTION over connection
  states; registry lookup-only (fixed descriptors); controller owns persistence
  via src/lib/search-config; search() runs only the selected provider.
- src-retention.md: RetentionUnit = file|directory (sweep granularity);
  RetentionEntryStat = {bytes,mtimeMs} only; production importers ONLY
  commands/retention.ts + commands/ctx.ts; auto-sweep once/day atomic wx claim.

## HELD-DRAFT (4) - rewrite named sections before accepting
- src-harness-external.md: 4 false role/flow claims (dispatch.ts is a pure
  validator/narrower; registry lookup-only over frozen table; supervise.ts
  imports no monitor; supervise-mcp imports no codec); Flow 1 = runExternalChild
  fail-closed order.
- src-harness-provider-anthropic.md: grant is constrain-only (no grant ->
  terminal auth error, fetch never invoked); SSE parser is a semantics-free
  framer shared by openai/gemini/compat (event mapping lives in provider
  switch); contracts edge test-only.
- src-forgetting.md: identity.ts is the layer reconcile WRITES
  (syncSectionRegistry/tombstones), not an attribution model;
  RemovedIdentity/RemovalAttribution live in propagation.ts; type is
  DeletionTrail; propagation reads every layer, writes none (report, not
  cascade); retention edge is a test-only pin.
- src-wiki-freshness.md: runFreshness delegates per-page evaluation to
  report.ts buildFreshnessReport; propagate.ts and queue.ts missing from page;
  FreshnessBasis = git-log|scope-hash|undecidable; renderMarkdown in run.ts;
  src/sync usage is only gitCmdResult.

## Unverified (19) - not yet checked against source
src-harness-{mutation,parallel,policy,process,process-sandbox,replay,resume,run},
src-mcp-client, src-mcp-servers, src-lib-oauth, scripts, scripts-stress,
src-tui-games, src-tui-games-tic-tac-toe, vscode-extension-src,
fixtures-import-policy-allowed-client-imports-core-facade-gdgraph,
fixtures-import-policy-tree-shaken-through-barrel-harness, fixtures-mcp-servers.
