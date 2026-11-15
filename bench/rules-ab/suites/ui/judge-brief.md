# Matching and noise brief (ui)

Three lists describe one code change that adds a UI feature to a React + Tailwind web app:

- `truth` — defects known to be in the change. Items `T1…`. It may be empty (a clean control).
- `decoys` — things in the change that look like defects but are justified. Items `D1…`, each with the reason it is not a defect.
- `candidate` — findings from one reviewer. Items `G1…`.

## Part 1 — truth

For every `T` item decide whether the candidate list contains the same defect.

- `match`: some `G` item identifies the same underlying defect — same cause, in the same code — so that fixing what `G` describes would fix what `T` describes. Different wording, a different line in the same component, or a different severity still match. A `T` listing several sites is matched by a `G` that names the class and at least two of the sites.
- `partial`: a `G` item points at the same code and a closely related problem, but a maintainer acting only on `G` would not necessarily fix `T`.
- `miss`: no `G` item covers it. Same file or same topic alone is a miss.

## Part 2 — every candidate

For every `G` item give one label:

- `truth`: it is the `match` or `partial` for some `T`.
- `decoy`: it reports a `D` item as a defect (at `minor` or above).
- `valid`: not in either list, but a real, specific UI problem the change introduces, that a maintainer would reasonably fix. Check the code before you say so.
- `noise`: anything else — not a real problem, not introduced by the change, pure taste, a duplicate of another `G`, or an `info` remark with no defect in it.

Judge from the lists and, where they leave it unclear, from the code snapshot at the path in your task (read with the Read tool; search with `keryx ctx rg <pattern> <path>` run inside the snapshot; do not look at any other commit or at `.metaproject/reviews`, `.metaproject/flows`, `bench/`). `apps/orders-web/DESIGN.md` and any measurements file in the snapshot are part of the evidence. When torn between two verdicts, pick the lower one (`partial` over `match`, `noise` over `valid`).

Write one JSON file (path in your task):

```json
{
  "truth": [{ "tid": "T1", "verdict": "match | partial | miss", "gid": "G4 or null", "why": "one sentence" }],
  "candidates": [{ "gid": "G1", "label": "truth | decoy | valid | noise", "why": "one sentence" }]
}
```

One entry per `T` and one per `G`, in order. Done when the file parses with exactly those entries; confirm it exists with the Read tool. Reply with one line: match / partial / miss, then truth / decoy / valid / noise counts.
