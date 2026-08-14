# Shared Agent Context — Lifecycle Binding Agent Protocol
Version: 0.1.0

## Status

Future / planned protocol. Agents must not assume a current workspace or
binding exists in the current runtime.

## Discovery

1. Prefer future `workspace current` for the trusted active Session.
2. Use future `workspace list` only when the task needs a choice; treat it as
   reference-only discovery, not context retrieval.
3. If no valid binding exists, use an explicit authorised workspace ID. Do not
   infer it from a filesystem path, prompt, previous transcript, Flow title, or
   worktree name.
4. Treat `not_bound`, `binding_stale`, `binding_ambiguous`, and denial as
   absence of usable context; never probe IDs to distinguish those states.

## Read and resume

`--session current` is a convenience resolver, not an access grant. After
resolution, agents must request the smallest ordinary overview/read suitable
for the task. They must follow Context Operations budgets, progressive
disclosure, stale/denied outcomes and receipt rules. A binding must not cause
automatic injection of workspace entries, Session content, Flow content, or an
accepted target into a model context.

On resume, an agent may report the binding's minimal metadata and request
authorised detail. It must not represent the previous Session's transcript or
Flow projection as a current truth without a fresh read.

## Flow and worktree

An agent may request a derivation preview for a visible Flow/worktree pairing.
It must describe the result as a proposal until an authorised operator creates
it. It may not use the preview to alter Flow, create a worktree, change a
workspace, or claim a selected current workspace.

## Completion and promotion

At completion, the agent may make an explicit minimal wrap-up proposal under
the existing SAC proposal protocol. It must not mark Flow complete, accept its
own proposal, promote content, or request link-back implicitly. After owner
acceptance, it may request explicit link-back only with the relevant receipt
and authority; it must report link-back as pending/succeeded/failed separately
from owner acceptance.

## Prohibited behaviour

- Passing actor, role, Session principal, or current workspace as a forged tool
  argument.
- Copying an entire workspace, Session archive, Flow snapshot, or owner artifact
  into a prompt merely because a binding exists.
- Treating one worktree path as authority for another worktree or workspace.
- Using SAC as a Flow completion channel or assuming accepted targets are
  automatically attached to a workspace.
