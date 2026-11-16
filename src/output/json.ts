/**
 * Version of the `--json` output. Adding fields keeps it; removing a field or
 * changing its meaning bumps it.
 */
export const JSON_SCHEMA_VERSION = 1;

/** `data` with `"schema": 1` first. */
export function withSchema<T extends object>(data: T): { schema: number } & T {
  return { schema: JSON_SCHEMA_VERSION, ...data };
}
