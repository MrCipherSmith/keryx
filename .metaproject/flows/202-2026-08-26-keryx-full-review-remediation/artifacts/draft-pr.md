# Draft PR

## Title

`fix: remediate validated full-project review findings`

## Summary

- remove the background/shell and SAC runtime dependency cycles through narrow
  neutral seams;
- inject fleet presentation events instead of importing TUI state from the
  spawn-subagent tool;
- correct health decline/regression semantics and cover all fourteen catch
  dispositions;
- guard durable persistence sinks and enforce web-taint/acknowledgement
  boundaries;
- add focused architecture, health, security, and fallback coverage.

## Verification

- focused remediation: 195 pass, 0 fail, 2 live sandbox skips;
- TypeScript, build, graph, health, and diff gates pass;
- full suite: 5372 pass, 48 pre-existing fail, 18 skip, with no new failure
  identity;
- independent architecture and security reviews: no findings.

## Notes

The existing 48 full-suite failures and the scanner allow-on-internal-failure
policy are unchanged and intentionally out of scope.
