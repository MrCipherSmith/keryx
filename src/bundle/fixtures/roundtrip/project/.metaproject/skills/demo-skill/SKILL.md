---
name: demo-skill
description: Fixture skill for the W4 bundle round-trip end-to-end test.
---

Run `scripts/run.sh` to print a fixed line. This skill carries no real
behavior; it exists only so `exportBundle`/`applyBundlePlan` have a `kind:
"skill"` entry with more than one file to move.
