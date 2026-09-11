# keryx shell loses the arena on tools and errors: self-spawned keryx, provider identity and error bodies, search noise, project-blind roster, head-only read_file

Status: formalized
Source: arena measurement, `arena/keryx-shell-defects.md` on branch `arena/measurement`
(K-004, K-005, K-008, K-009, S-1)

## Problem

The arena runs keryx's own shell and the grok CLI on the SAME model (grok-4.6)
against the same task. On the first completed smoke (task `t1-53254e0e`, four gold
files) the grok CLI found 4/4 and keryx-shell 1/4 — in both arms, with and without
`.metaproject/`. A kept transcript of a keryx-shell arm (43 tool calls) shows the
shell's own tools and error handling working against the model:

- **K-005** — a provider refusal is reported as `Ollama API returned HTTP 403` on a
  grok session: every OpenAI-compatible provider is constructed with Ollama's
  identity (`make-provider.ts`), a non-JSON or non-`error.message` body is dropped,
  and every 4xx is classified `invalid_request`. The grok CLI, on the same account
  state, printed `402 Payment Required: Grok Build usage balance exhausted`.
- **K-008** — `search_code` prints the absolute checkout path on every match line
  (the path argument is passed to ripgrep absolute), a search for `6435` returned
  8 KB of one-line matches inside an SVG, and a clipped result says only
  `…(truncated)`, so the model cannot tell how much it did not see.
- **K-009** — the roster offers ~20 metaproject tools in a project that has no
  `.metaproject/`. The arm called `graph_find` and got `index-incomplete … never
  built here`. Each is also a description the model reads every round.
- **S-1** — `read_file` returns only the first 20,000 bytes and has no way to read
  further; the one gold file the smoke's answer did contain was clipped there.
- **K-004** — `makeKeryxRunner` spawns whatever `keryx` PATH resolves. In the shell
  that path is narrower than first logged (the shell always passes an in-process
  port; only `search_code`'s fallback and the port-less tool set use the runner),
  but where it is used it runs a different keryx than the one executing — in the
  arena, the 0.2.84 release under a shell built from source.

## Expected Outcome

- Errors from an OpenAI-compatible provider name that provider, carry the status
  and the server's reason (redacted, bounded), and classify auth and rate limits.
- `search_code` output is repository-relative, long lines are capped, and a clipped
  result says how much was shown out of how much.
- A project without `.metaproject/` is not offered tools that can only fail there;
  a project with one gets exactly today's roster.
- `read_file` can read past the first 20 KB of a file, by line, with bounded memory.
- The subprocess runner invokes the keryx that is running.

## Out of Scope

- The system prompt (`buildAgentSystemInstruction`). K-006 (hunting the commit in
  git history) is unconfirmed until the arena compares grok-build on the same task,
  and K-007 (not committing to an answer) is a prompt change the operator deferred.
  Consequence recorded as a follow-up: the prompt names tools statically, so in a
  project without `.metaproject/` it will mention tools the roster no longer offers.
- Keeping a turn's partial findings when the provider fails mid-turn (K-005's third
  part) — an agent-loop change, not an error-reporting one.
- Giving each compat provider its own `providerId` / `providerRevision`; tests pin
  `"ollama"` there and make-provider.ts records it as a separate naming fix.
- Arena-side changes (the provisioner's PATH keryx) — they live on `arena/measurement`.
