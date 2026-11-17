import add from "./add.ts";
import attach from "./attach.ts";
import configCheck from "./config-check.ts";
import configInstructions from "./config-instructions.ts";
import configResolve from "./config-resolve.ts";
import doctor from "./doctor.ts";
import due from "./due.ts";
import edit from "./edit.ts";
import finish from "./finish.ts";
import help from "./help.ts";
import init from "./init.ts";
import install from "./install.ts";
import list from "./list.ts";
import log from "./log.ts";
import { machinesCommands } from "./machines.ts";
import pause from "./pause.ts";
import { remoteCommands } from "./remote.ts";
import resume from "./resume.ts";
import retry from "./retry.ts";
import rm from "./rm.ts";
import run from "./run.ts";
import runner from "./runner.ts";
import runnerStatus from "./runner-status.ts";
import runs from "./runs.ts";
import sessionClose from "./session-close.ts";
import sessionRead from "./session-read.ts";
import sessionStatus from "./session-status.ts";
import show from "./show.ts";
import status from "./status.ts";
import task from "./task.ts";
import tick from "./tick.ts";
import top from "./top.ts";
import type { Command } from "./types.ts";
import version from "./version.ts";

export type { Command } from "./types.ts";

/**
 * The only shared list of commands. Each command lives in its own file under
 * `src/commands/`; to add one, import it and add it here (keep the list sorted).
 */
export const commands: Command[] = [
  add,
  attach,
  configCheck,
  configInstructions,
  configResolve,
  doctor,
  due,
  edit,
  finish,
  help,
  init,
  install,
  list,
  log,
  ...machinesCommands,
  pause,
  ...remoteCommands,
  resume,
  retry,
  rm,
  run,
  runner,
  runnerStatus,
  runs,
  sessionClose,
  sessionRead,
  sessionStatus,
  show,
  status,
  task,
  tick,
  top,
  version,
];

export function findCommand(name: string): Command | undefined {
  return commands.find((c) => c.name === name);
}

/** Subcommands of a group such as `config` (commands named `config <sub>`). */
export function subcommandsOf(group: string): Command[] {
  return commands.filter((c) => c.name.startsWith(`${group} `));
}
