# Shared Agent Context — Documentation Truth: Product Requirements
Version: 0.1.0

## Problem

The 2026-08-14 analysis verified that the public SAC guide contains obsolete
proposal syntax, historical test-suite totals are presented as if current,
SAC graph/wiki edges are missing or stale, capability/opt-in names are
inconsistent, and phase status can overstate delivered behavior. These are
current gaps, not claims fixed by this package.

## Goal

Make SAC documentation a verifiable, release-scoped projection of authoritative
runtime contracts and evidence. Readers must be able to distinguish planned,
implemented-at-a-commit, current verified, deprecated, unavailable, and denied
without relying on prose inference.

## Users

- Agents and operators need executable, accurate command/tool guidance.
- Maintainers need one status taxonomy and explicit evidence rules.
- Reviewers/release owners need drift gates before publishing claims.
- Graph/wiki consumers need SAC ownership/dependency context that points back
  to verified source/operation contracts.

## Functional requirements

| ID | Requirement |
|---|---|
| RP12-1 | Define a truth-source hierarchy: owner runtime contract/registry, executable verification artifact, commit/build identity, generated graph/wiki projection, authored guide, and roadmap/requirements. Lower sources cannot overrule higher ones. |
| RP12-2 | Every implemented/current claim is commit-pinned and records command/fixture, result, environment scope, timestamp, artifact digest/location, and known limits. Historical results are labelled historical and never used as current proof. |
| RP12-3 | Maintain future SAC graph/wiki coverage for public operation roots, owner boundaries, major dependencies, capability gates, and documentation references. Generated coverage is navigation context, not independent behavioral proof. |
| RP12-4 | Generate or registry-validate operation documentation, help, schemas, defaults, transport/risk, authorization action, capability prerequisites, errors, and deprecations from the canonical operation contract. |
| RP12-5 | Make documentation examples executable in isolated local fixtures. Each example names supported status/capability assumptions and asserts normalised output or expected safe failure. |
| RP12-6 | Define a shared status taxonomy for lifecycle, capability, evidence freshness, and verification scope; unsupported combinations fail documentation checks. |
| RP12-7 | Add future CI gates for source/doc/graph/wiki drift, broken links, generated-file freshness, executable examples, status/evidence validity, and no unsupported current claims. |

## Success criteria

- Published SAC operation syntax comes from a validated operation contract and
cannot drift from supported local adapters.
- A current claim links to evidence pinned to the documented commit/build; a
different commit is labelled stale/unverified until rechecked.
- Guides describe disabled, unavailable, degraded, denied, and
not-found-or-denied outcomes consistently without leaking hidden resources.
- Required graph/wiki pages cover SAC integration boundaries and link only to
real artifacts; generated output has a freshness/provenance marker.
- CI blocks a stale example, bad link, status contradiction, unpinned total, or
unexplained graph/wiki coverage gap.

## Risks

- Treating generated graph/wiki text as runtime proof can reproduce stale data;
commit identity and source verification are mandatory.
- Executable docs can become privileged test backdoors; fixtures must preserve
local transport, ACL, and non-disclosure constraints.
- A rigid taxonomy may obscure genuine unknowns; `unverified`/`unknown` must
remain allowed explicit states rather than be coerced to `implemented`.
- Documentation CI can slow releases unless checks are deterministic and
scoped to affected operation/docs coverage.

## Recommendation

Establish the taxonomy and evidence format first, then bind generated operation
docs and executable examples, then add graph/wiki and CI gates. Do not publish
a current runtime claim without exact commit-pinned verification evidence.
