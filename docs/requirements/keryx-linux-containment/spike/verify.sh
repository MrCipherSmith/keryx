#!/usr/bin/env bash
# SPIKE ONLY — the evidence behind README.md.
#
# Answers, on this host, the four questions in implementation-plan.md Step 2:
#   1. can bun:ffi reach the Landlock ABI query?
#   2. can it create a ruleset, add rules and restrict_self?
#   3. is the restriction enforced in the exec'd child?
#   4. is it inherited by that child's own children?
#
# Discipline this script holds itself to: every assertion that a thing was
# DENIED is paired with a control that differs only in the ruleset, and asserts
# the reason for the denial rather than just its symptom. An assertion that
# passes when the command never ran is not evidence — see README.md, "what
# surprised us" #4, for the one that got through the first draft.
#
# Usage: ./verify.sh    (no arguments, no privilege, exits non-zero on any
#                        assertion failure so it can be re-run as a check)

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$HERE/landlock-exec.ts"
BUN="$(command -v bun)"
BUN_DIR="$(dirname "$(readlink -f "$BUN")")"

# Every `ok` below is counted; the total is asserted at the end so a section
# that silently stops running cannot leave the script exiting 0.
EXPECTED_ASSERTIONS=29

PASS=0
FAIL=0
SKIP=0

ok()   { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); }
skip() { printf '  SKIP  %s\n' "$1"; SKIP=$((SKIP + 1)); }

WORK="$(mktemp -d)"
OUTSIDE="$(mktemp -d)"
trap 'rm -rf "$WORK" "$OUTSIDE"' EXIT

printf 'inside-readable\n' > "$WORK/inside.txt"
# The marker must not appear in the file's own path, or a "did it leak?" check
# matches the filename echoed back in an error message and fails a passing case.
printf 'LEAKMARKER42\n'    > "$OUTSIDE/private.txt"

# The read-only hierarchies a command needs merely to start: the loader, the
# runtime, the shell. Built by probing rather than hardcoded, because /lib64
# does not exist on aarch64 and the launcher fails closed on an unopenable rule
# path — a hardcoded list would make this script silently x86_64-only.
BASE=()
for dir in /usr /bin /lib /lib64 /etc /proc /sys; do
  [[ -d "$dir" ]] && BASE+=(--ro "$dir")
done
BASE+=(--dev /dev --ro "$BUN_DIR")
# /dev/shm is a tmpfs beneath /dev where POSIX shm creates regular files. It
# gets its own nested rule rather than widening the whole /dev grant.
[[ -d /dev/shm ]] && BASE+=(--rw /dev/shm)

run_contained() {
  "$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" -- "$@"
}

echo
echo "== host =="
echo "  kernel        $(uname -r)"
echo "  arch          $(uname -m)"
echo "  bun           $("$BUN" --version)"

ABI="$(cd "$HERE" && "$BUN" -e 'const m = await import("./landlock-ffi.ts"); console.log(m.abiVersion());')"
echo "  landlock abi  $ABI"

echo
echo "== 1. ABI query through bun:ffi =="
if [[ "$ABI" -ge 1 ]]; then ok "landlock_create_ruleset(NULL,0,VERSION) returned ABI $ABI"
else bad "ABI query returned $ABI — no Landlock on this kernel, nothing below can pass"; fi

echo
echo "== 2. ruleset + rules + no_new_privs + restrict_self =="
if OUT="$(run_contained /bin/true 2>&1)"; then
  ok "a full apply sequence completed and the command ran"
else
  bad "apply sequence failed (rc=$?): $OUT"
fi

echo
echo "== 3. enforcement in the exec'd child =="
# $WORK and $OUTSIDE are both mktemp -d under /tmp: same owner, same mode, same
# parent. Only the ruleset differs between them, so ordinary file permissions
# cannot explain any denial below.

if OUT="$(run_contained /bin/cat "$WORK/inside.txt" 2>&1)" && [[ "$OUT" == "inside-readable" ]]; then
  ok "read INSIDE the allowed hierarchy succeeds"
else
  bad "read inside the allowed hierarchy failed: $OUT"
fi

