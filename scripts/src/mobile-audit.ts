/**
 * Phone layout audit (docs/mobile-plan.md, Part A).
 *
 * Opens every page of the web app at phone widths as a touch device and checks:
 *   - sideways scroll (fails the run)
 *   - a control partly under another control's tap area, so it would lose taps (fails the run)
 *   - pages that crash or show the error screen (fails the run)
 *   - tap targets under 44px and text fields under 16px (reported; fail only with --strict)
 *   - pages that do not load or stay blank (fails the run)
 * Saves a full-page screenshot of each page and a report to tmp/mobile-audit/.
 *
 *   pnpm --filter @workspace/scripts run mobile-audit
 *   pnpm --filter @workspace/scripts run mobile-audit -- --widths 375 --only /tasks --strict
 *
 * Needs the API and web dev servers running, DATABASE_URL and ALLOWED_EMAIL.
 * Signs in with a session row of its own (deleted at the end) and blocks every
 * API request that is not a GET, so it never changes data. Brief pages are
 * skipped unless --include-briefs is given, because opening one can write the
 * brief with the AI model.
 *
 * Env: AUDIT_WEB_URL (default http://localhost:24812), AUDIT_API_URL
 * (default http://localhost:8080), CHROMIUM_PATH to use a Chromium that is
 * already installed instead of Playwright's own.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { asc, eq, desc } from "drizzle-orm";
import { chromium, type Page } from "playwright";
import {
  db,
  decisionsTable,
  notesTable,
  organisationsTable,
  peopleTable,
  playbooksTable,
  pool,
  productsTable,
  projectsTable,
  sessionsTable,
  tasksTable,
  calendarEventsTable,
} from "@workspace/db";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const APP_TSX = path.join(ROOT, "artifacts/ollieos/src/App.tsx");
const OUT = path.join(ROOT, "tmp/mobile-audit");

const MIN_TARGET = 44;
const MIN_INPUT_FONT = 16;

/* ---------- options ---------- */

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const WIDTHS = (value("--widths") ?? "360,375").split(",").map(Number).filter(Boolean);
const ONLY = value("--only");
const STRICT = flag("--strict");
const INCLUDE_BRIEFS = flag("--include-briefs");
const WEB = (process.env.AUDIT_WEB_URL ?? "http://localhost:24812").replace(/\/$/, "");
const API = (process.env.AUDIT_API_URL ?? "http://localhost:8080").replace(/\/$/, "");

/* ---------- routes ---------- */

type Samples = Record<"task" | "person" | "project" | "organisation" | "decision" | "note" | "playbook" | "product" | "event", string | null>;
type RouteCheck = { pattern: string; url: string | ((s: Samples) => string | null) };

/**
 * Every route in App.tsx, by its pattern, with the address to open.
 * A route with an id uses the first matching record and is skipped when there is none.
 */
