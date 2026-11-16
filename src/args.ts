import { parseArgs, type ParseArgsConfig } from "node:util";
import { UsageError } from "./errors.ts";

type Options = NonNullable<ParseArgsConfig["options"]>;

/**
 * Parses a command's own arguments with `util.parseArgs`, turning its errors
 * into usage errors (exit code 2).
 */
export function parseCommandArgs<O extends Options>(args: string[], options: O, { minPositionals = 0, maxPositionals = Number.POSITIVE_INFINITY } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const n = parsed.positionals.length;
  if (n < minPositionals) throw new UsageError(`missing argument${minPositionals - n > 1 ? "s" : ""}`);
  if (n > maxPositionals) throw new UsageError(`unexpected argument "${parsed.positionals[maxPositionals]}"`);
  return parsed;
}
