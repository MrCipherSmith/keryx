#!/usr/bin/env bash
# Sequential benchmark batch. Runs detached so an incoming chat message cannot
# abort a run mid-flight -- that is exactly how the first attempt died.
#
#   batch.sh <case> <variant> [variant...]
#
# Appends one line per finished run to status.tsv and never stops the batch on a
# single failure: a variant that dies is recorded and the next one starts.
set -u
BENCH="$(cd "$(dirname "$0")" && pwd)"
CASE="$1"; shift
STATUS="$BENCH/status.tsv"

for V in "$@"; do
  START=$(date -u +%H:%M:%S)
  printf '%s\tRUNNING\t%s\t%s\n' "$CASE" "$V" "$START" >> "$STATUS"
  if timeout 420 python3 "$BENCH/drive.py" "$V" "$CASE" "$BENCH/prompts/$CASE.txt" \
       --timeout 220 --keep > "$BENCH/logs/$CASE-$V.json" 2> "$BENCH/logs/$CASE-$V.err"; then
    SECS=$(python3 -c "import json;print(json.load(open('$BENCH/logs/$CASE-$V.json'))['wallTimeSeconds'])" 2>/dev/null || echo "?")
    printf '%s\tDONE\t%s\t%s\t%ss\n' "$CASE" "$V" "$START" "$SECS" >> "$STATUS"
  else
    printf '%s\tFAILED\t%s\t%s\t%s\n' "$CASE" "$V" "$START" "$(tail -1 "$BENCH/logs/$CASE-$V.err" 2>/dev/null | cut -c1-120)" >> "$STATUS"
  fi
done
printf '%s\tBATCH-COMPLETE\t%s\n' "$CASE" "$(date -u +%H:%M:%S)" >> "$STATUS"