const ROUTES: RouteCheck[] = [
  { pattern: "/", url: "/" },
  { pattern: "/triage", url: "/triage" },
  { pattern: "/clear-out", url: "/clear-out" },
  { pattern: "/tasks", url: "/tasks" },
  { pattern: "/tasks", url: "/tasks?tab=backlog" },
  { pattern: "/tasks", url: (s) => (s.task ? "/tasks?task=" + s.task : null) },
  { pattern: "/review", url: "/review" },
  { pattern: "/email", url: "/email" },
  { pattern: "/email", url: "/email?tab=drafts" },
  { pattern: "/ask", url: "/ask" },
  { pattern: "/ask/:threadId", url: "/ask/0" },
  { pattern: "/knowledge/inbox", url: "/knowledge/inbox" },
  { pattern: "/knowledge", url: "/knowledge" },
  { pattern: "/knowledge/projects/:slug", url: (s) => (s.project ? "/knowledge/projects/" + s.project : null) },
  { pattern: "/knowledge/people", url: "/knowledge/people" },
  { pattern: "/knowledge/people/:slug", url: (s) => (s.person ? "/knowledge/people/" + s.person : null) },
  { pattern: "/knowledge/organisations", url: "/knowledge/organisations" },
  { pattern: "/knowledge/organisations/:slug", url: (s) => (s.organisation ? "/knowledge/organisations/" + s.organisation : null) },
  { pattern: "/knowledge/decisions", url: "/knowledge/decisions" },
  { pattern: "/knowledge/decisions/:id", url: (s) => (s.decision ? "/knowledge/decisions/" + s.decision : null) },
  { pattern: "/knowledge/notes", url: "/knowledge/notes" },
  { pattern: "/knowledge/notes/:id", url: (s) => (s.note ? "/knowledge/notes/" + s.note : null) },
  { pattern: "/knowledge/library", url: "/knowledge/library" },
  { pattern: "/knowledge/library", url: "/knowledge/library?tab=rules" },
  { pattern: "/knowledge/library", url: "/knowledge/library?tab=playbooks" },
  { pattern: "/knowledge/playbooks/:id", url: (s) => (s.playbook ? "/knowledge/playbooks/" + s.playbook : null) },
  { pattern: "/knowledge/products", url: "/knowledge/products" },
  { pattern: "/knowledge/products/:slug", url: (s) => (s.product ? "/knowledge/products/" + s.product : null) },
  { pattern: "/knowledge/sessions", url: "/knowledge/sessions" },
  { pattern: "/knowledge/map", url: "/knowledge/map" },
  { pattern: "/meetings", url: "/meetings" },
  { pattern: "/briefs/next", url: () => (INCLUDE_BRIEFS ? "/briefs/next" : null) },
  { pattern: "/briefs/:eventId", url: (s) => (INCLUDE_BRIEFS && s.event ? "/briefs/" + s.event : null) },
  { pattern: "/digest", url: "/digest" },
  { pattern: "/digest/week", url: "/digest/week" },
  { pattern: "/digest/:date", url: "/digest/2026-01-01" },
  { pattern: "/goals", url: "/goals" },
  { pattern: "/strategy", url: "/strategy" },
  { pattern: "/people", url: "/people" },
  { pattern: "/settings/:section", url: "/settings/connectors" },
  { pattern: "/settings/:section", url: "/settings/email" },
  { pattern: "/settings/:section", url: "/settings/knowledge" },
  { pattern: "/settings/:section", url: "/settings/noise-rules" },
  { pattern: "/settings/:section", url: "/settings/planning" },
  { pattern: "/settings/:section", url: "/settings/imports" },
  { pattern: "/oauth/consent", url: "/oauth/consent" },
];

/** Routes that only redirect, so there is no page of their own to check. */
const REDIRECT_ONLY = new Set(["/people/:slug", "/settings"]);

/** Fails loudly when App.tsx gains a route this audit does not visit. */
function checkCoverage() {
  const src = readFileSync(APP_TSX, "utf8");
  const inApp = [...src.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);
  const covered = new Set(ROUTES.map((r) => r.pattern));
  const missing = inApp.filter((p) => !covered.has(p) && !REDIRECT_ONLY.has(p));
  if (missing.length) {
    throw new Error(`mobile-audit: add these App.tsx routes to ROUTES in scripts/src/mobile-audit.ts: ${missing.join(", ")}`);
  }
}

async function loadSamples(): Promise<Samples> {
  const first = async <T,>(q: Promise<T[]>) => (await q)[0];
  const task = await first(db.select({ id: tasksTable.id }).from(tasksTable).orderBy(desc(tasksTable.id)).limit(1));
  const person = await first(db.select({ slug: peopleTable.slug }).from(peopleTable).where(eq(peopleTable.isSelf, false)).orderBy(asc(peopleTable.id)).limit(1));
  const project = await first(db.select({ slug: projectsTable.slug }).from(projectsTable).orderBy(asc(projectsTable.id)).limit(1));
  const organisation = await first(db.select({ slug: organisationsTable.slug }).from(organisationsTable).orderBy(asc(organisationsTable.id)).limit(1));
  const decision = await first(db.select({ id: decisionsTable.id }).from(decisionsTable).orderBy(desc(decisionsTable.id)).limit(1));
  const note = await first(db.select({ id: notesTable.id }).from(notesTable).orderBy(desc(notesTable.id)).limit(1));
  const playbook = await first(db.select({ id: playbooksTable.id }).from(playbooksTable).orderBy(asc(playbooksTable.id)).limit(1));
  const product = await first(db.select({ slug: productsTable.slug }).from(productsTable).orderBy(asc(productsTable.id)).limit(1));
  const event = await first(db.select({ id: calendarEventsTable.id }).from(calendarEventsTable).orderBy(desc(calendarEventsTable.startsAt)).limit(1));
  return {
    task: task ? String(task.id) : null,
    person: person?.slug ?? null,
    project: project?.slug ?? null,
    organisation: organisation?.slug ?? null,
    decision: decision ? String(decision.id) : null,
    note: note ? String(note.id) : null,
    playbook: playbook ? String(playbook.id) : null,
    product: product?.slug ?? null,
    event: event ? String(event.id) : null,
  };
}

/* ---------- in-page checks ---------- */

