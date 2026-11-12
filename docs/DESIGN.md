# OllieOS: Design spec

The visual source of truth for the build. The screen files in `design/screens/` show every layout and interaction; this file gives the tokens and rules behind them.

## 1. How to read the screen files

Each `design/screens/*.dc.html` file is a working prototype screen. They are reference, not code to copy in.

- Markup with inline styles shows the layout, spacing and colours exactly.
- `{{name}}` is a value filled in from the script at the bottom of the file.
- `<sc-for list="{{items}}" as="item">` repeats its contents for each item. `<sc-if value="{{flag}}">` shows its contents when the flag is true.
- The `<script type="text/x-dc">` block holds the example data and the interactions (state changes on click). Read it for the behaviour.
- `<script src="./support.js">` is the prototype runtime. Ignore it.
- Example content (Slack and meeting Inbox items, the AI read log, the Sale process access request) is illustrative. Real content comes from the database.

Rebuild each screen as React components using the tokens below. Do not hard-code colours in components; put them in one theme file.

## 2. Screens

| File | Screen | PRD section |
|---|---|---|
| `Main.dc.html` | Home (desktop), with Triage mode overlay | 6, 6.2 |
| `Ask.dc.html` | Ask OllieOS answer | 6.1 |
| `Tasks.dc.html` | Tasks list with tabs | 7.2 |
| `TaskDetail.dc.html` | Task detail panel | 7.3 |
| `Knowledge.dc.html` | Project page with AI access panel | 8.2, 10 |
| `Person.dc.html` | Person page | 8.3 |
| `Settings.dc.html` | Settings: AI access | 10, 11 |
| `PhoneHome.dc.html` | Home on phone (390 × 844) | 6 |
| `PhoneTriage.dc.html` | Triage on phone (390 × 844) | 6.2 |
| `KnowledgeInbox.dc.html` | Knowledge Inbox: Suggested, Conflicts, Needs a check | features/01, 02 |
| `MeetingBrief.dc.html` | Meeting brief | features/03 |
| `Goals.dc.html` | Goals and unlinked work | features/04 |
| `People.dc.html` | People and contact cadence | features/05 |
| `Library.dc.html` | Library: Documents and Playbooks tabs | features/06, 07 |
| `Digest.dc.html` | Daily digest | features/08 |
| `PhoneVoice.dc.html` | Voice capture on phone (390 × 844) | features/09 |

## 3. Typography

| Role | Font | Size and weight |
|---|---|---|
| Interface | `'Google Sans', 'DM Sans', system-ui, sans-serif` (DM Sans self-hosted from `src/assets/fonts`, see `src/theme/fonts.css`) | Body 14 to 15px / 400 |
| Page title (light) | Interface font | 30 to 32px / 600, letter-spacing −0.015em |
| Greeting (dark) | Interface font | 34px desktop, 28px phone / 500 |
| Section label | Interface font | 13px / 600, uppercase, letter-spacing 0.06em |
| Accent: dates, counts, eyebrows | `'Instrument Serif'`, italic | 16 to 22px; large numbers 28 to 48px roman |
| Table header | Interface font | 13px / 400, muted colour |
| Pills | Interface font | 11 to 12px |

Use `font-variant-numeric: tabular-nums` for times, counts and dates in tables.

## 4. Colour tokens

### Shared

| Token | Value | Use |
|---|---|---|
| `ink` | `#1b1d22` | Primary text on light, primary buttons, active nav |
| `ink-muted` | `#55524c` | Secondary text on light |
| `ink-soft` | `#3d3a35` | Body text in rows |
| `accent` | `#f4c542` | OllieOS mark, Next label, Inbox count, Brief me links, triage progress |
| `page` | `#f4f1ea` | Light page background |
| `panel` | `#ffffff` | Light panels and cards |
| `line` | `#e8e5de` | Borders and table header rule |
| `line-soft` | `#f0ede6` | Row dividers |
| `field` | `#f1efea` | Search fields, neutral pills, selected nav item |
| `control-border` | `#e3dfd6` | Buttons and inputs on light |

### Dark surfaces

| Token | Value |
|---|---|
| `bg-gradient` | `radial-gradient(120% 80% at 85% 105%, #b5441a 0%, rgba(181,68,26,.55) 22%, transparent 48%), radial-gradient(90% 70% at 15% 0%, #39507a 0%, transparent 60%), radial-gradient(80% 60% at 50% 55%, #a7a39b 0%, transparent 70%), linear-gradient(180deg, #2c3a55 0%, #6f7277 48%, #8b6a55 100%)` |
| `grain` | SVG `feTurbulence` fractal noise, base frequency 0.9, greyscale, 22% opacity, `mix-blend-mode: overlay` |
| `glass` | `rgba(30,30,32,0.66)`, border `1px solid rgba(255,255,255,0.10)`, `backdrop-filter: blur(22px)` |
| `glass-quiet` | `rgba(30,30,32,0.5)`, border at 8% |
| `glass-input` | `rgba(12,12,14,0.55)` |
| `text-on-dark` | `#ffffff`; secondary at 78 to 85% opacity |
| `ok-dot` | `#8fd18a` (sweep status, done ticks) |

