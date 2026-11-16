import { type Context, output } from "./context.ts";
import { UsageError } from "./errors.ts";
import type { Command } from "./commands/types.ts";

const GLOBAL_OPTIONS = `Global options:
  --json         Machine-readable output
  --now <iso>    Use this time as "now" (e.g. 2026-11-17T09:00:00+01:00)
  -h, --help     Show help`;

export function renderHelp(commands: Command[]): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  const list = commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`).join("\n");
  return `agent-tasks: a minimal scheduler for coding agents

Usage: agent-tasks <command> [options]

Commands:
${list}

${GLOBAL_OPTIONS}

Run "agent-tasks help <command>" for details on a command.
`;
}

export function renderCommandHelp(cmd: Command): string {
  return `${cmd.summary}\n\n${cmd.usage.trimEnd()}\n\n${GLOBAL_OPTIONS}\n`;
}

export function renderGroupHelp(group: string, subs: Command[]): string {
  const width = Math.max(...subs.map((c) => c.name.length));
  return `Usage: agent-tasks ${group} <subcommand> [options]\n\nSubcommands:\n${subs.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`).join("\n")}\n`;
}

function describe(cmd: Command) {
  return { name: cmd.name, summary: cmd.summary, usage: cmd.usage };
}

/** Prints general help, or the help of one command or group. */
export function printHelp(ctx: Context, commands: Command[], words: string[]): void {
  const name = words.join(" ");
  const findCommand = (n: string) => commands.find((c) => c.name === n);
  const subcommandsOf = (group: string) => commands.filter((c) => c.name.startsWith(`${group} `));
  if (!name) {
    output(ctx, { commands: commands.map(describe) }, () => renderHelp(commands));
    return;
  }
  const cmd = findCommand(name);
  if (cmd) {
    output(ctx, describe(cmd), () => renderCommandHelp(cmd));
    return;
  }
  const subs = subcommandsOf(name);
  if (subs.length > 0) {
    output(ctx, { group: name, commands: subs.map(describe) }, () => renderGroupHelp(name, subs));
    return;
  }
  throw new UsageError(`unknown command "${name}"`);
}

