# OllieOS: how to use it

OllieOS is where your work lives: tasks, the people and organisations you work with, projects, decisions and what you know about them. It reads Gmail, Slack, Google Calendar, Granola, Drive and Dropbox for you, and Claude, ChatGPT and Gemini can read and write it through its connector. Nothing it learns becomes knowledge until you approve it, and it never sends an email or a Slack message for you: it drafts, you send.

This guide follows the app from left to right. On a phone the bar at the bottom has Home, Tasks, the yellow add button, People and Knowledge; everything else is reached from those pages.

## Home

- **Today strip.** Your meetings today, with a link to each prep page. A meeting you have not prepared for shows "Not prepped".
- **Add box.** Type a task in plain words: "Chase Sam on the contract Wednesday high" sets the due date and priority and links the person and project it finds. On a phone, the yellow add button opens the same box; hold it down to speak instead (see Voice capture).
- **Cards.** Inbox, Now, Waiting on, Slack to answer, Not prepped, the week check ("This week is over by about 2 hours") and where your time went.

## Triage

Open Triage from the Inbox card. One item at a time: **Now** (N), **Backlog** (B), **Waiting** (W), **Noise** (X), and U to undo. On a phone, swipe right for Now and left for Noise. Sending something to Noise offers "Always ignore items like this", which makes a noise rule. Items in Noise are deleted after 90 days.

## Tasks

The full list by tab (Inbox, Now, Backlog, Waiting on, Done, Noise). Click a task for its panel: status, priority, due date, project, person, steps, notes, the source it came from, and its history.

- **Looks done.** When a later message, email or meeting says a task is finished, the task shows "Looks done" with Mark done and Not done. A task finished in its own conversation (you replied "done" in the same Slack thread) closes itself, and "What OllieOS has seen" lists why.
- **Reply drafts.** On email tasks, Draft a reply writes one in your style and your rules; Check lists any line that breaks a rule, Fix these rewrites only those lines, and Save to Gmail puts it in your drafts. You send it.
- **Keep as a test case.** On an item OllieOS found that it got wrong (or right), this saves what the reader was given so a later change can be checked against it.
- **Export.** Tasks, Export downloads every task as a CSV file.

## Email

- **To answer.** Inbox emails sorted into Needs a reply and For your information, with a line on what each wants.
- **Slack.** Slack messages waiting for your reply.
- **Waiting for a reply.** Emails you sent that asked for something and have had no answer.
- **Drafts.** Every draft OllieOS has written: replies, chases, check-ins and meeting follow-ups.

## Meetings and briefs

Meetings lists the next two weeks and the last two. Each work meeting has a prep page: why it matters, a suggested agenda (with your "Next time I see…" points at the top), questions, the people and what is open with them, the client's pulse and research on outside companies. Every work meeting opens, even one with nobody you know on it: that page shows who is coming, lets you add them to People (one is enough for a brief), and has Your agenda: drop your thoughts in any order and OllieOS shapes them into a timed agenda, then changes it as you add more ("put budget first"). The agenda is rich text (bold, headings, numbered and bullet lists, checklists) and stays yours to edit; the next message starts from your edited version, Undo puts back the version before the last change, and Start again clears the conversation. The same agenda shows on the prep page once the meeting has one. Once the meeting ends, From Granola shows its Granola note, the actions it sent to your Inbox and a link to open it in Granola, for every work meeting, brief or not. Until the note arrives it says it is waiting, with Check Granola now. If your thoughts name anyone or anything hidden from AI, nothing is sent and you edit by hand. After the meeting, the Granola notes add actions, decisions and, for external meetings, a follow-up email draft. Repeating meetings that have brought nothing lately are listed under "Worth a look".

## Digest and round-up

The digest (built with the first check of each weekday) says what changed overnight: what needs you, what moved, who has gone quiet, documents colleagues changed, and meetings not yet prepared. The weekly round-up looks back at the week, including where your time went and any agent that slipped. Thumbs up or down on a digest, a brief or an Ask answer tells OllieOS how it is doing.

## Ask

Ask a question in plain words. Answers come only from what OllieOS holds, with a source on every line. "Allow for this question" opens items hidden from AI for that one answer. You can turn an answer into a draft or a bundle of tasks.

## Knowledge

- **Knowledge Inbox.** Everything proposed by OllieOS's readers, by Claude and the other AIs, and by your edits: facts, decisions, people, organisations, rules, playbooks and relationships. Approve, reject or mark as the same as one you have. Nothing becomes knowledge without your approval.
- **Projects, People, Organisations, Products.** Each page holds its facts, decisions, notes, documents, tasks and links. Organisations show their pulse (meetings, emails, what is owed, tone of the last meeting) and, for clients, renewal date, contract value and account health when known. People show "Next time I see…" points.
- **Library.** Documents (add from Drive by search or link, from Dropbox, or upload), rules (how you want things written or done; each shows how often it was used) and playbooks (how your team does things, step by step; Run makes the steps into tasks for a person, organisation or project).
- **Decisions, Notes, Sessions, Map.** Decisions and notes as lists; Cowork sessions saved by Claude; the map shows how everything connects.

## Goals, strategy and People

Goals link projects to what you want this quarter, with time spent against each. Strategy holds your direction and the ideas list. People shows who is due a catch-up on the cadence you set for each.

## Settings

- **Connectors.** Which sources OllieOS reads, when each was last checked, and any that are failing.
- **AI access.** Which AIs are connected, what each may see, and the read log. Anything marked confidential or hidden from AI is never sent to any model.
- **Agents.** Every AI job inside OllieOS: what it reads, its runs, cost and errors this week, how often you kept what it did, the writers' checks and grades, and the readers' test cases with Replay.
- **Email, Knowledge, Planning, Look back, Dropbox, Sweep.** Settings for each of those.

## Voice capture

Hold the yellow add button on a phone, or press the microphone in the add box. Say a task, a note or what just happened; OllieOS shows what it found as cards (tasks to the Inbox, facts to the Knowledge Inbox). Edit or remove any card, then Save all, or Discard to keep nothing. Speech is turned into text by your browser; no audio is uploaded or kept. Without a microphone the screen offers a text box instead.

## On your phone's home screen

Open OllieOS in Safari (iPhone) or Chrome (Android) and choose Add to Home Screen. It opens full screen like an app.

## For Claude and the other AIs

Connect Claude (or ChatGPT or Gemini) to the OllieOS connector from its settings. It can search and read what you allow, add tasks, promises, notes and activity directly, and propose everything else to the Knowledge Inbox. It cannot delete anything. Before drafting for you it reads your rules, and it can check a draft against them with `check_draft`.

## For whoever maintains it

- Tests: `pnpm --filter @workspace/api-server run test` (a separate `ollieos_test` database).
- After changing how a reader sorts messages: `pnpm --filter @workspace/api-server run replay` runs the kept test cases against the new code.
- One-off imports: `POST /api/import` with `kind` "tasks" or "knowledge", once per kind (see `docs/PRD.md` section 14).
- The build plan, with what each part does and how it was checked, is `docs/build-plan.md`.
