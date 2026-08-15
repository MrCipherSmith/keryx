# OpenTUI session-info inspector on the shared modal host

Status: ready to freeze
Source: docs/requirements/keryx-opentui-session-info/

## Problem

Grok `/session-info` (`/status`, `/info`) shows a modal inspector. Keryx has
session metadata and usage estimates but no inspector and no those slash
tokens.

## Expected Outcome

`/session-info`, `/status`, `/info` in chat and agent modes open the **shared**
modal host (flow 154) on a Session tab (plus Usage). Fields come from
`SessionSummary` + live selection + usage/estimate. `c` copies id, `y` copies
the block. Readline prints the same rows. Slash never hits `provider.stream`.

## Out of Scope

Building the modal host (flow 154). Grok OAuth/sandbox/model-hash rows.
Mouse copy. `/model` migration. Changing `keryx status` CLI.
