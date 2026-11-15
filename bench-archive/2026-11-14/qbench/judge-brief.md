# Matching and noise brief

Three lists describe one code change:

- `truth` — defects known to be in the change. Items `T1…`.
- `decoys` — things in the change that look like defects but are justified. Items `D1…`, each with the reason it is not a defect.
- `candidate` — findings from one reviewer. Items `G1…`.

## Part 1 — truth

For every `T` item decide whether the candidate list contains the same defect.

- `match`: some `G` item identifies the same underlying defect — same cause, in the same code — so that fixing what `G` describes would fix what `T` describes. Different wording, a different line in the same function, or a different severity still match. A `T` listing several sites is matched by a `G` that names the class and at least two of the sites.
- `partial`: a `G` item points at the same code and a closely related problem, but a maintainer acting only on `G` would not necessarily fix `T`.
- `miss`: no `G` item covers it. Same file or same topic alone is a miss.

## Part 2 — every candidate

For every `G` item give one label:

- `truth`: it is the `match` or `partial` for some `T`.
- `decoy`: it reports a `D` item as a defect.
- `valid`: not in either list, but a real, specific code-quality problem the change introduces, that a maintainer would reasonably fix. Check the code before you say so.
- `noise`: anything else — not a real problem, not introduced by the change, under a threshold the reviewer's own lens or the project rules allow, pure taste, or a duplicate of another `G`.

Judge from the lists and, where they leave it unclear, from the code snapshot at the path in your task (read with the Read tool; search with `keryx ctx rg <pattern> <path>` run inside the snapshot; do not look at any other commit or at `.metaproject/reviews`, `.metaproject/flows`). When torn between two verdicts, pick the lower one (`partial` over `match`, `noise` over `valid`).

Write one JSON file (path in your task):

```json
{
  "truth": [{ "tid": "T1", "verdict": "match | partial | miss", "gid": "G4 or null", "why": "one sentence" }],
  "candidates": [{ "gid": "G1", "label": "truth | decoy | valid | noise", "why": "one sentence" }]
}
```

One entry per `T` and one per `G`, in order. Done when the file parses with exactly those entries. Reply with one line: match / partial / miss, then truth / decoy / valid / noise counts.
</content>