if OUT="$(run_contained /bin/sh -c "echo written > '$WORK/created.txt'" 2>&1)" && [[ -f "$WORK/created.txt" ]]; then
  ok "write INSIDE the allowed hierarchy succeeds"
else
  bad "write inside the allowed hierarchy failed: $OUT"
fi

ERR="$(run_contained /bin/sh -c "echo nope > '$OUTSIDE/denied.txt'" 2>&1)"
if [[ ! -f "$OUTSIDE/denied.txt" ]] && grep -qi 'permission denied' <<<"$ERR"; then
  ok "write OUTSIDE is denied (EACCES): ${ERR##*: }"
else
  bad "write outside was NOT denied (stderr: $ERR, file exists: $([[ -f "$OUTSIDE/denied.txt" ]] && echo yes || echo no))"
fi

ERR="$(run_contained /bin/cat "$OUTSIDE/private.txt" 2>&1)"
# Assert the contents did not leak, not merely that a denial was printed.
if grep -qi 'permission denied' <<<"$ERR" && [[ "$ERR" != *LEAKMARKER42* ]]; then
  ok "read OUTSIDE is denied (EACCES) and the contents did not leak"
else
  bad "read outside was NOT denied or leaked contents: $ERR"
fi

echo
echo "== 4. inheritance by a grandchild and a great-grandchild =="

# The contained process spawns /bin/sh, which spawns a SECOND /bin/sh. The
# restriction is a property of the process, inherited across fork and exec, so
# the grandchild must be bound by it too.
if OUT="$(run_contained /bin/sh -c "/bin/sh -c \"echo grandchild > '$WORK/gc.txt'\"" 2>&1)" \
   && [[ -f "$WORK/gc.txt" ]]; then
  ok "grandchild write inside the allowed hierarchy succeeds"
else
  bad "grandchild write inside the allowed hierarchy failed: $OUT"
fi

ERR="$(run_contained /bin/sh -c "/bin/sh -c \"echo nope > '$OUTSIDE/gc-denied.txt'\"" 2>&1)"
if [[ ! -f "$OUTSIDE/gc-denied.txt" ]] && grep -qi 'permission denied' <<<"$ERR"; then
  ok "grandchild write OUTSIDE is denied — the restriction is inherited"
else
  bad "grandchild escaped the restriction (stderr: $ERR)"
fi

# Great-grandchild, with its OWN positive control. Absence of the output file is
# not sufficient evidence: a quoting slip or a launcher failure also leaves it
# absent. The control proves three-deep nesting runs at all, and the stderr
# assertion proves the failure was a denial rather than a non-start.
if OUT="$(run_contained /bin/sh -c "/bin/sh -c \"/bin/sh -c 'echo ggc > $WORK/ggc-ok.txt'\"" 2>&1)" \
   && [[ -f "$WORK/ggc-ok.txt" ]]; then
  ok "great-grandchild write inside the allowed hierarchy succeeds (three-deep nesting runs)"
else
  bad "great-grandchild control failed — the denial below would prove nothing: $OUT"
fi

ERR="$(run_contained /bin/sh -c "/bin/sh -c \"/bin/sh -c 'echo nope > $OUTSIDE/ggc.txt'\"" 2>&1)"
if [[ ! -f "$OUTSIDE/ggc.txt" ]] && grep -qi 'permission denied' <<<"$ERR"; then
  ok "great-grandchild write OUTSIDE is denied (EACCES) — inherited two levels down"
else
  bad "great-grandchild escaped the restriction (stderr: $ERR, file exists: $([[ -f "$OUTSIDE/ggc.txt" ]] && echo yes || echo no))"
fi

echo
echo "== 5. no_new_privs =="

# NNP prevents a set-uid binary from GAINING privileges across execve inside the
# domain. It is not what keeps the ruleset attached — a Landlock domain cannot
# be shed regardless. Paired with an uncontained control, because a container
# started with --security-opt no-new-privileges would inherit NNP=1 to every
# descendant and make the contained reading trivially true.
NNP_OUTSIDE="$(/bin/sh -c 'grep NoNewPrivs /proc/self/status' 2>&1)"
NNP_INSIDE="$(run_contained /bin/sh -c 'grep NoNewPrivs /proc/self/status' 2>&1)"
if grep -q 'NoNewPrivs:.*0' <<<"$NNP_OUTSIDE"; then
  ok "control: NoNewPrivs is 0 outside the launcher"
