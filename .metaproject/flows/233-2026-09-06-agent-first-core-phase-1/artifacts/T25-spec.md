# SAC shared-reader bounds

Apply the existing shared contained-read byte ceiling and regular-file requirement in the SAC nofollow wrapper. Preserve its strict workspace-relative and no-symlink semantics. Add bounded size-at-limit/over-limit and directory-kind fixtures before changing the wrapper. No change to SAC authorization or review independence.
