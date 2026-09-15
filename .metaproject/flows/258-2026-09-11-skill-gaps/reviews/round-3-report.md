# Flow 258 review round 3

Scope: one commit, `9da95727`, closing round 2's five findings. Branch
`skills/skill-gaps` at `9da95727`.

STATUS: DONE_WITH_CONCERNS

Every stated number reproduces by the stated method this time, including the
load-bearing claim that the finding list is byte-identical across the widening.
One new finding.

## Findings

```json keryx:findings
[
  {"id":"R3-m1","reviewer":"round-3","severity":"minor","file":"src/review/floor.ts","line":479,"problem":"The widened walk flattens every step's tokens into one bag, so a key one container out can contradict the name beside the number and take a real finding away. The commit presents the change as pure widening, and none of the three docstrings that discuss the walk says it can also remove findings.","impact":"Two of the five shapes lost are the module's own examples: the headline bar-lowering it calls the plainest there is, and the very line the capacity carve-out was narrowed to protect.","suggested_fix":"Keep the steps as separate token groups and let the innermost name that speaks decide; state in the docstring that the walk removes findings as well as adding them.","evidence":"Measured against 9da95727~1, each fired before and is silent now: \"coverage\": { \"maxWarnings\": 0 -> 50 }, thresholds: { maxLatencyMs: 500 -> 900 }, \"budget\": { \"minScore\": 90 -> 50 }, \"slo\": { \"timeoutMs\": 100 -> 900 }, maxRows: { minItems: 3 -> 0 }. The flat controls still fire, so the loss is exactly a bar nested inside a key whose words pull the other way. The in-window byte-identical check cannot see it: no such shape occurs in the 200 commits.","confidence":"high"}
]
```
