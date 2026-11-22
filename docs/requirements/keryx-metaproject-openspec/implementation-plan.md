# Implementation Plan — OpenSpec in Keryx Metaproject
Version: 0.1.0

Status: Spec ready for owner review. All runtime tasks are pending.

## Delivery and dependencies

P0–P2 deliver the read-only release. Start P3 as a separate Flow after local reading and linking are verified. The document names future tasks and verification commands. It does not allocate Flow IDs or authorize commits, pushes or a release.

| Task | Depends on | Work and expected output | Acceptance |
|---|---|---|---|
| P0.1 Fixture and contract | — | Build a synthetic portable OpenSpec checkout with specs, deltas, archive and explicit link config, and a second checkout containing a conflicting source. Define diagnostics, identities and test interfaces. | AC1–AC4 fixtures |
| P0.2 Source catalog | P0.1 | Implement local, bounded discovery, publication of coherent snapshots, link config validation and safe source refs in `src/openspec/`. Exercise root isolation and race/error paths. | AC1 |
| P0.3 Parse, relate and search | P0.2 | Parse Markdown sections and deltas, current baseline matches and archive history. Index titles, paths, headings and body terms. Implement stable paging and evidence locators. | AC2, AC3 |
| P1.1 Explorer projection | P0.3 | Extend the shared projection, validate graph backlinks, add v2 requests and preserve v1. Verify mixed-version negotiation, project-change handling and unchanged v1 callers. | AC3–AC5 |
| P1.2 CLI and harness routing | P0.3 | Add list, show and search commands with JSON/text output and local routing documentation. Verify the same fixture outputs in every reading surface. | AC5 |
| P2.1 Desktop tab and graph | P1.1 | Build Specs, Changes and Archive, detail and search deep links, explicit no-source/partial states, keyboard navigation and relationship evidence. Preserve selected node and query across views and drop stale responses. | AC3, AC4, AC6 |
| P2.2 Verification and guide | P1.2, P2.1 | Add guide and link configuration example. Run GitHub CI and a packaged Desktop and Shell walkthrough. Attach correct-version evidence and assess scan/interaction budgets. | AC1–AC7 |
| P3.1 Flow preview and create | P2.2 | Add read preview and confirmation-driven draft creation with canonical source fingerprint, criterion evidence and idempotency through the Flow owner. Integrate the same operation in Desktop and Shell. | AC8 |
| P3.2 Flow workflow verification | P3.1 | Exercise preview, submit/retry, source drift, operator edits and native freeze on a disposable local Flow; update the guide with status and recovery. | AC8 plus live handoff |

P1.1 and P1.2 can run in parallel after the reader contract is fixed. A Desktop lane may build fixture-driven UI against the v2 contract while the integration lane completes transport; acceptance requires exercising the actual sidecar. Keep path-local contract fixtures and the v1 scenario throughout implementation.

## GitHub CI

Use the existing [core CI](../../../.github/workflows/ci.yml) and [Desktop Check](../../../.github/workflows/desktop-check.yml). Confirm that the new `src/openspec/` module and targeted command tests are included by the core workflow's test discovery/shards. Add a narrow inclusion only if the new suite would otherwise be missed. Include Desktop changes on the release candidate so the existing path filters trigger its own workflow.

| CI scope | Evidence to inspect |
|---|---|
| Core | Catalog fixtures, delta and history, search, Explorer v1/v2 and CLI parity (AC1–AC5) |
| Desktop | Native command validation, cross-version handling and webview behavior (AC6) |
| Later Flow | Draft creation, idempotency and stale source handling (AC8) |
| Documentation | Package links and published-guide links, and no unsupported runtime claims |

Run automated tests in GitHub CI. A macOS desktop job with a stub sidecar is evidence for adapters and tests. AC7 requires a real bundled or matching explicitly selected CLI. Prefer a real packaged signed/unsigned development build with the same code as the evaluated commit. Record exact commit, app build and CLI version for the walkthrough. Runtime verification starts only after implementation.

## Live Desktop and Shell walkthrough (AC7)

Use a disposable project with an ordinary OpenSpec tree, a Wiki page, one linked source file and a code graph. Include an archived change and an active change for the same capability; include a second checkout with an identically named capability and differing text. Generate the code graph using the existing explicit rebuild action.

1. Open the project in the packaged macOS app, switch to Metaproject and verify **Graph**, **Wiki** and **OpenSpec**. Repeat without Hub login and without the OpenSpec CLI on PATH.
2. In **Specs**, find a sentence that occurs only in a scenario body. Assert that search opens that scenario and shows the original source path. Record the result, then repeat the query in `keryx shell` and via the documented Keryx CLI from an external harness. Compare the same checkout-relative path, heading and digest.
3. Switch to **Changes** and inspect an active Modified, Removed and Rename operation. In **Archive**, find the same capability's earlier change. Confirm the archival date label and inspect the original delta. Confirm that including Archive in search exposes historical text without presenting it as a current requirement.
4. Select a spec, show its graph neighborhood, open the linked Wiki page and code node details, verify the file path, and trace a backlink. Verify edge provenance, direction, active selection and return to the search. Repeat using the keyboard and in a narrow window with the details panel open.
5. Reopen without a built graph and then with stale graph data. Confirm OpenSpec and Wiki remain readable. Switch checkout during a search and verify the old result never appears. Change the OpenSpec source and refresh; confirm that stale detail is invalidated and existing selection resolves correctly when still present.
6. Open a checkout with no OpenSpec, then a malformed/partial example, and verify distinct states and visible omissions. Exercise old CLI behavior with a known Explorer v1 binary. Record the compatibility outcome separately.
7. Run the large fixture check below and record screenshots or a short recording with keyboard focus, archive and relationship evidence. Record any skipped step or unavailable environment.

### Large fixture and observation protocol

Prepare a committed synthetic checkout with 100 capabilities, 500 active changes and 2,000 archived changes with searchable Markdown. Record file and byte counts, Mac model/RAM reported by the reviewer, executable versions and a query list including rare text, common headings and an Archive-only phrase. Time cold first open, warm collection navigation and a completed search over five trials. Record median and slowest trial, from user action to rendered result, with fixture size and any partial states. Engineering targets on a current Apple Silicon development Mac are first usable result within 2 s median and warm search within 500 ms median. These are investigation thresholds and carry no current benchmark claim. File a performance finding when missed. Blocking AC7 requires a documented usability failure such as an unresponsive window, undiscoverable omitted current records or unexplained blank states.

### Later Flow walkthrough (AC8 companion)

Use a separate disposable local Flow. Preview a change, edit one proposed criterion and create a draft. Confirm a retry opens the existing draft. Edit the source and verify drift is visible. Try confirming a pre-edit preview and confirm it creates no extra draft. Verify imported evidence survives opening the Flow in Shell and normal Freeze. Compare the recorded source and criteria after changing the OpenSpec file again.

## Integration and rollback

- Roll out v2 reader and Desktop support together where possible. Keep v1 compatible throughout. If a regression requires reverting Desktop v2, Graph/Wiki continue over the original transport and upstream OpenSpec files require no cleanup.
- P0–P2 only read existing project sources. The optional links file is operator-owned. Invalid entries have bounded diagnostics. Project authors can omit the file and still browse history and delta relationships.
- P3 introduces local writes only through the existing Flow owner. If disabled or reverted, previously created Flows are ordinary Flows with retained source metadata. Document its supported compatibility with older clients before release.
- Update the Desktop Metaproject guide and routing references once the measured runtime is available. Record implementation and evidence in this package and the requirements roadmap after release verification.
