# Shell TUI sidebar cards: Work card counters and dynamic drill-down tabs for subagents and jobs

Status: draft (flow-init skill formalizes this)
Source: user description

## Problem

After sidebar sections were grouped into cards (PR #1070, flow 468), card detail tabs flattened each section into text. Subagent and background-job rows lost their click targets, and Work needs live worker counters.

## Expected Outcome

Work shows active/successful worker counters from live stores. Clicking a structured worker row opens its live inspector in a temporary tab of the same modal. Returning to a source tab or pressing Escape removes the temporary tab and releases inspector subscriptions. Closing the modal releases active subscriptions too.

## Outcome criteria

- Users can inspect live subagent work and job output from Work, return to the updated list, and repeat without accumulating tabs or subscriptions. Automated counter, click, modal lifecycle and embedded inspector tests verify this; production usage is not measured.

## Out of Scope

Changing worker execution/status semantics, redesigning existing inspectors, converting unrelated card sections to entity lists, publishing a release, or merging a PR. Structured item/render callbacks provide an extension point for future entity types.
