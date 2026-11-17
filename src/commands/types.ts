import type { Context } from "../context.ts";

export interface Command {
  /** One word (`list`) or a group and a subcommand (`config resolve`). */
  name: string;
  /** One line for the command list. */
  summary: string;
  /** Full help: synopsis, arguments and options. */
  usage: string;
  /** Left out of the main command list (internal commands such as `remote …`). */
  hidden?: boolean;
  /** Receives the arguments after the command name, with the global flags removed. Returns the exit code. */
  run(ctx: Context, args: string[]): Promise<number | void> | number | void;
}