### Status and priority pills

| Pill | Background | Text |
|---|---|---|
| Now | `#eef3c7` | `#4a5410` |
| Backlog | `#ece9e2` | `#3d3a35` |
| Waiting on | `#fbe3dc` | `#8a2a10` |
| Done | `#dfeed7` | `#2f5320` |
| High priority | `#fbe3dc` | `#8a2a10`, weight 600 |
| Medium / Low | `#f1efea` | `#3d3a35` |
| Confidential lock and labels | | `#8a2a10` |
| Access request banner | `#fdf6e1`, border `#efd88f` | `#5c4a1a` |

### Source marks (24px circles with a letter)

| Source | Letter | Background | Text |
|---|---|---|---|
| Email | E | `#d9e2f1` | `#233455` |
| Slack | S | `#efe7fb` | `#5b2e9c` |
| Meeting | M | `#f3dccf` | `#6b2d12` |
| Quarterly | Q | `#dfeed7` | `#2f5320` |
| Manual | O | `#ece9e2` | `#3d3a35` |

People avatars use the same palette with initials.

## 5. Shape and spacing

| Element | Radius |
|---|---|
| Page panels | 22px |
| Dark cards | 20px |
| Ask box and triage dialog | 24px |
| Stat cards and inner cards | 14 to 16px |
| Buttons | 10px (phone: 12 to 16px) |
| Inputs | 9 to 12px |
| Pills | 6px; chips and nav pills 999px |

Gaps: 16px between cards, 22 to 26px between sections in a panel. Page gutter 24px desktop, 16px phone. Max content width 900px on Home, 1220px on light pages.

## 6. Components

- **Icon rail (desktop Home):** floating glass pill, 40px icon buttons, active item white with ink icon. Stroke icons, 1.8px, round caps.
- **Top nav (light pages):** OllieOS mark (30px yellow square, "OS"), then pill links; active pill is ink with white text.
- **Bottom tab bar (phone):** 84px including safe area, five slots: Home, Tasks, the centre 48px yellow round add button, People, More. More opens a bottom sheet (glass, 52px rows with icon, label and chevron) with Knowledge, Meetings, Email, Goals, Strategy, Settings and Log out; the More tab is lit on any of those pages. The light pages' phone header is just the logo.
- **Primary button:** ink on light, white on dark. Secondary: outlined. Destructive: text in `#8a2a10`.
- **Segmented control:** `field` background track, selected segment ink with white text.
- **Switch:** 40 × 24px track (ink when on, `#d6d2c8` off; Confidential on uses `#8a2a10`), 18px white knob.
- **Tables:** no zebra stripes, 1px `line-soft` row dividers, hover `#faf8f3`, wide tables scroll inside their own box.
- **Toast and undo:** small glass bar with the action and an Undo link in `accent`.

### Phone rules

Checked by `pnpm --filter @workspace/scripts run mobile-audit` (see `docs/mobile-plan.md`).

- One phone breakpoint: below 640px. `sm:` in Tailwind, `@media (max-width: 639px)` in CSS. Phone layouts are the same route with a different layout, never a separate page.
- Nothing scrolls sideways at 360px or 375px. Wide content (tables, tab rows, filter rows) scrolls inside its own box.
- A box that scrolls sideways is `position: relative` whenever anything inside it is absolutely positioned (including `sr-only` text). Otherwise that element escapes the box and widens the whole page.
- Tap targets at least 44 × 44px on phones. A link inside a sentence is exempt. Where the control's box is its look (buttons, fields), it gets taller. Where it is small on purpose (pills, text buttons, the tick circle, switches), an invisible absolutely positioned `::before` grows the tap area without changing the look: add `oo-tap` to a one-off link or button, the shared classes already have it (`index.css`, end of file). The audit measures these layers.
- Keep about 10px between a small control and its neighbours, so its tap layer does not cover them. The audit fails a page where a control would lose taps to something over it.
- Task cards on phones: a tap anywhere on the card opens the task; the tick, pills and buttons sit above that.
- Text fields 16px on phones, so iPhone does not zoom in on focus. Pinch zoom stays on (no `maximum-scale`).
- The viewport uses `viewport-fit=cover`, so fixed bars, sheets and full-screen panels use `env(safe-area-inset-*)` for their outer padding, and both shells pad their sides with the left and right insets (a phone held sideways gets the desktop rail).
- A row that scrolls sideways uses `ScrollRow` (`components/scroll-row.tsx`): it fades the edge with more beyond it and keeps the selected tab in view.

## 7. Behaviour

- Respect `prefers-reduced-motion`. Motion is limited to fades on triage and completing a task (2 seconds before a completed row leaves the list).
- Visible focus ring: 2px solid, ink on light and white on dark, 2px offset.
- Every icon-only button has an `aria-label`. Use real `<button>`, `<a>`, `<input>` and `<label>` elements.
- Text contrast at least 4.5:1, including muted text on glass.
- Dates as ordinals ("Friday 13th November"); times in 24-hour format.
- British English, no em dashes in any interface text.
