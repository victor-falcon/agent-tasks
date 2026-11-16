import { parseCommandArgs } from "../args.ts";
import { printHelp } from "../help.ts";
import type { Command } from "./types.ts";

const help: Command = {
  name: "help",
  summary: "Show help for all commands or for one",
  usage: "Usage: agent-tasks help [<command>]",
  run(ctx, args) {
    const { positionals } = parseCommandArgs(args, {}, { maxPositionals: 2 });
    printHelp(ctx, positionals);
  },
};

export default help;
