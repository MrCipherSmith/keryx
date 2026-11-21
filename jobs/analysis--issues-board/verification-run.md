# Native acceptance run for Flow 511

On 22 November 2026 the operator used Keryx Issues QA, a separate macOS application bundle (Desktop 0.2.9, bundled CLI 0.4.46), on macOS 26.5.1. The checkout, issue, session and Flow below are disposable fixtures. The Desktop reported that the installed PATH CLI was 0.4.45 and used its bundled CLI. The Shell observations used that same bundled executable.

| Scenario | Observed result |
|---|---|
| AC4, Board and List | Selected the fixture account in the native app and found private issue #2 under Created by me. Both layouts opened the same detail panel with the repository, an unassigned issue, the external issue link, Markdown headings and a list under Description, followed by Comments with zero entries. Escape returned focus to the Board card. On the List detail panel, focus on the splitter and the left arrow changed its width from 550 to 574. The test issue had no comments, so this run did not establish chronological ordering across pages. |
| Normal session | Open session entered Sessions. The operator submitted a local-preview constraint and asked the agent to confirm date handling during planning. The agent's acknowledgement and original message were visible again after restarting the application and opening the issue session. |
| Concurrent turn and recovery | Opening Create Flow during the earlier conversation turn allocated fixture Flow 001 with an unsent preparation turn. The first build showed a busy warning and later offered only Open Flow. A subsequent QA build at `20b3c0d45` presented Resume preparation on this same issue after a restart. Clicking it entered the existing session and started the coordinator without typing its prompt. The CLI reported stage `preparing`, an accepted initial turn, the same launch key and the same Flow. |
| Shell and backlink | From the fixture clone, `keryx flow list --json` returned one package. `keryx flow status 001` showed initializing, a GitHub issue source ending in /issues/2, and unfrozen criteria. The branch was main. After restarting, Open Flow opened package 001. Its Open source issue action returned to the correct description and discussion. |
| Projects permission | Before the owner authorized Projects access, opening private Project #4 in Desktop returned an access error and Retry. Switching to Created by me still retrieved the private issue. The owner then granted the project scope. Desktop subsequently opened Project #4 using that account. |

The synthetic identifiers used to correlate native and Shell observations were session `c736f084…`, launch key `99a4710d…`, and accepted initial turn `56bdb987…`. They identify the fixture only.

On the resumed build the coordinator loaded the project Flow skill in the existing conversation and asked “Release-note preview: should it include a date?” through the ordinary session question control. Before the answer and again after quitting the native process, Shell returned `awaiting_answer`, the same question `6b8a25e1…`, the accepted initial turn `56bdb987…` and exactly one candidate Flow. GitHub's owner-scoped REST endpoint also confirmed that the synthetic issue was #2, had Markdown, zero assignees and zero comments. The ambient account was denied this private issue.

On build `b3be63932`, reopening the application retained Needs an answer on the card and both historical question tool calls in the existing session. The active Answer dialog did not reappear, including after switching between two entries in Sessions. Shell retained the durable question. The Desktop session-registry admission path rejected new question requests on an idle, restored session. On the same build the native Sessions header’s Open source issue button opened fixture #2 and its discussion.

Build `71d514143` restored the original date question in the ordinary answer dialog after a cold start. The operator chose **Omit the date entirely**. The coordinator resumed and asked about the intended audience. The operator chose **E2E test operators of this fixture**.

The cropped [native issue detail capture](issue-detail.jpg) shows the rendered synthetic Markdown and Comments below it.

## Outcome of preparation

The ordinary session resumed with both answers. Its first attempt to update the planning files used an unsupported patch format. The operator sent one follow-up to continue in the same session. The coordinator then wrote the plan and eight criteria, updated the description and context, and registered seven implementation tasks with dependencies. Shell showed four resolved scaffold tasks out of eleven, stage `prepared`, and one linked Flow (001). The plan included the operator's undated format, E2E operator audience and local-only preview. The native card displayed “Plan and criteria ready for Freeze.” The test stopped before freezing or starting the fixture implementation.

## Open a Shell Flow in Desktop

For separate disposable issue #3, Shell created Flow 002 with `keryx flow init --issue <fixture-issue-url> --slug shell-first --base main`. Opening the issue's Flow from the board displayed Flow #002 in Desktop. Repeating initialization returned existing Flow 002. An explicit `--new` created Flow 003 with slug `shell-second`. The issue card then displayed “Choose the linked Flow” with both package directories and their initializing states. Selecting the second entry opened Flow #003. Fixture issue #2 continued to resolve exclusively to Flow 001.

