# Where the wiki and graph work should go next

**Status.** Research note. No implementation, no decision taken.
**Date.** 2026-09-05, against `main` at `f21fcd1b`.
**Question asked.** What the current external trends are, and what they imply for
keryx's wiki and graph.

## What the field is doing

Four themes recur across recent work, and keryx already sits inside three of
them.

### 1. The repository as a queryable graph, not a search target

The consistent framing is that an agent should narrow an investigation
structurally — symbols, imports, call chains, likely blast radius — *before*
opening files, rather than grepping its way to an answer. Systems named in the
current literature: RepoGraph, CodexGraph, RepoHyper, RPG (Repository Planning
Graph), GraphCodeAgent.

**keryx has this.** `gdgraph` with `affected`, cycles, orphans, symbol search
and a PageRank repo map is the same shape. The routing rule that sends agents to
the graph before raw search is the same argument.

### 2. Freshness as a first-class signal, not a maintenance chore

This is the sharpest convergence, and it is recent. The reported failure mode in
production RAG is not retrieval quality but **staleness**: one survey of
enterprise deployments attributes 60% of post-pilot failures to inability to
maintain freshness at scale. Vector search has no mechanism to prefer a newer
document unless freshness is injected explicitly, and standard evaluation suites
have no temporal component at all — so a system can score 95% on faithfulness
and relevance while serving information superseded weeks ago.

One commentary argues specifically that agents should attach a local code
knowledge graph **with freshness signals** rather than run more greps, and lists
"flag when the index is stale, incomplete, or conflicts with the files" as a
required capability.

**keryx shipped exactly this in 0.2.77–0.2.78** — `describes` edges, `VerifiedAt`
provenance, six change classes, confidence-decaying propagation, a read-only
backlog, and a health metric that cannot move the gate. The guide's own warning
("`VerifiedAt` does not mean the page is correct") is more careful than most of
what the field publishes.

Two of today's fixes are the same theme one level down: sync reporting "up to
date" when it could not resolve the recorded revision, and a graph whose
provenance named a squash-deleted commit.

### 3. Documentation that repairs itself, with a human gate

The agentic reading of "living documentation" is: subscribe to merge events,
compare the diff against existing prose, and draft corrections. GitHub's Copilot
Docs roadmap includes documentation agents that proactively open PRs for
outdated docs. The stated reason matters: agents cannot compensate for stale
docs the way humans can — they operate confidently on whatever the doc says, so
stale documentation in an agentic system produces *confidently wrong output
instead of obvious failure*.

**keryx has the deterministic half** (`wiki refresh` regenerates Reference blocks
with no model) and deliberately stopped before the prose half — measured, not
preferred: over a 189-file range the drift was 100% `stale-reference` and 0%
`stale-prose`, so the token-spending phase had nothing to work on. That number
was checked twice.

The external trend is the merge-triggered draft-a-PR pattern. keryx's `verify`
gate — refusing to stamp provenance without a human — is the guardrail most of
these tools do not describe having.

### 4. The gap: nobody here is measuring whether it helps

This is the theme keryx is **outside** of, and it is the one I would act on.

2026 produced benchmarks aimed precisely at this layer, between SWE-bench and
end-to-end agent evaluation:

- **Agent Retrieval Bench** — isolates retrieval so a failed patch can be
  attributed to retrieval rather than reasoning or editing. Leakage-controlled,
  with construction-separated no-gold controls, over PR-to-test,
  review-comment-to-context, trace-to-root-cause and anchored-edit-to-ripple
  queries.
- **SWE-ContextBench** — 1,100 base tasks, 376 related, 51 repositories, 9
  languages.
- **CORE-Bench**, **SWE-Explore** — code retrieval and repository-exploration
  behaviour.

Metrics in use: File F1, gold contact, tool calls, context tokens.

keryx measures a great deal — review precision, detector false-negative rates,
wiki drift, routing baselines — and does not measure **the claim the whole
product rests on**: that project-local context makes an agent better at a task.
`gdgraph affected` is asserted to beat grepping. Nothing here has ever tested it.

## What follows, in order of how much it would teach us

**A. Measure the core claim.** Take one of the leakage-controlled benchmarks —
Agent Retrieval Bench is the closest fit, since it isolates retrieval — and run
an agent over the same tasks twice: once with keryx's graph and wiki available,
once without. Report File F1, tool calls and context tokens for both.

This is the highest-value item and also the riskiest, because the answer might
be "no measurable difference". That is precisely why it is worth doing, and this
repository has spent three days demonstrating that an unverified claim is worth
less than a measured disappointment. A negative result would redirect the next
year of work.

**B. Freshness for the graph, matching what the wiki now has.** The wiki knows
when its pages were last verified against which revision. The graph knows only
when it was built — and today that pointed at a commit which no longer exists.
The wiki's provenance model applied to graph artifacts would give
`gdgraph affected` the same "how far behind, and against what" answer that
`wiki freshness` already gives.

**C. Incremental graph rebuild.** Already recorded as deliberately not built,
correctly: 2.3s full builds do not hurt yet. Worth revisiting only when they do.

**D. The prose half of enrichment.** Also deliberately deferred, on a measured
zero. The trigger to revisit is data — `stale-prose` becoming non-zero — not the
fact that other tools ship it.

## What I would not copy

- **Nightly re-indexing.** Called a design failure in the current writing, and
  keryx's event-driven accumulation is already better than it.
- **Auto-accepted prose rewrites.** The `verify` human gate is a genuine
  advantage; the tools racing to auto-open documentation PRs are trading it away.
- **Universal speed claims from small pilots.** One of the sources warns against
  exactly this, and it is the failure mode B is designed to avoid.

## Sources

- [Agent Retrieval Bench: Evaluating Repository Context Retrieval for Coding Agents](https://arxiv.org/html/2607.24882)
- [SWE Context Bench: A Benchmark for Context Learning in Coding](https://arxiv.org/abs/2602.08316)
- [CORE-Bench: A Comprehensive Benchmark for Code Retrieval in the Era of Agentic Coding](https://arxiv.org/html/2606.11864)
- [SWE-Explore: Benchmarking How Coding Agents Explore Repositories](https://huggingface.co/papers/2606.07297)
- [CodexGraph: Bridging Large Language Models and Code Repositories via Code Graph Databases](https://arxiv.org/pdf/2408.03910)
- [Knowledge Graph Based Repository-Level Code Generation](https://arxiv.org/pdf/2505.14394)
- [Why AI coding agents should attach local code knowledge graphs and freshness signals first](https://aq-score.com/blog/codegraph-local-code-knowledge-graph-agent-ops-guide-2026)
- [RAG Knowledge Base Freshness: The Staleness Problem Teams Solve Last](https://tianpan.co/blog/2026-04-20-rag-knowledge-base-freshness-index-rot)
- [RAG Architecture in 2026: How to Keep Retrieval Actually Fresh](https://medium.com/real-time-data-evolution/rag-architecture-in-2026-how-to-keep-retrieval-actually-fresh-3a9bae9ec8f9)
- [Self-Updating Documentation: Docs Agents Keep in Sync](https://www.augmentcode.com/guides/self-updating-documentation-docs-agents-sync)
- [Continuous Context: Why AI Docs Decay](https://datahub.com/blog/continuous-context/)
- [Source Context Management: Turn Repos Into Query Engines](https://www.harness.io/blog/your-repo-is-a-knowledge-graph-you-just-dont-query-it-yet)

Read on 2026-09-05. Claims attributed to sources are theirs; the comparisons to
keryx are mine, and rest on this repository's own code and measurements.
