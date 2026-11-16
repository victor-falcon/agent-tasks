import add from "./add.ts";
import configResolve from "./config-resolve.ts";
import due from "./due.ts";
import edit from "./edit.ts";
import help from "./help.ts";
import list from "./list.ts";
import pause from "./pause.ts";
import resume from "./resume.ts";
import rm from "./rm.ts";
import runs from "./runs.ts";
import show from "./show.ts";
import type { Command } from "./types.ts";
import version from "./version.ts";

export type { Command } from "./types.ts";

/**
 * The only shared list of commands. Each command lives in its own file under
 * `src/commands/`; to add one, import it and add it here (keep the list sorted).
 */
export const commands: Command[] = [
  add,
  configResolve,
  due,
  edit,
  help,
  list,
  pause,
  resume,
  rm,
  runs,
  show,
  version,
];

export function findCommand(name: string): Command | undefined {
  return commands.find((c) => c.name === name);
}

/** Subcommands of a group such as `config` (commands named `config <sub>`). */
export function subcommandsOf(group: string): Command[] {
  return commands.filter((c) => c.name.startsWith(`${group} `));
}
