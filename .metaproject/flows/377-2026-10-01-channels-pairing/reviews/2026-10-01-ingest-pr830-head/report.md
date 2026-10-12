Review of flow 377 at PR #830 head fd937144 (correctness, Sonnet). The identity proof and group migration read correct; five findings remain in the channels controller, the shell client and the proof's failure path: F-202 major, F-201, F-203, F-204, F-205 minor.

```json keryx:findings
[
  {
    "id": "F-201",
    "reviewer": "flow377-pr830-correctness",
    "severity": "minor",
    "problem": "ChannelsController.pair() prepares a Pairing (getMe), awaits dropPairing(), re-checks only `generation`, then calls begin() and stores it. ChannelsController.stop() (called by serve shutdown after surface.close()) does not bump `generation` and does not run under `exclusive`, so a pair() that is mid-await when serve stops still passes the generation check, starts a new poller and parks the Pairing in this.pairing after stop() already cleared it.",
    "impact": "After `keryx serve` begins shutting down, a pair request in flight starts a live getUpdates poller and a 10-minute timer that nothing will ever cancel; the process keeps polling Telegram for that token during and after shutdown, and it may collide with the next serve's poller (409 conflict) on the same bot token.",
    "suggested_fix": "Have stop() bump `this.generation` (and set a `stopped` flag that pair() checks right before begin()), or run stop() through `exclusive` so it waits for an in-flight pair. Add a test in channels-serialize.test.ts: start pair with a slow getMe, call controller.stop(), release getMe, assert no poller was started.",
    "evidence": "src/remote/channels.ts:78-81 (stop), 123-157 (pair), 83-87 (exclusive); src/remote/service.ts:212-217 (shutdown order); src/remote/channels-serialize.test.ts has no stop-during-pair case",
    "confidence": "medium",
    "file": "src/remote/channels.ts",
    "line": 154,
    "quote": "      opened.pairing.begin();"
  },
  {
    "id": "F-202",
    "reviewer": "flow377-pr830-correctness",
    "severity": "major",
    "problem": "ChannelsClient.startPairing writes the new bot token to disk, calls channels-pair, and on ANY failure restores the file to the bytes captured before its own write. That includes `no-answer` (timeout: serve may have already opened a pairing for the new token) and `superseded` (a second shell wrote its own token after this shell's snapshot). The restore overwrites whatever is on disk at that moment, not the value this call wrote.",
    "impact": "Token file and live pairing can disagree. After a timeout or a supersede, serve keeps a pairing for token B while the file is rolled back to A (or deleted); the later Connect/Resume writes the config with ids paired through bot B and reloads the hub with token A, or fails with no token. Two shells connecting at once can erase each other's token. The file also briefly holds a rejected token while an older ready/live pairing exists, which a concurrent reload would pick up.",
    "suggested_fix": "Roll back only on definitive refusals (rejected / no-token / already-connected / serve-down) and only if the file still holds the exact token this call wrote (compare before restoring). On `no-answer` and `superseded` leave the file alone and let the next channels-status/pairing read tell the truth, as connectFinish already does for no-answer. Add tests for both codes.",
    "evidence": "src/remote/channels-client.ts:147-164 (startPairing, restore), 370-384 (restore); src/remote/channels.ts:124-148 (pair reads the token from disk via openApi at the time it runs)",
    "confidence": "medium",
    "file": "src/remote/channels-client.ts",
    "line": 161,
    "quote": "      this.restore(file, before);",
    "class_scope": {
      "sites": [
        "src/remote/channels-client.ts startPairing (line 161): restores on every failure code, including no-answer and superseded; this is the defect",
        "src/remote/channels-client.ts restore() helper (line 371): overwrites the file with the snapshot without comparing the current content to what the call wrote",
        "src/remote/channels-client.ts connectFinish (line 210): same helper, but it already skips no-answer; checked and not affected by the no-answer case"
      ],
      "enumeration_method": "keryx ctx rg --all -n 'restore\\(' src/remote/channels-client.ts lists exactly three matches (161, 210, 371 definition); each caller was read."
    }
  },
  {
    "id": "F-203",
    "reviewer": "flow377-pr830-correctness",
    "severity": "minor",
    "problem": "pair() takes `++this.generation` on entry, before the new token is validated. A second pair call carrying a bad token therefore bumps the generation while an earlier valid pair() is still awaiting getMe; the earlier call then hits `mine !== this.generation` and returns 409 superseded, discarding the Pairing it just prepared, and the second call fails with token-rejected. The `bad token keeps pairing` guarantee holds only for a pairing that already exists, not for one still starting.",
    "impact": "A mistyped token or a second shell racing the first can leave the operator with no pairing at all: the valid request is reported as superseded and the invalid one as rejected, so neither pairing exists and the shell has restored the token file. The operator has to start over.",
    "suggested_fix": "Bump the generation only after the new token has validated (in the exclusive section, right after Pairing.prepare succeeds), or have a failed validation restore the previous generation so an in-flight valid start is not superseded. Add a test: pair(valid) in flight, pair(rejected token) arrives, the first still comes up.",
    "evidence": "src/remote/channels.ts:123-157; src/remote/channels-serialize.test.ts:90-108 (two valid pairs) and 245-268 (bad token only against an existing, not an in-flight, pairing)",
    "confidence": "high",
    "file": "src/remote/channels.ts",
    "line": 124,
    "quote": "    const mine = ++this.generation;"
  },
  {
    "id": "F-204",
    "reviewer": "flow377-pr830-correctness",
    "severity": "minor",
    "problem": "Serve signs only answers produced inside RemoteHttpSurface.handle. Every authenticated answer produced before or around it carries no proof: the 503 draining reply, the 404/405 for shell callers, the 429 throttle, and the 500 internal-error when the surface throws. The shell verifies the proof before looking at the status, so all of them surface as `unverified-serve` (channels) or an `unverified` TransientClientError (remote client).",
    "impact": "During a serve drain, a token-rotation race, or an internal error in the controller, the operator is told that another program is answering on the port and to restart serve and update keryx on both sides. That sends them after a security incident or a version mismatch that does not exist, and hides the real status and message.",
    "suggested_fix": "Sign those answers too (move proof creation into serve-server for the shell principal, around the whole routeServeRequest result for authenticated shell callers), or have the shell distinguish `no proof header and non-2xx` from `proof present and wrong` and report the HTTP status for the former without trusting the body. Add a test with a draining serve and with a surface that throws.",
    "evidence": "src/lib/serve-server.ts:916-931 (401/429), 940-942 (503 draining), 952-963 (404/405 and handler call), 892-895 (500); src/remote/http-surface.ts:277-298 (proof added only in handle); src/remote/channels-client.ts:348-351; src/remote/client.ts:368-370",
    "confidence": "high",
    "file": "src/remote/channels-client.ts",
    "line": 348,
    "quote": "    if (!verifyServeResponseProof(token, nonce, route, response.status, text, response.headers.get(SERVE_PROOF_HEADER))) {"
  },
  {
    "id": "F-205",
    "reviewer": "flow377-pr830-correctness",
    "severity": "minor",
    "problem": "A pairing that reaches `ready` is final, so expireIfDue() never touches it (it only acts on non-final states), recheck() only inspects while `waiting-for-group`, and the controller now keeps reporting state `pairing` for it indefinitely. There is no TTL and no re-check of the group before Resume connects it.",
    "impact": "A finished pairing left by a closed modal stays as `pairing` until someone reloads or cancels, so the channel never shows as not-connected, and Resume days later connects ids from a snapshot that was never re-verified (the group may have lost Topics or the bot its admin rights, or the paired user may have been removed). The failure then appears only as a hub that cannot start, and `reload` has already consumed the pairing (dropPairing), so everything must be redone.",
    "suggested_fix": "Give ready its own deadline (expire after the group step's ttl), and have channels-pairing re-run inspectGroup for a ready pairing before returning it as ready, falling back to waiting-for-group with the problems named if the check fails. Add a test for expiry of an unconsumed ready pairing.",
    "evidence": "src/remote/pairing.ts:189-198, 201-210, 231-236, 238-256; src/remote/channels.ts:94-107 and 179-201 (reload consumes the pairing before startHub); src/remote/channels-serialize.test.ts:210-244 (F-107 covers only that ready is reported, not its lifetime)",
    "confidence": "medium",
    "file": "src/remote/pairing.ts",
    "line": 232,
    "quote": "    if (!FINAL.has(this.state) && this.now() > this.expiresAt) {"
  }
]
```
