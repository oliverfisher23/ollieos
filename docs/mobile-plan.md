# Mobile responsiveness and optimisation plan

Status: Parts A to C built (11th November 2026); C waiting for sign-off. Parts D and E not started. Each part is its own sign-off, in the order below.

Relates to: PRD section 5 ("works at 375px", "touch targets at least 44px", saved to the home screen), PRD acceptance criterion 8, and build plan milestone 9 (phone Home and Triage, swipe, home screen install, voice).

## 1. Where things stand (measured)

Measured against a local copy with the seed data: every route rendered at 375 × 812 as a touch device, plus a load test at 390 × 844 on a throttled phone connection (150ms latency, 1.6 Mbps, CPU slowed 4×).

**Already good**

- Only one page scrolled sideways: Settings, Connectors, by about 200px whenever a tool is connected. The first check missed it; the Part A audit found it and it is fixed (see Part A). Every other route fits at 360px and 375px.
- The bottom tab bar, add sheet, phone triage panel, task detail sheet and Email's one-pane-at-a-time layout all exist.
- Most shared controls (`.oo-btn`, `.oo-control`, `.oo-seg`, `.oo-navpill`, dropdowns) already grow to 44px below 640px.

**Not good yet**

| Area | Finding |
|---|---|
| Bundle | One 975 KB script (269 KB gzipped by Vite's report; 262.6 KB by the build budget's measure, which is the number used from now on). Every route loads up front: 342 KB of it is pages, 172 KB components, 170 KB react-dom. The phone Home screen downloads Map, Playbooks, Settings, Ask and the rest before it can draw. |
| Load time | First paint about 2.2s and largest paint about 2.7s on the throttled phone, for Home, Tasks and Knowledge alike. That is mostly the single script, then the wait for `/api/auth/user` before any page data is asked for. |
| Fonts | Google Fonts stylesheet blocks rendering (a third-party connection before first paint). |
| Refetching | Queries have no `staleTime` (default 0) and `refetchOnWindowFocus` is on, so every return to the app from another phone app refetches every visible query. Knowledge index fires 10 API calls on open. |
| Touch targets | Under-sized targets on most light pages. Worst: Tasks (about 40 per screen: tick circles 22 × 22, row priority/status/date pills 30px tall, Email and Meetings links 21px), Knowledge Map filter chips (32px), person and project pages (`oo-textbtn` links such as "Add a fact" at 24px), switches (40 × 24), light top nav links and logo (30px). |
| Input text | Many inputs below 16px (Settings pages have 6 each, search boxes, add-step). Fine on iPhone today only because the viewport sets `maximum-scale=1`, which also stops pinch zoom on Android. |
| Home screen install | No web app manifest, no icons, no `apple-mobile-web-app-*` tags, no `theme-color`, no service worker. `viewport-fit=cover` is missing, so the tab bar's `env(safe-area-inset-bottom)` padding does nothing in a full-screen home screen app. |
| Layout density | Tasks: four stat cards fill the first screen; the first task starts about 720px down. Knowledge: the whole side nav (about 15 links) sits above the content, and the index opens on a function page 4,700px tall. Settings, Connectors is 6,700px tall (about 8 screens). Tab rows (Tasks, Email) scroll sideways with no sign there is more. |
| Hover-only | `.oo-step-tools` is fixed for touch (`hover: none`); rail tooltips are desktop only. Nothing else found. |
| Copy | Email error reads "Could not load this your inbox." (`components/knowledge/parts.tsx:677` with `what="your inbox"`). |

Not checked here: real iPhone Safari (safe areas, keyboard covering inputs, rubber-band scroll), pages with lots of real data (the local copy only has the seed tasks, so long names, many projects and real email threads were not tried), voice capture (not built).

## 2. Targets

