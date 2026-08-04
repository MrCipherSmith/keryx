# Run keryx in CI

**The problem:** the workspace is only useful while it is current, and nobody
remembers to refresh it by hand.

**What you get:** committable, normalized artifacts that humans and agents read
later, plus gates that fail a job on a signal instead of on a grep over a
linter's output.

Every command below was executed on this repository; the output is from those
runs.

## The refresh sequence

```bash
keryx gdgraph build
keryx test analyze
keryx health run --changed
keryx dashboard build
```

Each writes under `.metaproject/data/`. The lifecycle commands (`init`,
`update`) never write there, so a self-update refreshes the toolchain without
destroying accumulated knowledge.

```console
$ keryx test analyze
frameworks: bun
scripts: 3
configs: 2
test files: 295
recommendations: 0
```

## The gates

### Code health

```console
$ keryx health gate --strict-warn
gate: pass
- PASS: no gate conditions triggered
```

Non-zero exit fails the job. `--strict-warn` makes a warning fatal.

### Security detector false-negative rate

This is the one worth adding even if you add nothing else, because it fails on
a *measured regression* rather than on a feeling:

```console
$ keryx security eval --corpus all
detector                     pos   TP   FN   FP   fnRate  ceiling  status
egress                         9    9    0    0   0.0000   0.0000   ok
pii.credit-card                3    3    0    0   0.0000   0.0000   ok
pii.iban                       2    2    0    0   0.0000   0.0000   ok
pii.ip                         2    2    0    0   0.0000   0.0000   ok
pii.phone                      1    1    0    0   0.0000   0.0000   ok
pii.ssn                        1    1    0    0   0.0000   0.0000   ok
prompt-injection               8    5    3    0   0.3750   0.5000   ok
secret                         3    3    0    0   0.0000   0.0000   ok
  ✓ all detectors within FN-rate ceilings
```

Read the `prompt-injection` row rather than the summary line. It misses **three
of eight** positives, and that is `ok` because its committed ceiling is 0.5.
The gate does not claim the detector is good; it claims the detector has not
got worse than a number someone wrote down and can defend. Every other detector
here has a ceiling of zero, which is a much stronger statement.

### Documentation links

If you keep documentation in the repository:

```console
$ bun run check:doc-links
checked 567 relative links across 175 files, 0 broken
```

It resolves `#anchor` fragments against the target's headings, and fails if it
checked *zero* links — a glob that quietly stops matching should not look like a
clean sweep. This gate found 39 broken links the first time it ran here.

## A minimal workflow

```yaml
- run: keryx gdgraph build
- run: keryx test analyze
- run: keryx health run --changed
- run: keryx health gate --strict-warn
- run: keryx security eval --corpus all
```

Install `ripgrep` on the runner if anything in your pipeline uses `keryx ctx rg`
or the agent's `search_code` — it exits non-zero without it rather than falling
back.

## Verify

```console
$ keryx health gate --strict-warn && echo "gate exit: $?"
```

A `0` means the gate ran and passed. If you get a pass without the artifacts
having been rebuilt first, you are gating on stale data — run the refresh
sequence in the same job.

## Where to go next

- [Give an agent context](give-an-agent-context.md) — what these artifacts are for.
- [CLI reference](../cli-reference.md) — flags and exit codes.
