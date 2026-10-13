# Third-party notices

Keryx adapts a small number of techniques from third-party works. This file
carries the notices their licenses require. Everything else in this
repository is covered by [LICENSE](LICENSE).

## agent-skills (MIT)

Source: https://github.com/addyosmani/agent-skills

Techniques adapted from this skills library and re-expressed in Keryx's own
words and mechanisms:

- `src/gdskills/bundled/skills/quality/root-cause` — carrying a debugging skill.
- `src/gdskills/bundled/skills/quality/fresh-eyes` — the in-flight doubt pass
  (a reader gets the artifact and the contract, never the author's reasoning).
- `src/gdskills/bundled/skills/quality/api-truth` — checking a dependency before
  calling it and marking what went out unchecked.
- `src/gdskills/bundled/skills/quality/deprecation-path` — carrying a
  deprecation skill.
- `src/gdskills/bundled/skills/quality/perf-check` — "neutral is a revert" and
  the ledger of reverted attempts.
- `src/gdskills/bundled/skills/planning/interviewer` — a hedged agreement is not
  approval.
- `src/gdskills/bundled/skills/orchestration/task-implementer` — the
  noticed-but-not-touching / assumptions / not-touched result fields.
- `src/review/floor.ts` — the catalogue of four test-weakening edits.
- `src/gdskills/bundled-eval.ts` — the required skill anatomy, the length budget
  and description discipline, made executable.
- `src/commands/routing-corpus.ts` — the routing corpus shape (positive prompts
  per skill, negatives naming the owner that must outrank them).
- `docs/skills/rejected-skill-changes.md` — the rejected-change ledger.

```
MIT License

Copyright (c) 2025 Addy Osmani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
