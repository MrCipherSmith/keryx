# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: (G1) on `cp -a` copies of three vantage-frontend packages placed in a project root, `keryx review required --package <copy> --json` without a flag has neither `review-clean-code` nor `review-style` in `required`, has an `excluded` entry for each with a reason that names the flag, and the rest of the roster equals the one `required` gives with `--style`; with `--style` the roster of each copy equals the roster of the same command on the engine before this flow (compared on the same copy). [verify: judged]
- AC2: (G2) with `"reviewRoles": {"disabled": ["review-performance"]}` in the project's `routing.config.json`, `review-performance` leaves the roster of a copy with an `excluded` entry that names `routing.config.json`; an unknown name in `disabled` or `enabled` prints a warning and the command succeeds; a core role in `disabled` stays in the roster with a warning; a name in `enabled` stays on although it is off by default. [verify: judged]
- AC3: (G3) `required --all` and `required --gating` without the flag keep the two roles out and print a warning that names them and `--style`; `required --depth light` on a project that has neither `review-frontend-conventions` nor `review-backend` picks no conventions reviewer instead of `review-clean-code`, and with `--style` it picks `review-clean-code` as before. [verify: judged]
- AC4: (G4) `keryx review complete` writes the line "опциональные роли не запускались: …" into `report.md` of a package whose round had roles off, a second `review complete` leaves exactly one such line, a round started with `--style` (nothing off) gets no line, and a role that has a driver or a raw reply in the package is not listed. [verify: exec `bun test src/review/role-switches.test.ts src/review/role-switches-complete.test.ts`]
- AC5: the opt-in is recorded: `review start --style` and `required --package <dir> --style` write `round-roles.json` in the package, and ledger build, estimate, wave drivers, the coverage gate, the reviewers-left-out computation and the review panel read it, so a package opted in is held to the roster that includes the roles, and a package not opted in is not held to them. `--style` on `attach` and `ingest` is refused. [verify: exec `bun test src/review/coverage.test.ts src/review/role-switches.test.ts src/commands/review-required-package.test.ts`]
- AC6: `--style` and `--with-role` are in `REQUIRED_FLAGS`, `CREATE_FLAGS` and the non-path flag list of `required`; the guard test that ties the lists passes, and `--with-role` with an unknown role is a warning. [verify: exec `bun test src/commands/review-slice-paths.test.ts src/commands/review.test.ts`]
- AC7: the review panel row names the roles switched off for the review and the way to bring them back; a row with nothing off is unchanged. [verify: exec `bun test src/tui/review-panel.test.ts src/tui/review-inspector.test.ts`]
- AC8: existing tests that expected the two roles in a default roster are changed to the new default and still check what they checked before (the roster with `--style`); `bun run typecheck` is clean and the tests of the touched modules pass. [verify: exec `bun run typecheck`]
- AC9: `docs/docs/cli-reference.md`, the review guide, the `required` and `start` help, the orchestrator skill's flag table and `CHANGELOG.md` describe `--style`, `--with-role`, `reviewRoles.disabled|enabled`, `round-roles.json` and the report line. [verify: judged]
- AC10: acceptance ran on copies made with `cp -a`; the originals of the three packages have the same path, size, mtime and sha256 before and after (fingerprints in `verification.md`). [verify: judged]
- AC11: `verification.md` lists per requirement G1-G4 the evidence of its `Verification:` field, the doc-versus-code discrepancies (among them: `required.json` is saved `--json` output, Keryx writes no such file), and what could not be checked (token and time saving are not measured). [verify: judged]
- AC12: nothing is committed or pushed before the operator's word, and no AI attribution appears in files, branch names, commit messages, PR text or flow text. [verify: judged]
