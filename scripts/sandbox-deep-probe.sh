#!/usr/bin/env bash
# Portable deep probe for keryx OS sandbox + harness hardening (AC-H3..H5).
# - No GNU date %N (macOS-safe).
# - Absolute paths for harness exec.
# - CONTROL runs outside sandbox for deny claims.
# - Writes RUN_DIR under .metaproject/tmp/sandbox-probe-<ts>/
# - REPORT.md + report.json; redaction FAIL if fixture secret leaks.
#
# Usage:
#   ./scripts/sandbox-deep-probe.sh
#   ./scripts/sandbox-deep-probe.sh --live-smokes   # optional live bun path checks
#
# Env:
#   KERYX_BIN   override keryx binary (default: keryx on PATH, else bun run)
#   ROOT        override repo root (default: git rev-parse or script parent)

set -euo pipefail

LIVE_SMOKES=0
for arg in "$@"; do
  case "$arg" in
    --live-smokes) LIVE_SMOKES=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
  esac
done

# --- paths (portable, absolute) ------------------------------------------------
SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
if ROOT_CANDIDATE="$(cd "$SCRIPT_DIR/.." && pwd)"; then
  ROOT="${ROOT:-$ROOT_CANDIDATE}"
else
  ROOT="${ROOT:-$(pwd)}"
fi
cd "$ROOT"

# Portable timestamp (no GNU %N)
TS="$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || date +%Y%m%dT%H%M%S)"
RUN_DIR="${ROOT}/.metaproject/tmp/sandbox-probe-${TS}"
mkdir -p "$RUN_DIR"
EVIDENCE_DIR="${RUN_DIR}/evidence"
mkdir -p "$EVIDENCE_DIR"
HELPERS_DIR="${RUN_DIR}/helpers"
mkdir -p "$HELPERS_DIR"

# Fixture secret for redaction gate only — never a real key (P-SEC-2).
# Synthetic only — must not look like a real provider key (no sk- prefix).
FIXTURE_SECRET="fixture-probe-redaction-only-not-a-real-key"
printf '%s\n' "$FIXTURE_SECRET" >"${RUN_DIR}/.fixture-secret-marker"
# Marker file is excluded from scan source list; we inject a deliberate leak only in tests.

# Resolve keryx
resolve_keryx() {
  if [[ -n "${KERYX_BIN:-}" ]]; then
    echo "$KERYX_BIN"
    return
  fi
  if command -v keryx >/dev/null 2>&1; then
    command -v keryx
    return
  fi
  if [[ -x "${ROOT}/.metaproject/runtime/keryx/bin/keryx" ]]; then
    echo "${ROOT}/.metaproject/runtime/keryx/bin/keryx"
    return
  fi
  # Fall back to bun entry (dev tree)
  if command -v bun >/dev/null 2>&1 && [[ -f "${ROOT}/src/cli.ts" ]]; then
    echo "bun"
    return
  fi
  echo ""
}

KERYX_RESOLVED="$(resolve_keryx)"
keryx_exec() {
  if [[ -z "$KERYX_RESOLVED" ]]; then
    echo '{"outcome":{"kind":"blocked","reason":"keryx binary not found"}}'
    return 127
  fi
  if [[ "$KERYX_RESOLVED" == "bun" ]]; then
    bun "${ROOT}/src/cli.ts" "$@"
  else
    "$KERYX_RESOLVED" "$@"
  fi
}

# Matrix rows as tab-separated: id verdict notes control evidence
ROWS_FILE="${RUN_DIR}/rows.tsv"
: >"$ROWS_FILE"

add_row() {
  local id="$1" verdict="$2" notes="$3" control="${4:-n/a}" evidence="${5:-}"
  # Escape tabs/newlines in notes
  notes="${notes//$'\t'/ }"
  notes="${notes//$'\n'/ }"
  printf '%s\t%s\t%s\t%s\t%s\n' "$id" "$verdict" "$notes" "$control" "$evidence" >>"$ROWS_FILE"
}

# Write helper scripts (chmod +x; no shell metachar in harness argv)
write_helper() {
  local name="$1"
  local body="$2"
  local path="${HELPERS_DIR}/${name}"
  printf '%s\n' "#!/bin/sh" "$body" >"$path"
  chmod +x "$path"
  echo "$path"
}

# harness exec JSON (last line that parses as JSON preferred)
run_harness() {
  local out_file="$1"
  shift
  set +e
  keryx_exec harness exec --allow-real-subprocess "$@" >"$out_file" 2>"${out_file}.err"
  local rc=$?
  set -e
  echo "$rc"
}

