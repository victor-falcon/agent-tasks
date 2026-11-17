// Results of `config check` and `doctor`: one line per check with ✓ / ! / ✕
// and, when something is wrong, how to fix it.

export type CheckStatus = "ok" | "warn" | "error";

export interface Check {
  /** Stable id, e.g. `config.load` or `launcher.command`. */
  id: string;
  status: CheckStatus;
  message: string;
  /** How to fix it; only for `warn` and `error`. */
  hint?: string;
  /** Extra lines, e.g. every problem in an invalid config. */
  details?: string[];
}

const SYMBOLS: Record<CheckStatus, string> = { ok: "✓", warn: "!", error: "✕" };

export function ok(id: string, message: string): Check {
  return { id, status: "ok", message };
}

export function warn(id: string, message: string, hint?: string, details?: string[]): Check {
  return { id, status: "warn", message, ...(hint ? { hint } : {}), ...(details?.length ? { details } : {}) };
}

export function fail(id: string, message: string, hint?: string, details?: string[]): Check {
  return { id, status: "error", message, ...(hint ? { hint } : {}), ...(details?.length ? { details } : {}) };
}

export function hasErrors(checks: readonly Check[]): boolean {
  return checks.some((c) => c.status === "error");
}

/** The lines of one check: the message, its details and how to fix it. */
export function renderCheck(c: Check): string[] {
  return [`${SYMBOLS[c.status]} ${c.message}`, ...(c.details ?? []).map((d) => `    - ${d}`), ...(c.hint ? [`    fix: ${c.hint}`] : [])];
}

export function renderChecks(checks: readonly Check[]): string {
  const lines = checks.flatMap(renderCheck);
  const errors = checks.filter((c) => c.status === "error").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  lines.push("", errors === 0 && warnings === 0 ? "All checks passed." : `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}.`);
  return lines.join("\n");
}

/** `{ ok, checks }` for `--json`. */
export function checksJson(checks: readonly Check[]): { ok: boolean; checks: readonly Check[] } {
  return { ok: !hasErrors(checks), checks };
}
