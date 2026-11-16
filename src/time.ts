/**
 * Office-local time helpers. Zero dependencies: uses Intl for time zones (handles DST).
 * Weekdays are ISO numbers: 1 = Monday ... 7 = Sunday.
 */

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export interface WorkSchedule {
  timeZone: string; // IANA, e.g. "Europe/Oslo"
  startHour: number; // local, inclusive
  endHour: number; // local, exclusive
  workdays: readonly number[];
}

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 1-7
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

export function localParts(t: number, timeZone: string): LocalParts {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  const p: Record<string, string> = {};
  for (const { type, value } of f.formatToParts(t)) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAY[p.weekday ?? ""] ?? 0,
  };
}

function offsetAt(t: number, timeZone: string): number {
  const p = localParts(t, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** Epoch ms for a wall-clock time in a time zone. */
export function zonedTime(timeZone: string, year: number, month: number, day: number, hour = 0, minute = 0): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
}

export function monthKey(t: number, timeZone: string): string {
  const p = localParts(t, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}`;
}

export function isWorkingTime(t: number, s: WorkSchedule): boolean {
  const p = localParts(t, s.timeZone);
  return s.workdays.includes(p.weekday) && p.hour >= s.startHour && p.hour < s.endHour;
}

/** t itself if inside working hours, otherwise the start of the next working window. */
export function nextWorkingStart(t: number, s: WorkSchedule): number {
  if (isWorkingTime(t, s)) return t;
  const p = localParts(t, s.timeZone);
  let day = Date.UTC(p.year, p.month - 1, p.day);
  if (p.hour >= s.startHour) day += DAY;
  for (let i = 0; i < 14; i++, day += DAY) {
    const d = new Date(day);
    const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    if (s.workdays.includes(weekday)) {
      return zonedTime(s.timeZone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), s.startHour);
    }
  }
  throw new Error("work schedule has no workdays");
}

/** Adds `ms` of working time: the clock is paused at night, weekends and non-workdays. */
export function addWorkingTime(t: number, ms: number, s: WorkSchedule): number {
  let cur = nextWorkingStart(t, s);
  let remaining = ms;
  for (;;) {
    const p = localParts(cur, s.timeZone);
    const end = zonedTime(s.timeZone, p.year, p.month, p.day, s.endHour);
    if (remaining <= end - cur) return cur + remaining;
    remaining -= end - cur;
    cur = nextWorkingStart(end, s);
  }
}