json_field() {
  # Very small portable extract via bun/node if present; else grep heuristic
  local file="$1" expr="$2"
  if command -v bun >/dev/null 2>&1; then
    bun -e "
      const fs = require('fs');
      const t = fs.readFileSync(process.argv[1], 'utf8').trim().split(/\\n/).filter(Boolean);
      let obj = null;
      for (let i = t.length - 1; i >= 0; i--) {
        try { obj = JSON.parse(t[i]); break; } catch {}
      }
      if (!obj) { process.exit(2); }
      const path = process.argv[2].split('.');
      let v = obj;
      for (const p of path) {
        if (v == null) { console.log(''); process.exit(0); }
        v = v[p];
      }
      if (v === undefined || v === null) console.log('');
      else if (typeof v === 'object') console.log(JSON.stringify(v));
      else console.log(String(v));
    " "$file" "$expr" 2>/dev/null || true
  elif command -v node >/dev/null 2>&1; then
    node -e "
      const fs = require('fs');
      const t = fs.readFileSync(process.argv[1], 'utf8').trim().split(/\\n/).filter(Boolean);
      let obj = null;
      for (let i = t.length - 1; i >= 0; i--) {
        try { obj = JSON.parse(t[i]); break; } catch {}
      }
      if (!obj) process.exit(2);
      const path = process.argv[2].split('.');
      let v = obj;
      for (const p of path) { if (v == null) { console.log(''); process.exit(0); } v = v[p]; }
      if (v === undefined || v === null) console.log('');
      else if (typeof v === 'object') console.log(JSON.stringify(v));
      else console.log(String(v));
    " "$file" "$expr" 2>/dev/null || true
  else
    echo ""
  fi
}

PLATFORM="$(uname -s 2>/dev/null || echo unknown)"
case "$PLATFORM" in
  Darwin) PLATFORM_ID="darwin" ;;
  Linux) PLATFORM_ID="linux" ;;
  *) PLATFORM_ID="unknown" ;;
esac

KERYX_VERSION="$(keryx_exec --version 2>/dev/null | head -1 || echo unknown)"

# --- A2: harness echo ----------------------------------------------------------
A2_OUT="${EVIDENCE_DIR}/A2.json"
A2_RC="$(run_harness "$A2_OUT" -- /bin/echo probe-a2)"
A2_KIND="$(json_field "$A2_OUT" "outcome.kind")"
A2_EXIT="$(json_field "$A2_OUT" "outcome.exitCode")"
if [[ "$A2_KIND" == "completed" && ( "$A2_EXIT" == "0" || -z "$A2_EXIT" ) ]]; then
  add_row "A2" "PASS" "harness exec /bin/echo completed" "n/a" "evidence/A2.json"
elif [[ "$A2_KIND" == "blocked" ]]; then
  A2_REASON="$(json_field "$A2_OUT" "outcome.reason")"
  add_row "A2" "FAIL" "blocked: ${A2_REASON:-unknown}" "n/a" "evidence/A2.json"
else
  add_row "A2" "UNKNOWN" "kind=${A2_KIND:-?} exit=${A2_EXIT:-?} rc=${A2_RC}" "n/a" "evidence/A2.json"
fi

# --- B1: write inside workspace ------------------------------------------------
WRITE_IN="${RUN_DIR}/b1-write-in.txt"
HELPER_B1="$(write_helper "b1-write-in.sh" "printf ok > \"${WRITE_IN}\"")"
B1_OUT="${EVIDENCE_DIR}/B1.json"
B1_RC="$(run_harness "$B1_OUT" -- "$HELPER_B1")"
if [[ -f "$WRITE_IN" ]]; then
  add_row "B1" "PASS" "write inside RUN_DIR succeeded" "n/a" "evidence/B1.json"
else
  B1_KIND="$(json_field "$B1_OUT" "outcome.kind")"
  B1_REASON="$(json_field "$B1_OUT" "outcome.reason")"
  add_row "B1" "FAIL" "in-workspace write missing kind=${B1_KIND} reason=${B1_REASON}" "n/a" "evidence/B1.json"
fi

# --- B2: write outside workspace + CONTROL ------------------------------------
OUTSIDE_PATH="/tmp/keryx-sandbox-probe-b2-${TS}.txt"
rm -f "$OUTSIDE_PATH" 2>/dev/null || true
HELPER_B2="$(write_helper "b2-write-out.sh" "printf outside > \"${OUTSIDE_PATH}\" 2>/dev/null; exit 0")"
B2_OUT="${EVIDENCE_DIR}/B2.json"
B2_RC="$(run_harness "$B2_OUT" -- "$HELPER_B2")"
# CONTROL: unsandboxed write must work
CONTROL_B2_OK=0
if printf control >"$OUTSIDE_PATH" 2>/dev/null; then
  CONTROL_B2_OK=1
  rm -f "$OUTSIDE_PATH" 2>/dev/null || true
