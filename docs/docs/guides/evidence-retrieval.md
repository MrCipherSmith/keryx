# Search past evidence: evidence retrieval

Evidence retrieval lets you, and optionally the agent, search an index built from
files you name and, if you opt in, this project's session archives. Hits are
**untrusted historical data**: they are not accepted memory, wiki or Shared Agent
Context knowledge, and the agent is told not to treat them as instructions.

It is off by default. Nothing is scanned or indexed until you enable it.

## Status and limits

- Lexical (keyword) retrieval works. Hybrid (semantic) mode is **not available**:
  the schema accepts `mode: "hybrid"`, but no embedding owner is wired, so it is
  refused with `hybrid-owner-unavailable` instead of falling back silently.
- No benefit has been measured. The paired evaluation (A to E) is not done, and the
  independent review is a reduced static assessment. Whether to roll this out is an
  operator decision, pending.
- Exact exclusion of context the model already sees works only for adapters that
  expose the serialized request (OpenAI today). Other adapters report unknown.
- There is no TUI panel, modal or slash command yet. Use the CLI.

## Turn it on

Create `.metaproject/evidence.json`:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "roots": ["docs"],
  "sessionArchives": false
}
```

Then build and query it:

```bash
keryx evidence index
keryx evidence search "why did we pin the lockfile" --json
keryx evidence status
```

`roots` are project-relative directories. Files in the session store are never
indexed as ordinary files. Session archives are included only with
`"sessionArchives": true`. All keys and limits are listed in the
[CLI reference](../cli-reference.md#evidence).

## What is stored and for how long

Derived data lives in `.metaproject/evidence/` with owner-only permissions. Text
passes the security scanner before it is stored, and each hit says whether
redaction was applied. Derived data expires after 30 days; `keryx evidence
maintenance` removes expired data and superseded generations.

## Disable, clear, revoke

- **Disable:** set `"enabled": false` or delete the file. Search returns `disabled`.
- **Clear:** `keryx evidence clear` deletes derived artifacts only. It keeps your
  source files and the revocation ledger, and it needs `enabled: true`.
- **Revoke a session:** a trusted runtime API writes a durable tombstone and drains
  readers, so a revoked session is no longer delivered. There is no CLI command for
  it, it does not delete the archive, and there is no ACP `session/delete`.

## The agent

The interactive agent has a read-only `evidence_search` tool. It never builds an
index and returns `index-absent` if you have not run `keryx evidence index`.

Set `"automatic": true` (with `"enabled": true`) and each user turn runs one lexical
retrieval, drops hits already visible in the request, and adds the rest as an
untrusted historical-data block within the evidence budget. It does nothing in
sub-agent runs. An outcome line is written to stderr as `[evidence automatic]`.