- Every route: no sideways scroll at 360px and 375px (360 adds small Android phones).
- Every tappable thing at least 44 × 44 on phones, or 44px tall with at least 8px between neighbours where a row of pills has to stay compact.
- Every text field 16px on phones; pinch zoom allowed.
- Throttled phone load (settings above): first paint under 1.2s on Home and Tasks; real content (Do next card, first task) clearly faster than before. (Largest paint turned out to track a late-loading italic heading font rather than the page being usable, so content time is measured instead; see Part B.)
- Script needed for Home on first load: under 120 KB gzipped (from 262.6 KB as the budget measures it). Revised to 145 KB in Part B; see there for why.
- Opens from the home screen full screen, with the tab bar clear of the home indicator.

## 3. Parts

### Part A. Guard rails (half a day)

So it stays fixed once fixed.

- Add `scripts/mobile-audit` (Playwright): signs in a test session, visits every route at 360 and 375, fails on sideways scroll, lists targets under 44px and inputs under 16px, saves screenshots.
- Add a bundle budget: a check that fails the build if the entry chunk and what it loads with it go over budget.
- Write down the phone rules in `DESIGN.md`: 640px is the one phone breakpoint (`sm:` in Tailwind, `max-width: 639px` in CSS), 44px targets, 16px inputs.

**Built (11th November 2026):**

- `pnpm --filter @workspace/scripts run mobile-audit` (`scripts/src/mobile-audit.ts`). Visits up to 46 addresses (every `App.tsx` route, plus the Tasks, Email, Library and Settings tabs) at 360 and 375px as a touch device. A page for a record type with no records yet is skipped and listed in the report; with the seed data that left 39, missing one organisation, decision, note, playbook and product page, and the two brief pages. It fails on sideways scroll, the error screen or a script error, and with `--strict` also on small targets and text fields. For a sideways scroll it names the element causing it, not the fixed bars that stretch with the page. Report and screenshots go to `tmp/mobile-audit/` (not committed). It fails if `App.tsx` gains a route it does not visit.
- Safe to run against the real database: it signs in with its own session row and deletes it at the end, blocks every API call that is not a GET, and skips brief pages unless `--include-briefs` is given (opening a brief can write it with the model).
- Bundle budget in `artifacts/ollieos/vite.config.ts` (`INITIAL_JS_BUDGET_KB`): adds up the gzipped size of the entry chunk and every chunk it imports statically, and fails the build over the limit. Set to 280 KB now (today: 262.6 KB); Part B lowers it to 120. Checked that a 100 KB limit fails the build.
- Phone rules in `DESIGN.md` section 6, and both commands in `replit.md`.
- Fix found by the audit: the Connected tools table on Settings, Connectors has an `sr-only` "Action" header. Its scroll box was not positioned, so that hidden text escaped the box and widened the page by about 200px on phones. The box is now `position: relative`, and the rule is in `DESIGN.md`.
- Result with the seed data: 78 page checks, 0 failures. Still reported (Part C fixes them): small targets on most pages, small text fields, and a viewport that blocks pinch zoom.
- Not yet tried on Replit itself. Playwright's Chromium has to be installed there once (`pnpm --filter @workspace/scripts exec playwright install chromium`); if that fails on Replit's system libraries, set `CHROMIUM_PATH` to a Chromium that Replit provides.

### Part B. Load faster (1 to 2 days)

1. **Split by route.** `React.lazy` for every page in `App.tsx` except Home and Tasks, with one `Suspense` fallback that matches each shell's loading state. Map (d3-force), Ask, Brief, Playbooks, Library, Settings and Knowledge pages become their own chunks. Prefetch a route's chunk on hover/touchstart of its nav link.
2. **Vendor chunk.** `manualChunks` for react, react-dom, react-query and Radix so app deploys do not bust the vendor cache.
3. **Self-host the fonts.** DM Sans and Instrument Serif as woff2 in `public/fonts`, subset to Latin, `font-display: swap`, preload the two weights Home uses. Removes the third-party blocking request.
4. **Stop the auth waterfall.** Start the current route's main query at the same time as `/api/auth/user` (prefetch from the router on boot). Data routes already answer 401 without a session, so asking early is safe; a 401 just shows Sign in as now.
5. **Calmer refetching.** Default `staleTime` of 30 seconds; keep `refetchOnWindowFocus` but only for Home, Tasks and Email lists. Review Knowledge index's 10 calls (several are only for panels below the fold and can wait until visible).
6. **Cache the shell.** Long cache headers on hashed assets (check how the published app serves `dist/public`).