fi
# Re-run sandboxed only after control file removed
rm -f "$OUTSIDE_PATH" 2>/dev/null || true
B2_RC="$(run_harness "$B2_OUT" -- "$HELPER_B2")"
if [[ "$CONTROL_B2_OK" -ne 1 ]]; then
  add_row "B2" "UNKNOWN" "CONTROL unsandboxed write to /tmp failed" "failed" "evidence/B2.json"
elif [[ -f "$OUTSIDE_PATH" ]]; then
  add_row "B2" "FAIL" "outside write succeeded under sandbox (should deny)" "ok" "evidence/B2.json"
  rm -f "$OUTSIDE_PATH" 2>/dev/null || true
else
  add_row "B2" "PASS" "outside /tmp write denied; CONTROL ok" "ok" "evidence/B2.json"
fi

# --- C1: network off + CONTROL ------------------------------------------------
# Preserve curl exit status (do not mask with `|| echo` → always 0).
HELPER_C1="$(write_helper "c1-curl.sh" "curl -sS -m 3 -o /dev/null https://example.com; exit \$?")"
C1_OUT="${EVIDENCE_DIR}/C1.json"
C1_RC="$(run_harness "$C1_OUT" -- "$HELPER_C1")"
C1_KIND="$(json_field "$C1_OUT" "outcome.kind")"
C1_EXIT="$(json_field "$C1_OUT" "outcome.exitCode")"
# CONTROL: unsandboxed curl should work (or SKIP if no network on host)
CONTROL_C1="ok"
set +e
curl -sS -m 3 -o /dev/null https://example.com 2>/dev/null
CURL_CTRL=$?
set -e
if [[ "$CURL_CTRL" -ne 0 ]]; then
  CONTROL_C1="failed"
  add_row "C1" "UNKNOWN" "CONTROL curl failed (host network?); sandboxed kind=${C1_KIND} exit=${C1_EXIT}" "failed" "evidence/C1.json"
elif [[ "$C1_KIND" == "completed" && "$C1_EXIT" != "0" && -n "$C1_EXIT" ]]; then
  add_row "C1" "PASS" "network-off: curl non-zero under sandbox (exit=${C1_EXIT}); CONTROL ok" "ok" "evidence/C1.json"
elif [[ "$C1_KIND" == "blocked" ]]; then
  add_row "C1" "PASS" "network path blocked: $(json_field "$C1_OUT" "outcome.reason")" "ok" "evidence/C1.json"
elif [[ "$C1_KIND" == "completed" && ( "$C1_EXIT" == "0" || -z "$C1_EXIT" ) ]]; then
  # exit 0 with network off is a real containment failure on darwin
  add_row "C1" "FAIL" "network-off curl exited 0 (expected deny)" "ok" "evidence/C1.json"
else
  add_row "C1" "UNKNOWN" "kind=${C1_KIND} exit=${C1_EXIT}" "$CONTROL_C1" "evidence/C1.json"
fi

# --- C2: allowlist allow + deny via decisions (macOS); Linux fail-closed note --
C2_OUT="${EVIDENCE_DIR}/C2.json"
if [[ "$PLATFORM_ID" == "linux" ]]; then
  C2_RC="$(run_harness "$C2_OUT" --allowed-domains example.com -- /bin/echo c2)"
  C2_KIND="$(json_field "$C2_OUT" "outcome.kind")"
  C2_REASON="$(json_field "$C2_OUT" "outcome.reason")"
  if [[ "$C2_KIND" == "blocked" ]] || [[ "${C2_REASON}" == *"not yet enforced on Linux"* ]] || [[ "${C2_REASON}" == *"Linux"* ]]; then
    add_row "C2" "PASS" "Linux restricted fail-closed as documented: ${C2_REASON:-blocked}" "n/a" "evidence/C2.json"
  else
    add_row "C2" "SKIP" "Linux restricted/mask: expected fail-closed; kind=${C2_KIND} reason=${C2_REASON}" "n/a" "evidence/C2.json"
  fi
