# Documentation

This directory holds two kinds of material, kept apart on purpose: the user
documentation that is published as a site, and the project records that explain
how and why Keryx was built.

## User documentation

The published site is at <https://mrciphersmith.github.io/keryx/>. Its source is
in this repository:

- [`docs/`](docs/index.md) — every page in the site navigation: getting started,
  guides, module pages, concepts and the reference. Start at
  [`docs/index.md`](docs/index.md).
- [`examples/`](examples/review-bot.yml) — example configuration the guides refer
  to.
- [`assets/`](assets/keryx-logo.png) — images used by the README and the site.
- [`integrations/`](integrations/harness-capability-matrix.json) — the
  capability matrix of supported agent harnesses, checked for drift in CI.

## Project records

These are history and evidence. They are kept where they are, are not part of
the site, and describe intent or measurements at a date, so they can differ from
shipped behaviour. For what Keryx does today, use the site.

| Directory | What it holds | Status |
| --- | --- | --- |
| [`requirements/`](requirements/roadmap.md) | Per-feature requirement packages, the requirements roadmap and the [backlog](requirements/backlog.md) | Historical intent; may differ from shipped behaviour |
| `decisions/` | Harness decision records | Accepted decisions |
| `analysis/` | Audits and analyses | Point in time |
| `plans/` | Implementation and announcement plans | Point in time; may be stale |
| `report/` | Release-readiness and benchmark reports | Point in time |
| `reviews/` | Review fix plans | Point in time |
| `verification/` | Verification evidence and runbooks | Point in time |
| `skills/` | Log of rejected skill changes | Log |

The direction of the project is in [`ROADMAP.md`](../ROADMAP.md); the shape of
the code is in [`ARCHITECTURE.md`](../ARCHITECTURE.md).

## Documentation policy

- English is canonical. [`README.ru.md`](../README.ru.md) is a maintained
  translation of the README, not a second source of truth.
- `docs/docs/` describes shipped behaviour and is checked against the code and
  the live CLI help. Tests compare the CLI reference with the command registry.
- The records above describe intent or evidence at a date and say so.
- Pages for users do not carry internal tracking identifiers.
- Generated `.metaproject/` artifacts are refreshed through the CLI; raw and
  reproducible output stays ignored according to the managed `.gitignore`.
- Build the site locally with `pip install -r requirements-docs.txt` and
  `mkdocs serve`; see [CONTRIBUTING.md](../CONTRIBUTING.md#documentation).
