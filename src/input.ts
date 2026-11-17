import { existsSync, readFileSync } from "node:fs";
import type { Context } from "./context.ts";
import { AgentTasksError, NotFoundError, UsageError } from "./errors.ts";
import { resolvePath } from "./paths.ts";
import { isObject } from "./schema.ts";

// Reading and checking command input: stdin, files, flag values.

/** Reads all of stdin as text. */
export async function readStdin(): Promise<string> {
  return await Bun.stdin.text();
}

/** Reads all of stdin as bytes (for files that may not be text). */
export async function readStdinBytes(): Promise<Uint8Array> {
  return await Bun.stdin.bytes();
}

/** Reads a file argument relative to the command's cwd, or stdin for "-". */
export async function readFileArg(ctx: Context, path: string): Promise<string> {
  if (path === "-") return await readStdin();
  const file = resolvePath(path, ctx.env, ctx.cwd);
  if (!existsSync(file)) throw new NotFoundError(`file not found: ${file}`);
  return readFileSync(file, "utf8");
}

/** Parses JSON read from stdin or a file, as an object. */
export function parseJsonObject(text: string, what: string): Record<string, unknown> {
  if (text.trim() === "") throw new AgentTasksError("invalid_json", `${what} is empty`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new AgentTasksError("invalid_json", `${what} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isObject(value)) throw new AgentTasksError("invalid_json", `${what} must be a JSON object`);
  return value;
}

/** A comma-separated flag value whose items must all be in `allowed`. */
export function parseEnumList<T extends string>(flag: string, value: string, allowed: readonly T[]): T[] {
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = items.find((s) => !(allowed as readonly string[]).includes(s));
  if (bad !== undefined || items.length === 0) throw new UsageError(`${flag}: unknown value "${bad ?? value}" (one or more of: ${allowed.join(", ")})`);
  return items as T[];
}

/** An integer flag value >= `min`. */
export function parseCount(flag: string, value: string, min: number): number {
  if (!/^\d+$/.test(value) || Number(value) < min) throw new UsageError(`${flag} must be an integer >= ${min} (got "${value}")`);
  return Number(value);
}