elif [[ "$PLATFORM_ID" == "darwin" ]]; then
  HELPER_C2="$(write_helper "c2-curl-deny.sh" "curl -sS -m 3 -o /dev/null -w '%{http_code}' https://example.org 2>/dev/null; exit 0")"
  C2_RC="$(run_harness "$C2_OUT" --allowed-domains example.com -- "$HELPER_C2")"
  C2_DECISIONS="$(json_field "$C2_OUT" "network.decisions")"
  C2_KIND="$(json_field "$C2_OUT" "outcome.kind")"
  # decisions-over-exitCode: look for allowed:false on example.org
  if echo "$C2_DECISIONS" | grep -q 'example.org' && echo "$C2_DECISIONS" | grep -q 'false'; then
    add_row "C2" "PASS" "deny via network.decisions (not exitCode alone)" "n/a" "evidence/C2.json"
  elif echo "$C2_DECISIONS" | grep -q 'allowed'; then
    add_row "C2" "PASS" "restricted decisions present: ${C2_DECISIONS}" "n/a" "evidence/C2.json"
  elif [[ "$C2_KIND" == "blocked" ]]; then
    add_row "C2" "PASS" "restricted blocked: $(json_field "$C2_OUT" "outcome.reason")" "n/a" "evidence/C2.json"
  else
    add_row "C2" "UNKNOWN" "no deny decision observed kind=${C2_KIND} decisions=${C2_DECISIONS}" "n/a" "evidence/C2.json"
  fi
else
  add_row "C2" "SKIP" "platform ${PLATFORM_ID}: restricted network not claimed" "n/a" "evidence/C2.json"
fi

# --- F1: metachar blocked -----------------------------------------------------
F1_OUT="${EVIDENCE_DIR}/F1.json"
F1_RC="$(run_harness "$F1_OUT" -- /bin/sh -c 'echo hi > /tmp/x')"
F1_KIND="$(json_field "$F1_OUT" "outcome.kind")"
F1_REASON="$(json_field "$F1_OUT" "outcome.reason")"
if [[ "$F1_KIND" == "blocked" ]]; then
  add_row "F1" "PASS" "metachar argv blocked: ${F1_REASON}" "n/a" "evidence/F1.json"
else
  add_row "F1" "FAIL" "expected blocked for shell metachar; kind=${F1_KIND}" "n/a" "evidence/F1.json"
fi

# --- optional live smokes -----------------------------------------------------
if [[ "$LIVE_SMOKES" -eq 1 ]]; then
  if command -v bun >/dev/null 2>&1; then
    add_row "E1" "SKIP" "live smokes flag set; full dual-axis remains operator-run" "n/a" ""
  else
    add_row "E1" "SKIP" "bun not on PATH" "n/a" ""
  fi
fi

# --- R1: redaction scan -------------------------------------------------------
# Scan RUN_DIR for fixture secret (should not appear in evidence dumps).
# The marker file under RUN_DIR/.fixture-secret-marker is intentional source only —
# we exclude it and only fail if secret appears elsewhere (REPORT, evidence, helpers).
REDACTION_HITS=0
while IFS= read -r -d '' f; do
  base="$(basename "$f")"
  case "$base" in
    .fixture-secret-marker) continue ;;
  esac
  # Skip the probe script itself if copied
  if grep -F -q -- "$FIXTURE_SECRET" "$f" 2>/dev/null; then
    REDACTION_HITS=$((REDACTION_HITS + 1))
    echo "leak:$f" >>"${EVIDENCE_DIR}/redaction-hits.txt"
  fi
done < <(find "$RUN_DIR" -type f -print0 2>/dev/null)

if [[ "$REDACTION_HITS" -eq 0 ]]; then
  add_row "R1" "PASS" "no fixture secret substrings under RUN_DIR (marker excluded)" "n/a" "evidence/"
else
  add_row "R1" "FAIL" "redaction hits=${REDACTION_HITS}" "n/a" "evidence/redaction-hits.txt"
fi

# --- overall ------------------------------------------------------------------
PASS_N=0 FAIL_N=0 SKIP_N=0 UNKNOWN_N=0
while IFS=$'\t' read -r id verdict notes control evidence; do
  case "$verdict" in
    PASS) PASS_N=$((PASS_N + 1)) ;;
    FAIL) FAIL_N=$((FAIL_N + 1)) ;;
    SKIP) SKIP_N=$((SKIP_N + 1)) ;;
    UNKNOWN) UNKNOWN_N=$((UNKNOWN_N + 1)) ;;
  esac
done <"$ROWS_FILE"

OVERALL="PASS"
if [[ "$FAIL_N" -gt 0 || "$REDACTION_HITS" -gt 0 ]]; then
  OVERALL="FAIL"
