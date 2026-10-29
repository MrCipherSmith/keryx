# Per-mutant rows of the bail replay (AC9)

Source of the table in `replay-bail.md`: 38 mutants, three groups, each run once by default (bail) and once with `--no-bail`. `ms` is the time of that mutant alone. `recorded` is the status in the earlier recorded pass the mutant came from.

| group | mutant | recorded | bail | ms (bail) | no-bail | ms (no-bail) |
|---|---|---|---|---|---|---|
| 1 | N19-same-outcome-only | killed | killed | 189 | killed | 2010 |
| 1 | N45-legacy-last-status-first | killed | killed | 1846 | killed | 2055 |
| 1 | S22-classify-always-fence | killed | killed | 189 | killed | 2013 |
| 1 | M10-outcome-reviewer-result-true | killed | killed | 183 | killed | 2041 |
| 1 | M05-pipe-escape-off | killed | killed | 194 | killed | 2064 |
| 1 | N40-cli-target-guard-off | killed | killed | 3043 | killed | 2025 |
| 1 | M06-outcome-no-empty | killed | killed | 333 | killed | 2065 |
| 1 | N01-decision-161-undecided | killed | killed | 3341 | killed | 2068 |
| 1 | R01-decisionfor-same-undecided | survived | killed | 3376 | killed | 2061 |
| 1 | M23-scrub-drops-work-tree | survived | survived | 3208 | survived | 2071 |
| 1 | M40-legacy-nested-last-status | survived | killed | 3318 | killed | 2070 |
| 1 | M38-cli-write-no-target-guard | survived | killed | 3228 | killed | 2065 |
| 1 | S26-write-target-guard-off | survived | survived | 3628 | survived | 2013 |
| 1 | R03-same-deepequal-only | survived | survived | 2622 | survived | 1978 |
| 2 | M09 | killed | killed | 2833 | killed | 2935 |
| 2 | X02 | killed | killed | 1551 | killed | 2967 |
| 2 | D01 | killed | killed | 1775 | killed | 2982 |
| 2 | W02 | killed | killed | 256 | killed | 2445 |
| 2 | T11 | killed | killed | 2656 | killed | 2968 |
| 2 | T06 | killed | killed | 2543 | killed | 3001 |
| 2 | B01 | killed | killed | 2653 | killed | 2936 |
| 2 | M04 | killed | killed | 2794 | killed | 2962 |
| 2 | N03 | survived | killed | 2742 | killed | 2963 |
| 2 | W06 | survived | killed | 885 | killed | 2256 |
| 2 | D03 | survived | killed | 1798 | killed | 2932 |
| 2 | H01 | survived | killed | 2757 | killed | 2974 |
| 2 | O11 | survived | killed | 2672 | killed | 2986 |
| 2 | N04 | survived | survived | 3057 | survived | 2940 |
| 5 | r1-gate-moved-off | killed | killed | 2068 | killed | 21125 |
| 5 | r1-cite-dedupe-off | killed | killed | 8240 | killed | 21071 |
| 5 | r1-cite-worktree-off | killed | killed | 8171 | killed | 13101 |
| 5 | r2-ev-placeholder-off | killed | killed | 9421 | killed | 9817 |
| 5 | r1-narrowed-remains-off | killed | killed | 9667 | killed | 9747 |
| 5 | r2-cli-status-null | killed | survived | 9496 | survived | 9744 |
| 5 | r2-cli-detect-off | survived | survived | 9437 | survived | 9586 |
| 5 | r1-lex-absolute-ok | survived | killed | 8463 | killed | 9464 |
| 5 | r2-gate-unusable-dropped-sayso | survived | survived | 9667 | survived | 9631 |
| 5 | r2-cite-root-lowercase | survived | survived | 9437 | survived | 9462 |
