const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const DURATION_RE = /^(?:\d+[smhd])+$/;

/** Parses durations such as `15m`, `2h`, `1d` or `1h30m` into milliseconds. */
export function parseDuration(input: string): number {
  const text = input.trim();
  if (!DURATION_RE.test(text)) {
    throw new Error(`invalid duration "${input}" (expected e.g. 30s, 15m, 2h, 1d or 1h30m)`);
  }
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+)([smhd])/g)) {
    total += Number(amount) * UNIT_MS[unit!]!;
  }
  if (total <= 0) throw new Error(`invalid duration "${input}": must be greater than zero`);
  return total;
}

export function isDuration(input: unknown): input is string {
  if (typeof input !== "string") return false;
  try {
    parseDuration(input);
    return true;
  } catch {
    return false;
  }
}

/** Formats milliseconds as the shortest duration string, e.g. `1h30m`. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  let rest = Math.round(ms / 1000) * 1000;
  let out = "";
  for (const unit of ["d", "h", "m", "s"]) {
    const size = UNIT_MS[unit]!;
    const n = Math.floor(rest / size);
    if (n > 0) {
      out += `${n}${unit}`;
      rest -= n * size;
    }
  }
  return out || "0s";
}
