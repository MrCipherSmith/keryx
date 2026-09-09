# T25 SAC read bounds

SAC now passes the shared 8 MiB bound and regular-file requirement to descriptor reads; existing strict nofollow semantics retained. RED: 0 pass / 2 fail (12-44-28-873). GREEN: 2 pass / 0 fail (12-48-30-270). Scoped ESLint pass (12-51-08-379). Independent T23 recheck: 19 containment/SAC tests pass, owner-race probe refuses replacement, Stage1 and Stage2 PASS; see T23-recheck.md.
