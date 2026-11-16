import { AgentTasksError } from "./errors.ts";

/** A template variable: a value, a lazily computed value, or unavailable (`undefined`). */
export type VarValue = string | (() => string) | undefined;

export interface Vars {
  values: Record<string, VarValue>;
  /** Why a known variable is unavailable, e.g. "$HC_TERMINAL_ID is not set". */
  missing?: Record<string, string>;
  /** Environment behind `{{env.NAME}}` (e.g. `{{env.REX_SESSION}}`). */
  env?: Record<string, string | undefined>;
}

export class TemplateError extends AgentTasksError {
  constructor(message: string) {
    super("template", message);
  }
}

const VAR_RE = /\{\{\s*([a-z][a-z0-9_]*|env\.[A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Characters that never need quoting in a POSIX shell word. */
const SAFE_WORD_RE = /^[A-Za-z0-9_\/.:=@%+,-]+$/;

/** Quotes a string as one POSIX shell word: `it's` → `'it'\''s'`. */
export function shellQuote(value: string): string {
  if (SAFE_WORD_RE.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function lookup(vars: Vars, name: string, where: string): string {
  if (name.startsWith("env.")) {
    const key = name.slice("env.".length);
    const value = vars.env?.[key];
    if (!value) throw new TemplateError(`variable {{${name}}} in ${where} is not available: $${key} is not set`);
    return value;
  }
  if (!Object.hasOwn(vars.values, name)) {
    const known = Object.keys(vars.values).sort().join(", ");
    throw new TemplateError(`unknown variable {{${name}}} in ${where} (known: ${known}, env.NAME for an environment variable; add _quoted to any of them for a shell-quoted value)`);
  }
  const raw = vars.values[name];
  const value = typeof raw === "function" ? raw() : raw;
  if (value === undefined) {
    const why = vars.missing?.[name];
    throw new TemplateError(`variable {{${name}}} in ${where} is not available${why ? `: ${why}` : ""}`);
  }
  return value;
}

/** Value of a variable; `<name>_quoted` gives the shell-quoted value of `<name>`. */
export function getVar(vars: Vars, name: string, where: string): string {
  if (!Object.hasOwn(vars.values, name) && name.endsWith("_quoted")) {
    return shellQuote(lookup(vars, name.slice(0, -"_quoted".length), where));
  }
  return lookup(vars, name, where);
}

/** Replaces every `{{name}}` in `template`. Unknown or unavailable variables are errors. */
export function render(template: string, vars: Vars, where = "template"): string {
  return template.replace(VAR_RE, (_, name: string) => getVar(vars, name, where));
}

/** Names of the variables a template uses (without duplicates). */
export function variablesIn(template: string): string[] {
  return [...new Set([...template.matchAll(VAR_RE)].map((m) => m[1]!))];
}

/** Memoizes a lazy variable so it is computed at most once. */
export function once(fn: () => string): () => string {
  let value: string | undefined;
  return () => (value ??= fn());
}