type PageFindings = {
  sideways: number;
  overflowers: string[];
  covered: string[];
  smallTargets: string[];
  smallInputs: string[];
  errorScreen: boolean;
  blank: boolean;
  viewportMeta: string;
};

/**
 * Runs in the browser. Kept as a string so the TypeScript runner's helpers
 * never end up in code the page has to execute.
 */
const IN_PAGE = `(() => {
  const MIN_TARGET = ${MIN_TARGET}, MIN_INPUT_FONT = ${MIN_INPUT_FONT};
  const vw = document.documentElement.clientWidth;
  const label = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter((c) => c.startsWith('oo-')).slice(0, 2).join('.') : '';
    const text = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
    const tid = el.getAttribute('data-testid');
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (tid ? '[' + tid + ']' : '') + (text ? ' "' + text + '"' : '');
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    // Behind an open modal the page ignores taps (pointer-events: none), so it is not a target there.
    if (getComputedStyle(el).pointerEvents === 'none') return false;
    return el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true;
  };
  // Is el cut off by a scroll or clip box? An absolutely positioned element escapes
  // that box unless the box, or something between, is positioned (its containing block).
  const clipped = (el) => {
    let contained = getComputedStyle(el).position !== 'absolute';
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (!contained && (s.position !== 'static' || s.transform !== 'none')) contained = true;
      if (contained && s.overflowX !== 'visible') return true;
    }
    return false;
  };

  const inFixed = (el) => {
    for (let p = el; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).position === 'fixed') return true;
    return false;
  };

  const overflowers = [];
  for (const el of document.body.querySelectorAll('*')) {
    // Fixed bars (and what is in them) stretch with the page, so they show the problem rather than cause it.
    if (inFixed(el)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || r.right <= vw + 1 || clipped(el)) continue;
    const parent = el.parentElement;
    if (parent && parent !== document.body && !inFixed(parent) && parent.getBoundingClientRect().right > vw + 1 && !clipped(parent)) continue;
    overflowers.push(label(el) + ' right edge ' + Math.round(r.right) + 'px');
  }

  // The tap area: the element's box, grown by an absolutely positioned ::before or ::after that takes
  // taps (the .oo-check / .oo-tap pattern: an invisible layer with negative insets).
  const hitArea = (el) => {
    const r = el.getBoundingClientRect();
    let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
    // The layer is placed against its containing block: the element if positioned, else the nearest
    // positioned ancestor (how a title's layer can cover a whole card).
    let cb = el;
    while (cb && cb !== document.body) {
      const cs = getComputedStyle(cb);
      if (cs.position !== 'static' || cs.transform !== 'none') break;
      cb = cb.parentElement;
    }
    if (cb && cb !== document.body) {
      const c = cb.getBoundingClientRect();
      const s = getComputedStyle(cb);
      const bl = parseFloat(s.borderLeftWidth) || 0, bt = parseFloat(s.borderTopWidth) || 0, br = parseFloat(s.borderRightWidth) || 0, bb = parseFloat(s.borderBottomWidth) || 0;
      for (const which of ['::before', '::after']) {
        const p = getComputedStyle(el, which);
        if (p.content === 'none' || p.content === 'normal' || p.position !== 'absolute' || p.pointerEvents === 'none' || p.display === 'none') continue;
        const t = parseFloat(p.top), l = parseFloat(p.left), rt = parseFloat(p.right), bo = parseFloat(p.bottom);
        if ([t, l, rt, bo].some((v) => Number.isNaN(v))) continue;
        left = Math.min(left, c.left + bl + l);
        top = Math.min(top, c.top + bt + t);
        right = Math.max(right, c.right - br - rt);
        bottom = Math.max(bottom, c.bottom - bb - bo);
      }
    }
    return { width: right - left, height: bottom - top };
  };

  const small = new Set();
  const targets = 'a[href], button, select, summary, input:not([type=hidden]), textarea, [role=button], [role=tab], [role=switch], [role=checkbox], [role=radio], [role=combobox], [role=link], [role=menuitem], [role=option]';
  for (const el of document.querySelectorAll(targets)) {
    if (!visible(el)) continue;
    if (el.parentElement && el.parentElement.closest(targets) && el.parentElement.closest(targets) !== el) continue;
    const s = getComputedStyle(el);
    // A link inside a sentence is exempt (WCAG 2.5.8 inline exception).
    if (el.tagName === 'A' && s.display === 'inline') {
      const own = (el.textContent || '').trim().length;
      const around = (el.parentElement && el.parentElement.textContent || '').trim().length;
      if (around > own + 10) continue;
    }
    const r = hitArea(el);
    // Half a pixel of slack: a layer sized with calc() can land at 43.9px.
    if (r.height < MIN_TARGET - 0.5 || r.width < MIN_TARGET - 0.5) small.add(label(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
  }

  // A control whose own box is partly under another control's tap area would lose taps to it.
  // Checked by asking the browser what a tap would hit at points inside each control.
  const covered = new Set();
  const all = [...document.querySelectorAll(targets)].filter((el) => visible(el) && !inFixed(el));
  const scrollY = window.scrollY;
  for (const el of all) {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    // One box per line for a link that wraps; its overall rectangle would take in text beside it.
    for (const r of el.getClientRects()) {
      if (r.width < 6 || r.height < 6) continue;
      for (const fx of [0.15, 0.5, 0.85]) {
        for (const fy of [0.2, 0.5, 0.8]) {
          const x = r.left + r.width * fx, y = r.top + r.height * fy;
          if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
          const hit = document.elementFromPoint(x, y);
          if (!hit || el === hit || el.contains(hit)) continue;
          // Whatever would take the tap: another control, or anything else sitting over this one.
          const owner = hit.closest(targets) || hit;
          if (owner === el || owner.contains(el) || el.contains(owner) || inFixed(owner)) continue;
          covered.add(label(el) + ' is partly under ' + label(owner));
        }
      }
    }
  }
  window.scrollTo(0, scrollY);

  const inputs = new Set();
  const textTypes = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week']);
  for (const el of document.querySelectorAll('input, textarea, [contenteditable=""], [contenteditable=true]')) {
    if (el.tagName === 'INPUT' && !textTypes.has((el.getAttribute('type') || '').toLowerCase())) continue;
    if (!visible(el)) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < MIN_INPUT_FONT) inputs.add(label(el) + ' ' + size + 'px');
  }

  return {
    sideways: Math.max(0, document.documentElement.scrollWidth - vw),
    overflowers: overflowers.slice(0, 10),
    covered: [...covered],
    smallTargets: [...small],
    smallInputs: [...inputs],
    errorScreen: /Something went wrong/.test(document.body.innerText),
    blank: !document.getElementById('root') || !document.getElementById('root').children.length,
    viewportMeta: document.querySelector('meta[name=viewport]')?.getAttribute('content') || '',
  };
})()`;