else
  bad "control failed — NoNewPrivs already set on this host ($NNP_OUTSIDE); section 5 proves nothing"
fi
if grep -q 'NoNewPrivs:.*1' <<<"$NNP_INSIDE"; then
  ok "NoNewPrivs is 1 inside the contained child"
else
  bad "NoNewPrivs not set in the child: $NNP_INSIDE"
fi

echo
echo "== 5b. execve mode leaves no resident Bun in the process tree =="

# With --execve (the default) the Bun process is REPLACED by the command, so
# the command's parent is whatever invoked landlock-exec. With --spawn, Bun
# stays resident as the parent for the command's whole lifetime.
SELF_COMM="$(cat /proc/$$/comm)"
PARENT_EXECVE="$(run_contained /bin/sh -c 'cat /proc/$PPID/comm' 2>&1)"
PARENT_SPAWN="$("$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" --spawn -- /bin/sh -c 'cat /proc/$PPID/comm' 2>&1)"

# Assert the positive value: "not bun" would also be satisfied by an error
# message, i.e. by the command never having run.
if [[ "$PARENT_EXECVE" == "$SELF_COMM" ]]; then
  ok "execve: contained command's parent is '$PARENT_EXECVE' (this script), not a resident bun"
else
  bad "execve did not replace the bun process (parent '$PARENT_EXECVE', expected '$SELF_COMM')"
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

# Signal death must not be reported as success. Bun returns exitCode null for a
# signalled child, and process.exit(null) exits 0.
run_contained /bin/sh -c 'kill -9 $$' >/dev/null 2>&1; SIG_EXECVE=$?
"$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" --spawn -- /bin/sh -c 'kill -9 $$' >/dev/null 2>&1; SIG_SPAWN=$?
if [[ "$SIG_EXECVE" -eq 137 && "$SIG_SPAWN" -eq 137 ]]; then
  ok "SIGKILL reports 137 in both modes, not 0 (execve=$SIG_EXECVE spawn=$SIG_SPAWN)"
else
  bad "signal death misreported (execve=$SIG_EXECVE spawn=$SIG_SPAWN, expected 137 both)"
fi

echo
echo "== 6. fail-closed =="

# Same ruleset as every working invocation, plus ONE bad path — so exit 125 is
# attributable to that path and not to the absence of the base grants.
if OUT="$("$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" --rw /definitely/not/a/real/path \
          -- /bin/sh -c "echo ran > '$OUTSIDE/failopen.txt'" 2>&1)"; then
  bad "a bad ruleset did not fail the launcher: $OUT"
else
  RC=$?
  if [[ ! -f "$OUTSIDE/failopen.txt" && "$RC" -eq 125 ]] && grep -q 'definitely/not/a/real/path' <<<"$OUT"; then
    ok "an inapplicable ruleset exits 125, names the path, and never runs the command"
  else
    bad "fail-closed violated (rc=$RC, ran=$([[ -f "$OUTSIDE/failopen.txt" ]] && echo yes || echo no), out=$OUT)"
  fi
fi

# The TCP axis must fail closed rather than degrade. This host reports ABI 4, so
# the branch cannot be reached through the kernel; assertNetSupported is exported
# pure precisely so the behaviour itself can be exercised rather than inspected.
GUARD="$(cd "$HERE" && "$BUN" -e '
const m = await import("./landlock-ffi.ts");
const results = [];
try { m.assertNetSupported(1, true); results.push("ABI1-ALLOWED"); }
catch { results.push("ABI1-REFUSED"); }
try { m.assertNetSupported(4, true); results.push("ABI4-ALLOWED"); }
catch { results.push("ABI4-REFUSED"); }
try { m.assertNetSupported(1, false); results.push("NONET-ALLOWED"); }
catch { results.push("NONET-REFUSED"); }
console.log(results.join(","));')"
if [[ "$GUARD" == "ABI1-REFUSED,ABI4-ALLOWED,NONET-ALLOWED" ]]; then
  ok "the TCP axis is refused below ABI 4, allowed at 4, and irrelevant when unrequested"
else
  bad "TCP axis ABI gate misbehaves: $GUARD"
