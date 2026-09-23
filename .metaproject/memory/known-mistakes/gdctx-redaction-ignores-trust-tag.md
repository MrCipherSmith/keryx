# gdctx-redaction-ignores-trust-tag

Version: 0.1.0
Type: known-mistake
Status: accepted
Confidence: high

## Summary

A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.

## Details

`keryx ctx read` and `keryx ctx run` redact public URLs (image badges, CI badges, npm badges) as `[REDACTED:url]` even when the source file is explicitly tagged `source: "trusted-project"` — signifying that the operator has vetted the content by committing it.

**Reproduction:** `keryx ctx read README.md --mode full` redacts CI badge `<img src>`, npm badge `<img src>`, and the repo's own logo `<img>` as `[REDACTED:url]`, while the outer `<a href="https://github.com/...">` links remain intact.

**Root cause:** The `SecuritySource` tag is attached to findings as metadata (`src/security/resolve.ts:84-87`) but never consulted for the redaction decision itself. The policy resolver (`resolveDecision`, `buildFinding` at `src/security/resolve.ts:74-189`) selects policy purely by category via `policyFor(match.category, config)` (`resolve.ts:37-51`, category-only, no source parameter). The redaction decision at `src/security/resolve.ts:184` checks only `m.mask !== undefined` and never branches on `opts.source` or any trust axis.

**Impact:** Makes `ctx read` lossy on the single most common OSS README pattern (CI/npm/license badges with `<img src>`), undermining "read files via `keryx ctx read`" as the routing default the whole program depends on.

**Fix shape:**
- Add a per-category, per-source override table in `SecurityConfig`: for category `egress`, policy id `image-url`, source `trusted-project` downgrades the default action from `redact` to `allow`
- Restrict to URLs with no credential-shaped query string: reuse existing secret/PII detectors on the URL's query string as a second gate
- Keep the override as data (`SecurityConfig.policies.egress.sourceOverrides`), not hardcoded in `resolve.ts`, so projects can tighten it back
- Still record the finding (paper trail of "URL was evaluated") even when action becomes `allow`
- Regression fixture: this repo's README.md badge block with CI/npm badge URLs must survive `ctx read` unredacted; a synthetic fixture with a `?token=` query param must still redact

## Provenance

- Source: flow 304 (W7 gdgraph/gdctx correctness)
- Link: docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2)
- Confirmed-By: Reproduced this session via `keryx ctx read README.md --mode full`
- Created: 2026-09-24
- Updated: 2026-09-24

## Related Scopes

- Module: security, redaction, policy-resolution
- Entity: resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
- Files:
  - `src/commands/ctx.ts:317` (redactRaw call site)
  - `src/security/resolve.ts` (policy/redaction logic)
  - `src/security/types.ts` (SecuritySource documentation)
  - `src/security/detect/exfil.ts` (image-URL detection)
- Skills:

## Tags

gdctx, redaction, security, policy, trust, image-url, false-positive

## Changelog

- 0.1.0 - Initial version documenting GDCTX-2 defect from W7 correctness investigation.
