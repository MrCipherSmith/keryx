# What would make the workspace pay — proposals from the test-v1 data

Written 2026-09-12 by the session that ran the sweep, from the data in
[`data/`](data/). Not an independent review: a reviewer was dispatched for this and
produced nothing before it was stopped, so read this as the operator's own analysis
and check it against the transcripts where it matters.

Every claim below names the measurement it rests on. Where the evidence is too thin
to carry a conclusion, it says so — 13 tasks at ~0.35 recall supports very little.

## Summary

The workspace did not decide these tasks. It changed *how* the agents worked far more
than *how well*: with `.metaproject/` present, claude stopped delegating to sub-agents
entirely (0 against 16), and keryx spent 89% of its calls on plain search, read and
list regardless. The three affordances the workspace exists for — graph, wiki,
memory — accounted for 9% of keryx's calls and about 5% of claude's metaproject
output.

The clearest signal in the data is not about the workspace at all: **both legs are
blind to whole classes of file.** Config and fixtures were never found, components
almost never.

## 1. Where the agents lost

Gold files, pooled over both legs and both arms, by kind:

| kind | missed | found | hit rate |
|---|---|---|---|
| config (`*.json`, `*.mjs`, `*.config.ts`, dotfiles) | 8 | 0 | **0%** |
| fixture / mock (`*.msw.*`, `__mocks__`, `fixtures/`) | 8 | 0 | **0%** |
| component (`*.tsx`) | 17 | 1 | **6%** |
| source (`*.ts`) | 34 | 17 | 33% |
| e2e (`e2e/…`) | 4 | 18 | **82%** |

This is a retrieval failure with a shape, not uniform weakness:

- **e2e files are found because the task text names them.** Several T1 tasks are
  themselves e2e work ("deflake profile-search", "migrate synergy flows"), so the
  query words appear in the path. Search by name works when the name is in the query.
- **Fixtures and config are never found because nothing in the task text names
  them.** `dc-service.msw.ts` changes because the service it mocks changed;
  `eslint.config.mjs` changes because a lint rule moved. Both are reachable only by
  asking "what else changes when this file changes" — the one question a plain
  grep cannot answer and a dependency graph can.
- **Components at 6% is the same failure one step out:** the store changes, the
  `.tsx` that renders it changes, and no query word connects them.

The agents answered with what they could grep for and stopped.

## 2. What the workspace was actually used for

keryx context arms, 1098 tool calls across 13 arms:

| tool | calls | share |
|---|---|---|
| `search_code` | 592 | 54% |
| `read_file` | 257 | 23% |
| `list_dir` | 131 | 12% |
| `graph_find` | 43 | 4% |
| `wiki_ask` | 17 | 2% |
| `memory_search` | 14 | 1% |
| `graph_symbol` | 13 | 1% |
| `graph_affected` | 7 | 0.6% |
| `test_related` | 4 | 0.4% |
| everything else (skills, flow, health, slate) | ~20 | ~2% |

claude's context arms tell the same story from the other side: 123 metaproject calls
returning 265k characters, of which **236k came from `keryx ctx`** — the grep
equivalent — 14k from reading the index, 1k from memory, and effectively nothing from
the wiki or flow.

So: 89% of keryx's calls, and 89% of claude's metaproject bytes, went to capabilities
that exist without a workspace at all. `graph_affected` — the one tool whose answer is
"what else changes when this changes", i.e. the exact question behind every missed
fixture and component — was called **seven times in thirteen arms**.

Two tasks show what it looks like when the workspace is used well: `t1-5dde4b04`
finished in 27 s with context against 279 s without, and `t1-feca1074` used 270k
tokens against 543k. Both are single-site changes where one graph or search answer
landed on the file. Where the change is broad, the workspace cost more and returned
the same score.

## 3. Proposals

### (a) keryx-shell — the agent

**A1. Make `graph_affected` the reflex for "what else changes", not an afterthought.**
*Problem:* 7 calls in 13 arms, while 33 gold files were missed in exactly the classes
it answers for. *Change:* when the agent has named a candidate file and the task asks
which files change, the system prompt should require one `graph_affected` call on
that file before answering; the tool's own description should say what it is for in
those words, rather than describing a graph. *Effect:* fixtures and components enter
the candidate set by dependency rather than by name. *Measured by:* hit rate for
fixture/mock and `.tsx` kinds, and `graph_affected` calls per arm.

