# Voice for keryx: investigation report (flow 388)

Date: 2026-10-02. Evidence labels: read (source read on this machine), measured, doc (vendor documentation), unverified.

## Recommendation

First follow-up flow: inbound Telegram voice only. Download the voice message, transcribe it with Groq Whisper through one plain `fetch` call, deliver it as a text line. No new npm package, no extra install weight. Spoken replies come second, using the OGG/Opus output a cloud provider returns directly. Local engines come third and only if the operator wants no audio to leave the machine.

## Operator decisions (2026-10-02, messages 177302, 177315, 177324)

- The shell receives only text; voice lives entirely in `keryx serve` (download, transcribe, deliver as a text line).
- Voice is an optional module of `keryx serve`, which is installed from npm next to the main keryx package. The user chooses at install time whether to have voice. If yes, the module downloads its own Piper and voices.
- keryx and helyx must not know about each other: no path into helyx's `piper/` folder and no shared code. keryx ships and manages its own, fully independent copy. This replaces the earlier idea of pointing keryx at `/home/altsay/bots/helyx/piper`.
- The voice module may pull its own npm dependencies (message 177335), but they must be the minimum, and each one must be justified in the follow-up flow with its size. The main keryx package keeps `dependencies` at `{}`.
- Voices are chosen during an interactive install in the terminal: the user picks which voices to download (for example English only), and nothing else is fetched. The installer must show the size of each voice before downloading.

## 1. How helyx does voice today (read)

- STT: `utils/transcribe.ts` calls Groq `whisper-large-v3` through multipart `fetch`, passing the OGG file as is. The fallback is a local whisper-asr-webservice on :9000; it is commented out in compose and not listening on this machine. helyx's "about 200 ms" claim is unverified.
- TTS: `utils/tts.ts` tries Piper, then Yandex for Russian. For English it tries Piper, then Kokoro, then Groq Orpheus. Delivery is a multipart `sendVoice` in tracks of about 90 s, with an outbound secret scan.
- Triggers: a spoken recap after a voice message or for 200+ characters of prose; 300+ raw characters on the older path.
- Weight (measured): Piper runtime 52 MB, three voices 181 MB. The `kokoro-js` chain is hundreds of MB; the Kokoro model was never downloaded here.
- Suspected defects (unverified): it sends WAV to `sendVoice`, which Telegram only guarantees for OGG/Opus, MP3 and M4A. Groq Orpheus is capped at 200 characters, returns WAV and has no Russian, while helyx passes up to 4000 characters.
- Reusable by keryx: ideas only (the Groq call shape, language switch, chunking, retry on 429, text first).
- Not reusable: the code itself, helyx as a service (it exposes no STT or TTS endpoint), and the local ASR container.

## 2. keryx today (read, measured)

- No audio code anywhere in `src`. `dependencies` is `{}`; the install is 20.6 MB unpacked.
- `bot-api-http.ts` is JSON-only: no `getFile`, no `sendVoice`, no multipart.
- `BotMessage` has no voice field, and `hub.ts route()` silently drops a message with no text.
- `no-live-network.test.ts` allows `fetch` only in `bot-api-http.ts`.
- ffmpeg, opusenc, piper, whisper and espeak-ng are absent on this machine.

## 3. Speech-to-text options (a 15 s message)

| Option | Type | Size | Dependency | Price | Per message |
|---|---|---|---|---|---|
| Groq whisper-large-v3-turbo | cloud | 0 | `fetch` | $0.04/h, 10 s minimum billed | $0.00017 |
| OpenAI gpt-4o-mini-transcribe | cloud | 0 | `fetch` | $0.003/min | $0.00075 |
| Yandex SpeechKit STT | cloud | 0 | `fetch` | $0.0013 per 15 s | $0.0013 |
| whisper.cpp | local | model 57-142 MiB; v1.9.4 ships no binaries, needs a build | none for npm; needs ffmpeg or similar to decode OGG | $0 | $0 |
| Vosk | local | about 40-50 MB per model | native lib plus a binding (a Bun one is unverified) | $0 | $0 |

- Russian and English: all are multilingual. Vosk small-ru WER 9.8 (doc). Russian quality of whisper.cpp tiny/base is unverified. Latency was not measured for any option.
- Sources (doc): console.groq.com/docs/speech-to-text, the Yandex Cloud pricing page, costgoat.com, alphacephei.com/vosk/models.

## 4. Text-to-speech options (a 300 character reply)

| Option | Type | Size | Dependency | Price | RU / EN | Per reply | Output |
|---|---|---|---|---|---|---|---|
| Piper | local | 52 MB + about 60 MB per voice | spawn a binary | $0 | both | $0 | WAV, needs an encoder |
| Yandex v1 | cloud | 0 | `fetch` | $11 / M chars | RU best, EN available | $0.0033 | `oggopus`, usable directly |
| OpenAI tts-1 | cloud | 0 | `fetch` | $15 / M chars | both | $0.0045 | `opus`, usable directly |
| Groq Orpheus | cloud | 0 | `fetch` | $22 / M chars | EN only | $0.0066 | WAV, 200 character cap |
| edge-tts (`node-edge-tts`) | cloud, unofficial | 22 packages, 1.7 MB (measured) | npm | free | both | $0 | MP3; breaks Microsoft terms (secondary sources) |

- Piper, measured on a cold process: 196 Russian characters into 15.9 s of audio took 1.7 s wall and 268 MB RSS; 156 English characters into 8.9 s took 1.55 s and 209 MB RSS.
- Kokoro and espeak-ng were considered. Kokoro is not recommended: it brings back the heavy stack keryx already removed.
- Cloud TTS latency and Opus encoding latency were not measured.

## 5. Dependency paths

- No new npm dependency: Groq STT with the OGG sent straight in, Yandex `oggopus` or OpenAI `opus` for TTS, and a multipart `sendVoice`. 0 MB and 0 packages added, with about 300-400 lines of new source (estimate).
- Smallest dependency: `@evan/opus`, 1 package and 3.6 MB (measured), only needed once a local engine produces WAV. An Ogg muxer would be extra in-house code.

## 6. Smallest first step: expected outcome of follow-up flow 1

A voice message from an allowed user in a paired topic is downloaded (`getFile`, 20 MB cap, token scrubbed), transcribed by Groq whisper-large-v3-turbo through one `fetch` call, and delivered as `🎤 <text>` exactly once, with no duplicates after a restart. The transcript is echoed in the topic. With no key, or on any failure, the topic gets one plain message and the poller is never blocked. `dependencies` stays `{}`. `no-live-network.test.ts` is extended by one named file. Tests use fakes only. The TUI shows the voice status.

Flow 2: spoken replies with Opus from the provider. Flow 3: local engines.

## 7. Open decisions for the operator

1. May audio go to Groq (privacy)?
2. Reuse the stored Groq provider key, or a separate voice key?
3. Does "shell" mean non-TUI CLI commands? Mic and playback tools are absent here, and the flow description puts the TUI out of scope.
4. Which engine for spoken replies: OpenAI, Yandex or Piper?
5. Which trigger: helyx's 300 character rule, or per topic on request?
6. Where does the speech fetch live: a named test exception, or a module outside `src/remote`?
7. Fix helyx's two suspected defects, or ignore them?

## Not done

No cloud call was made (Groq, OpenAI and Yandex latency are unmeasured), whisper.cpp was not built, and how Telegram displays WAV sent through `sendVoice` was not checked.
