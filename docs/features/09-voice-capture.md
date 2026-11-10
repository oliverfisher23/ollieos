# Feature PRD: Voice capture

| | |
|---|---|
| Screen | `design/screens/PhoneVoice.dc.html` |
| Entry point | The yellow add button in the phone tab bar (long press), and a microphone button in the Home add box |
| Milestone | 6, with phone polish |

## 1. Problem

The best moment to capture a task or a fact is straight after a call or while walking between meetings, when typing is awkward.

## 2. What it does

Ollie speaks; OllieOS transcribes, splits what he said into tasks and knowledge, and shows the result for a quick check before saving.

## 3. Screen (phone first)

- **Idle:** "Say a task, a note, or what just happened." and a large yellow microphone button.
- **Recording:** live waveform, live transcript, timer; the button turns red and stops recording.
- **Review:** one white card per item found:
  - Task cards go to Inbox, with due date, project and person chips.
  - Fact cards go to the Knowledge Inbox, with the item they belong to.
  - Actions: **Discard** and **Save both** (or "Save all"). Tapping a card edits it.
- **Saved:** "Saved." with what went where.

## 4. Rules

1. Maximum recording 2 minutes.
2. Transcription, then parsing by the Anthropic API into tasks, promises and facts, using the same inline rules as quick add (due dates, priority words, project and person names matched against OllieOS).
3. Nothing is saved until Ollie confirms. Tasks go to Inbox, never straight to Now. Facts go to the Knowledge Inbox, so voice is never a backdoor around approval.
4. The audio file is deleted once the transcript is saved. The transcript is kept on each created item as its source.
5. Works in the browser with microphone permission. Without permission, the screen falls back to a text box.

## 5. Data model

`tasks` and `suggestions` use `source_type = voice` and store the transcript in `source_quote`.

## 6. Acceptance criteria

1. "Chase Emma on the PwC sign-off on Wednesday" creates one Inbox task due on the coming Wednesday, linked to PwC Skills for Tomorrow and Emma Duck.
2. A spoken fact creates a Knowledge Inbox suggestion, not a fact.
3. Discard saves nothing and deletes the audio.
4. Audio is not kept after saving.

## 7. Open decisions

| Item | Proposal |
|---|---|
| Transcription | The browser's built-in speech recognition where available, with a hosted speech-to-text service as fallback (key in Replit Secrets). Decide at milestone 6 |
