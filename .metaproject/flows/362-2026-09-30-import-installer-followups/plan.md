# Implementation Plan

Status: ready

## What the context task established (T5, reproduced on main a3b25c26)

- The gate is not bypassed. The project's security mode is `advisory` by default, and in advisory
  `guardOutput` never blocks (`src/security/guard.ts` `isBlockingMode`), so `allowed` is always true.
- The importer (`src/gdskills/import-skills.ts` `overwriteImportedSkill`, `writePlacedRule`) reads only
  `output.allowed` and `output.content`. It never reads `bytesPreserved`, `redaction`, `guard.decision` or
  `formatGuardWarning`, so a redaction and every finding are invisible on the row.
- Secrets are masked (`[REDACTED:secret]`); prompt-injection and egress findings carry no mask, so they are
  detected and written verbatim. The deterministic injection detector flags "Ignore all previous
  instructions…" (`prompt-injection.ignore-instructions`, `.role-override`, confidence 0.4 < the 0.5 gate
  minimum → `warn`), and an egress URL in the same text escalates them to `require-approval`
  (`src/security/resolve.ts` `escalateInjection`), with `egress.external-url-send → block`.
- Dry runs never call the gate, so a dry run can say `would-import` for content the real run redacts or
  (in `enforced`) refuses.
- In `enforced` a blocked SKILL.md throws after `createProjectSkill` already wrote the scaffold, aborting the
  run without a row table and leaving a header-only SKILL.md.
- `source: "untrusted-external"` changes no policy outcome; it is a label.

## Decisions

**D1 — the import is stricter than the project mode for instruction text.** Imported SKILL.md and rule
content becomes instructions an agent follows, so for the import (and `skills update`) any
`prompt-injection.*` finding at any action, or a gate result of `fail`, means the file is **not written**,
in every security mode. The row status is `refused` (new status) with the reason from `formatGuardWarning`
(leak-safe: policy ids and counts, never the matched text). The operator can override per run with
`--allow-flagged` after reading the file; then the file is written and the row says
`imported — flagged by the security gate (<warning>), written because --allow-flagged`. Rejected: following
the project mode (advisory would keep writing injection text verbatim, which is the defect), and refusing
the whole run (one flagged package must not block the others).

**D2 — redaction is reported, not silent.** When the gate changed the bytes (`bytesPreserved === false`) and
the file is written, the row says `… — redacted by the security gate (<warning>)` and `--json` carries
`security: { action, findings: [{policyId, category, action}], redacted: true }` on the row. In `enforced`
mode a secret is a `block`, so it falls under D1 (refused) — that is the project's chosen policy and is
reported the same way.

**D3 — the gate runs before anything is written, and in dry runs.** Evaluate the gate on the final content
(the stamped SKILL.md / the rule) during planning, so a refusal happens before `createProjectSkill` writes a
scaffold, the dry run reports the same status the real run will produce (`would-refuse`, or
`would-import — would be redacted …`), and a refused SKILL.md is a row, never an exception. The real run
still writes the gate's output, not the pre-gate text.

**D4 — measure false positives before shipping.** Run the gate the way the import does over every bundled
skill (`src/gdskills/bundled/skills/**/SKILL.md`), the bundled rules, and the real overlay
`~/.acme-frontend/skills/*/SKILL.md` + `rules/core/*.mdc` (read-only), and report which would be refused.
A security reviewer skill that quotes "ignore previous instructions" as an example is the expected false
positive; the decision for those is `--allow-flagged`, not weakening D1 — unless the measurement shows the
refusal hits ordinary reviewers, in which case stop and report.

**D1 refined after the D4 measurement (T8, 2026-10-01).** 196 files measured (81 bundled skill docs, 35
bundled rules, 55 overlay skills, 25 overlay rules): the original rule would refuse 3, all false positives,
none in the overlay. Two of the three were refused only by the `fail`-gate clause — a plain code-example URL
in `async-patterns.mdc` (`egress.external-url-send:block`) and the AWS documentation placeholder key in a
"BAD" example in `security-baseline.mdc`. The third is `review-pr-feedback/SKILL.md`, which describes injected
PR comments (`prompt-injection.ignore-instructions:warn`). Refined rule: refuse in every mode only on a
`prompt-injection.*` finding; every other finding follows the project's security mode (advisory: write,
redact as the gate does, report flagged/redacted on the row; enforced: refuse). `--allow-flagged` overrides
only the injection refusal, never an enforced-mode block. Expected false-positive rate on the measured
corpora: 1 of 196, a bundled skill that is not imported through this path.

## Steps

1. T6 — tests for F-010 / R06 (done, 2072edf4).
2. T7 — implement D1–D3 test-first in `import-skills.ts` (+ CLI flag in both import commands and
   `skills update`), with tests for: secret rule redacted+reported; injection rule refused in advisory;
   injection SKILL.md refused with no scaffold left; dry run reports the same; `--allow-flagged`; enforced
   mode secret refused; `--json` shape.
3. T8 — D4 measurement (read-only script), result into the journal.
4. T9 — docs: `reviewer-skill-creator/SKILL.detail.md` rows and flag, `docs/docs/cli-reference.md`, help
   texts; `skills verify --bundled` 0 findings.
5. Push, draft PR, CI (no local suite runs).
6. Review round (one), fixes, re-verify, completion choice.

## Risks

- False positives on legitimate security-related skills — measured in T8, escape hatch `--allow-flagged`.
- Behaviour change for anyone importing in advisory today: injection-flagged files are no longer written.
  Called out in the PR.
