# Feature PRD: Playbooks

| | |
|---|---|
| Screen | `design/screens/Library.dc.html` (Playbooks tab) |
| Also shown in | Meeting briefs ("Watch-outs from your playbooks") |
| Milestone | 3 |

## 1. Problem

Ollie's standing rules (writing style, PwC terminology, how to describe Micro Internships, defence talk facts, build-request handling) are scattered across Claude memory, project instructions and his head. Each AI tool knows a different subset.

## 2. What it does

Playbooks are short, named rules with a "when it applies" trigger. Every AI tool reads the relevant playbooks from OllieOS before drafting.

## 3. Screen

- Card grid. Each card: title, an on/off switch ("Claude follows [title]"), "Applies when: …", the rule text, and its state ("Claude reads this before drafting" or "Paused: Claude ignores this").
- **New playbook** button opens a simple form: title, applies when, rule, linked projects (optional).

## 4. Rules

1. A playbook is global unless linked to projects or organisations; linked playbooks apply only in that context.
2. `get_context`, Ask and meeting briefs include every enabled playbook that applies.
3. Playbooks are written by Ollie. AI can propose one through the Knowledge Inbox (kind "playbook") but never create or edit one directly.
4. Paused playbooks stay in the list but are never sent to AI.
5. Keep rules short: under 400 characters each. The form shows a counter.

Seed playbooks (from existing Claude memory and project instructions): Writing style; PwC terminology; Micro Internship claims; Defence talks; RAF framing; Build requests.

## 5. Data model

| Table | Fields |
|---|---|
| `playbooks` | id, title, applies_when, rule, enabled, created_at, updated_at |

Links to projects and organisations through `links`.

## 6. MCP changes

- New tool `get_playbooks(context)` where context is a project, person or "general".
- MCP server instructions tell clients to call it before drafting anything on Ollie's behalf.

## 7. Acceptance criteria

1. `get_context` for PwC Skills for Tomorrow includes the PwC terminology playbook.
2. Pausing a playbook removes it from all AI responses immediately.
3. A playbook proposed by AI appears in the Knowledge Inbox and is inactive until approved.
