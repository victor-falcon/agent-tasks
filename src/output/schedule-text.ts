import type { Schedule } from "../schema.ts";
import { absoluteTime } from "./time.ts";

// Schedules in words: `every hour`, `every day 08:00`, `Mon 09:00`. Cron
// expressions that don't fit a simple pattern are shown as they are.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const NUMBER = /^\d+$/;

function hhmm(hour: string, minute: string): string {
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

function weekdays(field: string): string | null {
  if (field === "1-5") return "weekdays";
  if (field === "0,6" || field === "6,0" || field === "6-7") return "weekends";
  const days = field.split(",");
  if (!days.every((d) => NUMBER.test(d) && Number(d) <= 7)) return null;
  return days.map((d) => WEEKDAYS[Number(d)]).join(",");
}

/** A cron expression in words, or null when it has no simple reading. */
export function describeCron(cron: string): string | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null; // seconds or years: leave as is
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (month !== "*") return null;
  const step = /^\*\/(\d+)$/;
  if (dom === "*" && dow === "*") {
    if (minute === "*" && hour === "*") return "every minute";
    const m = step.exec(minute);
    if (m && hour === "*") return `every ${m[1]} min`;
    if (NUMBER.test(minute) && hour === "*") return minute === "0" ? "every hour" : `every hour at :${minute.padStart(2, "0")}`;
    const h = step.exec(hour);
    if (NUMBER.test(minute) && h) return `every ${h[1]}h at :${minute.padStart(2, "0")}`;
    if (NUMBER.test(minute) && NUMBER.test(hour)) return `every day ${hhmm(hour, minute)}`;
    return null;
  }
  if (!NUMBER.test(minute) || !NUMBER.test(hour)) return null;
  if (dom === "*") {
    const days = weekdays(dow);
    return days ? `${days} ${hhmm(hour, minute)}` : null;
  }
  if (NUMBER.test(dom) && dow === "*") return `day ${dom} of each month ${hhmm(hour, minute)}`;
  return null;
}

/** Short text for tables: `every day 08:00`, `Nov 20 09:00` (one-off), or the raw cron. */
export function scheduleText(schedule: Schedule, timezone: string, now: Date): string {
  if (schedule.type === "once") return absoluteTime(new Date(schedule.at), timezone, now);
  return describeCron(schedule.cron) ?? schedule.cron;
}
