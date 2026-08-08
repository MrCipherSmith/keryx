#!/usr/bin/env bash
# SPIKE ONLY — the evidence behind README.md.
#
# Answers, on this host, the four questions in implementation-plan.md Step 2:
#   1. can bun:ffi reach the Landlock ABI query?
#   2. can it create a ruleset, add rules and restrict_self?
#   3. is the restriction enforced in the exec'd child?
#   4. is it inherited by that child's own children?
#
# Usage: ./verify.sh    (no arguments, no privilege, exits non-zero on any
#                        assertion failure so it can be re-run as a check)

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/landlock-exec.ts"
BUN="$(command -v bun)"
BUN_DIR="$(dirname "$(readlink -f "$BUN")")"

PASS=0
FAIL=0

ok()   { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d)"
OUTSIDE="$(mktemp -d)"
trap 'rm -rf "$WORK" "$OUTSIDE"' EXIT

printf 'inside-readable\n' > "$WORK/inside.txt"
printf 'secret\n'          > "$OUTSIDE/secret.txt"

# The read-only hierarchies a command needs merely to start: the loader, the
# runtime, the shell. /proc is included because Bun reads it during startup.
readonly -a BASE=(
  --ro /usr --ro /bin --ro /lib --ro /lib64 --ro /etc --ro /proc --ro /sys
  --rw /dev
  --ro "$BUN_DIR"
)

run_contained() {
  "$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" -- "$@"
}

echo
echo "== host =="
echo "  kernel        $(uname -r)"
echo "  arch          $(uname -m)"
echo "  bun           $("$BUN" --version)"
printf '  landlock abi  '
"$BUN" -e 'import("./landlock-ffi.ts").then(m => console.log(m.abiVersion()))' \
  --cwd "$HERE" 2>/dev/null || (cd "$HERE" && "$BUN" -e 'const m = await import("./landlock-ffi.ts"); console.log(m.abiVersion());')

echo
echo "== 1. ABI query through bun:ffi =="
ABI="$(cd "$HERE" && "$BUN" -e 'const m = await import("./landlock-ffi.ts"); console.log(m.abiVersion());')"
if [[ "$ABI" -ge 1 ]]; then ok "landlock_create_ruleset(NULL,0,VERSION) returned ABI $ABI"
else bad "ABI query returned $ABI"; fi

echo
echo "== 2. ruleset + rules + no_new_privs + restrict_self =="
if run_contained /bin/true; then ok "a full apply sequence completed and the command ran"
else bad "apply sequence failed"; fi

echo
echo "== 3. enforcement in the exec'd child =="

if OUT="$(run_contained /bin/cat "$WORK/inside.txt" 2>&1)" && [[ "$OUT" == "inside-readable" ]]; then
  ok "read INSIDE the allowed hierarchy succeeds"
else
  bad "read inside the allowed hierarchy failed: $OUT"
fi

if run_contained /bin/sh -c "echo written > '$WORK/created.txt'" && [[ -f "$WORK/created.txt" ]]; then
  ok "write INSIDE the allowed hierarchy succeeds"
else
  bad "write inside the allowed hierarchy failed"
fi

ERR="$(run_contained /bin/sh -c "echo nope > '$OUTSIDE/denied.txt'" 2>&1)"
if [[ ! -f "$OUTSIDE/denied.txt" ]] && grep -qi 'permission denied' <<<"$ERR"; then
  ok "write OUTSIDE is denied (EACCES): ${ERR##*: }"
else
  bad "write outside was NOT denied (stderr: $ERR, file exists: $([[ -f "$OUTSIDE/denied.txt" ]] && echo yes || echo no))"
fi

ERR="$(run_contained /bin/cat "$OUTSIDE/secret.txt" 2>&1)"
if grep -qi 'permission denied' <<<"$ERR"; then
  ok "read OUTSIDE is denied (EACCES): ${ERR##*: }"
else
  bad "read outside was NOT denied: $ERR"
fi

echo
echo "== 4. inheritance by a grandchild =="

# The contained process spawns /bin/sh, which spawns a SECOND /bin/sh. The
# restriction is a property of the process, inherited across fork and exec, so
# the grandchild must be bound by it too.
if run_contained /bin/sh -c "/bin/sh -c \"echo grandchild > '$WORK/gc.txt'\"" \
   && [[ -f "$WORK/gc.txt" ]]; then
  ok "grandchild write inside the allowed hierarchy succeeds"
else
  bad "grandchild write inside the allowed hierarchy failed"
fi

ERR="$(run_contained /bin/sh -c "/bin/sh -c \"echo nope > '$OUTSIDE/gc-denied.txt'\"" 2>&1)"
if [[ ! -f "$OUTSIDE/gc-denied.txt" ]] && grep -qi 'permission denied' <<<"$ERR"; then
  ok "grandchild write OUTSIDE is denied — the restriction is inherited"
else
  bad "grandchild escaped the restriction (stderr: $ERR)"
fi

# A great-grandchild, because "two levels" is the claim people actually rely on.
ERR="$(run_contained /bin/sh -c "/bin/sh -c \"/bin/sh -c 'echo nope > $OUTSIDE/ggc.txt'\"" 2>&1)"
if [[ ! -f "$OUTSIDE/ggc.txt" ]]; then
  ok "great-grandchild write OUTSIDE is denied too"