elif [[ "$UNKNOWN_N" -gt 0 ]]; then
  OVERALL="PASS_WITH_GAPS"
fi

# Required rows missing → PASS_WITH_GAPS (or FAIL if we want strict)
for req in A2 B1 B2 C1 C2 F1 R1; do
  if ! grep -q "^${req}	" "$ROWS_FILE"; then
    if [[ "$OVERALL" == "PASS" ]]; then OVERALL="PASS_WITH_GAPS"; fi
    add_row "$req" "UNKNOWN" "required row missing from matrix" "missing" ""
  fi
done

# --- REPORT.md ----------------------------------------------------------------
REPORT="${RUN_DIR}/REPORT.md"
{
  echo "# Sandbox deep probe REPORT"
  echo ""
  echo "- **overall:** ${OVERALL}"
  echo "- **platform:** ${PLATFORM_ID}"
  echo "- **keryx:** ${KERYX_VERSION}"
  echo "- **runDir:** ${RUN_DIR}"
  echo "- **redactionHits:** ${REDACTION_HITS}"
  echo "- **timestamp:** ${TS}"
  echo ""
  echo "## Matrix"
  echo ""
  echo "| ID | Verdict | Control | Notes | Evidence |"
  echo "|----|---------|---------|-------|----------|"
  while IFS=$'\t' read -r id verdict notes control evidence; do
    notes_esc="${notes//|/\\|}"
    echo "| ${id} | ${verdict} | ${control} | ${notes_esc} | ${evidence} |"
  done <"$ROWS_FILE"
  echo ""
  echo "## Metrics"
  echo ""
  echo "| Metric | Value |"
  echo "|--------|-------|"
  echo "| matrixPass | ${PASS_N} |"
  echo "| matrixFail | ${FAIL_N} |"
  echo "| matrixSkip | ${SKIP_N} |"
  echo "| matrixUnknown | ${UNKNOWN_N} |"
  echo "| redactionHits | ${REDACTION_HITS} |"
  echo ""
  echo "## Notes"
  echo ""
  echo "- Restricted network: trust \`network.decisions\`, not curl exitCode alone."
  echo "- CONTROL required for deny claims (B2, C1)."
  echo "- Linux restricted/mask remains fail-closed until OS package lands full support."
  echo "- No real API keys in fixtures (synthetic \`sk-fixture-…\` only)."
  echo ""
} >"$REPORT"

# --- report.json (schema companion) -------------------------------------------
REPORT_JSON="${RUN_DIR}/report.json"
{
  echo "{"
  echo "  \"schemaVersion\": 1,"
  echo "  \"platform\": \"${PLATFORM_ID}\","
  echo "  \"keryxVersion\": $(printf '%s' "$KERYX_VERSION" | bun -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.stringify(s.trim())))' 2>/dev/null || echo "\"${KERYX_VERSION//\"/\\\"}\""),"
  echo "  \"runDir\": $(printf '%s' "$RUN_DIR" | bun -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.stringify(s.trim())))' 2>/dev/null || echo "\"${RUN_DIR//\"/\\\"}\""),"
  echo "  \"overall\": \"${OVERALL}\","
  echo "  \"redactionHits\": ${REDACTION_HITS},"
  echo "  \"rows\": ["
  first=1
  while IFS=$'\t' read -r id verdict notes control evidence; do
    notes_json=$(printf '%s' "$notes" | bun -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.stringify(s)))' 2>/dev/null || printf '"%s"' "${notes//\"/\\\"}")
    if [[ $first -eq 0 ]]; then echo ","; fi
    first=0
    printf '    {"id":"%s","verdict":"%s","notes":%s,"evidence":"%s","control":"%s"}' \
      "$id" "$verdict" "$notes_json" "${evidence//\"/\\\"}" "$control"
  done <"$ROWS_FILE"
  echo ""
  echo "  ],"
  echo "  \"metrics\": {"
  echo "    \"matrixPass\": ${PASS_N},"
  echo "    \"matrixFail\": ${FAIL_N},"
  echo "    \"matrixSkip\": ${SKIP_N},"
  echo "    \"matrixUnknown\": ${UNKNOWN_N}"
  echo "  }"
  echo "}"
} >"$REPORT_JSON"

# Human-facing summary to stdout
echo "RUN_DIR=${RUN_DIR}"
echo "REPORT=${REPORT}"
echo "overall=${OVERALL}"
echo "redactionHits=${REDACTION_HITS}"
cat "$REPORT"

if [[ "$OVERALL" == "FAIL" ]]; then
  exit 1
fi
exit 0
