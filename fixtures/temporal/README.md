# Temporal fixture (Block C / C2)

A committed, deterministic mini-metaproject exercising the bitemporal fact model
(spec §8.1; AC-C5, AC-C6). `.metaproject/memory/decisions/` holds a three-link
supersession chain for the "authentication" decision plus one non-temporal
control entry:

| entry | Valid-From | Valid-To | Superseded-By | status |
|-------|-----------|----------|---------------|--------|
| `auth-sessions.md` | 2026-01-01 | 2026-03-01 | `decisions/auth-jwt.md` | superseded |
| `auth-jwt.md` | 2026-03-01 | 2026-06-01 | `decisions/auth-oauth.md` | superseded |
| `auth-oauth.md` | 2026-06-01 | (open) | — | accepted |
| `logging-json.md` | — | — | — | accepted (control, no validity fields) |

`queries.json` records the expected resolution for the default `current` query
and for `--as-of <date>` queries. The temporal harness test asserts 100% correct
resolution against this manifest (`src/memory/temporal.fixture.test.ts`).
