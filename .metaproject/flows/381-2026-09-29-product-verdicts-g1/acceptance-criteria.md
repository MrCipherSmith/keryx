# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: An observation is a line beginning `outcome-observed:` followed by exactly one of `helped`, `no-effect`, `harmed` or `inconclusive`, then an em dash and a note, and `product index` stores the verdict and the note on the intent [verify: exec `bun test src/product/observation.test.ts`]
- AC2: A line beginning `outcome-observed:` with no recognized verdict is reported by `product index` as a parse failure naming the flow, makes the command exit non-zero, and does not remove the flow from the `product open` queue [verify: exec `bun test src/product/observation-errors.test.ts`]
- AC3: `product open` and `product index` report the verdict counts of the observed intents (helped, no-effect, harmed, inconclusive) next to the observed total, in the CLI output and in the TUI `/product` view [verify: exec `bun test src/product/open.test.ts src/tui/product-open-surface.test.ts`]
- AC4: The description.md template written by `flow init` carries an `Outcome criteria` section whose hint asks for a criterion or `not measured — <reason>`, and an untouched hint is read by the index as no outcome criterion stated, never as a declared one [verify: exec `bun test src/flow/templates.test.ts src/product/extract.test.ts`]
- AC5: A requirements package records observations in an `Outcome observations` section of its README using the same verdict format, `product index` stores them on the package intent, and a malformed line is a parse failure naming the package [verify: exec `bun test src/product/docpack-observation.test.ts`]
- AC6: `flow init` prints one informational line when the intent statement of the new flow's description cannot be extracted, and that line changes neither the exit code nor any flow state [verify: exec `bun test src/commands/flow-init-intent-note.test.ts`]
- AC7: Gate G1 in `docs/requirements/keryx-product-module/implementation-plan.md` is replaced by two gates, G1a (share of the next ten new flows that declare an outcome criterion or an honest `not measured — <reason>`; near zero means stop) and G1b (share of those flows with an outcome criterion that received an observation line with a verdict, read two to four weeks after release; near zero means stop), states that `map` is built only if both pass, and states that G1b needs calendar time [verify: exec `grep -q 'G1a' docs/requirements/keryx-product-module/implementation-plan.md && grep -q 'G1b' docs/requirements/keryx-product-module/implementation-plan.md && grep -q 'calendar time' docs/requirements/keryx-product-module/implementation-plan.md`]
- AC8: `docs/requirements/keryx-product-module/metrics-and-validation.md` records 310 of 310 as the "before" arm for outcomes, captioned as "the instrument did not exist" and not as "nothing worked", together with the 423, 347, 76, 130 and 0 figures it was read from [verify: exec `grep -q 'the instrument did not exist' docs/requirements/keryx-product-module/metrics-and-validation.md && grep -q '310 of 310' docs/requirements/keryx-product-module/metrics-and-validation.md`]
- AC9: Nothing gates and the bulk budget holds: the existing never-gates, no-model and bulk-budget invariants stay green, only `index` and `open` exist, and neither `flow init` nor freeze nor completion refuses anything because of an outcome criterion or an observation [verify: invariant `bun test src/product/never-gates.test.ts src/product/no-model.test.ts src/product/bulk-budget.test.ts`]
- AC10: No existing flow directory and no existing requirements package README is modified by the change: outcome criteria and observations are never written backwards into the corpus, so the 310 of 310 stays the honest "before" arm [verify: judged]
- AC11: `bun run typecheck` is clean, `bun test src/product src/flow` passes, the CLI help pins and docs (README, docs site CLI reference, module page `.metaproject/modules/product.md`) describe the verdict format and the template slot, and the CHANGELOG has a 0.3.31 entry with the version bumped [verify: exec `bun run typecheck && bun test src/product src/flow`]
- AC12: After release the work stops before G1a: the flow journal records that G1a is read only once ten new flows exist and that nothing beyond `index` and `open` is built until both gates pass [verify: none — a stop is an absence of work; the journal entry and the operator report are the evidence]
