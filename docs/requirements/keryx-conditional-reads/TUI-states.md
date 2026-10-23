# TUI states: conditional reads

Authoritative for AC16: every row is implemented and has a render test in
`src/tui/project-context-inspector.test.ts` (test names start with the row ID).
Surfaces: sidebar `ProjectCtx` line, `/projectctx` modal References tab, command
`/projectctx refs`.

The References tab is always present, so `/projectctx refs` works in every state.
The Status and Last resolve tabs, and the sidebar line, are unchanged when the
project has no references file.

| ID | State | Sidebar | References tab |
|---|---|---|---|
| R0 | No references file | no `refs` segment | one line: no declarations, with the command `keryx skills references suggest` |
| R1 | Declared, no resolve yet | `refs -/<n>` | `References: <n> declared, no resolve yet`; each row: path, anchor, condition, status "not resolved" |
| R2 | Resolved, some promoted | `refs <p>/<n>` | `References: <p> promoted of <n> declared`; each row: path, anchor, condition, `promoted` with the reason (`matched glob <g>` or `matched keyword <k>`) and the bytes (section bytes with an anchor, file bytes without), or `on demand` with the description. A declaration the last resolve did not list reads `not in the last resolve (see its warnings)` |
| R3 | Resolved, none promoted | `refs 0/<n>` | rows show `on demand` with their description |
| R4 | Promoted and over the cap | `refs <p>/<n>` plus the existing over-cap marker (`cap exceeded`) | promoted rows show their bytes and `over the cap: <used> of <limit> bytes` |
| R5 | Problems from check | `refs <p>/<n> !<k>` (`refs -/<n> !<k>` before a resolve) | after the rows, `problems (<k>):` and one line per finding of `keryx skills references check`: `[error\|warning] <code> <path>: <message>` (dead anchor, thin description, undeclared citation, and the other check codes) |
| R6 | Invalid references file | `refs ?` | `References file is invalid:` and the validation messages, each naming the entry |
| R7 | New resolve recorded | counters update without reopening anything (the status is re-read every 5 seconds and when the modal opens) | an open tab repaints in place when the status changes; an unchanged status repaints nothing |

Notes:

- `<n>` is the number of declarations in the file; `<p>` counts the declared
  references the last recorded resolve listed as `must_read`. A cited contract
  (an entry without a condition) is not a reference and is not counted.
- Before any resolve, and when `last.json` is unreadable, `<p>` is `-`.
- With a references file but no project rules and no recorded resolve, the sidebar
  line is still shown (`warn · 0 rules · refs -/<n>`).
- Problems are counted as `<k>` whatever their severity; the tab shows which are
  errors and which are warnings.
