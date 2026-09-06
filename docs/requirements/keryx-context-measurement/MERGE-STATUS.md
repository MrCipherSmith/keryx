# What from this branch is already on `main`, and what is not

This branch (`measurement/context-2026-09-05`) holds the whole 2026-09-05
context measurement. **`main` was reset to `46cfd583` (release 0.2.80) on
2026-09-06 at the operator's instruction** — the measurement is deliberately not
in `main`, because keryx is a public repository and the material describes a
private work codebase.

## Already applied to `main`

Cherry-picked to `fix/context-gate-and-subagent-routing` → **PR #487**. Neither
commit contains any reference to a private repository; both were checked before
picking.

| commit here | what | on `main` as |
|---|---|---|
| `89e163f1` | subagents no longer all made to read the routing index | `82f32e33` |
| `9608699e` | `index.md` becomes a 277-token gate, router moves to `routing.md` | `f296ef05` |
| — | `context-loading.md`, the cost model both cite | added in PR #487 |

`context-loading.md` exists in both places and is identical. It was audited for
private references before being copied: **zero**.

## Deliberately NOT on `main`

Everything below names, quantifies, or derives from a private work repository.

| file | why it stays here |
|---|---|
| `pre-registration.md` | task counts, filter yields, a real commit subject with the file it changed, an internal guard script name, a `.gitignore` line number |
| `results-vantage-frontend.md` | the primary run's results |
| `results-keryx.md` | comparative figures naming the private repo |
| `improvements.md` | 4 private references |
| `README.md` | the consolidated report |
| `data/*.jsonl`, `data/*.json` | raw per-arm results, including real file paths |
| `scripts/benchmark/retrieval-*.ts`, `run-retrieval.ts` | the harness; comments name the private repo and its internal guard |

## Reverted along with the measurement, and worth restoring separately

The revert also undid fixes to **pre-existing** bugs in older benchmark scripts
that had nothing to do with the measurement — they merely arrived in the same
pull request as the typecheck expansion. On `main` today:

- five ablation scripts pass `maxToolCalls` to `AgentDeps`, which has no such
  field — **the cap does not take effect**
- `keryx-shell-stress` calls `resolveAgentMaxToolCalls()`, which does not exist
  — **that line throws whenever the JSON report is written**
- `run-containment` treats `canaryServer.port` as certain
- `scripts/` is outside `tsconfig`, which is how all of the above went unnoticed

Those four stand on their own merits and are not proposed here.

## A thing `main` cannot fix

Resetting removed the commits from the branch, **not from GitHub**. The eight
reset commits and the commits of closed PR #486 remain reachable by hash on a
public repository until GitHub Support purges them.
