---
description: Keryx is a project-local brain for AI agents and teams. Wiki, code graph, memory, skills and flows in one workspace, plus a terminal shell with its own agent harness.
---

# Keryx

<img src="assets/keryx-mark.svg" alt="" width="72" align="right">

**One project-local brain for your AI agents and your team.**

Keryx keeps a project's knowledge, rules and work history in a `.metaproject/` folder next to your code. Your agents read it, the `keryx` shell works from it, and your team reviews it like any other file.

```sh
npm i -g @mrciphersmith/keryx
```

<div class="hero-buttons" markdown>
[Get started](getting-started/install.md){ .md-button .md-button--primary }
[GitHub](https://github.com/MrCipherSmith/keryx){ .md-button }
</div>

![keryx init, doctor and the code graph in a small project](assets/demo.gif)

## What is in it

<div class="grid cards" markdown>

-   **Project knowledge**

    ---

    A wiki, a code graph and project memory that every agent in the project reads from the same place.

    [:octicons-arrow-right-24: Project knowledge](modules/project-knowledge.md)

-   **The shell**

    ---

    A terminal shell where an agent works inside your repository, with approval modes and `/rewind`.

    [:octicons-arrow-right-24: The keryx shell](modules/shell.md)

-   **Managed work**

    ---

    Flows, jobs and tasks with frozen acceptance criteria, journals and evidence.

    [:octicons-arrow-right-24: Managed work](modules/managed-work.md)

-   **Review**

    ---

    Reviews that leave a durable record, and a pull request bot that can be measured.

    [:octicons-arrow-right-24: Review with a durable record](guides/review-with-a-record.md)

-   **Safety**

    ---

    A harness with a policy engine, containment and a completion gate between an agent and your machine.

    [:octicons-arrow-right-24: Harness and safety](modules/harness-and-safety.md)

-   **Connect your agents**

    ---

    Adapters that install Keryx's context into the agents and editors you already use.

    [:octicons-arrow-right-24: Connect your agents](modules/integrations.md)

</div>

## Pick your path

| You are | Start here |
|---|---|
| New to Keryx | [Quickstart](getting-started/quickstart.md) |
| Evaluating it | [Keryx in five minutes](getting-started/concepts.md) and [Project status](project/status.md) |
| Wiring up an agent | [Connect your agents](modules/integrations.md), and [llms.txt](https://mrciphersmith.github.io/keryx/llms.txt) for the machine-readable index |
| Contributing | [Built with Keryx](project/built-with-keryx.md) and [Contributing and support](project/contributing.md) |

---

*Keryx is pre-1.0 and published to npm with provenance. macOS is fully supported; Linux supports the core with a sandbox that has no domain allowlist; Windows is unverified. See [Project status](project/status.md) for platforms and stability, and the [Changelog](project/changelog.md) for what changed.*
