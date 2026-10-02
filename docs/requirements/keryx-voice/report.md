# Voice for keryx: investigation report (flow 388)

Date: 2026-10-02. Evidence labels: read (source read on this machine), measured, doc (vendor documentation), unverified.

## Recommendation

Superseded by the operator's decision of 2026-10-02 (message 177370): speech recognition is local from the first version, with no cloud. The cloud analysis in sections 3 to 6 is kept as background only.

Recommended stack (section 8, measured on Linux x64): one npm package, `sherpa-onnx-node` (Apache-2.0, 33-40 MB of native code per platform, no ffmpeg, Python or build step, runs under Bun), for both speech recognition and speech synthesis. Recognition: GigaAM v3 CTC int8 (Russian, 215 MB) or Parakeet-TDT v3 int8 (25 languages incl. ru and en, with punctuation, 487 MB), picked at install. Synthesis: Piper voices through sherpa (about 21 MB per voice). Telegram's OGG/Opus is handled by `ogg-opus-decoder` (decode) and `@evan/opus` plus a small own Ogg muxer (encode), about 14 MB together.

First follow-up flow: inbound voice in the topic, transcribed locally and delivered as a text line, as an optional install module. Spoken replies second.

## Operator decisions (2026-10-02, messages 177302, 177315, 177324)

- The shell receives only text; voice lives entirely in `keryx serve` (download, transcribe, deliver as a text line).
- Voice is an optional module of `keryx serve`, which is installed from npm next to the main keryx package. The user chooses at install time whether to have voice. If yes, the module downloads its own Piper and voices.
- keryx and helyx must not know about each other: no path into helyx's `piper/` folder and no shared code. keryx ships and manages its own, fully independent copy. This replaces the earlier idea of pointing keryx at `/home/altsay/bots/helyx/piper`.
- The voice module may pull its own npm dependencies (message 177335), but they must be the minimum, and each one must be justified in the follow-up flow with its size. The main keryx package keeps `dependencies` at `{}`.
- Voices are chosen during an interactive install in the terminal: the user picks which voices to download (for example English only), and nothing else is fetched. The installer must show the size of each voice before downloading.
- Speakable text (message 177452): helyx runs every reply through a separate model before speech so the voice engine can read it (for Russian: English words and transcriptions rewritten in Cyrillic, text summarised). keryx must do this itself, without an external model: the agent that produces the reply is the one that makes it speakable, so a spoken reply passes through a speakable-text stage before the voice engine. Decided (message 177512): `keryx serve` asks the keryx shell to run a sub-agent, chosen by the model-tier definition (a light tier, not a hard-coded model id), which turns the reply into text for speech using both a dictionary (transliteration, cleanup of code, links and tables) and the model's own knowledge. Decided (message 177529): the model level comes from the existing keryx shell routing, by tier and by availability, so the voice module adds no routing of its own; if the sub-agent is unavailable, the original text is spoken. Open for the follow-up flow only: an acceptance criterion with a fixed set of sample replies.

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

Answered by the operator: no cloud (local from the first version); "shell" means keryx shell, which only receives text; an optional independent module with its own downloads and voices chosen at install.

Still open:

