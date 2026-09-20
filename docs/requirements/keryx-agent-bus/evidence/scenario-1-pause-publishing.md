# Evidence: Scenario 1 — pause publishing

Flow 279 T5, AC4. PRD scenario 1: A holds a `git-publish` lease over B; B's
`git push` then requires approval under `auto` mode; A resumes; B's push no
longer requires it.

This was run on a real throwaway clone with two **linked git worktrees**, each
running its own real `keryx shell` process from the working tree (agent
surface, readline — not the TUI). Nothing here is a unit test double for the
bus, the lease store or the presence store: every JSON blob below was read off
disk from files these two real processes wrote.

See [README.md](README.md) for what is and is not exercised across both
scenarios, and why.

## Setup

Every command below is real and was actually run to produce the output quoted
after it. `$ROOT` is the repo checkout this evidence lives in
(`/Users/Goodea/goodea/keryx-bus-p4` when reproducing against that checkout).
Run the block once to build the sandbox; the `bun` invocations later in this
file assume these variables are still set in the same shell.

```bash
WORK=$(mktemp -d)
REPO="$WORK/repo"
WT="$WORK/wt"

mkdir -p "$REPO"
cd "$REPO"
git init -q -b main .
echo x > README.md
git add .
git -c user.name=t -c user.email=t@example.com commit -q -m initial

git worktree add -q -b feature "$WT" main
```

Observed:

```
$ git worktree list
<repo>  <sha> [main]
<wt>    <sha> [feature]
```

Two linked worktrees of one clone — this is the AC4 setup.

Each shell gets its own throwaway `HOME`/`XDG_*`/`KERYX_DATA_DIR` so its bus
identity is never the operator's own (the pattern in
`src/commands/shell-pause.process.test.ts`). Both share `KERYX_BUS_POLL_MS=250`
so the evidence run does not sit through the production 1500 ms poll.

```bash
# Terminal A (holder), cwd = $REPO
export HOME="$WORK/envA/home" XDG_DATA_HOME="$WORK/envA/home/.local/share" \
       XDG_CONFIG_HOME="$WORK/envA/home/.config" KERYX_DATA_DIR="$WORK/envA/data" \
       KERYX_BUS_POLL_MS=250 NO_COLOR=1
mkdir -p "$HOME" "$KERYX_DATA_DIR"
cd "$REPO"
bun $ROOT/src/cli.ts shell --provider deepseek --model unused --no-tui --agent --name alpha

# Terminal B (target), cwd = $WT
export HOME="$WORK/envB/home" XDG_DATA_HOME="$WORK/envB/home/.local/share" \
       XDG_CONFIG_HOME="$WORK/envB/home/.config" KERYX_DATA_DIR="$WORK/envB/data" \
       KERYX_BUS_POLL_MS=250 NO_COLOR=1
mkdir -p "$HOME" "$KERYX_DATA_DIR"
cd "$WT"
bun $ROOT/src/cli.ts shell --provider deepseek --model unused --no-tui --agent --auto --name beta
```

`--provider deepseek --model unused` with no `DEEPSEEK_API_KEY` in either
sandbox env resolves (`src/harness/provider/make-provider.ts`) to the offline
`FakeProvider([])` — no network call is ever attempted by either shell. This
matters for what this evidence can and cannot show; see
[README.md](README.md).

## Step 1 — the two worktrees see each other (AC4)

Both shells printed, on join:

```
bus: joined as @alpha · 0 peers
bus: joined as @beta · 0 peers
```

The real presence store (`<git-common-dir>/keryx/bus/root/presence/*.json`)
then held exactly two records:

```json
[
  {
    "instanceId": "0976db3f-36de-40dc-8fe0-36e29f98d9d3",
    "name": "alpha",
    "checkout": ".../repo",
    "branch": "main",
    "surface": "readline",
    "status": "idle"
  },
  {
    "instanceId": "a41b4896-510f-4cab-acfe-9284de181def",
    "name": "beta",
    "checkout": ".../wt",
    "branch": "feature",
    "surface": "readline",
    "status": "idle"
  }
]
```

