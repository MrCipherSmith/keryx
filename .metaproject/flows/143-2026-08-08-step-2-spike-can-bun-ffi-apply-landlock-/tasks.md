# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Read spec §4/§4.2, implementation plan Step 2, ADR-0010; establish the measurement method already used for bwrap/docker |
| T2 | implement | `landlock-ffi.ts` — bun:ffi binding: syscall(2) seam, ABI query, ruleset/rule structs, ABI clamping, `execve` |
| T3 | test | `verify.sh` — executable assertions for ABI, apply sequence, enforcement, inheritance, no_new_privs, fail-closed, TCP axis; every denial paired with a positive control |
| T4 | review | Self-review and prepare draft PR |
| T5 | test | Measure per-command overhead with ADR-0010's method, all mechanisms in one run |
| T6 | test | Cost the compiled-helper alternative by building and measuring it, not estimating it |
| T7 | docs | Write the committed finding; link it from the package README and Step 2 of the plan |
