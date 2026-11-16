import configResolve from "./config-resolve.ts";
import help from "./help.ts";
import type { Command } from "./types.ts";
import version from "./version.ts";

export type { Command } from "./types.ts";

/**
 * The only shared list of commands. Each command lives in its own file under
 * `src/commands/`; to add one, import it and add it here (keep the list sorted).
 */
export const commands: Command[] = [
  configResolve,
  help,
  version,
];

export function findCommand(name: string): Command | undefined {
  return commands.find((c) => c.name === name);
}

/** Subcommands of a group such as `config` (commands named `config <sub>`). */
export function subcommandsOf(group: string): Command[] {
  return commands.filter((c) => c.name.startsWith(`${group} `));
}