/* ---------- run ---------- */

type Result = PageFindings & { width: number; url: string; pattern: string; pageErrors: string[]; loadError: string | null; screenshot: string };

async function auditPage(page: Page, width: number, route: RouteCheck, url: string): Promise<Result> {
  const pageErrors: string[] = [];
  const onError = (e: Error) => pageErrors.push(e.message.split("\n")[0]);
  page.on("pageerror", onError);
  let loadError: string | null = null;
  try {
    const res = await page.goto(WEB + url, { waitUntil: "networkidle", timeout: 20_000 });
    if (res && !res.ok()) loadError = `HTTP ${res.status()}`;
  } catch (err) {
    // Pages that keep polling never go idle; check what has drawn by now. Anything else is a failed load.
    if (!(err instanceof Error && err.name === "TimeoutError")) loadError = err instanceof Error ? err.message.split("\n")[0] : String(err);
  }
  await page.waitForTimeout(500);
  const findings = (await page.evaluate(IN_PAGE)) as PageFindings;
  const name = url.replace(/[/?=&]+/g, "_").replace(/^_+|_+$/g, "") || "home";
  const screenshot = path.join(OUT, String(width), name + ".png");
  await page.screenshot({ path: screenshot, fullPage: true });
  page.off("pageerror", onError);
  return { ...findings, width, url, pattern: route.pattern, pageErrors, loadError, screenshot: path.relative(ROOT, screenshot) };
}

function failed(r: Result) {
  return r.loadError !== null || r.blank || r.sideways > 0 || r.covered.length > 0 || r.errorScreen || r.pageErrors.length > 0 || (STRICT && (r.smallTargets.length > 0 || r.smallInputs.length > 0));
}

