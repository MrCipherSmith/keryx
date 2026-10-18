# Conditional mandatory reads for documents cited by project rules

Flow: 462 (`.metaproject/flows/462-2026-10-18-conditional-reads/`). Status: DRAFT for the operator; criteria are not frozen.
Criteria (single source): `.metaproject/flows/462-2026-10-18-conditional-reads/acceptance-criteria.md`.
Builds on flow 461 (PR #1047, project rules first). This branch must be rebased on `main` once #1047 is merged; nothing here compiles without the 461 resolver.

## 1. Problem

Flow 461 made project rules `must_read` for code and test workers, and a validator compares what the worker cites with what the resolver required. Documents that a rule only points at are different. A Vantage rule such as `styling.mdc` says "see `STYLING.md`" (about 100 KB) and `THEMING.md` (about 68 KB). The resolver lists such a file as `kind: contract`, `tier: on_demand`, with no condition: it is always optional, the validator never asks for it, and the rule carries no statement of when the document matters. A worker that touches `className` or a theme token can finish with a green validator without having read the document that governs exactly that.

The operator's wording (voice 212151): when a task intersects styling or theming the agent must read the project rule, and the same holds for the other rules; so the files imported into project rules need not just links and hashes but a proper description, so the agent understands when it must read the main document and that it must go to the link and actually read it.

## 2. Decisions already taken by the operator (poll 211, 2026-10-18)

| Question | Answer |
|---|---|
| When | a separate flow after green CI of #1047 (this flow) |
| Condition shape | path masks of the task's files plus keywords of the task text, an anchor and a description per reference |
| Effect of a match | the reference is promoted from `on_demand` to `must_read` |
| Proof of reading | path, hash, anchor and a short summary |

## 3. Goals

1. A project declares, per cited document: where it applies (file globs and task keywords), which section matters (anchor), and a description of what the document governs.
2. The resolver reads the declarations and the task, and promotes the matching documents to `must_read`; unmatched ones stay `on_demand` but now carry their description, so the worker can decide.
3. The worker's result proves the read: path and sha256 as today, plus the anchor and a summary of the section.
4. A validator checks the proof deterministically. A summary that has nothing to do with the section fails. It warns first and blocks under the existing `enforcement: block` setting.
5. A project can see what is missing: undeclared citations, dead anchors, thin descriptions.
6. All of it is visible in the TUI (sidebar, modal tab, command).

## 4. Non-goals

- Proving that a model actually read the text. The check is a deterministic proxy: the hash pins the version, the anchor pins the place, the summary must use the section's own vocabulary. It raises the cost of skipping the read; it cannot make it impossible. The docs say so.
- Inferring conditions with a model. Declarations are authored (a human or an agent edits a file); `suggest` only prints a skeleton.
- Reading whole 100 KB files up front. The anchor limits the obligation to one section.
- Changing how rules themselves are selected (glob, `alwaysApply`) or the cap default.
- Releasing (batched).

## 5. Design

### 5.1 Declarations

A project file `.metaproject/rules/project/references.json` (schema committed under `docs/requirements/keryx-conditional-reads/schemas/`):

```json
{
  "schema": 1,
  "references": [
    {
      "path": "STYLING.md",
      "when": { "globs": ["src/**/*.css", "src/**/*.tsx"], "keywords": ["className", "tailwind", "style", "spacing"] },
      "anchor": "Class conventions",
      "description": "Class naming and the Tailwind 4 cascade contract. Read before adding or changing className, CSS or inline style."
    }
  ]
}
```

Why a sidecar and not front matter: rules are imported byte for byte from the upstream (`keryx skills import --rules`), so edits inside them are overwritten by `skills update`, and the front-matter reader is a flat YAML subset with no nested objects. The sidecar survives updates and is the project's own statement.

`when.globs` use the same glob engine as rules. `when.keywords` are matched case-insensitively against the task text. A declaration with neither is invalid. A match on either is a match (a task can touch styling without touching a `.css` file, and the reverse).

### 5.2 Resolution

`resolve-context` takes the task text (`--task-text`, passed by the orchestrators from the task title and description; also a field of the shell/MCP operation). For each declared reference whose file exists and is cited or declared:

- matched: `tier: must_read`, `reason: condition:glob|keyword (<rule or declaration>)`, plus `anchor`, `description`, `section_bytes`, `sha256` of the whole file;
- not matched: `tier: on_demand`, with `description`, `anchor` and the condition, so the worker sees why it was not required.

With an anchor, the obligation is the section from that heading to the next heading of the same or higher level, and the budget counts `section_bytes`, not the file. A matched reference is never demoted by the cap (an obligation that disappears when the budget is tight is the original bug); the existing over-cap warning fires instead. Citations without a declaration behave exactly as in flow 461.

### 5.3 Proof

`project_context_applied` items gain optional `anchor` and `summary`. They are required for entries promoted by a condition. `how` keeps its enum (`read|followed|n/a`) so every existing result stays valid. The validator, in addition to the path and hash check of flow 461, requires: the anchor equals the declared one; the summary has at least 40 characters; it contains at least three distinct words of five or more letters that occur in the anchored section. A miss is reported with the reason; `enforcement: block` makes it exit 1, and `flow task done` refuses it as for other misses.

### 5.4 Authoring help

- `keryx skills references check`: two declarations of one normalised path (error, naming both), undeclared citations (warning), declared file missing or outside the root or over the size limit (error), anchor not found (error), description under 20 characters (warning), declaration that no rule cites and that has no globs/keywords match possible (warning).
- `keryx skills references suggest`: prints a JSON skeleton for every undeclared citation: path, size, the headings found as anchor candidates, empty `description`. Writes nothing.
- `keryx skills import --rules` ends with the count of undeclared citations and the command to run.

### 5.5 TUI

Sidebar `ProjectCtx` gains `refs <promoted>/<declared>` after a resolve. The `/projectctx` modal gets a References tab: each declaration with its condition, anchor, whether the last resolve promoted it and why, and the problems `check` found. `/projectctx refs` opens it. The tab refreshes when a new resolve is recorded. The state matrix goes to `TUI-states.md` of this folder.

## 6. Risks

| Risk | Handling |
|---|---|
| Keywords too broad promote everything and fill the cap | the obligation is one anchored section, not the file; the over-cap warning and the Last resolve tab show the cost; keywords are the project's own and `check` flags a keyword shorter than 4 characters |
| Keywords too narrow miss a real case | glob is an independent trigger; the unmatched reference stays listed with its description |
| Summary check false positive (non-English section, very short section) | words are compared case-insensitively on letters of any script; a section with fewer than three qualifying words requires only as many shared words as it holds (none: only the length rule); warn mode first |
| A worker fabricates a plausible summary | possible; the check raises the cost and the journal keeps the summary for review. Stated in the docs, not hidden |
| Declarations drift from the documents | `check` reports dead anchors; the hash pin catches edits between resolve and validate (AC13) |

## 7. Out of this flow

A live run on vantage-frontend is an operator run with a runbook (AC18), like AC22 of flow 461. Rollout to the other projects stays with the operator.
