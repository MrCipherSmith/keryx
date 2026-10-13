# Review of docs/requirements/keryx-voice/report.md (flow 388, PR 846)

Documentation-only change: one 144-line investigation report. Read in full against the flow's five acceptance criteria. Two claims about keryx today were re-checked against the code (bot-api-http.ts has no getFile, sendVoice or multipart; dependencies is empty). The measurements in section 8 and the vendor figures were not re-run or re-fetched; they are taken from the report's own evidence tags. No blockers.

**F-001. Section 6 still describes the cloud first step.** `docs/requirements/keryx-voice/report.md:72`, in the diff. The Recommendation says the first follow-up flow is local inbound voice, but section 6 ("Smallest first step") specifies Groq transcription and `dependencies` unchanged, and only the intro says sections 3 to 6 are background. A reader who jumps to section 6 gets a stale plan. Fix: add "(superseded, cloud background)" to the headings of sections 3 to 6.

**F-002. Install-weight table omits Windows.** `docs/requirements/keryx-voice/report.md:133`, in the diff. The table lists four platforms and the Not done section does not name Windows as untested or unsupported. Fix: add one line saying whether Windows is out of scope.

**F-003. Piper voice size differs between sections.** `docs/requirements/keryx-voice/report.md:57`, in the diff. Section 4 says about 60 MB per voice (the chat bot's own Piper), section 8 says about 21 MB per int8 voice through sherpa. Both are correct for their stack but not reconciled. Fix: one clause naming the stack in section 4.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "flow388-docs-consistency",
    "severity": "minor",
    "problem": "Section 6 'Smallest first step' still specifies a Groq cloud transcription flow, while the Recommendation and the operator decision say speech recognition is local from the first version. Only the intro marks sections 3 to 6 as background.",
    "impact": "A reader who opens section 6 directly plans the wrong first follow-up flow (cloud, Groq key) against the operator decision.",
    "suggested_fix": "Mark the headings of sections 3 to 6 as superseded cloud background, or point section 6 at the local first step in the Recommendation.",
    "evidence": "Read docs/requirements/keryx-voice/report.md lines 5-11 (Recommendation) and 72-76 (section 6) at b856f1d8.",
    "confidence": "high",
    "file": "docs/requirements/keryx-voice/report.md",
    "line": 72,
    "quote": "## 6. Smallest first step: expected outcome of follow-up flow 1"
  },
  {
    "id": "F-002",
    "reviewer": "flow388-docs-consistency",
    "severity": "minor",
    "problem": "The install-weight table covers Linux x64, Linux arm64, macOS arm64 and macOS x64 only. Windows is neither covered nor declared out of scope.",
    "impact": "The follow-up flow could assume Windows support that nobody investigated.",
    "suggested_fix": "State in the Not done section whether Windows is out of scope or unverified.",
    "evidence": "Read report.md lines 131-144 at b856f1d8; the word Windows does not appear in the file.",
    "confidence": "medium",
    "file": "docs/requirements/keryx-voice/report.md",
    "line": 133,
    "quote": "| Stack | Linux x64 | Linux arm64 | macOS arm64 | macOS x64 |"
  },
  {
    "id": "F-003",
    "reviewer": "flow388-docs-consistency",
    "severity": "info",
    "problem": "Piper voice size is about 60 MB per voice in section 4 and about 21 MB per voice in section 8, without saying the first is the chat bot's own Piper build and the second is the int8 sherpa export.",
    "impact": "Two figures for the same product in one report can read as an error; no decision depends on it because section 4 is background.",
    "suggested_fix": "Name the stack next to each figure.",
    "evidence": "Read report.md lines 27, 57 and 120 at b856f1d8.",
    "confidence": "high",
    "file": "docs/requirements/keryx-voice/report.md",
    "line": 57,
    "quote": "| Piper | local | 52 MB + about 60 MB per voice | spawn a binary | $0 | both | $0 | WAV, needs an encoder |"
  }
]
```