1. Recognition model tiers to offer at install: GigaAM v3 (ru, 215 MB), Parakeet v3 (ru+en, 487 MB), the small Russian tier (60 MB)?
2. Spoken replies: Piper only, or Supertonic 3 as the one-model option too? Which trigger (helyx's 300 character rule, or per topic on request)?
3. Is the model licence acceptable (Parakeet licence unverified; Supertonic weights OpenRAIL-M; espeak-ng-data GPL-like)?
4. May the module depend on `sherpa-onnx-node`, `ogg-opus-decoder` and `@evan/opus` (about 50 MB together on a platform)?
5. Where does the module live: a separate npm package next to `keryx serve`, and how the interactive installer is started?
6. Fix helyx's two suspected defects, or ignore them (it is a separate project)?

## 8. Local-first research (2026-10-02; measured on Linux x64, 16 cores, CPU only, Node 24 and Bun 1.4.2 gave identical results)

Tags: [M] measured here, [D] documentation or registry data, [U] unverified.

Scope (operator, message 177808): the comparison is local only. For AC1 this section is the comparison: three or more recognition options and four synthesis options, all local, all $0 per use, all through one dependency (`sherpa-onnx-node`). Per option the tables give languages (Russian and English), download size, latency where measured (`not measured` where not) and a source tag. The cloud tables in sections 3 and 4 stay as background only and are not part of the recommendation.

### One package for recognition and synthesis: sherpa-onnx-node (Apache-2.0)

- Version 1.13.8, published 2026-09-10 [D]. The JS wrapper is 61 KB; native code comes as optional per-platform packages: linux-x64 33 MB, linux-arm64 40 MB, darwin-arm64 34 MB, darwin-x64 38 MB [D npm]. Only linux-x64 was installed and run [M].
- No ffmpeg, Python or native build; runs under Bun [M]. It reads WAV only, so OGG/Opus must be decoded first [U]. It resamples to 16 kHz internally [M].
- Models are downloaded separately from GitHub releases or HuggingFace, which fits the interactive "pick your voices" install.

### Speech recognition candidates (all through sherpa-onnx)

| Model | Languages | Download | Measured (11.3 s Russian clip) | Notes |
|---|---|---|---|---|
| GigaAM v3 CTC int8 | Russian only | 215 MB | 0.70 s decode (RTF 0.06), 2 s load, 376 MB RSS [M] | MIT. Lowercase, no punctuation; transcript correct [M]. Published Nov 2025. The HF export is not yet in an official sherpa release [D, issue 3619]. |
| Parakeet-TDT-0.6b-v3 int8 | 25 languages incl. ru, en | 487 MB (641 MB on disk) | 1.1 s (RTF 0.1), 4.7 s load [M] | Punctuation and capitals; English clip correct [M]. About 1 GB RSS with TTS loaded [M]. Licence [U]. |
| sherpa zipformer-ru int8 | Russian | 60 MB | not measured | smaller tier [D] |
| Streaming small-ru Vosk int8 | Russian | 24 MB | not measured | smallest tier [D] |
| Whisper tiny / base via sherpa | multilingual | 116 / 208 MB | not measured | Russian quality at these sizes is weak [U] |
| Moonshine tiny/base | no Russian [D] | 108 / 251 MB | not measured | not suitable for ru |

Rejected: Vosk standalone (last release 2024-04), whisper.cpp v1.9.4 (the release has no prebuilt binaries, so a cmake build or a spawned binary is needed; ggml q5_1 sizes tiny 32 MB, base 60 MB, small 190 MB; not built or measured), faster-whisper (needs Python), transformers.js (pulls onnxruntime-node, 301 MB).

### Speech synthesis candidates

| Voice | Languages | Download | Measured | Notes |
|---|---|---|---|---|
| Piper through sherpa, int8 | ru (ruslan, irina, dmitri, denis), en (lessac and others) | about 21 MB each (37 MB on disk with espeak-ng-data) | irina: 1.4 s for 6.5 s of audio (RTF 0.21), 1.2 s load [M]; re-transcription had one small error [M] | The espeak-ng-data licence is GPL-like [U]. Upstream Piper moved to OHF-Voice/piper1-gpl (GPL-3.0, Python wheel); the old MIT repo is archived. Use the sherpa route. |
| Supertonic 3 int8 | 31 languages incl. ru, en | 129 MB | RTF 0.43-0.45, 44.1 kHz; re-transcribed verbatim [M] | code MIT, weights OpenRAIL-M [D]; one model for ru and en |
| Kokoro | no Russian [D] | kokoro-js 30 MB + transformers.js | - | not a fit |
| Kitten TTS | English only | 31 MB (sherpa nano int8) [D] | - | not a fit for ru |

### Telegram audio without ffmpeg (round trip measured [M])

- Decode: `ogg-opus-decoder` (MIT, 1.7.5; 9.8 MB installed, about 115 KB of wasm used) returns 48 kHz float PCM; a 6 s clip decoded in 40-68 ms.
- Encode: `@evan/opus` 1.0.3 (MIT, 3.6 MB, last release 2024-02) with native files for linux and mac, x64 and arm64, plus a 324 KB wasm fallback. It writes raw Opus frames with no Ogg container, so a roughly 30-line Ogg muxer (OpusHead, OpusTags, CRC32) is needed; `file` accepts the result as "Ogg data, Opus audio". 6.3 s encoded in 60 ms. Set the bitrate near 24 kbps for speech.
- The full loop Piper -> OGG/Opus -> decode -> GigaAM worked under Node and Bun. Sending the file to Telegram `sendVoice` was not tested.

### Install weight of the recommended stack (npm + models)

| Stack | Linux x64 | Linux arm64 | macOS arm64 | macOS x64 |
|---|---|---|---|---|
| sherpa native code | 33 MB | 40 MB | 34 MB | 38 MB |
| Opus packages | 14 MB | 14 MB | 14 MB | 14 MB |
| Ru + en minimal: GigaAM v3 + Piper ru + Piper en | 215 MB + 42 MB of voices | same | same | same |
| Parakeet v3 + Piper ru and en | 487 MB (641 MB on disk) + 42 MB | same | same | same |

Native sizes are registry data; only linux-x64 was installed and run. Not measured: arm64 and macOS runs, GPU, whisper.cpp build and latency, WER on any benchmark, English clips with GigaAM, the Telegram upload.

## Not done

Cloud calls were not made (sections 3-6 are registry and documentation data). The measurements in section 8 are for Linux x64 only; arm64 and macOS were not run.
