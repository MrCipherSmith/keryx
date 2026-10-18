STATUS: DONE

```json keryx:premises
{
  "judge": "review-premise",
  "model": "claude-opus-5-5",
  "premises": [
    {
      "finding_id": "F1",
      "verdict": "challenged",
      "intent_signals": [
        { "ref": "src/player/PlaybackTimeline.tsx:33", "says": "explicit dir=\"ltr\" override on the timeline root" },
        { "ref": "src/player/PlaybackTimeline.tsx:7", "says": "doc comment: pixel offset from the scroller's left edge is media time (physical-LTR mapping by design)" },
        { "ref": "eslint.config.js:10", "says": "exemption names PlaybackTimeline.tsx and MediaPlaybackControls.tsx a physical-LTR scroll/pixel island because the timeline maps pixels to media time, which runs left to right" },
        { "ref": "src/player/MediaPlaybackControls.tsx:8", "says": "sibling media control forces the same dir=\"ltr\"; this contradicts the finding's claim that the timeline is the only component in src/player forcing a direction" },
        { "ref": "8c77b10", "says": "commit message: pin the timeline to dir=ltr because scrollLeft and pixel offsets map to media time, which flows left to right, and the sibling media controls already do the same; exempted from the lint for this island" },
        { "ref": "a398b42", "says": "commit message: force dir=ltr on media controls because play/seek icons carry a direction that must not swap in RTL" }
      ],
      "practice_sources": [
        { "name": "Material Design — Bidirectionality (what not to mirror: media playback controls and progress)", "says": "media playback buttons and the playback progress indicator do not mirror in RTL, because they show the direction of tape/time rather than reading direction" },
        { "name": "Apple Human Interface Guidelines — Right to left", "says": "video/audio playback controls and timeline indicators keep their left-to-right direction in RTL layouts" }
      ],
      "reasoning": "The fact reproduces (dir=\"ltr\" is there), but the code chose it deliberately, with a lint exemption, a commit message giving the reason, and a sibling media control doing the same. Platform practice is that playback progress does not mirror, so STYLING.md's general rule meets a recognised exception here. The suggested fix would remove a documented exemption and make the timeline differ from its sibling MediaPlaybackControls, which makes the system less consistent, and a senior reviewer would reject mirroring a playback timeline on platform grounds.",
      "question": "The playback timeline is LTR on purpose, as Material and Apple guidance do for media progress, and it matches the sibling media controls. Keep it LTR, or mirror it anyway?",
      "options": ["dismiss — keep the timeline LTR, as platforms do", "uphold — mirror the timeline and drop the lint exemption"]
    },
    {
      "finding_id": "C1",
      "verdict": "upheld",
      "reasoning": "No intent signal for ignoring scroll offset. The component's own contract (line 7) defines media time as pixel offset from the scroller's content left edge, and the effect at line 21 maps time to scrollLeft, so a pointer-to-time conversion without scrollLeft is inconsistent and seeks to the wrong time once the strip is scrolled. The fix is sound and stays physical-LTR, consistent with the island."
    },
    {
      "finding_id": "C2",
      "verdict": "upheld",
      "reasoning": "The effect at lines 24-30 adds a window resize listener with no cleanup and re-runs on every positionMs change, so listeners accumulate and the element is kept after unmount. No signal of intent; returning removeEventListener is the standard React effect idiom."
    },
    {
      "finding_id": "C3",
      "verdict": "upheld",
      "reasoning": "The emoji-only button at VolumeBar.tsx:6 has no accessible name (WCAG 4.1.2 Name, Role, Value), and sibling buttons in MediaPlaybackControls.tsx:9-11 all carry aria-label, so the fix makes the system more consistent. No intent signal against it."
    }
  ]
}
```

## Summary

upheld 3 (C1, C2, C3); challenged 1 (F1). Held: F1.
