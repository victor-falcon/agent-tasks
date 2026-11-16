// Dates for people: relative near now ("4m ago", "in 6d"), absolute far away,
// always in the display time zone. `now` is always passed in.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Up to this distance from now, dates are shown relative. */
export const RELATIVE_LIMIT_MS = 7 * DAY;

interface LocalParts {
  year: number;
  month: string;
  day: number;
  weekday: string;
  time: string;
  seconds: string;
  /** `YYYY-MM-DD`, to compare calendar days. */
  date: string;
}

function localParts(date: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "short",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const numericMonth = new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "2-digit" }).format(date);
  return {
    year: Number(get("year")),
    month: get("month"),
    day: Number(get("day")),
    weekday: get("weekday"),
    time: `${get("hour")}:${get("minute")}`,
    seconds: get("second"),
    date: `${get("year")}-${numericMonth}-${get("day").padStart(2, "0")}`,
  };
}

/** A length of time, coarse: `45s`, `4m`, `2h`, `2h05m`, `3d`, `3d4h`. */
export function formatSpan(ms: number): string {
  const abs = Math.max(0, Math.abs(ms));
  if (abs < MINUTE) return `${Math.floor(abs / 1000)}s`;
  if (abs < HOUR) return `${Math.floor(abs / MINUTE)}m`;
  if (abs < DAY) {
    const h = Math.floor(abs / HOUR);
    const m = Math.floor((abs % HOUR) / MINUTE);
    return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}m`;
  }
  const d = Math.floor(abs / DAY);
  const h = Math.floor((abs % DAY) / HOUR);
  return h === 0 || d >= 7 ? `${d}d` : `${d}d${h}h`;
}

/** `4m ago`, `in 6d`, `now` (under a minute away). */
export function relativeTime(date: Date, now: Date): string {
  const diff = date.getTime() - now.getTime();
  if (Math.abs(diff) < MINUTE) return "now";
  const abs = Math.abs(diff);
  // Minutes are cut, hours and days rounded: 1h50m is "2h", 5d22h is "6d".
  const unit = abs < HOUR ? `${Math.floor(abs / MINUTE)}m` : abs < DAY - HOUR / 2 ? `${Math.round(abs / HOUR)}h` : `${Math.max(1, Math.round(abs / DAY))}d`;
  return diff < 0 ? `${unit} ago` : `in ${unit}`;
}

/** `09:00` */
export function clockTime(date: Date, timezone: string): string {
  return localParts(date, timezone).time;
}

/** `09:00:03` */
export function clockTimeWithSeconds(date: Date, timezone: string): string {
  const p = localParts(date, timezone);
  return `${p.time}:${p.seconds}`;
}

/** `Nov 17 09:00`, with the year when it is not the current one: `Nov 17 2025 09:00`. */
export function absoluteTime(date: Date, timezone: string, now: Date): string {
  const p = localParts(date, timezone);
  const year = p.year === localParts(now, timezone).year ? "" : ` ${p.year}`;
  return `${p.month} ${p.day}${year} ${p.time}`;
}

/** Relative near now, absolute beyond a week: `4m ago`, `in 6d`, `Nov 20 09:00`. */
export function whenTime(date: Date, timezone: string, now: Date): string {
  return Math.abs(date.getTime() - now.getTime()) < RELATIVE_LIMIT_MS ? relativeTime(date, now) : absoluteTime(date, timezone, now);
}

/** For an agenda: `10:00` today, `Mon 09:00` within a week, `Nov 20 09:00` later. */
export function agendaTime(date: Date, timezone: string, now: Date): string {
  const p = localParts(date, timezone);
  if (p.date === localParts(now, timezone).date) return p.time;
  if (Math.abs(date.getTime() - now.getTime()) < 6 * DAY) return `${p.weekday} ${p.time}`;
  return absoluteTime(date, timezone, now);
}

/** A time that belongs next to another one (the slot): `09:12` on the same day, `Nov 18 09:12` otherwise. */
export function timeNear(date: Date, reference: Date, timezone: string, now: Date): string {
  return localParts(date, timezone).date === localParts(reference, timezone).date ? clockTime(date, timezone) : absoluteTime(date, timezone, now);
}

/** Whether two instants fall on the same calendar day in the zone. */
export function sameDay(a: Date, b: Date, timezone: string): boolean {
  return localParts(a, timezone).date === localParts(b, timezone).date;
}
