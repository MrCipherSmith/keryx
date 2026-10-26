# Review engine speedup, step 5: optional review roles by flag and project config (R5, G1-G4)

Status: draft (flow-init skill formalizes this)
Source: user description (origin: human-request)

## Problem

`review-clean-code` and `review-style` are in the full roster of every round with no gate and no way to leave them out. On vantage-frontend (23 rounds, 472 findings) 98 findings came from them, none major, and by the analysis in doc 20 almost all concern readability, not behavior or the PR contract. Each round pays their dispatches. There is also no general mechanism: a project cannot switch off any other built-in role (for example `review-performance`), and the `light` round's fallback conventions pick can land on `review-clean-code`.

## Expected Outcome

- A role can be off by default. `review-clean-code` and `review-style` are off unless the round asks for them: `keryx review required` and `keryx review start` take `--style`. With the flag the roster equals today's.
- The mechanism is general. The project's `routing.config.json` carries `reviewRoles.disabled` (built-in or project roles that are off) and `reviewRoles.enabled` (roles that stay on even when off by default); `--with-role <name>` turns one more on for a round. An unknown name is a warning, never a refusal; a core role (`review-logic`, `review-architecture`, `review-security-code`, `review-highload`, `review-regression`) cannot be switched off and the attempt is a warning.
- The opt-in belongs to the package: `required --package` and `start` record it in `round-roles.json`, and every place that computes the roster of a package (ledger build, estimate, drivers, coverage gate, review panel) reads it back.
- `--all` and `--gating` do not bring the roles back, and the output says which are off and how to turn them on. The `light` round's conventions fallback never returns an off role.
- A switched-off role leaves an `excluded` entry with the reason in the `--json` output of `required`, and `review start` names the off roles and the way back.
- `keryx review complete` writes the line "опциональные роли не запускались: …" into `report.md` (absent when no role was off), idempotently, and prints it.
- The review panel states the off roles for a review row.

## Outcome criteria

- Запрос (дословно): «/home/altsay/arena/ideas/pr-review-management/23_KERYX_IMPLEMENTATION_PROMPT.md» (source: Helyx message 226364, 2026-10-25; order r6 then r5: message 226906; scope of the mechanism: poll 291, 2026-10-24; config location `routing.config.json` key `reviewRoles.disabled`: poll 306)
- Эффект (формализация агента): a round no longer pays for the two readability roles unless the operator asks for them, the operator can see in the report which roles did not run and how to bring them back, and a project can use the same switch for any other built-in role.
- Как наблюдать (предложение агента): on copies of three vantage-frontend packages `required` without the flag omits the two roles and records why, with `--style` the roster equals the one today; `report.md` of a completed round carries the line without the flag and not with it.

## Out of Scope

`review-pr-contract` (it already joins when `pr-context.md` exists), the skills of the two roles, the `light` depth rules, the packages of the original reviews. Measuring the time or tokens the two roles cost: saving is not measured in this flow. Another project than vantage-frontend: the default of the two roles is the engine's, the project can bring them back with `reviewRoles.enabled`.
