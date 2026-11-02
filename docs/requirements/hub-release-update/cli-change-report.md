# CLI implementation report
Version: 0.1.0
Date: 2026-11-01

Status: CLI implementation complete for independent integration review; no release publication, Hub update or production acceptance performed by this worker.

## Delivered

The full Keryx CLI routes `hub update` before project-binding/client flags. It supports explicit stable version or latest, check, dry-run, installation selection and explicit yes. All delegates use an argument array and inherited terminal streams, preserving the installed tool's exact exit status. It does not interpret shell text, download/run remote scripts or read a Hub bearer, project binding or credentials file.

The selected installation must contain a bounded regular executable hubctl with protocol marker1 and a canonical current-to-releases version directory. Foreign-owned (outside UID0 or the invoking user) or group/world-writable tools/directories, external tool links, external current links, legacy wrappers, absent installs, invalid versions and unknown/repeated/conflicting flags fail before execution. Check and dry-run delegate to the release tool's designated read-only entry points; actual artifact verification, consistency backup, trial and cutover remain installation-tool responsibilities.

Dedicated update help works through the CLI registry's safe help printer, without invoking an installation. The standalone context client is unchanged and does not gain administrative update access.

## Changed files

- src/commands/hub-update.ts — parsing, safe local installation resolution and bridge execution.
- src/commands/hub-update.test.ts — permanent negative/positive boundary tests and actual CLI help regression.
- src/commands/hub.ts — early update routing and focused help.
- src/cli-registry.ts — forward help arguments to the pure Hub help printer.
- docs/docs/cli-reference.md — documented CLI contract and standalone limitation.

## Verification

Initial test execution was RED because the new module did not exist. Then13 dedicated tests passed, including permanent four-target ownership refusal and trusted-root ownership coverage. The current updater/machine/reference run passed93 tests across5files with3091 assertions; prior91-test proof is superseded. The independent wrong-owner probe was RED before the ownership guard and GREEN after it. Root TypeScript check passed after final implementation. Scoped ESLint passed. Actual `src/cli.ts hub update --help` uses the dedicated non-mutating help path, covered by a spawned-process test.

These tests use disposable synthetic installations with local shell fixtures, not Docker, production credentials or network release downloads. The final end-to-end release-tool/real-data migration and deployment gates belong to the coordinator and must pass before production activation.

Routing: graph_used=yes (orientation snapshot predates the concurrent main merge and new module); wiki_used=existing parent domain context; ctx_used=yes; raw_rg_used=no. No commit or staging performed by this worker.
