# Product Module — Theory

Version: 0.1.0

## Why a theory document

The module is derived, not invented. This document states what it is derived
from, separates what is already established from what is not, and records the
predictions the design is betting on — so that a later reader can check whether
the bet paid.

## Three phase transitions

### 1. Producing an artefact fell to near-zero cost

A spec, a ticket, a prototype, code — all of it moved from person-days to
minutes. What changed is not typing speed but **the cost of an attempt**. When
an attempt was expensive, people thought before attempting. When an attempt is
cheaper than the deliberation about it, behaviour changes entirely, not
marginally.

This is the only transition everyone noticed, and the only one the tool market
serves: every product of 2026 sells the same thing — produce faster.

### 2. The bottleneck moved from production to verification

Development is sequential: decide, describe, build, verify, release. Speed up
one step tenfold and leave the rest, and total time barely moves — you reach the
next step. Three steps were accelerated. The fourth was not, because trust is
human.

Measured consequences: AI-authored pull requests wait **4.6×** longer for review;
**38 %** of developers say such code takes more effort to review; **96 %** do not
fully trust it; and the enterprise product backlog **did not shrink at all**
across a year of heavy adoption.

### 3. Product attention stopped scaling

This is the transition nobody discusses, and it is the one this module addresses.

Product work always consisted of applying judgement to each decision
individually: read the requirement and decide whether it is the right one, look
at the criterion and decide whether it is enough, look at the result and decide
whether it is accepted. Per-item judgement *was* the job, not overhead around it.

The number of items rose by an order of magnitude. The head stayed one.

The profession did not lose its work. **It lost the ability to tell which part of
its work still requires it** — because from the outside everything looks
identical. A criterion closed by running a test and a criterion someone wrote
"covered" against are indistinguishable: both confirmed, both green, both pass
the same gate and carry the same signature.

That leaves two bad options — read everything, which is impossible, or trust
everything, which is dangerous — and in practice a third: read whatever surfaced.
Attention is allocated by chance rather than by risk.

## Current trends, with figures

| Finding | Figure | Consequence |
|---|---|---|
| Ideas that do not work (Cagan; still true in 2026) | 50–75 % | If one idea in four survives and nobody looks back, the signal from the other three is discarded entirely. The process produces four times more waste than product and collects no data on it. |
| New companies with a single founder (Carta) | ⅓ | Developer and product owner converged into one head as the default mode, not the exception. |
| Tools built for the converged role | 0 | The market is split along a boundary that no longer exists: Jira, Linear, Productboard, Amplitude on one side; Cursor, Claude Code, Codex on the other. Each serves half a person. |
| Discovery | cheaper, not obsolete | "It matters more, not less — what changed is how fast and how cheaply you find out whether ideas work." Evals became a new discovery habit. |
| Teams measuring outcomes rather than outputs | **no data exists** | The evidence base is practitioner guidance, not studies, and it names the reason: outcomes are noisier than outputs, so outputs get measured. The missing number is itself a finding. |

## The prior literature — what this does not claim to have invented

"Roles dissolve, functions remain" is **not** an original claim here.

- **Work Without Jobs** (Jesuthasan & Boudreau, MIT Press, 2022): deconstruct a
  job into tasks and projects; describe a person by capability rather than by
  job description. The authors call it a new work operating system.
- **Skills-based organisations**: 79 % of HR leaders moving from job titles to a
  skills model; 59 % of CEOs treat critical-skill availability as a business risk.
- The same literature states the split this module's sibling package measured in
  product criteria, but for roles generally: *AI dissolves the work that defined
  the bottom half of traditional roles and extends the work that defined the top
  half.* The K-shaped split is a general mechanism, already described.

Three gaps remain, and the third is this package's ground.

1. That literature lives in HR and organisational design — talent marketplaces,
   skills-based pay, learning. It says nothing about the tools the work is done with.
2. The idea won at the level of org charts and never reached the software. Jira is
   built around a role, Amplitude around a role, Cursor around a role. The
   ontology of the tools is still the old one.
3. **The literature deconstructs jobs in order to distribute tasks across many
   people** — marketplaces, freelancers, crowdsourcing. Here the deconstruction
   happens for the opposite reason: the roles collapsed into one person. Same
   first move — break work into functions. Opposite second move — absorb rather
   than distribute. Nothing is written about the second move, and it is not an
   organisational question but a tooling one: one head does not scale, so the
   tool must hold the context between functions.

## Dated predictions this design bets on

| When | Prediction | What it implies here |
|---|---|---|
| Now | The role splits K-shaped; the middle disappears; the surviving role resembles a portfolio investor more than a project manager | Design for judgement and for stopping decisions, not for tracking execution |
| 2027 | Supervising, directing and training agents enters the median knowledge-worker job description as a core duty | The operator is already an orchestrator; the tool must report to a supervisor, not to a doer |
| 2028 | A third of enterprise software interaction becomes agent-to-agent | Outcome measurement built only around human behaviour will be partly blind |
| 2028 | **Governability overtakes capability** as the primary enterprise selection criterion | The winner is not the most capable tool but the most demonstrable one — which is what an intent set with verification status is |

## The design principle this yields

**Modules are named after questions, not after roles.** Questions compose; roles
conflict. `gdgraph` is not "the architect's module" and `health` is not "the QA
module" — which is precisely why they can all be used by one person at once. A
module named `product-manager` would re-import the boundary the work is
dissolving, and would immediately contend with a `business-analyst` module over
requirements.

Hence: not four modules for four job titles, but one module for the two
questions nothing answers.

And its corollary for the operator: the tool never asks which hat is being worn.
It reports which function was left unclosed in a given piece of work — and an
answer of "not needed here" is recorded as a decision, which is the difference
between a gap and a choice.

## Sources

- Builder.io — *The Backlog Problem AI Didn't Solve*; *I Didn't Become a Developer to Review AI Slop* (LinearB 4.6×; Sonar 96 % / 38 %)
- Product Compass — *What Is Product Discovery in the AI Era (2026)* (Cagan on 50–75 %)
- Product Talk (Teresa Torres) — evals as a discovery habit
- Founder Institute — *The One-Person Unicorn* (Carta, one third)
- Jesuthasan & Boudreau — *Work Without Jobs*, MIT Press, 2022
- Skills-based organisation surveys, 2026 (79 % / 59 %)
- Agents Today — *The Great Reshuffling* (K-shaped split, judgement layer)
- Product Management Society — *What to expect in 2027* (agent supervision; agent-to-agent; governability by 2028)
