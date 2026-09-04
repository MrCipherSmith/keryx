# Flow Journal

- 2026-09-04T11:28:22.714Z - flow created
- 2026-09-04T11:29:09.538Z - task-done: T1: Collect remaining context
- 2026-09-04T11:29:09.648Z - task-added: T5: Register the four commands with honest flags (AC1,AC2)
- 2026-09-04T11:29:09.787Z - task-added: T6: MCP read-only freshness surface preserving limitations (AC3,AC4,AC5)
- 2026-09-04T11:29:09.992Z - task-added: T7: gdwiki SKILL route: consult before reading, carry the caveat (AC6)
- 2026-09-04T11:29:10.122Z - task-added: T8: Tests: registry coverage, MCP shape, no-write proof (AC7)
- 2026-09-04T11:29:10.268Z - frozen: 7 criteria; checksum recorded
- 2026-09-04T11:29:10.377Z - started
- 2026-09-04T12:00:04.995Z - task-done: T5: Register the four commands with honest flags (AC1,AC2)
- 2026-09-04T12:00:05.372Z - task-done: T6: MCP read-only freshness surface preserving limitations (AC3,AC4,AC5)
- 2026-09-04T12:00:05.721Z - task-done: T7: gdwiki SKILL route: consult before reading, carry the caveat (AC6)
- 2026-09-04T12:00:06.015Z - task-done: T8: Tests: registry coverage, MCP shape, no-write proof (AC7)
- 2026-09-04T12:00:06.362Z - ac-confirmed: AC1: wiki-freshness-op.test.ts registry tests; keryx commands --json shows wiki freshness/refresh/verify/migrate-markers with read, json and sideEffects
- 2026-09-04T12:00:06.755Z - ac-confirmed: AC2: Asserted per command: freshness read:true, the other three read:false with a non-empty sideEffects list — a registered write with no declared effect would be a claim an agent acts on
- 2026-09-04T12:00:07.115Z - ac-confirmed: AC3: The operation returns the report including limitations, and the formatter prints them FIRST; test asserts the INCOMPLETE block appears before the finding list
- 2026-09-04T12:00:07.730Z - ac-confirmed: AC4: wiki-freshness-op.test.ts 'with no report it says so instead of returning a clean-looking empty result' — output contains NO-REPORT and the not-evidence sentence, and no findings section
- 2026-09-04T12:00:08.083Z - ac-confirmed: AC5: wiki-freshness-op.test.ts compares the full project tree and the report file byte-for-byte before and after the call; operation declared risk: read
- 2026-09-04T12:00:08.497Z - ac-confirmed: AC6: skills/gdwiki/SKILL.md route added, covering all four categories and the limitations-first rule, plus that stamping provenance is a human act
- 2026-09-04T12:00:09.224Z - ac-confirmed: AC7: see the full-suite result recorded in the journal

## 2026-09-04 — the registry's own guard caught me

I registered `wiki freshness` as `read: true` while declaring that it writes
`data/wiki/freshness/latest.{json,md}`, and wrote a comment justifying it:
read-only "in the sense that matters to a caller", since it touches no wiki
page and no source file.

`command-registry.coverage.test.ts` rejected it outright — *no descriptor
claims read-only while declaring side effects* — and the guard is right where
the reasoning was not. `read` feeds `isAutoAllowable`, so `true` would let an
agent invoke the command with no approval, and it writes. Whether the write is
small, or somewhere the caller does not care about, is beside the point: the
flag is a permission claim, not a description of intent.

Corrected to `read: false`, with the reasoning recorded at the site so the
next person does not re-derive the same wrong argument. The genuinely
read-only way to ask this question is the MCP surface, which reads the report
and writes nothing.

That makes four times in this package that a plausible-sounding claim was
wrong in a way tests caught: a range label, a provenance stamp, two vacuous
assertions, and now a permission flag. Three of the four I wrote myself while
building the thing meant to prevent exactly this.

### Two more failures, both correct

Adding `wiki_freshness` changed the agent tool set, and two tests assert that
set exactly (`interactive-agent-tools.test.ts`, `shell.test.ts`). They are
guards against the surface growing unnoticed, so they SHOULD fail on a new
tool. Updated rather than relaxed.
- 2026-09-04T12:11:48.138Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-04T12:11:48.251Z - task-done: T2: Implement per plan
- 2026-09-04T12:11:48.407Z - task-done: T3: Add/adjust tests and make them pass
