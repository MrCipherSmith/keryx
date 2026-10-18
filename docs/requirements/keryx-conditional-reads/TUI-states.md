# TUI states: conditional reads

Draft. Surfaces: sidebar `ProjectCtx` line, `/projectctx` modal References tab, command `/projectctx refs`.

| State | Sidebar | References tab |
|---|---|---|
| No references file | no `refs` segment | one line: no declarations, with the command `keryx skills references suggest` |
| Declared, no resolve yet | `refs -/<n>` | declarations with condition and anchor, status "not resolved" |
| Resolved, some promoted | `refs <p>/<n>` | each row: path, anchor, condition, promoted or on demand, and the reason (glob or keyword that matched) |
| Resolved, none promoted | `refs 0/<n>` | rows show on demand with their description |
| Promoted and over the cap | `refs <p>/<n>` plus the existing over-cap marker | row shows section bytes and the over-cap warning |
| Problems from check | `refs <p>/<n> !<k>` | problems listed under the rows: dead anchor, thin description, undeclared citation |
| Invalid references file | `refs ?` | the validation message naming the entry |
| New resolve recorded | counters update without reopening | tab refreshes in place |
