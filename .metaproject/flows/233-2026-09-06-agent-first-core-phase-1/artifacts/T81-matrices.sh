#!/bin/bash
# T81 — run every prior matrix probe and hash its output. $1 = "before" | "after".
# Run from the project root. Read-only: it only executes existing probes.
set -u
PHASE="$1"
A=.metaproject/flows/233-2026-09-06-agent-first-core-phase-1/artifacts
R=.metaproject/data/gdctx/raw
PROBES="T42-exfil-attack T24-recheck2-exfil T42-charrefs T53-extract T53-resolve T53-base T53-boundary T42-boundary T24-recheck2-boundary T52-base T46-surfaces T72-md T72-gates T72-srcset T72-doc T77-doc T53-corpus T78-md T78-corpus"
for p in $PROBES; do
  bun "$A/$p.ts" > "$R/T81-$PHASE-$p.log" 2>&1
  code=$?
  h=$(shasum -a 256 "$R/T81-$PHASE-$p.log" | cut -d' ' -f1)
  echo "$p exit=$code sha256=$h"
done