**Built (11th November 2026):**

- **Pages load on first visit.** Every page except Home and Tasks is its own file (`src/routes.ts`, using `lazyPage` in `src/lib/lazy-page.ts`). The tab bar, the rail and the phone header links start a page's download when touched, hovered or focused. While one downloads, the page area shows a skeleton, but only after 300ms. Triage and the clear-out keep Home on screen while they load. If a page's file has gone after a deploy, the app reloads once to pick up the new build; if it is still missing, the usual error screen shows (checked both ways).
- **Task detail loads on demand.** The detail panel (with reply drafting and checklists) is out of the first load. Tasks fetches it in the background 1.5 seconds after the list is up, so opening a task stays instant (checked: preloaded, fetched on tap, and opened from a link).
- **Library chunks.** React and React Query are their own long-lived files. Radix is deliberately not grouped: Rollup already splits it, and grouping it forced dialogs that only lazy pages use into the first load.
- **Smaller first load.** `tailwind-merge` is no longer used by the toast and tooltip wrappers (plain `clsx` gives the same classes there; toasts only use the default style plus `oo-toast`, whose rules are all `!important`). The unused `TooltipProvider` is gone.
- **Fonts self-hosted** (`src/theme/fonts.css`, files and SIL Open Font Licence texts in `src/assets/fonts/`), with hashed names. Latin Extended downloads only when a page needs it. **Not preloaded**, against the plan: on the slow phone link, the 62 KB preload shared bandwidth with the app's script and delayed first paint by about 0.3s in every test. Text now draws in the fallback font and swaps.
- **Splash in `index.html`.** The same dark splash React shows while checking sign-in is now in the HTML, so the phone draws it as soon as the CSS arrives instead of showing a white page until the script has run. This is most of the first-paint gain.
- **No more waiting on sign-in.** `startEarlyLoads` (`src/lib/query-client.ts`, called from `main.tsx`) starts the current page's code and, for Home and Knowledge, their first data at the same moment as the sign-in check. On Knowledge it also fetches the latest project, which the page otherwise only asks for after the project list and its own code arrive. Signed out, those calls answer 401 and are dropped.
- **Calmer refetching.** Queries count as fresh for 30 seconds, so coming back to the app does not refetch everything; writes still refresh at once because they invalidate their queries. Home's own query uses 5 seconds, because its status line carries Claude's access requests (checked: one `/api/home` at start-up, refetched on return after 6 seconds, Tasks not refetched after 3).
- **Budget** lowered from 280 to 145 KB.

**Results** (throttled phone as in section 1, median of five, the Part A build against this one):

| Page | First paint | Content on screen | Bytes downloaded |
|---|---|---|---|
| Home (Do next card) | 2.21s → 0.89s | 2.74s → 1.98s | 310 → 294 KB |
| Tasks (first task) | 2.20s → 0.89s | 2.76s → 2.15s | 300 → 263 KB |
| Knowledge (project heading) | 2.20s → 0.89s | 2.94s → 2.56s | 300 → 301 KB |

First load: 262.6 → 141.5 KB gzipped (React 58.6, React Query 10.4, app 72.5). Phone audit: 78 checks, 0 failures. Clicking through the tab bar and header on a phone: every page loads its own code, with no errors and no skeleton left behind.

**Where it differs from the plan:**

- **120 KB was not reachable without bigger changes.** React and React Query alone are 69 KB. The next largest piece is the generated API client: `api.ts` is one module, so every endpoint any page uses lands in the first load (about 40 KB before compression). Splitting it means switching Orval to `tags-split` and regenerating the client. That is worth doing as its own change, probably saving 8 to 10 KB gzipped. Budget set to 145 KB.
- **Font preload dropped** (measured, above).
- **Largest paint** stays around 2.2s on Home and 3.4s on Knowledge. The browser counts a small italic heading painted when Instrument Serif arrives, after the data, so it does not show when the page is usable. Content time is the measure used above.
- **Knowledge's 10 calls** are now 9 and start earlier. Making them lazy per panel is left for Part D's Knowledge layout work.
- **Cache headers** (item 6) not changed: the published app is served by Replit's static hosting from `artifacts/ollieos/.replit-artifact/artifact.toml`, with no header setting there. File names are hashed, so a stale cache can never serve old code. Worth a look at the published app's response headers some time.

