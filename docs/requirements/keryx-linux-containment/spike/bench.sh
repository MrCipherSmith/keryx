#!/usr/bin/env bash
# SPIKE ONLY — per-command overhead, measured the way ADR-0010 measured the
# others: wall clock around N runs of /bin/echo on this host.
#
# Differences from ADR-0010, stated so the figures are not mistaken for its:
#   - N is 30, not 5. Five samples of a ~2 ms operation is mostly noise.
#   - every mechanism is measured in the SAME run, so rows are comparable to
#     each other. They are NOT comparable to ADR-0010's, which were taken in a
#     different session (see README.md).
#   - each iteration is timed individually and min/median/max are reported, so
#     "stable" is a claim the output supports rather than one the reader must
#     take on trust. The median is the headline figure; a mean would be the
#     statistic a single load spike contaminates.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/landlock-exec.ts"
BUN="$(command -v bun)"
BUN_DIR="$(dirname "$(readlink -f "$BUN")")"
RUNS="${RUNS:-30}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

BASE=()
for dir in /usr /bin /lib /lib64 /etc /proc /sys; do
  [[ -d "$dir" ]] && BASE+=(--ro "$dir")
done
BASE+=(--dev /dev --ro "$BUN_DIR" --rw "$WORK")

# Times each iteration separately and prints "median  min-max".
measure() {
  local samples=() start end
  for ((i = 0; i < RUNS; i++)); do
    start="$(date +%s%N)"
    "$@" >/dev/null 2>&1
    end="$(date +%s%N)"
    samples+=("$((end - start))")
  done
  printf '%s\n' "${samples[@]}" | sort -n | awk -v n="$RUNS" '
    { v[NR] = $1 }
    END {
      median = (n % 2) ? v[(n + 1) / 2] : (v[n / 2] + v[n / 2 + 1]) / 2
      printf "%.1f  (%.1f-%.1f)", median / 1e6, v[1] / 1e6, v[n] / 1e6
    }'
}

row() { printf '| %-46s | %-9s | %-22s |\n' "$1" "$2" "$3"; }

cd "$WORK" || exit 1

echo
echo "host: $(uname -r) / $(uname -m) / bun $("$BUN" --version) / N=$RUNS runs of /bin/echo"
echo "figures are median ms per command, with (min-max) across the $RUNS runs"
echo
row "mechanism" "axes" "per command"
printf '|%s|%s|%s|\n' "$(printf -- '-%.0s' {1..48})" "$(printf -- '-%.0s' {1..11})" "$(printf -- '-%.0s' {1..24})"

row "none (/bin/echo)" "-" "$(measure /bin/echo hi)"

# NOTE on comparability: the bwrap invocation is ADR-0010's verbatim, and it
# includes --unshare-net, so it is doing strictly MORE than the Landlock rows
# (which handle the filesystem axis only). The direction of that difference
# favours the conclusion drawn in README.md, so it weakens rather than inflates
# the "~3x" claim — but it is not like-for-like and the axes column says so.
if command -v bwrap >/dev/null 2>&1 && bwrap --ro-bind / / --dev /dev --unshare-net /bin/true 2>/dev/null; then
  row "bubblewrap (ADR-0010's invocation)" "fs+netns" \
    "$(measure bwrap --ro-bind / / --dev /dev --unshare-net /bin/echo hi)"
  row "bubblewrap (no --unshare-net, fs only)" "fs" \
    "$(measure bwrap --ro-bind / / --dev /dev /bin/echo hi)"
else
  row "bubblewrap (unavailable or failing on this host)" "-" "n/a"
fi

row "landlock bun:ffi (spec §4.2 shape, execve)" "fs" \
  "$(measure "$BUN" "$EXEC" "${BASE[@]}" -- /bin/echo hi)"
row "landlock bun:ffi (+ TCP axis handled)" "fs+tcp" \
  "$(measure "$BUN" "$EXEC" "${BASE[@]}" --handle-tcp -- /bin/echo hi)"
row "landlock bun:ffi (spawn mode, bun resident)" "fs" \
  "$(measure "$BUN" "$EXEC" "${BASE[@]}" --spawn -- /bin/echo hi)"

# The prebundle claim in README.md must be measured, not asserted.
if "$BUN" build "$EXEC" --target=bun --outfile "$WORK/landlock-exec.js" >/dev/null 2>&1; then
  row "landlock bun:ffi (prebundled to one .js)" "fs" \
    "$(measure "$BUN" "$WORK/landlock-exec.js" "${BASE[@]}" -- /bin/echo hi)"
else
  row "landlock bun:ffi (prebundle failed)" "fs" "n/a"
fi

# The alternative the spec hoped to avoid, so the trade is a number not a guess.
if ! command -v cc >/dev/null 2>&1; then
  row "landlock compiled C helper (no cc on this host)" "fs" "n/a"
elif CC_ERR="$(cc -O2 -o "$WORK/alt-helper" "$HERE/alternative-helper.c" 2>&1)"; then
  row "landlock compiled C helper (the Codex shape)" "fs" \
    "$(measure "$WORK/alt-helper" "${BASE[@]}" -- /bin/echo hi)"
else
  row "landlock compiled C helper (COMPILE FAILED)" "fs" "see below"
  echo "cc error: $CC_ERR"
fi

echo
echo "decomposition — where the bun:ffi cost actually is:"
row "bun -e '0' (runtime cold start, irreducible)" "-" "$(measure "$BUN" -e '0')"

"$BUN" -e '
const t0 = Bun.nanoseconds();
const m = await import("'"$HERE"'/landlock-ffi.ts");
const t1 = Bun.nanoseconds();
const abi = m.abiVersion();
const t2 = Bun.nanoseconds();
m.restrictSelfWith({
  paths: ["/usr","/bin","/lib","/lib64","/etc","/proc","/sys","'"$BUN_DIR"'"]
    .filter((p) => { try { return require("node:fs").statSync(p).isDirectory(); } catch { return false; } })
    .map((path) => ({ path, allowed: m.READ_ONLY_ACCESS }))
    .concat([{ path: "/dev", allowed: m.DEVICE_ACCESS }]),
});
const t3 = Bun.nanoseconds();
const ms = (n) => (n / 1e6).toFixed(3);
const row = (l, v) => console.log("| " + l.padEnd(46) + " | " + "-".padEnd(9) + " | " + (v + " ms").padStart(22) + " |");
row("  import + transpile landlock-ffi.ts", ms(t1 - t0));
row("  abi query (syscall 444, version flag)", ms(t2 - t1));
row("  create + path rules + nnp + restrict_self", ms(t3 - t2));
row("  all landlock syscalls together", ms(t3 - t1));
console.log("  (abi " + abi + ", n=1 — these are single samples, not medians)");
'

if [[ -f "$WORK/alt-helper" ]]; then
  echo
  echo "compiled helper size: $(stat -c %s "$WORK/alt-helper") bytes"
fi
echo
