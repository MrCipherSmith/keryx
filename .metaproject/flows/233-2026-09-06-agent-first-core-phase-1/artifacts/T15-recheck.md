# T15 Security Recheck — MCP HTTP loopback transport

## Scope

This is a bounded recheck of the original T15 F-001 finding after the root
change. The initial finding remains preserved in `T15-review.md`; this report
records whether the current request path still permits it. No source, flow, or
git files were changed by this recheck.

## Recheck result

The request guard in `src/mcp/transport/http-sse.ts` now rejects nonnumeric
configured names even when they are supplied in its host list. The listener
passes only the verified numeric bind address and reserved `localhost`; the
configured name is used for startup resolution and binding, but is not treated
as a browser-origin authority. A direct deterministic predicate check therefore
rejects the configured-name matching Host/Origin pair while accepting the
pinned numeric and reserved-localhost cases.

The added same-origin configured-name regression was red before the root fix
(15 pass, 1 fail; parent artifact timestamp `2026-09-06T11-30-52`). The current
focused HTTP, boundary, and installer suites pass 26/0:

- Summary: `.metaproject/data/gdctx/artifacts/2026-09-06T11-32-55-889Z_run.md`
- Raw log: `.metaproject/data/gdctx/raw/2026-09-06T11-32-55-889Z_run.log`

Stage 1 remains passing: loopback validation occurs before SDK connect/listen,
the listener binds the verified address, and request failures remain generic.
No external socket or model call was used; the listener fixture is local only.

## Disposition

F-001 was a confirmed pre-fix major finding and is resolved by the current root
change. No new security finding was found in this scoped recheck.

Routing audit: `graph_used=parent target discovery`; `wiki_used=T15 HTTP spec
and policies`; `ctx_used=yes`; `raw_rg_used=no`.

