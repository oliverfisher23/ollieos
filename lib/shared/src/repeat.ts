import { addDays, ordinal, todayLondon, weekday } from "./dates";

/**
 * Repeating tasks (build plan 14, Part I). A rule is anchored on the task's due date: the weekday
 * for weekly ones, the day of the month (or "second Tuesday") for monthly ones, and so on. The
 * anchors are kept on the rule so a month that clamps the 31st to the 30th does not drift.
 */
export const REPEAT_EVERY = ["day", "weekday", "week", "fortnight", "month", "quarter", "year"] as const;
export type RepeatEvery = (typeof REPEAT_EVERY)[number];

export interface RepeatRule {
  every: RepeatEvery;
  /** Day of the month (1 to 31), for month, quarter and year by date */
  day?: number;
  /** Month of the year (1 to 12), for year */
  month?: number;
  /** Day of the week (0 = Sunday), for week, fortnight and month by weekday */
  weekday?: number;
  /** Which one in the month (1 to 4, or 5 for the last), for month by weekday */
  nth?: number;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const NTH_WORDS = ["", "first", "second", "third", "fourth", "last"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const pad = (n: number) => String(n).padStart(2, "0");
const parts = (date: string) => date.split("-").map(Number) as [number, number, number];
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Which of that weekday in its month the date is: 1 to 4, or 5 when it is the last one. */
function nthOf(date: string): number {
  const [y, m, d] = parts(date);
  if (d + 7 > daysInMonth(y, m)) return 5;
  return Math.ceil(d / 7);
}

/** Builds a rule anchored on a date. byWeekday picks "second Tuesday" over "the 10th" for monthly ones. */
export function buildRepeat(every: RepeatEvery, anchor: string, byWeekday = false): RepeatRule {
  const [, m, d] = parts(anchor);
  switch (every) {
    case "day":
    case "weekday":
      return { every };
    case "week":
    case "fortnight":
      return { every, weekday: weekday(anchor) };
    case "month":
      return byWeekday ? { every, weekday: weekday(anchor), nth: nthOf(anchor) } : { every, day: d };
    case "quarter":
      return { every, day: d };
    case "year":
      return { every, day: d, month: m };
  }
}

function addMonths(date: string, months: number, day: number): string {
  const [y, m] = parts(date);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(day, daysInMonth(ny, nm)))}`;
}

function nthWeekdayOf(y: number, m: number, wd: number, nth: number): string {
  if (nth === 5) {
    const last = daysInMonth(y, m);
    const lastDate = `${y}-${pad(m)}-${pad(last)}`;
    const back = (weekday(lastDate) - wd + 7) % 7;
    return addDays(lastDate, -back);
  }
  const first = `${y}-${pad(m)}-01`;
  const ahead = (wd - weekday(first) + 7) % 7;
  return addDays(first, ahead + (nth - 1) * 7);
}

/** The next date after the given one. */
export function stepRepeat(rule: RepeatRule, from: string): string {
  const [y, m, d] = parts(from);
  switch (rule.every) {
    case "day":
      return addDays(from, 1);
    case "weekday": {
      let next = addDays(from, 1);
      while (weekday(next) === 0 || weekday(next) === 6) next = addDays(next, 1);
      return next;
    }
    case "week":
    case "fortnight": {
      const gap = rule.every === "week" ? 7 : 14;
      if (rule.weekday == null || weekday(from) === rule.weekday) return addDays(from, gap);
      // Moved off its weekday by hand: go to the next one that matches.
      return addDays(from, (rule.weekday - weekday(from) + 7) % 7 || 7);
    }
    case "month": {
      if (rule.nth != null && rule.weekday != null) {
        const total = y * 12 + (m - 1) + 1;
        return nthWeekdayOf(Math.floor(total / 12), (total % 12) + 1, rule.weekday, rule.nth);
      }
      return addMonths(from, 1, rule.day ?? d);
    }
    case "quarter":
      return addMonths(from, 3, rule.day ?? d);
    case "year":
      return addMonths(from, 12, rule.day ?? d);
  }
}

/**
 * The next due date once a repeating task is ticked off. Steps on from its due date (today when it
 * had none) and skips any dates already gone, so ticking it off late does not pile up missed copies.
 */
export function nextRepeatDate(rule: RepeatRule, due: string | null, today: string = todayLondon()): string {
  let next = stepRepeat(rule, due ?? today);
  for (let i = 0; next <= today && i < 2000; i++) next = stepRepeat(rule, next);
  return next;
}

/** "Every month on the second Tuesday", as shown on the task. */
export function repeatLabel(rule: RepeatRule): string {
  const wd = rule.weekday != null ? WEEKDAY_NAMES[rule.weekday] : null;
  switch (rule.every) {
    case "day":
      return "Every day";
    case "weekday":
      return "Every weekday";
    case "week":
      return wd ? `Every week on ${wd}` : "Every week";
    case "fortnight":
      return wd ? `Every 2 weeks on ${wd}` : "Every 2 weeks";
    case "month":
      if (rule.nth != null && wd) return `Every month on the ${NTH_WORDS[rule.nth]} ${wd}`;
      return rule.day ? `Every month on the ${ordinal(rule.day)}` : "Every month";
    case "quarter":
      return rule.day ? `Every quarter on the ${ordinal(rule.day)}` : "Every quarter";
    case "year":
      return rule.day && rule.month ? `Every year on ${ordinal(rule.day)} ${MONTH_NAMES[rule.month - 1]}` : "Every year";
  }
}

/** Short form for lists: "Monthly". */
export const REPEAT_SHORT: Record<RepeatEvery, string> = {
  day: "Daily",
  weekday: "Weekdays",
  week: "Weekly",
  fortnight: "Every 2 weeks",
  month: "Monthly",
  quarter: "Quarterly",
  year: "Yearly",
};

/** The choices offered for a task due on the anchor date, keyed "month_weekday" for the weekday form. */
export function repeatChoices(anchor: string): { value: string; label: string }[] {
  const keys: [string, RepeatEvery, boolean][] = [
    ["day", "day", false],
    ["weekday", "weekday", false],
    ["week", "week", false],
    ["fortnight", "fortnight", false],
    ["month", "month", false],
    ["month_weekday", "month", true],
    ["quarter", "quarter", false],
    ["year", "year", false],
  ];
  return keys.map(([value, every, byWd]) => ({ value, label: repeatLabel(buildRepeat(every, anchor, byWd)) }));
}

/** The choice key for a stored rule, matching repeatChoices. */
export function repeatChoiceOf(rule: RepeatRule | null): string {
  if (!rule) return "";
  return rule.every === "month" && rule.nth != null ? "month_weekday" : rule.every;
}
