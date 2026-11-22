import { forwardToHub, runsLocally } from "./client.ts";
import { commands, findCommand, subcommandsOf } from "./commands/index.ts";
import { createContext, type Writer } from "./context.ts";
import { AgentTasksError, EXIT_ERROR, EXIT_OK, EXIT_USAGE, UsageError } from "./errors.ts";
import type { Env } from "./paths.ts";
import { printHelp } from "./help.ts";
import { withSchema } from "./output/json.ts";
import { CLIENT_PROTOCOL_FLAG, REMOTE_PROTOCOL } from "./ssh.ts";
import { parseIsoTimestamp } from "./time.ts";

export { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "./errors.ts";

export interface GlobalFlags {
  json: boolean;
  now: string | undefined;
  help: boolean;
  /** `--client-protocol`: set by a client forwarding the command to this hub. */
  clientProtocol: string | undefined;
  /** Everything that is not a global flag, in order. */
  rest: string[];
}

/** Pulls the global flags (`--json`, `--now`, `--help`) out of argv, wherever they are. Stops at `--`. */
export function extractGlobalFlags(argv: string[]): GlobalFlags {
  const flags: GlobalFlags = { json: false, now: undefined, help: false, clientProtocol: undefined, rest: [] };
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
    else if (arg.startsWith(`${CLIENT_PROTOCOL_FLAG}=`)) flags.clientProtocol = arg.slice(CLIENT_PROTOCOL_FLAG.length + 1);
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
    stdout.write(`${JSON.stringify(withSchema({ error: { code, message: summary, details } }), null, 2)}\n`);
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
    if (flags.clientProtocol !== undefined) checkClientProtocol(flags.clientProtocol);
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
    const hub = runsLocally(cmd.name) ? undefined : ctx.config.config.hub;
    // A forwarded command that reaches another client would be forwarded again, maybe in a loop.
    if (hub && flags.clientProtocol !== undefined) {
      throw new AgentTasksError("not_a_hub", `a client forwarded "${cmd.name}" here, but this machine is not the hub either (its config has \`hub\`: "${hub.ssh}"); point the client's \`hub\` at the machine that holds the data`);
    }
    if (hub) return await forwardToHub(ctx, hub.ssh, cmd.name, args, forwardedGlobals(flags));
    return (await cmd.run(ctx, args)) ?? EXIT_OK;
  } catch (err) {
    reportError(err, json, stdout, stderr, err instanceof UsageError ? (hint ?? 'Run "agent-tasks help" for usage.') : undefined);
    return err instanceof UsageError ? EXIT_USAGE : EXIT_ERROR;
  }
}

/** The global flags a client passes on to the hub with a forwarded command. */
function forwardedGlobals(flags: GlobalFlags): string[] {
  return [...(flags.json ? ["--json"] : []), ...(flags.now !== undefined ? [`--now=${flags.now}`] : [])];
}

/** On the hub: refuses a command forwarded by a client that speaks another protocol. */
function checkClientProtocol(value: string): void {
  if (value === String(REMOTE_PROTOCOL)) return;
  const theirs = Number(value);
  if (!/^\d+$/.test(value)) throw new UsageError(`${CLIENT_PROTOCOL_FLAG} must be a protocol number (got ${JSON.stringify(value)})`);
  const update = theirs < REMOTE_PROTOCOL ? "the client" : "this hub";
  throw new AgentTasksError(
    "protocol_mismatch",
    `the client speaks agent-tasks protocol ${theirs} and this hub speaks ${REMOTE_PROTOCOL}; update agent-tasks on ${update} (git pull, then bun install, in its agent-tasks checkout)`,
  );
}

function parseNow(value: string): Date {
  try {
    return parseIsoTimestamp(value);
  } catch (err) {
    throw new UsageError(`--now: ${(err as Error).message}`);
  }
}
