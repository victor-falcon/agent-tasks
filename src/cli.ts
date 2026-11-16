import { commands, findCommand, subcommandsOf } from "./commands/index.ts";
import { createContext, type Writer } from "./context.ts";
import { AgentTasksError, UsageError } from "./errors.ts";
import type { Env } from "./paths.ts";
import { printHelp } from "./help.ts";
import { parseIsoTimestamp } from "./time.ts";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

export interface GlobalFlags {
  json: boolean;
  now: string | undefined;
  help: boolean;
  /** Everything that is not a global flag, in order. */
  rest: string[];
}

/** Pulls the global flags (`--json`, `--now`, `--help`) out of argv, wherever they are. Stops at `--`. */
export function extractGlobalFlags(argv: string[]): GlobalFlags {
  const flags: GlobalFlags = { json: false, now: undefined, help: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      flags.rest.push(...argv.slice(i));
      break;
    }
    if (arg === "--json") flags.json = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--now") {
      const value = argv[++i];
      if (value === undefined) throw new UsageError("--now needs a value, e.g. --now 2026-11-17T09:00:00+01:00");
      flags.now = value;
    } else if (arg.startsWith("--now=")) flags.now = arg.slice("--now=".length);
    else flags.rest.push(arg);
  }
  return flags;
}

export interface MainOptions {
  env?: Env;
  cwd?: string;
  stdout?: Writer;
  stderr?: Writer;
}

function reportError(err: unknown, json: boolean, stdout: Writer, stderr: Writer, hint?: string): void {
  const known = err instanceof AgentTasksError;
  const code = known ? err.code : "internal";
  const message = known ? err.message : String((err as Error)?.stack ?? err);
  if (json) {
    const details = known ? err.details : [];
    const summary = known && details.length > 0 ? message.split("\n")[0] : message;
    stdout.write(`${JSON.stringify({ error: { code, message: summary, details } }, null, 2)}\n`);
  } else {
    stderr.write(`agent-tasks: ${message}\n${hint ? `${hint}\n` : ""}`);
  }
}

/** Runs the CLI and returns the exit code. Never calls process.exit, so tests can call it. */
export async function main(argv: string[], opts: MainOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  let json = argv.includes("--json");
  let hint: string | undefined;
  try {
    const flags = extractGlobalFlags(argv);
    json = flags.json;
    const now = flags.now === undefined ? new Date() : parseNow(flags.now);
    const ctx = createContext({ now, json, env: opts.env ?? process.env, cwd: opts.cwd ?? process.cwd(), stdout, stderr, commands });

    const [first, second, ...more] = flags.rest;
    if (first === undefined) {
      printHelp(ctx, []);
      return EXIT_OK;
    }

    const pair = second !== undefined ? findCommand(`${first} ${second}`) : undefined;
    const cmd = pair ?? findCommand(first);
    const args = pair ? more : flags.rest.slice(1);
    hint = `Run "agent-tasks help${cmd && cmd.name !== "help" ? ` ${cmd.name}` : ""}" for usage.`;

    if (!cmd) {
      const subs = subcommandsOf(first);
      if (subs.length === 0) throw new UsageError(`unknown command "${first}"`);
      if (flags.help) {
        printHelp(ctx, [first]);
        return EXIT_OK;
      }
      hint = `Run "agent-tasks help ${first}" for its subcommands.`;
      const names = subs.map((c) => c.name.slice(first.length + 1)).join(", ");
      throw new UsageError(second === undefined ? `"${first}" needs a subcommand: ${names}` : `unknown command "${first} ${second}" (subcommands: ${names})`);
    }
    if (flags.help) {
      printHelp(ctx, cmd.name.split(" "));
      return EXIT_OK;
    }
    return (await cmd.run(ctx, args)) ?? EXIT_OK;
  } catch (err) {
    reportError(err, json, stdout, stderr, err instanceof UsageError ? (hint ?? 'Run "agent-tasks help" for usage.') : undefined);
    return err instanceof UsageError ? EXIT_USAGE : EXIT_ERROR;
  }
}

function parseNow(value: string): Date {
  try {
    return parseIsoTimestamp(value);
  } catch (err) {
    throw new UsageError(`--now: ${(err as Error).message}`);
  }
}
