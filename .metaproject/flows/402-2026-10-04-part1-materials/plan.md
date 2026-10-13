# Implementation Plan

Status: ready

## Approach

Documentation-only flow: files go into `docs/research/role-blurring-part1/`, one test `src/docs/part1-materials.test.ts` guards structure, protocol equality, export field allow-list and the privacy search. The counting script is copied unchanged; discrepancies with the article are reported, not fixed.

## Steps

1. Copy the attached script and protocol; add the version header and table to the protocol copy.
2. Find the commit at which the script reproduces the article's numbers; fall back to the current main commit and list discrepancies.
3. Run the script from the repository root at that commit and store the output.
4. Build the contribution log from decision journals, flow journals and operator quotes; write only rows with a findable verbatim quote.
5. Export the recommendation journal for 2 to 4 October without text, by `keryx decisions export` or a one-off script.
6. Write the README; run the privacy search and write its result to the flow journal.
7. Add the test, open a draft PR.

## Risks

- The counts depend on the checked-out state; untracked flow folders in a working copy are not part of any commit.
- Quotes for some decisions the prompt names may not be findable; those rows are left out and listed.