fi

echo
echo "== 6b. program resolution parity between the two modes =="

# Round-2 review found these; each assertion below exists because the behaviour
# it checks was once wrong and shipped.

# A bare name on PATH must work in BOTH modes: raw execve does no PATH search,
# so without explicit resolution the modes differ in which commands they start.
R_EXECVE="$(run_contained echo bare-name-ok 2>&1)"
R_SPAWN="$("$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" --spawn -- echo bare-name-ok 2>&1)"
if [[ "$R_EXECVE" == "bare-name-ok" && "$R_SPAWN" == "bare-name-ok" ]]; then
  ok "a bare program name resolves via PATH in both modes"
else
  bad "PATH parity broken (execve='$R_EXECVE' spawn='$R_SPAWN')"
fi

# A name NOT on PATH must not fall back to the current directory. execve
# resolves a slash-free name against the cwd, which here is attacker-writable
# workspace, so a missing tool would silently run a planted file.
printf '#!/bin/sh\necho PLANTED_RAN\n' > "$WORK/plantedtool"
chmod +x "$WORK/plantedtool"
PLANT="$( cd "$WORK" && "$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" -- plantedtool 2>&1 )"
PLANT_RC=$?
if [[ "$PLANT" != *PLANTED_RAN* && "$PLANT_RC" -ne 0 ]]; then
  ok "a program absent from PATH is refused, not taken from the cwd (rc=$PLANT_RC)"
else
  bad "cwd fallback executed a planted file (rc=$PLANT_RC, out=$PLANT)"
fi

# A missing program must be a launcher failure (125), not the command's own 1.
"$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" -- no_such_program_xyz >/dev/null 2>&1; MISS_E=$?
"$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" --spawn -- no_such_program_xyz >/dev/null 2>&1; MISS_S=$?
if [[ "$MISS_E" -eq 125 && "$MISS_S" -eq 125 ]]; then
  ok "a missing program exits 125 in both modes, not 1 (execve=$MISS_E spawn=$MISS_S)"
else
  bad "missing program misreported (execve=$MISS_E spawn=$MISS_S, expected 125 both)"
fi

# A signal outside a hand-written table must not collapse to a plausible status.
run_contained /bin/sh -c 'kill -USR1 $$' >/dev/null 2>&1; U_E=$?
"$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" --spawn -- /bin/sh -c 'kill -USR1 $$' >/dev/null 2>&1; U_S=$?
if [[ "$U_E" -eq 138 && "$U_S" -eq 138 ]]; then
  ok "SIGUSR1 reports 138 in both modes (execve=$U_E spawn=$U_S)"
else
  bad "signal mapping diverges (execve=$U_E spawn=$U_S, expected 138 both)"
fi

# A real-time signal has no name node:os knows, and Bun reports signalCode as a
# NUMBER for it. A name-only lookup misses and would return the launcher's
# reserved 125 — reporting a command that ran and died as one that never started.
run_contained /bin/sh -c 'kill -34 $$' >/dev/null 2>&1; RT_E=$?
"$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" --spawn -- /bin/sh -c 'kill -34 $$' >/dev/null 2>&1; RT_S=$?
if [[ "$RT_E" -eq 162 && "$RT_S" -eq 162 ]]; then
  ok "a real-time signal reports 162 in both modes, never the reserved 125 (execve=$RT_E spawn=$RT_S)"
else
  bad "real-time signal misreported (execve=$RT_E spawn=$RT_S, expected 162 both)"
fi

# A malformed port must be refused rather than coerced: Number("") is 0, which
# would turn the whole TCP axis on with one meaningless rule at exit 0.
"$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" --allow-tcp-bind "" -- /bin/true >/dev/null 2>&1; P_EMPTY=$?
"$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" --allow-tcp-bind 0x50 -- /bin/true >/dev/null 2>&1; P_HEX=$?
if [[ "$P_EMPTY" -eq 125 && "$P_HEX" -eq 125 ]]; then
  ok "malformed port arguments fail closed (empty=$P_EMPTY hex=$P_HEX)"
else
  bad "malformed port accepted (empty=$P_EMPTY hex=$P_HEX, expected 125 both)"
fi

