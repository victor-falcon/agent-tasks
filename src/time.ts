/** Time zone of the machine, used when neither the task nor the config sets one. */
export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Requires a date, a time and an explicit offset, so the instant is never ambiguous.
const ISO_WITH_OFFSET_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * True for an ISO 8601 timestamp with an explicit offset (`Z` or `+01:00`).
 * Impossible dates (`2026-02-31`, hour 24) are rejected instead of rolling over.
 */
export function isIsoTimestamp(input: unknown): input is string {
  if (typeof input !== "string") return false;
  const m = ISO_WITH_OFFSET_RE.exec(input);
  if (!m) return false;
  const [year, month, day, hour, minute, second = 0, offH = 0, offM = 0] = m.slice(1).map((v) => (v === undefined ? undefined : Number(v)));
  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  return (
    month! >= 1 && month! <= 12 && day! >= 1 && day! <= daysInMonth &&
    hour! <= 23 && minute! <= 59 && second! <= 59 && offH! <= 23 && offM! <= 59 &&
    !Number.isNaN(Date.parse(input))
  );
}

export function parseIsoTimestamp(input: string): Date {
  if (!isIsoTimestamp(input)) {
    throw new Error(`invalid timestamp "${input}" (expected ISO 8601 with offset, e.g. 2026-11-17T09:00:00+01:00)`);
  }
  return new Date(input);
}

/** Formats an instant as ISO 8601 in the given time zone, e.g. `2026-11-17T09:00:00+01:00`. */
export function formatInZone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const local = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
  const asUtc = Date.parse(`${local}Z`);
  const offsetMin = Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
  if (offsetMin === 0) return `${local}Z`;
  const sign = offsetMin > 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${local}${sign}${hh}:${mm}`;
}
