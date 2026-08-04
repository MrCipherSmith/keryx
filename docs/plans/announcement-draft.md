# Announcement draft

Status: **draft, for the author to post.** Nothing here has been published.
Created: 2026-08-04, for `0.2.8`.

Written to Phase 7's rules: one demonstrated thing rather than a feature list,
the boundaries stated in the post itself, and every number re-derivable by a
reader who clones the repository.

---

## The post

> Agents keep rediscovering things my repository already knows.
>
> Which files relate to which. What was decided, and why. What broke the last
> time someone tried this. Every task, every agent, every person — and the
> answers land in scratchpads, CI logs and IDE rule files that never agree.
>
> So I built **keryx**: it writes those answers *into the repository*, as
> Markdown and JSON under `.metaproject/`, and points every agent at one index.
> The context is versioned with the code and readable in a diff.
>
> Here it is on a freshly cloned `expressjs/express` — four commands, nothing
> edited:
>
> ```
> $ keryx init --yes
> $ keryx gdgraph build
> gdgraph build complete: 139 nodes, 153 edges
>
> $ keryx gdgraph affected lib/express.js
> ## Dependencies
> - lib/application.js
> - lib/request.js
> - lib/response.js
> ## Dependents
> - examples/route-map/index.js
> - index.js
> ```
>
> *What breaks if I change this* is the question an agent otherwise reconstructs
> from a dozen file reads, and gets wrong on exactly the files where it matters.
>
> **What it is not**, because you should know before you install rather than
> after:
>
> — There is no hosted service. Nothing runs unless you start it.
> — Remote approvals are **not implemented**. A remote turn that needs one is
> denied, and the denial is recorded.
> — The network allowlist, credential masking and TLS termination are
> **macOS-only** and *refuse* on Linux rather than quietly doing less.
> — It does deterministic mechanics — scan, graph, score, checksum. The
> judgement stays with you.
>
> Zero runtime dependencies. MIT.
>
> Docs: https://mrciphersmith.github.io/keryx/
> Code: https://github.com/MrCipherSmith/keryx
>
> ⚠️ Install the **scoped** package — `npm install -g @mrciphersmith/keryx`.
> The unscoped `keryx` on npm is an unrelated project.

---

## Notes for the author

### The disambiguation is not optional

`npm install -g keryx` installs
[actionhero/keryx](https://github.com/actionhero/keryx) — an actively
maintained framework in the adjacent MCP space, with its own site. Any post,
comment or reply that names the project without the scope will send someone to
the wrong program. Carry the warning every time.

### Do not post before these two are true

1. **`@mrciphersmith/keryx` is actually published.** It is not yet: the release
   workflow needs an `NPM_TOKEN` repository secret, and then a `v0.2.8` tag.
   A post whose install command 404s is worse than no post.
2. **The docs site is reachable.** It is — https://mrciphersmith.github.io/keryx/
   returned 200 on 2026-08-03, with all five guides live.

### The three questions that will be asked

Prepared answers, all defensible from the repository:

**"How is this different from my agent's own memory?"**
An agent's memory is per-agent, per-vendor, and invisible to your teammates.
This is a directory in your repository — it diffs, it reviews, it survives
switching tools, and a human can read it. It is also *derived*: the graph is
rebuilt from the code, so it cannot drift into fiction the way a chat log does.

**"What happens to my code?"**
Nothing leaves the machine unless you configure something that does. There is no
database and nothing running by default. The two HTTP surfaces — `mcp serve
--http` and `keryx serve` — are off until you start them, and `keryx serve`
binds loopback and authenticates *before* routing. Model-backed features are
opt-in, and the deterministic core does not call them.

**"Why Bun?"**
Single-binary distribution and a fast startup for something that runs on every
git hook. The honest cost: it is a Bun runtime dependency, and that is a real
constraint if your team is standardised on Node.

### One more, and answer it plainly if asked

**"Is this production-ready?"**
It is `0.2.x`, and the version means what it says. The known gaps are listed in
[CHANGELOG.md](../../CHANGELOG.md) under *Known gaps* and in the
[readiness report](../report/release-readiness-2026-08-03/release-readiness.md)
— approvals, `GET /health`, the macOS-only tier, and a handful of modules that
are implemented and tested but not wired to any caller. Pointing at that list is
a better answer than a confident yes.

### What not to claim

- **No performance claim.** The benchmark harness exists precisely so one could
  be made honestly, and none has been. Do not imply a speedup.
- **Not "ML-powered".** The semantic and ML detectors have **no runtime
  shipped**; they run on their deterministic floor. Saying otherwise is the
  exact failure this project spent six review rounds learning to avoid.
- **Not "fully sandboxed".** Say which tier, on which platform.
