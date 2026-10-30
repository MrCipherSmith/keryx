# Remote sessions: packaging boundaries

## Hub server and context client

`bun scripts/package-team-hub.ts --out /absolute/output --linux-x64` produces a deterministic source tarball, Linux x64 server/client executables and SHA256SUMS. Set SOURCE_DATE_EPOCH to a nonnegative reproducible timestamp if required; the default is zero.

The source archive includes production Hub modules (including remote-v2), the neutral protocol boundary, generated standalone validators, generated types/manifest, frozen JSON schemas, frontend sources and embedded assets, MCP and context-watch implementation, runtime lockfile, and deployment/runbook documentation. It excludes native tools, model/provider execution, repository secrets, dependency trees and test fixtures. USTAR prefix fields support portable long paths; symlink inputs are refused. Only deliberately named `.env.example` deployment placeholders may ship.

Compilation installs the exact isolated runtime lockfile in a temporary staging directory. The MCP SDK is pinned to 1.32.1. Root developer node_modules is never an input. Docker remains pinned to oven/bun:1.3.14-debian; local Bun 1.4.2 success does not establish minimum-runtime support.

These artifacts provide the Hub and context client/MCP bridge. They do **not** install the full native Keryx machine executor. Do not advertise `team-hub-client` as a standalone headless agent installation.

## Native machine executor

A native executor needs the complete Keryx distribution, the production session runtime, command catalogue and permission policy, tools, containment resources, provider configuration and local checkout bindings. `keryx hub machine ...` and `keryx serve --hub ...` belong to that full installation. A Hub image does not execute project code or a model.

Compiled runtime capability/readiness must come from a validated embedded release descriptor. Runtime must not read a developer's output inventory JSON or unshipped TypeScript files. A source inventory count or CLI `--help` output cannot establish native readiness. Missing or stale validated native coverage remains a release blocker; packaging must not fabricate ready receipts or substitute a scripted runtime.

## Verification

`bun scripts/smoke/team-hub.ts` starts an isolated real Hub process with generated fixture-only credentials and executes HTTP lifecycle/auth checks plus real browser/machine WebSocket upgrades. `--server /absolute/server` exercises a compiled executable. The smoke imports the shipped neutral standalone validator, checks closed request schemas, agent/Origin denials, one-use enrollment, hello/heartbeat and socket revocation. No actual native model execution is claimed by that protocol peer.

Run the same probe from an extracted source archive after its locked isolated install, and in the pinned minimum-runtime container. Run additive migration and protocol regression tests separately. Full native production assembly requires an isolated configured provider/profile against a synthetic loopback protocol server and non-TTY execution; direct injected runtime callbacks alone are insufficient evidence.

Public Cloudflare traversal, real provider/vendor trials and final human acceptance remain separate gates. No smoke authorizes publication, deployment or accepting a Flow.

## Reproduce the installed native checkpoint

Run these commands from the full Keryx checkout, not the smaller Hub source archive.

```sh
bun scripts/smoke/package-native-candidate.ts --out /absolute/new/isolated-candidate
bun scripts/smoke/keryx-native-machine.ts --candidate /absolute/new/isolated-candidate/bin/keryx
```

The staging script builds the actual full CLI and proxy worker, copies npm-listed graph/bundled/contract/schema resources, and installs production optional dependencies from the root lockfile **inside that candidate directory**. This is an isolated test installation, not a supported release archive. The child receives only isolated HOME/config/temp settings and a restricted PATH beginning at the candidate bin directory. The probe checks both PATH realpath and the actual builtin hook argv resolver against that exact candidate; hooks remain enabled. Never run this proof against the laptop's globally installed CLI.

Compile the smoke harness itself to test execution without source imports. Repeat staging/build/execution under the pinned minimum-Bun image for Linux; local builds do not establish that minimum. The full native coverage descriptor remains required before a release can be declared ready.

## Current verification snapshot (2026-10-27)

Hub source/extracted archive, compiled Linux server/client and actual Docker image passed isolated HTTP/WebSocket/auth/protocol checks on Bun1.3.14; local1.4.2 also passed. Initial standalone compiled Linux assembly correctly refused before provider I/O because it lacked the security hook CLI launcher. After installing the actual isolated candidate CLI plus proxy/bundled/schema resources, the compiled production assembly passed with hooks enabled on Linux1.3.14 and macOS1.4.2: synthetic loopback provider HTTP, actual native host, read_file tool result and second model round. Earlier macOS checks using the ambient installed launcher are only historical provider/tool-path checkpoints and do not count as installed-candidate proof.

Validated embedded native command coverage, final physical-machine execution, public Cloudflare/vendor trials and owner acceptance remain separate mandatory gates. These snapshots are not final release candidates while peer-owned sources continue changing.