**A2. Answer with a ranked set, never a refusal.** *Problem:* in the earlier batch,
arms that could not find the commit answered "I can't reliably identify the files"
and scored zero; a refusal and a wrong answer are the same score but not the same
failure. *Change:* instruct the agent to always return its best-ranked candidates
with a stated confidence. *Effect:* converts refusals into scorable output. *Measured
by:* count of empty answers per leg (the arena should record it — see the arena notes).

**A3. Stop paying for roster discovery.** *Problem:* a claude arm spent 9k characters
on `keryx --help` twice; `skills_catalog` and `flow_status` were called in arms whose
task was to name files. *Change:* the agent's opening context should state the three
commands that matter for a code question; capability listings should not be reachable
by accident. *Effect:* fewer tokens before the first real search. *Measured by:*
tokens before the first `search_code`/`graph_*` call.

**A4. `search_code` output density.** *Problem:* it is 54% of all calls, so its shape
is most of what the model reads. *Change:* group hits by file with counts and a capped
number of lines per file, so a 40-hit query costs a page rather than a scroll.
*Effect:* more searches per token. *Measured by:* tokens per `search_code` call, and
recall at equal token budget.

### (b) The metaproject — content and routing

**B1. Route the index by question, not by capability.** *Problem:* the index offers
"search code", "architecture", "past decisions" — categories — and the agents
answered every question with search. *Change:* lead with the two questions these tasks
actually ask: "which files implement X" → `keryx ctx rg`; "what else changes if I
change X" → `keryx gdgraph affected <file>`; "which tests cover X" →
`keryx test related <file>`. *Effect:* the affordance that fixes the systematic miss
is one line away from the question that needs it. *Measured by:* share of arms calling
`graph_affected`/`test_related` at least once.

**B2. Charge the wiki its keep, or drop it for this work.** *Problem:* 503 provisioned
pages drew 17 `wiki_ask` calls and ~0 bytes into claude's arms. *Change:* either make
a wiki answer reachable from a symptom in one call and show it returning code paths,
or stop provisioning the wiki for retrieval tasks. *Effect:* either the wiki earns its
weight or the arm stops carrying it. *Measured by:* wiki calls per arm and whether
tasks with a wiki hit score above the leg's mean.

**B3. Do not advertise an empty store.** *Problem:* `memory_search` was called 14
times in a project with no memory entries, and until 0.2.98 each miss returned ~700
characters naming an absolute path (K-016). *Change:* when the store is empty, leave
the tool out of the roster instead of answering at length that there is nothing.
*Effect:* removes a class of call that cannot help. *Measured by:* `memory_search`
calls in a project with an empty store — should be zero.

### (c) Cross-cutting

**C1. Record per-affordance payoff in the run itself.** Every number in §2 came from a
one-off script over transcripts. The arena should emit calls-per-tool and
bytes-per-tool per arm beside the scores, so "which affordance paid" is a column
rather than an investigation.

**C2. The next question needs T2.** T1 measures retrieval, and the workspace's claim
is about understanding a codebase well enough to change it. Until an implement task
with hidden tests runs, nothing here can confirm or refute that claim.

## 4. What the data does not support

- **"The metaproject is useless."** It is not shown to help on T1 retrieval, which is
  not the same statement. Two tasks got 10× faster with it, and the strategy shift
  (no sub-agents) suggests it changes how a strong agent organises work.
- **"The metaproject costs 4×."** That figure was an artefact of a metric that cannot
  see sub-agent usage (K-018). Corrected: 1.26× tokens, 1.11× dollars.
- **"keryx-shell is as good as claude."** The legs ran on different models; this sweep
  compares arms within a leg, never legs with each other.
- **Tuning the index against these 13 tasks.** Any change that helps here must be
  stated as a rule about question types, or the next sweep measures memorisation.
- **Anything about `.tsx` components specifically.** 18 gold components across 13
  tasks is a handful of changes; the 6% is a flag to investigate, not a finding.