### Part C. Touch and type (1 to 2 days)

Mostly CSS in `index.css`, one change fixes many pages.

- Phone sizes for `.oo-check` (hit area 44px, circle stays 22px), row pills (`.oo-dd` bare/compact variants), `.oo-textbtn`, `.oo-switch` (hit area), `.oo-chip-toggle`, `.oo-back`, `.oo-edit-inline`, `.oo-link`, the light top nav and logo.
- Inputs and textareas 16px below 640px; remove `maximum-scale=1` from the viewport.
- Add `viewport-fit=cover` and check every fixed or sticky element (tab bar, sheets, triage, task detail, Ask composer) uses the safe-area insets.
- Fade edge on sideways-scrolling tab rows (Tasks, Email, Settings) so it is clear there is more.
- Fix the "this your inbox" wording.

**Built (11th November 2026):**

- **Tap areas.** One phone block at the end of `index.css`. Pills, text buttons, back links, inline edits, task titles, Knowledge row links, chips, filter chips and small controls get an invisible layer centred on them, at least 44 × 44, with `min(0px, calc(50% - 22px))` insets so a control already that big gets nothing extra. That is the same idea `.oo-check` and `.oo-switch` already used. The look does not change. `oo-tap` does the same for one-off links (the phone header logo, Home's Weekly round-up, All meetings and See everything done, the breadcrumb links on note, playbook and product pages, and the ChatGPT or Gemini expander). Buttons whose box is their look (small, mini, chase, the Claude prompt buttons, text fields, the compact Internal/External toggle) are 44px tall on phones. Search boxes are 44px tall with no extra padding.
- **Tick circle fixed.** Its layer started inside the 1.5px border, so the tap area was 42px, not 44. It is now 44+.
- **Task cards.** On phones a tap anywhere on a card opens the task; the tick, pills and other buttons sit above that layer. Wrapped pill rows are 14px apart and the title sits 12px above the pills, so no layer covers a neighbour. Checked with real taps: blank card area opens the task, a pill opens its menu, just outside the tick hits the tick, just under a title opens the task.
- **Goals.** The confidential switch's tap area (10px, at every width) covered the bottom of the Target field, so a tap there could flip the switch. The switch row now has 10px more space above it. This page is 10px taller on desktop too.
- **Text fields 16px on phones**, with `!important` because some fields set a smaller size inline. Pinch zoom is back (`maximum-scale=1` removed).
- **Safe areas.** `viewport-fit=cover`; both shells pad their sides with the left and right insets at every width (a phone held sideways is wider than 640px and gets the rail); the tab bar adds them to its own padding; the task detail sheet and the modal and triage backdrops clear the home indicator. The tab bar, add sheet and triage panel already did.
- **Sideways rows fade.** `ScrollRow` (`components/scroll-row.tsx`) on the tab rows of Tasks, Email, Library, Knowledge Inbox, People and Strategy ideas: it fades the edge that has more beyond it, hides the scrollbar, brings the selected tab clear of the fade on open (again when the counts load, until the row is touched) and whenever the selection changes. The Settings menu is left as it was: fading it dissolved its white panel, and Part D replaces it on phones.
- **Wording.** Email errors now read "Could not load this inbox." and "Could not load this list of drafts."
- **Audit.** Measures tap layers (`::before`/`::after`, against their real containing block), allows half a pixel for rounding, skips what sits behind an open modal, and has a new failing check: a control that would lose taps to anything over it, sampled per line box so a wrapped link is not judged by its overall rectangle.

**Results:** with one record of every kind added locally so no page is skipped, `mobile-audit --strict` passes all 88 checks (44 pages at 360 and 375px): no tap target under 44px, no text field under 16px, nothing covered. The add sheet, an open dropdown and the task detail sheet pass the same checks. Desktop at 1280px is pixel-identical on 12 of 16 pages; the others differ only as intended (the Goals spacing, the Email wording, the tab-row fade when the task detail narrows the list, and a port number in the Connectors addresses that comes from the test setup).

**Not checked:** a real iPhone (safe areas, the keyboard, how the fades look on a real screen); the many dialogs the audit does not open (forms for new projects, rules, playbooks and so on).

### Part D. Phone layouts that read well (2 to 3 days)

Same routes, different layout below 640px, as the build plan already says.

- **Tasks:** stat cards become one compact strip (four numbers in a row, tap to filter) so the list starts in the first screen. Filters collapse behind one "Filter" button opening a bottom sheet.
- **Knowledge:** side nav becomes a "Knowledge" dropdown or a sheet at the top; `/knowledge` on a phone opens a short index (Inbox count, Projects, People, Library, Map, Sessions) instead of the first function page. Long project and person pages get collapsible sections with counts (Rules, Playbooks, Relationships closed by default).
- **Settings:** each section (Connectors, AI access, Noise, Knowledge, Planning, Email) is already its own route; on phones show a list of sections first, then one section per page. Within Connectors, each service card collapses to its status line.
- **Tables:** Tasks, Library, People cadence and three Settings pages use `<table>`. None overflow at 375px with the seed data, but each needs checking with real, longer content; any that only fit by squeezing become cards below 640px.
- **Phone nav reach:** Meetings, Email, Goals and Strategy are only reachable through links on other pages. Proposal: a "More" sheet from the Knowledge tab, or swap Knowledge for "More" (Knowledge, Meetings, Email, Goals, Strategy, Settings). Needs Ollie's choice (question 1).

### Part E. Home screen app (1 day, then milestone 9 continues)

- `manifest.webmanifest` (name, short name, dark `theme_color`, `display: standalone`, start URL `/`), icons at 192, 512 and maskable, Apple touch icon, `apple-mobile-web-app-capable` and status bar style.
- A small service worker that caches the app shell and hashed assets only. No offline data and no caching of `/api` (private data, single user; stale tasks would be worse than a "you are offline" note).
- "You are offline" banner when a request fails for lack of network.
- Then the rest of milestone 9 as already planned: swipe in triage, voice capture.

## 4. Order and size

| Part | What | Size | Sign-off check |
|---|---|---|---|
| A | Audit script, bundle budget, rules in DESIGN.md | 0.5 day | Built: audit passes (78 checks), budget fails the build when exceeded |
| B | Route splitting, fonts, waterfall, caching | 1 to 2 days | Built: first load 141.5 KB (budget 145, see Part B for 120); first paint 0.89s; content 0.4s to 0.8s sooner |
| C | Touch targets, 16px inputs, safe areas | 1 to 2 days | Built: strict audit passes on every page (88 checks) |
| D | Tasks, Knowledge, Settings, tables on phone | 2 to 3 days | Screens reviewed by Ollie on his phone |
| E | Manifest, icons, shell service worker | 1 day | Added to home screen, opens full screen, tab bar clear of home indicator |

B and C do not depend on each other and could go in either order. D is the one that changes how screens look, so it is the one to review on a real phone.

## 5. Questions for Ollie

1. **Phone navigation.** Keep Home, Tasks, add, People, Knowledge and add a "More" sheet, or replace Knowledge with More?
2. **Which phone?** iPhone Safari only, or Android too? Decides how much to test at 360px and whether pinch zoom matters beyond accessibility.
3. **Offline.** Shell only (proposed), or keep a read-only copy of today's tasks and next meeting brief on the phone? The second means private data stored on the device.
4. **Phone priorities.** Which pages do you actually use on the phone? Proposal: Home, Tasks, task detail, triage, Email, Meetings and briefs first; Settings, Map and Playbooks only need to work, not shine.