`bun $ROOT/src/cli.ts bus list --json`, run from **both** `$REPO` (as alpha)
and `$WT` (as beta), returned the same two peers, both `"state": "live"`:

```json
{
  "peers": [
    { "name": "alpha", "state": "live", "checkout": ".../repo",  "branch": "main" },
    { "name": "beta",  "state": "live", "checkout": ".../wt",    "branch": "feature" }
  ],
  "leases": []
}
```

**Proves:** two shells in two linked worktrees of one clone list each other in
`keryx bus list` (AC4's first clause). Live, on-disk, from two real processes.

## Step 2 — baseline: no lease, `auto` bypasses the prompt

Before any lease exists, the exact inputs `executeCall`'s shell branch
(`src/commands/agent.ts`) would compute for a `git push` from B were
reproduced with a small driver script that imports the real, unmodified
production functions and nothing else:

```ts
// driver.ts — argv: <busRoot> <instanceId> <command>
import { createLeaseView } from "src/bus/pause.ts";
import { resolveApprovalDecision } from "src/commands/permission-mode.ts";
import { isPublishCommand } from "src/lib/command-risk.ts";

const [root, instanceId, command] = process.argv.slice(2);
const view = createLeaseView({ root, instanceId });
await view.refresh();
const publishLease = isPublishCommand(command) && view.appliesToMe("git-publish");
const decision = resolveApprovalDecision({
  mode: "auto", risk: "shell", destructive: false, credentials: false,
  sacReviewConfirmation: false, readOnly: false, publishLease,
});
console.log(JSON.stringify({ command, publishLease, decision }));
```

This is the same technique `src/commands/shell-pause.process.test.ts` already
uses for its AC11 coverage — see [README.md](README.md) for why a driver
script, not a live `git push`, is what is being run here.

Run with B's real `instanceId` and the real bus root from Step 1:

```
$ bun driver.ts "$BUS_ROOT" a41b4896-510f-4cab-acfe-9284de181def "git push origin feature"
{"command":"git push origin feature","publishLease":false,"decision":"auto"}

$ bun driver.ts "$BUS_ROOT" a41b4896-510f-4cab-acfe-9284de181def "git status"
{"command":"git status","publishLease":false,"decision":"auto"}
```

**Proves:** without a lease, `auto` mode never escalates a shell command
(baseline for the next step).

## Step 3 — A pauses B's publishing

Typed into shell A:

```
/bus pause @beta --scope git-publish --ttl 30m evidence run: publishing pause
```

A printed:

```
bus: paused git-publish for @beta (lease a50b3caf, expires 2026-09-20T12:13:34.843Z)
```

B printed, within one poll interval (250 ms):

```
⇄ [#1] @alpha pause-request: evidence run: publishing pause
```

The real lease file on disk (`leases/a50b3caf-*.json`):

```json
{
  "leaseId": "a50b3caf-70e8-4196-a804-d1e663626068",
  "holder": { "instanceId": "0976db3f-...", "name": "alpha", "origin": "operator" },
  "targets": ["a41b4896-510f-4cab-acfe-9284de181def"],
  "scope": "git-publish",
  "reason": "evidence run: publishing pause",
  "createdAt": "2026-09-20T11:43:34.843Z",
  "expiresAt": "2026-09-20T12:13:34.843Z",
  "requestEventSeq": 1
}
```

The real event log (`events.jsonl`), event 1:

```json
{
  "seq": 1,
  "id": "79d9a9ce-64f7-4a82-8ff1-2807789c7ee3",
  "kind": "pause-request",
  "from": "alpha",
  "to": "@beta",
  "refs": { "leaseId": "a50b3caf-70e8-4196-a804-d1e663626068" },
  "body": "evidence run: publishing pause"
}
```

**Proves:** a real, on-disk `git-publish` pause lease, created by a real
operator command in a real running shell, targeting a real live peer in the
other worktree, delivered to that peer over the real bus poll.

## Step 4 — B's `git push` now requires approval, in `auto` mode

Re-running the same driver against the **same live lease file**, unmodified:

```
$ bun driver.ts "$BUS_ROOT" a41b4896-510f-4cab-acfe-9284de181def "git push origin feature"
{"command":"git push origin feature","publishLease":true,"decision":"ask"}

$ bun driver.ts "$BUS_ROOT" a41b4896-510f-4cab-acfe-9284de181def "git status"
{"command":"git status","publishLease":false,"decision":"auto"}
```

**Proves:** `resolveApprovalDecision` — the real function `executeCall` calls
for every `shell_exec` — returns `ask` for a publish command while the lease
applies, **even though the shell is in `auto` mode**, matching specification
§4.4's publish floor. The unrelated `git status` command is unaffected
(ADR-0009: a classifier miss never grants, and the lease never widens what it
covers).

## Step 5 — A resumes; B's push no longer requires it

Typed into shell A:

```
/bus resume
```

A printed:

```
bus: resumed lease a50b3caf
```

B printed:

```
⇄ [#2] @alpha resume:
```

The lease store is now empty (`leases/` has no files); the event log's second
event:

```json
{
  "seq": 2,
  "id": "0c70cef2-56b7-4f22-8949-8f78f15e4383",
  "kind": "resume",
  "from": "alpha",
  "to": "@beta",
  "refs": { "leaseId": "a50b3caf-70e8-4196-a804-d1e663626068" }
}
```

Driver, run again with the same command:

```
$ bun driver.ts "$BUS_ROOT" a41b4896-510f-4cab-acfe-9284de181def "git push origin feature"
{"command":"git push origin feature","publishLease":false,"decision":"auto"}
```

**Proves:** the second half of the scenario — once A resumes, B's `git push`
is back to `auto`'s ordinary behaviour. Both shells then exited cleanly on
`/exit` (exit code `0` each).

## Result

**Held.** Scenario 1 passes exactly as the PRD describes it, on a real clone
with two real linked worktrees and two real running shells, both directions
(pause → escalate, resume → de-escalate).

## What was NOT exercised, and why

- **No real `git push` process was ever executed**, against a real or fake
  remote, gated or otherwise. The driver script computes the exact two
  boolean/string values (`publishLease`, `decision`) that
  `executeCall`'s shell branch (`src/commands/agent.ts`) would compute for a
  `shell_exec` call carrying that command string, calling the real,
  unmodified `isPublishCommand` and `resolveApprovalDecision` functions
  directly. It does not spawn `git`, does not go through `shell_exec`, and
  does not touch a network. This is the same substitution
  `src/commands/shell-pause.process.test.ts` makes for the identical
  scenario (its `"git-publish under auto"` test), for the reason below.
- **No live model ever decided to call `shell_exec("git push")`.** Both
  shells run `--provider deepseek --model unused` with no API key configured
  in either sandbox environment, which resolves to the offline
  `FakeProvider([])` (`src/harness/provider/make-provider.ts`) — a
  provider with zero transcripts that errors on the first call rather than
  reaching a network. There is no way to make `keryx shell`'s real agent
  turn actually invoke `shell_exec` without a real model (or a fixture the
  `FakeProvider` can match by exact request hash, which is impractical to
  construct against a live interactive session's system prompt). This is
  exactly the AC6 gap the dispatch anticipated: an agent turn needs a
  provider.
- **No human ever saw or answered a real approval prompt.** `ask` in the
  driver's output is the *decision* `resolveApprovalDecision` returns, not an
  interactive prompt rendered and answered. The prompt-rendering and
  allowlist-exclusion code (`evaluateShellApproval`,
  `src/commands/shell-approval.ts`) is unexercised by this evidence run —
  it is covered by the project's own unit suite
  (`src/commands/permission-mode.test.ts`, `src/commands/shell-approval.test.ts`),
  not by this dispatch.
- The bare `git push origin feature` command itself would have failed at the
  git layer in this sandbox regardless of any lease (no `origin` remote was
  configured) — irrelevant to what this scenario is about, since the
  approval floor sits in front of the command, not behind it, but worth
  stating so the driver's `"git push origin feature"` string is not
  mistaken for a command that was actually capable of succeeding here.
