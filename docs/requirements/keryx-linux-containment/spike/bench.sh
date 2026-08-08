#!/usr/bin/env bash
# SPIKE ONLY — per-command overhead, measured the way ADR-0010 measured the
# others: wall clock around N runs of /bin/echo on this host, mean per command.
#
# ADR-0010 used N=5. This uses N=20, because 5 samples of a ~2 ms operation is
# mostly noise. Every mechanism is measured in the SAME run so the figures are
# comparable to each other; they are NOT directly comparable to ADR-0010's,
# which were taken in a different session (see README.md).

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/landlock-exec.ts"
BUN="$(command -v bun)"
BUN_DIR="$(dirname "$(readlink -f "$BUN")")"
RUNS="${RUNS:-20}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

readonly -a BASE=(
  --ro /usr --ro /bin --ro /lib --ro /lib64 --ro /etc --ro /proc --ro /sys
  --rw /dev --ro "$BUN_DIR" --rw "$WORK"
)

measure() {
  local start end
  start="$(date +%s%N)"
  for ((i = 0; i < RUNS; i++)); do "$@" >/dev/null 2>&1; done
  end="$(date +%s%N)"
  awk -v ns="$((end - start))" -v n="$RUNS" 'BEGIN { printf "%.1f", ns / n / 1000000 }'
}

row() { printf '| %-50s | %8s ms |\n' "$1" "$2"; }

cd "$WORK" || exit 1

echo
echo "host: $(uname -r) / $(uname -m) / bun $("$BUN" --version) / $RUNS runs of /bin/echo"
echo
printf '| %-50s | %11s |\n' "mechanism" "per command"
printf '|%s|%s|\n' "$(printf -- '-%.0s' {1..52})" "$(printf -- '-%.0s' {1..13})"

row "none (/bin/echo)" "$(measure /bin/echo hi)"

if command -v bwrap >/dev/null 2>&1 && bwrap --ro-bind / / --dev /dev --unshare-net /bin/true 2>/dev/null; then
  row "bubblewrap (--ro-bind / / --dev /dev --unshare-net)" \
    "$(measure bwrap --ro-bind / / --dev /dev --unshare-net /bin/echo hi)"
else
  row "bubblewrap (unavailable or failing on this host)" "n/a"
fi

row "landlock via bun:ffi  (spec §4.2 shape, execve)" \
  "$(measure "$BUN" "$EXEC" "${BASE[@]}" -- /bin/echo hi)"
row "landlock via bun:ffi  (spawn mode, bun stays resident)" \
  "$(measure "$BUN" "$EXEC" "${BASE[@]}" --spawn -- /bin/echo hi)"

# The alternative the spec hoped to avoid, so the trade is a number not a guess.
if cc -O2 -o "$WORK/alt-helper" "$HERE/alternative-helper.c" 2>/dev/null; then
  row "landlock via compiled C helper (the Codex shape)" \
    "$(measure "$WORK/alt-helper" "${BASE[@]}" -- /bin/echo hi)"
else
  row "landlock via compiled C helper (no cc available)" "n/a"
fi

echo
echo "decomposition — where the bun:ffi cost actually is:"
row "  bun -e '0' (runtime cold start, irreducible)" "$(measure "$BUN" -e '0')"

"$BUN" -e '
const m = await import("'"$HERE"'/landlock-ffi.ts");
const t0 = Bun.nanoseconds();
const abi = m.abiVersion();
const t1 = Bun.nanoseconds();
m.restrictSelfWith({
  paths: ["/usr","/bin","/lib","/lib64","/etc","/proc","/sys","'"$BUN_DIR"'"]
    .map((path) => ({ path, allowed: m.READ_ONLY_ACCESS }))
    .concat([{ path: "/dev", allowed: m.READ_WRITE_ACCESS }]),
});
const t2 = Bun.nanoseconds();
const ms = (n) => (n / 1e6).toFixed(3);
const row = (label, value) => console.log("| " + label.padEnd(50) + " | " + (value + " ms").padStart(11) + " |");
row("  abi query (syscall 444, version flag)", ms(t1 - t0));
row("  create + 9 path rules + nnp + restrict_self", ms(t2 - t1));
row("  all landlock syscalls together", ms(t2 - t0));
console.log("  (abi " + abi + ")");
'
echo
