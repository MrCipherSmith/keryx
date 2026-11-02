# Retention mutation verification

- baseline / current repository assertions unchanged, fixture source redirected to isolated actual pruner: **baseline-pass**; /var/folders/dr/0zsc52nd5yn7p2htt__lxshw0000gp/T/pr1113-retention-mutation-hxx3db1i/baseline.log
- count-one / current repository assertions unchanged, fixture source redirected to isolated actual pruner: **killed**; /var/folders/dr/0zsc52nd5yn7p2htt__lxshw0000gp/T/pr1113-retention-mutation-hxx3db1i/count-one.log
- no-age-guard / current repository assertions unchanged, fixture source redirected to isolated actual pruner: **killed**; /var/folders/dr/0zsc52nd5yn7p2htt__lxshw0000gp/T/pr1113-retention-mutation-hxx3db1i/no-age-guard.log
- baseline / supplemental all-old: **baseline-pass**; ['upgrade-1', 'upgrade-4', 'upgrade-5', 'upgrade-6']
- baseline / supplemental young-fourth: **baseline-pass**; ['upgrade-1', 'upgrade-2', 'upgrade-3', 'upgrade-4', 'upgrade-5']
- count-one / supplemental all-old: **killed**; ['upgrade-1', 'upgrade-6']
- count-one / supplemental young-fourth: **survived-on-this-axis**; ['upgrade-1', 'upgrade-2', 'upgrade-3', 'upgrade-4', 'upgrade-5']
- no-age-guard / supplemental all-old: **survived-on-this-axis**; ['upgrade-1', 'upgrade-4', 'upgrade-5', 'upgrade-6']
- no-age-guard / supplemental young-fourth: **killed**; ['upgrade-1', 'upgrade-2', 'upgrade-3', 'upgrade-4']

Both mutations killed by current repository tests without assertion changes. Exact supplemental all-old and young-fourth + old-pointer cases confirm each invariant. No shared source writes. Optional test clarity improvement: an all-old fixture with explicit newest-three names, instead of relying on aggregate counts.