echo
echo "== 6c. the /dev grant covers what real commands need =="

if run_contained /bin/sh -c 'echo x > /dev/null' >/dev/null 2>&1; then
  ok "/dev/null is writable under the narrowed device grant"
else
  bad "/dev/null write failed under --dev"
fi

# /dev/shm is a tmpfs beneath /dev where POSIX shared memory creates regular
# files. A device grant without MAKE_REG denies shm_open/sem_open with EACCES,
# which breaks Chromium, Python multiprocessing and libpq.
if run_contained /bin/sh -c 'echo x > /dev/shm/lspike.$$ && rm -f /dev/shm/lspike.$$' >/dev/null 2>&1; then
  ok "/dev/shm supports file creation (POSIX shm and named semaphores work)"
else
  bad "/dev/shm file creation denied — shm_open/sem_open would fail with EACCES"
fi

echo
echo "== 7. ABI-4 TCP axis (mechanism reachability only) =="
echo "     NOTE: spec §4.3 — TCP-only, therefore NOT equivalent to network-off."

if [[ "$ABI" -lt 4 ]]; then
  skip "TCP axis requires Landlock ABI >= 4; this kernel reports $ABI (3 assertions skipped)"
  EXPECTED_ASSERTIONS=$((EXPECTED_ASSERTIONS - 3))
else
  # A bind, not a connect: connect() to a dead port returns ECONNREFUSED whether
  # or not Landlock is involved, so it cannot distinguish a denial from an
  # absence. Three cases, so the middle one means something:
  #   a) no --handle-tcp             -> BOUND   (control: the bind works here)
  #   b) --handle-tcp, no allow rule -> DENIED  (the restriction is what changed)
  #   c) --handle-tcp + allow bind   -> BOUND   (the allow-rule changed it back)

  # Port chosen at runtime by binding 0 and reading back the assignment, so a
  # busy fixed port cannot turn the section into misattributed failures.
  NET_PORT="$(cd "$HERE" && "$BUN" -e '
    const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    console.log(s.port); s.stop(true);')"

  # The probe is copied INTO the allowed hierarchy and run with cwd there: a
  # nested Bun aborts with CouldntReadCurrentDirectory if its cwd is outside the
  # ruleset, which is a fact Step 3 needs (see README.md, "what surprised us").
  cp "$HERE/net-probe.ts" "$WORK/net-probe.ts"
  PROBE="$WORK/net-probe.ts"

  NET_A="$(cd "$WORK" && "$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" -- "$BUN" "$PROBE" "$NET_PORT" 2>&1)"
  NET_B="$(cd "$WORK" && "$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" --handle-tcp -- "$BUN" "$PROBE" "$NET_PORT" 2>&1)"
  NET_C="$(cd "$WORK" && "$BUN" "$EXEC" "${BASE[@]}" --rw "$WORK" --allow-tcp-bind "$NET_PORT" -- "$BUN" "$PROBE" "$NET_PORT" 2>&1)"

  if [[ "$NET_A" == "BOUND" ]]; then
    ok "control: TCP bind on $NET_PORT succeeds when the net axis is not handled"
  else
    bad "control failed — bind does not work here at all, section 7 proves nothing ($NET_A)"
  fi

  # Assert the errno, not merely that some denial occurred: EADDRINUSE would
  # otherwise satisfy a bare 'DENIED' match and be read as enforcement.
  if [[ "$NET_B" == "DENIED:EACCES" ]]; then
    ok "handled_access_net with no allow-rule denies TCP bind with EACCES"
  else
    bad "expected DENIED:EACCES with the net axis handled, got '$NET_B'"
  fi

  if [[ "$NET_C" == "BOUND" ]]; then
    ok "an explicit net_port allow-rule restores the bind ($NET_C)"
  else
    bad "allow-rule did not restore the bind ($NET_C)"
  fi
fi

echo
echo "== summary =="
echo "  passed $PASS, failed $FAIL, skipped $SKIP (expected $EXPECTED_ASSERTIONS assertions)"

if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
if [[ "$PASS" -ne "$EXPECTED_ASSERTIONS" ]]; then
  echo "  ERROR: $PASS assertions ran, expected $EXPECTED_ASSERTIONS — a section stopped early."
  exit 1
fi
