# PR917 gate-fix round

Base: c59edc7da9d3b714efdb1bded76ff8d43b82d649.

Facade failure reproduced: 152 bypasses vs ceiling150; two imports moved through security/service without raising ceiling or changing detector/mask implementations.

Esc production failure was not reproduced locally. Test polling now explicitly renders before sampling; first Esc must leave wizard pending at provider list, second resolves undefined. Synthetic idle test verifies helper only, not native scheduler/root cause. Production TUI/timeouts unchanged.

Independent read-only scoped review sub:cafe6898-82b7-4338-9eea-1cf5b1afcc41: PASS. No security/navigation blocker. Reviewer did not execute tests or compare base diff. Explicit render may mask automatic-repaint defect; original CI cause remains unproven.

Parent execution:91pass0fail9files; ten independent Esc runs each8pass0fail; typecheck/ESLint/whitespace PASS. Final comment-only revision retested before commit. T3/AC9 final-SHA gates pending; existing AC9 historical. T4 blocked pending CI/whole-PR review. AC11 OPEN. No merge/release.
