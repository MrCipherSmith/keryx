# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `.github/workflows/ci.yml` gains a matrix job covering all four N1 targets — linux-x64, linux-arm64, darwin-arm64, darwin-x64 — with the runner label for each verified against GitHub's current hosted-runner offering rather than assumed. If a label turns out to be unavailable to this repository, that is recorded in the specification instead of silently dropped from the matrix.
- AC2: On every matrix target the job installs dependencies with **no Zig toolchain** present and asserts that `@opentui/core`'s platform-specific native binary actually resolved — a positive check, not the absence of an error.
- AC3: On every matrix target the OpenTUI-dependent tests run with **zero skips**. A skip means the optional dependency did not resolve, which would make the platform evidence vacuous; the job fails in that case rather than reporting green.
- AC4: A test drives `scripts/install.sh --global` into a temporary prefix using `KERYX_HOME` / `KERYX_BIN_DIR` / `KERYX_REPO_URL` / `KERYX_REF`, and asserts the produced wrapper is executable and actually runs the CLI. It must not write into the developer's real `~/.keryx` or `~/.local/bin`, and must not require network access to the published repository.
- AC5: The install test is falsifiable: it fails when the wrapper is not produced or does not run, demonstrated by breaking the relevant step and recording the failure in the flow journal.
- AC6: A cold-start measurement exists as a reproducible script or test, reporting readline start-up against the same path plus the `@opentui/core` native import, with at least a handful of runs and a median rather than a single sample. Raw numbers and the machine they came from are recorded.
- AC7: The cold-start record states plainly what it does **not** measure — a rendered first frame, because `createCliRenderer` needs a controlling terminal that CI does not have — so R5 is answered without implying more than was measured.
- AC8: No production behaviour is changed by this flow. It adds CI configuration, tests and a measurement; any change to `src/` beyond what a measurement seam strictly requires is justified in the journal, and any defect found is reported rather than silently fixed.
- AC9: `bun run typecheck` is clean and `bun test` passes with no fewer tests than the 2081-pass / 11-skip / 0-fail baseline on this branch. `bun test src/tui` reports 0 skips locally.
- AC10: The new CI job is proven to actually run and pass on the PR — not merely committed — with the run linked. A matrix leg that is skipped or never scheduled does not count as evidence.
- AC11: O-3, O-5 and O-4's install clause are closed in `docs/requirements/keryx-opentui-shell/specification.md` §10, each keeping the original finding above its resolution as O-1, O-2 and O-4 do. Anything that remains unproven — the rendered-frame gap behind both the pty limitation and the platform claim — stays listed as open rather than being absorbed into a closed item.
- AC12: The ongoing cost of the matrix (four hosted runners on every future PR) is stated in the specification or the CI file, so the trade-off is visible to whoever next edits CI.