function writeReport(results: Result[], skipped: string[]) {
  writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ widths: WIDTHS, strict: STRICT, skipped, results }, null, 2));
  const lines = [
    "# Phone layout audit",
    "",
    `Widths ${WIDTHS.join(", ")}px. Targets under ${MIN_TARGET}px and text fields under ${MIN_INPUT_FONT}px ${STRICT ? "fail the run" : "are reported only (use --strict to fail on them)"}.`,
    "",
    "| Width | Page | Sideways | Covered controls | Small targets | Small text fields | Errors |",
    "|---|---|---|---|---|---|---|",
    ...results.map((r) => `| ${r.width} | \`${r.url}\` | ${r.sideways ? r.sideways + "px" : "none"} | ${r.covered.length} | ${r.smallTargets.length} | ${r.smallInputs.length} | ${r.loadError ? "did not load (" + r.loadError + ") " : ""}${r.blank ? "blank page " : ""}${r.errorScreen ? "error screen " : ""}${r.pageErrors.length ? r.pageErrors.length + " script" : ""} |`),
    "",
    skipped.length ? `Skipped (no record to open, or brief pages without --include-briefs): ${skipped.map((s) => "`" + s + "`").join(", ")}` : "",
    "",
    "## Details",
    "",
  ];
  for (const r of results) {
    if (!r.loadError && !r.blank && !r.sideways && !r.covered.length && !r.smallTargets.length && !r.smallInputs.length && !r.errorScreen && !r.pageErrors.length) continue;
    lines.push(`### ${r.width}px \`${r.url}\``, "");
    if (r.sideways) lines.push(`Sideways scroll of ${r.sideways}px, caused by:`, ...r.overflowers.map((o) => "- " + o), "");
    if (r.covered.length) lines.push("Controls that would lose taps to another control:", ...r.covered.map((c) => "- " + c), "");
    if (r.pageErrors.length) lines.push("Script errors:", ...r.pageErrors.map((e) => "- " + e), "");
    if (r.smallTargets.length) lines.push("Small targets:", ...r.smallTargets.map((t) => "- " + t), "");
    if (r.smallInputs.length) lines.push("Small text fields:", ...r.smallInputs.map((t) => "- " + t), "");
  }
  writeFileSync(path.join(OUT, "report.md"), lines.join("\n"));
}

async function main() {
  checkCoverage();
  const email = process.env.ALLOWED_EMAIL?.trim();
  if (!email) throw new Error("mobile-audit: ALLOWED_EMAIL must be set (the audit signs in as that user).");

  const samples = await loadSamples();
  const sid = randomBytes(32).toString("hex");
  await db.insert(sessionsTable).values({
    sid,
    sess: { user: { id: "mobile-audit", email, firstName: null, lastName: null, profileImageUrl: null }, access_token: "mobile-audit", expires_at: Math.floor(Date.now() / 1000) + 3600 },
    expire: new Date(Date.now() + 60 * 60 * 1000),
  });

  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const results: Result[] = [];
  const skipped: string[] = [];
  try {
    const host = new URL(WEB).hostname;
    for (const width of WIDTHS) {
      mkdirSync(path.join(OUT, String(width)), { recursive: true });
      const context = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      await context.addCookies([{ name: "sid", value: sid, domain: host, path: "/" }]);
      const page = await context.newPage();
      await page.route(/\/(api|mcp)\//, (route) => {
        const req = route.request();
        if (req.method() !== "GET") return route.abort("blockedbyclient");
        const u = new URL(req.url());
        return route.continue({ url: API + u.pathname + u.search });
      });
      for (const route of ROUTES) {
        const url = typeof route.url === "string" ? route.url : route.url(samples);
        if (!url) {
          if (width === WIDTHS[0]) skipped.push(route.pattern);
          continue;
        }
        if (ONLY && !url.startsWith(ONLY)) continue;
        const r = await auditPage(page, width, route, url);
        results.push(r);
        const mark = failed(r) ? "FAIL" : "ok  ";
        console.log(`${mark} ${width} ${url.padEnd(34)} sideways=${r.sideways} covered=${r.covered.length} targets=${r.smallTargets.length} fields=${r.smallInputs.length}${r.loadError ? " DID-NOT-LOAD " + r.loadError : ""}${r.blank ? " BLANK" : ""}${r.errorScreen ? " ERROR-SCREEN" : ""}${r.pageErrors.length ? " SCRIPT-ERRORS=" + r.pageErrors.length : ""}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
    await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
    await pool.end();
  }

  writeReport(results, skipped);
  const viewport = results[0]?.viewportMeta ?? "";
  if (/maximum-scale\s*=\s*1(\.0)?\b|user-scalable\s*=\s*no/.test(viewport)) console.log(`\nNote: the viewport blocks pinch zoom ("${viewport}").`);
  const failures = results.filter(failed);
  console.log(`\n${results.length} pages checked, ${failures.length} failed. Report: ${path.relative(ROOT, path.join(OUT, "report.md"))}`);
  process.exitCode = failures.length ? 1 : 0;
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
