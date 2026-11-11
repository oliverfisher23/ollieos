# Mobile responsiveness and optimisation plan

Status: Part A built (11th November 2026), waiting for sign-off. Parts B to E not started. Each part is its own sign-off, in the order below.

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
- Throttled phone load (settings above): first paint under 1.2s, largest paint under 1.8s on Home and Tasks.
- Script needed for Home on first load: under 120 KB gzipped (from 262.6 KB as the budget measures it).
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

### Part C. Touch and type (1 to 2 days)

Mostly CSS in `index.css`, one change fixes many pages.

- Phone sizes for `.oo-check` (hit area 44px, circle stays 22px), row pills (`.oo-dd` bare/compact variants), `.oo-textbtn`, `.oo-switch` (hit area), `.oo-chip-toggle`, `.oo-back`, `.oo-edit-inline`, `.oo-link`, the light top nav and logo.
- Inputs and textareas 16px below 640px; remove `maximum-scale=1` from the viewport.
- Add `viewport-fit=cover` and check every fixed or sticky element (tab bar, sheets, triage, task detail, Ask composer) uses the safe-area insets.
- Fade edge on sideways-scrolling tab rows (Tasks, Email, Settings) so it is clear there is more.
- Fix the "this your inbox" wording.

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
| B | Route splitting, fonts, waterfall, caching | 1 to 2 days | Home entry under 120 KB gzipped; throttled first paint under 1.2s |
| C | Touch targets, 16px inputs, safe areas | 1 to 2 days | Audit shows no targets under 44px on Home, Tasks, task detail, Email |
| D | Tasks, Knowledge, Settings, tables on phone | 2 to 3 days | Screens reviewed by Ollie on his phone |
| E | Manifest, icons, shell service worker | 1 day | Added to home screen, opens full screen, tab bar clear of home indicator |

B and C do not depend on each other and could go in either order. D is the one that changes how screens look, so it is the one to review on a real phone.

## 5. Questions for Ollie

1. **Phone navigation.** Keep Home, Tasks, add, People, Knowledge and add a "More" sheet, or replace Knowledge with More?
2. **Which phone?** iPhone Safari only, or Android too? Decides how much to test at 360px and whether pinch zoom matters beyond accessibility.
3. **Offline.** Shell only (proposed), or keep a read-only copy of today's tasks and next meeting brief on the phone? The second means private data stored on the device.
4. **Phone priorities.** Which pages do you actually use on the phone? Proposal: Home, Tasks, task detail, triage, Email, Meetings and briefs first; Settings, Map and Playbooks only need to work, not shine.
