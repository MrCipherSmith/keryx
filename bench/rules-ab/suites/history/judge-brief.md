# Matching brief

Two lists describe defects in the same code change:

- `truth` — defects that were confirmed and later fixed. Items `T1…`.
- `candidate` — findings from one reviewer. Items `G1…`.

For every `T` item decide whether the candidate list contains the same defect.

- `match`: some `G` item identifies the same underlying defect — same cause, in the same
  code or text — so that fixing what `G` describes would fix what `T` describes. Different
  wording, a different line in the same function, or a different severity still match.
- `partial`: a `G` item points at the same code and a closely related problem, but a
  maintainer acting only on `G` would not necessarily fix `T` (it names a symptom, a
  narrower case, or a neighbouring defect).
- `miss`: no `G` item covers it. Same file or same topic alone is a miss.

Judge only from the two lists and, where the lists leave it unclear, from the code snapshot
at the path in your task (read with the Read tool; search with `keryx ctx rg <pattern> <path>`
run inside the snapshot; do not look at any other commit or at `.metaproject/reviews`,
`.metaproject/flows`). Do not judge whether a finding is correct — only whether it is the
same defect. When torn between two verdicts, pick the lower one.

Write one JSON file (path in your task):

```json
[{ "tid": "T1", "verdict": "match | partial | miss", "gid": "G4 or null", "why": "one sentence" }]
```

One entry per `T` item, in order. Done when the file parses and has exactly one entry per
`T`. Reply with one line: counts of match / partial / miss.
