import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import pkg from "../../package.json" with { type: "json" };
import type { Command } from "./types.ts";

const version: Command = {
  name: "version",
  summary: "Print the agent-tasks version",
  usage: "Usage: agent-tasks version",
  run(ctx, args) {
    parseCommandArgs(args, {}, { maxPositionals: 0 });
    output(ctx, { name: pkg.name, version: pkg.version }, `${pkg.name} ${pkg.version}`);
  },
};

export default version;
