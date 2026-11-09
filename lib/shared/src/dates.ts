/**
 * Date helpers for OllieOS. Everything is shown in Europe/London time and
 * written as ordinals ("Friday 13th November"). Calendar dates are plain
 * "YYYY-MM-DD" strings; instants are Date objects or ISO strings.
 */

export const TIME_ZONE = "Europe/London";

const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type DateInput = Date | string;

interface LondonParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

const partsFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function toDate(input: DateInput): Date {
  return input instanceof Date ? input : new Date(input);
}

/** Year, month, day, hour and minute of an instant, in London time. */
export function londonParts(input: DateInput): LondonParts {
  const parts = partsFormatter.formatToParts(toDate(input));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** True for a plain calendar date string such as "2026-11-13". */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** The London calendar date of an instant, as "YYYY-MM-DD". */
export function londonDate(input: DateInput = new Date()): string {
  if (typeof input === "string" && isIsoDate(input)) return input;
  const p = londonParts(input);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Today's date in London, as "YYYY-MM-DD". */
export function todayLondon(now: Date = new Date()): string {
  return londonDate(now);
}

function splitIso(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

/** Day of the week for a calendar date, 0 = Sunday. */
export function weekday(date: string): number {
  const [y, m, d] = splitIso(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = splitIso(date);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Whole days from a to b (b minus a), both calendar dates. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = splitIso(a);
  const [by, bm, bd] = splitIso(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** Monday of the week containing the date. Weeks run Monday to Sunday. */
export function weekStartOf(date: string): string {
  const wd = weekday(date);
  return addDays(date, wd === 0 ? -6 : 1 - wd);
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** "Friday 13th November". Adds the year when it is not the current London year. */
export function formatLong(input: DateInput, opts: { withYear?: boolean; now?: Date } = {}): string {
  const date = londonDate(input);
  const [y, m, d] = splitIso(date);
  const thisYear = Number(todayLondon(opts.now).slice(0, 4));
  const showYear = opts.withYear ?? y !== thisYear;
  return `${WEEKDAYS_LONG[weekday(date)]} ${ordinal(d)} ${MONTHS_LONG[m - 1]}${showYear ? ` ${y}` : ""}`;
}

/** "Fri 13th Nov", as used in tables. */
export function formatShort(input: DateInput): string {
  const date = londonDate(input);
  const [, m, d] = splitIso(date);
  return `${WEEKDAYS_SHORT[weekday(date)]} ${ordinal(d)} ${MONTHS_SHORT[m - 1]}`;
}

/** "13th November", without the weekday. */
export function formatDayMonth(input: DateInput): string {
  const date = londonDate(input);
  const [, m, d] = splitIso(date);
  return `${ordinal(d)} ${MONTHS_LONG[m - 1]}`;
}

/** 24-hour time in London, "07:42". */
export function formatTime(input: DateInput): string {
  const p = londonParts(input);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** "9th – 15th November 2026", or "30th November – 6th December 2026" across months. */
export function formatWeekRange(weekStart: string): string {
  const end = addDays(weekStart, 6);
  const [sy, sm, sd] = splitIso(weekStart);
  const [ey, em, ed] = splitIso(end);
  if (sy !== ey) {
    return `${ordinal(sd)} ${MONTHS_LONG[sm - 1]} ${sy} – ${ordinal(ed)} ${MONTHS_LONG[em - 1]} ${ey}`;
  }
  if (sm !== em) {
    return `${ordinal(sd)} ${MONTHS_LONG[sm - 1]} – ${ordinal(ed)} ${MONTHS_LONG[em - 1]} ${ey}`;
  }
  return `${ordinal(sd)} – ${ordinal(ed)} ${MONTHS_LONG[em - 1]} ${ey}`;
}

/** "Good morning", "Good afternoon" or "Good evening" for London time. */
export function greeting(now: Date = new Date()): string {
  const { hour } = londonParts(now);
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** The UTC instant for a London wall-clock time on a calendar date. */
export function londonWallTimeToInstant(date: string, hour = 0, minute = 0): Date {
  const [y, m, d] = splitIso(date);
  // Start from the UTC reading, then correct by London's offset at that moment.
  const guess = new Date(Date.UTC(y, m - 1, d, hour, minute));
  const p = londonParts(guess);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const offset = asUtc - guess.getTime();
  return new Date(guess.getTime() - offset);
}

/** Start (inclusive) and end (exclusive) instants of a London calendar date range. */
export function londonRange(startDate: string, days: number): { start: Date; end: Date } {
  return {
    start: londonWallTimeToInstant(startDate),
    end: londonWallTimeToInstant(addDays(startDate, days)),
  };
}

/** Tomorrow at 06:00 London time, the snooze target. */
export function snoozeUntilTomorrow(now: Date = new Date()): Date {
  return londonWallTimeToInstant(addDays(todayLondon(now), 1), 6, 0);
}

const DAY_TOKENS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};

/**
 * Resolves a due token to a calendar date. Accepts "2026-11-20", "today",
 * "tomorrow"/"tom", and day names ("fri" means the next Friday, or today if
 * today is Friday). Returns null when the token is not understood.
 */
export function resolveDueToken(token: string, today: string = todayLondon()): string | null {
  const t = token.trim().toLowerCase();
  if (isIsoDate(t)) return t;
  if (t === "today" || t === "tod") return today;
  if (t === "tomorrow" || t === "tom") return addDays(today, 1);
  if (t in DAY_TOKENS) {
    const target = DAY_TOKENS[t];
    const diff = (target - weekday(today) + 7) % 7;
    return addDays(today, diff);
  }
  return null;
}
