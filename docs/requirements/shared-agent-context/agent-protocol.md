# Keryx Shared Agent Context — Agent Protocol
Version: 1.2.0

## Status

Future protocol. It specifies agent behavior once SAC adapters exist; it does
not claim that an agent currently receives these tools automatically.

## Preconditions

An agent must receive a server-created `ActorContext`, workspace reference and,
when work-bound, a Flow reference. It must treat absent, denied or stale data as
unknown. It may not infer access from a filesystem path or prior conversation.

`ActorContext` contains an opaque stable subject, authentication method and
time, issued-role/revision, and a request correlation ID. It is created only by
a trusted local CLI/Harness boundary from the operating-system user or a
verified Harness session; it is propagated in-process to SAC and never accepted
from a tool argument, manifest field, prompt, environment variable or MCP
request payload. A caller-provided actor ID is display metadata at most and
never an authorization input.

For v1 MCP, SAC read tools are available only on the local single-user stdio
transport launched by the same trusted user. The transport supplies no remote
identity and therefore may not widen access beyond that user's local role. HTTP
or other remote transports, delegated credentials and multi-user use are out of
scope until they pass a verified principal or scoped capability to the server;
an unverified request is denied before workspace discovery. Every authorization
decision re-resolves the current role revision at the point of use.

## Read protocol

1. Request the smallest overview consistent with the current task and budget.
2. Distinguish Facts, Work and Know-how in every work product summary.
3. Follow evidence references before relying on a material Fact.
4. Request detail only through the authorised future CLI/MCP surface.
5. Respect `denied`, `stale`, `expired`, `withdrawn` and budget exhaustion; do
   not substitute hidden cache/transcript content.
6. Attribute material statements to reference IDs, not copied secret content.

When a mandatory overview item cannot fit the requested budget, the operation
returns typed `context_overflow` and no successful manifest/receipt. It may
return a successful partial result only after all mandatory items fit, only for
optional details, and only with `partial: true` plus identifiers of every
omitted optional item. The agent must not represent either result as complete.

## Work protocol

The agent reads Work from Flow and reports discrepancies. It must use existing
Flow commands/APIs for any work-state change; SAC is never an alternate tracker
or completion channel.

## Wrap-up and proposal protocol

The agent may propose only an explicit summary, decision, contract change, risk
or follow-up. It must include evidence IDs and target intent. It must not submit
raw transcripts, prompts, hidden reasoning, credentials, PII, unverified web
content or a claim that a target was updated.

Creation accepts only a server-issued, one-time `WrapUpProvenance` capability
created from an explicit completed Session or a read-only Flow wrap-up snapshot.
It binds the workspace, authenticated actor, source reference/revision, exact
summary digest, evidence revisions, issue/expiry times and replay state. A CLI,
MCP payload, prompt or environment value cannot mint or alter this capability.
Creation writes one immutable `proposed` record with the capability's minimal
source metadata, a proposal revision and evidence revisions. A proposal is
never edited into another state. A state change appends a separately identified
transition event that points to the proposal revision and prior event.

An `accepted` transition is valid only when, in causal order: (1) the current
reviewer `ActorContext` has authority for the target; (2) the applicable
security policy and its exact version/revision pass; (3) every evidence and ACL
revision is fresh at transition time; (4) SAC durably appends a `pending-write`
intent containing the exact owner idempotency key; and (5) the owning target
completes its guarded write and returns a correlation- and intent-bound
target-write receipt. The accepted event retains the full receipt binding
(intent, proposal/revision/workspace, correlation/idempotency, reviewer
authority and policy revision), not a derived hash alone. The decision, intent
and write receipt must share their correlation ID. Recovery asks the owner for
its mandatory durable receipt lookup by the persisted key before any mutation, so a crash between
owner write and SAC receipt persistence cannot duplicate a mutation.
A retry with the same key returns the original terminal result; a different key
after a terminal result is rejected. A target-write failure appends a
non-accepted failure transition; it never leaves an ambiguous acceptance.

## Failure protocol

- Evidence unresolved/changed: mark candidate `stale` or omit the Fact.
- Role/visibility denial: report access limitation without naming hidden refs.
- Security `fail`/`needs-approval`: do not retry around the gate; return typed
  result and await the owning process.
- Mandatory budget exhaustion: return `context_overflow`, without a successful
  manifest/receipt; request a smaller authorised scope or a larger budget.
- Optional-detail budget exhaustion: return the bounded partial result and
  receipt with `partial` and `omittedOptional`; do not broaden retrieval.
- Identity unavailable, role revision changed, or transport untrusted: deny
  without workspace discovery and record only permitted audit metadata.

## Prohibited behavior

- Writing accepted knowledge directly or accepting own proposal.
- Editing workspace role map or Flow state without authorised native command.
- Persisting/replaying raw agent reasoning or data outside approved contracts.
- Treating optional learned policy output as a permission decision.

## Required protocol tests

- Actor spoofing: a supplied actor ID, prompt claim or MCP parameter cannot
  obtain another subject's role.
- Cross-workspace access: a valid actor cannot list or directly read a
  non-visible workspace or reference.
- Revoked role: a role removed after context creation is denied at the next
  read, proposal and review gate.
- TOCTOU: evidence, ACL or target ownership changed between validation and
  write invalidates acceptance and leaves no target mutation.
- Replay: duplicate delivery with the same idempotency key returns the original
  result; conflicting or late transitions do not change the terminal history.
- Crash recovery: a failure after invoking an owner but before SAC appends the
  terminal event resumes the durable write-intent with the same owner key and
  yields the original receipt without a duplicate target mutation.
- Budget: a missing mandatory item yields `context_overflow`; omitted optional
  details are explicitly named and cannot be presented as complete.