else
  bad "great-grandchild escaped the restriction"
fi

echo
echo "== 5. the restriction cannot be shed =="

# NO_NEW_PRIVS is set, so a set-uid binary cannot be used to escape. Confirm the
# flag actually stuck by reading it back from inside the contained child.
NNP="$(run_contained /bin/sh -c 'grep NoNewPrivs /proc/self/status' 2>&1)"
if grep -q 'NoNewPrivs:.*1' <<<"$NNP"; then
  ok "NoNewPrivs is 1 inside the contained child ($NNP)"
else
  bad "NoNewPrivs not set in the child: $NNP"
fi

echo
echo "== 5b. execve mode leaves no resident Bun in the process tree =="

# With --execve (the default) the Bun process is REPLACED by the command, so
# the command's parent is whatever invoked landlock-exec. With --spawn, Bun
# stays resident as the parent for the command's whole lifetime.
PARENT_EXECVE="$(run_contained /bin/sh -c 'cat /proc/$PPID/comm' 2>&1)"
PARENT_SPAWN="$("$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" --spawn -- /bin/sh -c 'cat /proc/$PPID/comm' 2>&1)"

if [[ "$PARENT_EXECVE" != "bun" ]]; then
  ok "execve: contained command's parent is '$PARENT_EXECVE', not a resident bun"
else
  bad "execve did not replace the bun process (parent is '$PARENT_EXECVE')"
fi
if [[ "$PARENT_SPAWN" == "bun" ]]; then
  ok "control: --spawn does leave bun resident as the parent ('$PARENT_SPAWN')"
else
  bad "control unexpected: --spawn parent is '$PARENT_SPAWN'"
fi

# Exit codes must survive both modes, or the harness cannot report outcomes.
run_contained /bin/sh -c 'exit 42'; RC_EXECVE=$?
"$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" --spawn -- /bin/sh -c 'exit 42' >/dev/null 2>&1; RC_SPAWN=$?
if [[ "$RC_EXECVE" -eq 42 && "$RC_SPAWN" -eq 42 ]]; then
  ok "exit code 42 propagates in both modes (execve=$RC_EXECVE spawn=$RC_SPAWN)"
else
  bad "exit code lost (execve=$RC_EXECVE spawn=$RC_SPAWN)"
fi

echo
echo "== 6. fail-closed =="

# An unopenable rule path must abort BEFORE the command runs.
if OUT="$("$BUN" "$EXEC" --rw /definitely/not/a/real/path -- /bin/sh -c "echo ran > '$OUTSIDE/failopen.txt'" 2>&1)"; then
  bad "a bad ruleset did not fail the launcher"
else
  RC=$?
  if [[ ! -f "$OUTSIDE/failopen.txt" && "$RC" -eq 125 ]]; then
    ok "an inapplicable ruleset exits 125 and never runs the command"
  else
    bad "fail-closed violated (rc=$RC, ran=$([[ -f "$OUTSIDE/failopen.txt" ]] && echo yes || echo no))"
  fi
fi

echo
echo "== 7. ABI-4 TCP axis (mechanism reachability only) =="
echo "     NOTE: spec §4.3 — TCP-only, therefore NOT equivalent to network-off."

# A bind, not a connect: connect() to a dead port returns ECONNREFUSED whether
# or not Landlock is involved, so it cannot distinguish a denial from an
# absence. Three cases, so the middle one means something:
#   a) no --net              -> BOUND   (control: the bind itself works here)
#   b) --net, no allow rule  -> DENIED  (the restriction is what changed)
#   c) --net + allow bind    -> BOUND   (the allow-rule is what changed it back)
NET_PORT=39917
# The probe is copied INTO the allowed hierarchy and run with cwd there: a
# nested Bun aborts with CouldntReadCurrentDirectory if its cwd is outside the
# ruleset, which is a fact Step 3 needs (see README.md, "what surprised us").
cp "$HERE/net-probe.ts" "$WORK/net-probe.ts"
PROBE="$WORK/net-probe.ts"

NET_A="$(cd "$WORK" && "$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" -- "$BUN" "$PROBE" "$NET_PORT" 2>&1)"
NET_B="$(cd "$WORK" && "$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" --net -- "$BUN" "$PROBE" "$NET_PORT" 2>&1)"
NET_C="$(cd "$WORK" && "$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" --allow-tcp-bind "$NET_PORT" -- "$BUN" "$PROBE" "$NET_PORT" 2>&1)"

if [[ "$NET_A" == "BOUND" ]]; then
  ok "control: TCP bind on $NET_PORT succeeds when the net axis is not handled"
else
  bad "control failed — bind does not work here at all, section 7 proves nothing ($NET_A)"
fi

if grep -q '^DENIED:' <<<"$NET_B"; then
  ok "handled_access_net with no allow-rule denies TCP bind ($NET_B)"
else
  bad "TCP bind was NOT denied with the net axis handled ($NET_B)"
fi

if [[ "$NET_C" == "BOUND" ]]; then
  ok "an explicit net_port allow-rule restores the bind ($NET_C)"
else
  bad "allow-rule did not restore the bind ($NET_C)"
fi

echo
echo "== summary =="
echo "  passed $PASS, failed $FAIL"
[[ "$FAIL" -eq 0 ]]
