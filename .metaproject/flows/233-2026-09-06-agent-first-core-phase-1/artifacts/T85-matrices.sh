#!/bin/bash
# T85 — run every prior matrix probe, hash its output, and diff it against T83's
# own recorded run of the same probe (`T83-after-<p>.log`), which T84 re-verified.
# $1 = "before" | "after". Run from the project root.
# Read-only: it only executes existing probes and never edits one.
set -u
PHASE="$1"
A=.metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts
R=.metaproject/data/gdctx/raw
PROBES="T42-exfil-attack T24-recheck2-exfil T42-charrefs T53-extract T53-resolve T53-base T53-boundary T42-boundary T24-recheck2-boundary T52-base T46-surfaces T72-md T72-gates T72-srcset T72-doc T77-doc T53-corpus T78-md T78-corpus"
for p in $PROBES; do
  bun "$A/$p.ts" > "$R/T85-$PHASE-$p.log" 2>&1
  code=$?
  h=$(shasum -a 256 "$R/T85-$PHASE-$p.log" | cut -d' ' -f1)
  ref="$R/T83-after-$p.log"
  if [ -f "$ref" ]; then
    if cmp -s "$R/T85-$PHASE-$p.log" "$ref"; then cmpres="identical-to-T83"; else cmpres="DIFFERS-from-T83"; fi
  else
    cmpres="no-T83-log"
  fi
  echo "$p exit=$code sha256=$h $cmpres"
done