## Live GitHub Project write and conflict

The owner-scoped GitHub CLI reported fixture issue #2 in Todo. In Desktop, changing its Project Status to In Progress moved the card into the In Progress lane. A separate `gh project item-list` read confirmed In Progress. The local launch remained prepared with exactly one package, Flow 001.

For the concurrency check the second client changed the same item back to Todo while the displayed Desktop card still said In Progress. Selecting Done in that stale card returned “Another update changed this item to Todo.” Desktop displayed Todo, and an independent GitHub read confirmed Todo. This restored the original remote Status. No machine-wide network settings were changed for this run.

For the narrow layout, the operator tiled the native window to half the display (865 logical pixels wide) and opened its Browser panel, leaving about 294 logical pixels for Issues. The issue card then opened full-width in the remaining work area. The issue detail was the only accessible content of the WebView while open; Escape closed it and restored the board.

## Ordinary Shell without an issue

In a separate disposable checkout, the native CLI built from `c9c3cf812` ran a normal Keryx Shell with the project flow-orchestrator. The operator requested a local Markdown heading. The coordinator created a description-sourced package with one executable criterion and stopped before Freeze. In this separate checkout the operator ran the ordinary `flow freeze`, `flow start` and `flow next` commands. Shell reported ready, then in-progress, then task T1. The issue-sourced package in the private fixture remained available for inspection before Freeze.

The narrow native accessibility snapshot did not identify the focused node after Escape, and keyboard reactivation could not be independently confirmed in that layout. After switching to List, the same issue row still showed “Plan and criteria ready for Freeze.” and Project Status Todo. Network loss, a readable Project with write access denied, and multi-page comment ordering were not exercised against live GitHub in this fixture.

## Cold-start smoke at 593f1dfd7

The rebuilt native app opened the private Project from its saved owner, number and List preference. Both List and Board showed the prepared issue. On the Project card the accessible text now read “open Preparing Unassigned Plan and criteria ready for Freeze.” with distinct metadata. Status was Todo. In the narrow layout Escape closed the issue and returned the board. The macOS accessibility transport did not identify the focused control, and Enter after Escape did not visibly reopen the card. This build did not restore keyboard navigation reliably. The final retest below records the correction. Clicking Open Flow from the card opened the existing initializing package 001 and its source action.

For an isolated connectivity check the bundled Shell client ran one Project read with process-local HTTP(S) proxy variables pointing at an unused loopback port. It returned exit 1 and “offline: Could not reach GitHub. Check the connection and refresh.” This exercises the real bundled transport. The native window stayed online, so the stale-snapshot presentation after disconnection was not observed in Desktop.

A temporary QA build based on the same commit exposed an observation-only status for the card opener and `document.activeElement`. Opening fixture #2 displayed “QA opener captured.” After Escape and a 400 ms settling interval the board was visible, but the indicator read “QA focus other BODY docFocus=true.” This confirms an actual focus-loss defect in that revision's narrow layout.

After moving focus restoration to the effect that follows rendering the board and cleaning up the modal, the same cold-start test passed. The macOS accessibility tree explicitly identified the original issue #2 card button as the focused element after Escape. The independent indicator read “QA focus same opener BUTTON docFocus=true visible=true sequence=opener.” Pressing Enter without clicking reopened issue #2 and moved focus to Close issue. The observation-only indicator was used in QA for this check.

## Verification boundaries

The private fixture had no comments. GitHub CI exercised a two-page discussion, a failed page load, retry and duplicate suppression in the Desktop view. A separate read-only Project member and a Desktop disconnection during a mutation were unavailable for the live run. CI exercised read-only writes, a lost mutation reply and conflicting readback at the Projects transport boundary. No auxiliary QA code is included in the PR.

## GitHub checks for the final implementation

All 28 applicable PR checks passed on `9775f8fadc12c9e988edf92750362ebe158e8389`. GitHub Pages deployment was skipped on the pull request. The [main CI run](https://github.com/MrCipherSmith/keryx/actions/runs/44955430321) includes the four Core partitions, terminal and ACP client matrix, native command coverage, lint and type-check. The [Issues acceptance job](https://github.com/MrCipherSmith/keryx/actions/runs/44955430321/job/137002426840) covers the 13 frozen executable criteria. The [Desktop job](https://github.com/MrCipherSmith/keryx/actions/runs/44955430327/job/137002341112) covers the Rust bridge, Clippy and WebView tests. The interactive keyboard retest used the same final implementation with an observation-only indicator. A clean QA bundle was rebuilt after removing that indicator.
