import { parseCommandArgs } from "../args.ts";
import { type Check, checksJson, hasErrors, renderCheck, renderChecks } from "../checks.ts";
import { isHub, localMachine, type MachineEntry } from "../config.ts";
import { type Context, output } from "../context.ts";
import { AgentTasksError, NotFoundError, UsageError } from "../errors.ts";
import { type PingResult, pingCheck, pingMachine, writeConfigKeys } from "../machines.ts";
import { tildify } from "../paths.ts";
import { Checker, checkMachineName } from "../schema.ts";
import { listTasks } from "../store.ts";
import type { Command } from "./types.ts";

// `agent-tasks machines …`: the hub's registry of the machines tasks run on
// (`machines` in its config). Run on a client, they are forwarded to the hub
// like any data command.

function requireHub(ctx: Context): void {
  if (!isHub(ctx.config.config)) throw new AgentTasksError("hub_only", "the machine registry is on the hub");
}

function registry(ctx: Context): Record<string, MachineEntry> {
  return ctx.config.config.machines ?? {};
}

function checkName(name: string): void {
  const c = new Checker();
  checkMachineName(c, name);
  if (c.errors.length > 0) throw new UsageError(`machine name ${c.errors[0]}`);
}

/** Pings a registered machine and turns the answer into a doctor line. */
export function checkRegisteredMachine(ctx: Context, name: string, ssh: string): { result: PingResult; check: Check } {
  const result = pingMachine({ machine: name, ssh }, ctx.env);
  return { result, check: pingCheck(result, { id: "machines.reachable", mustBeClient: true, unreachable: "warn" }) };
}

const list: Command = {
  name: "machines list",
  summary: "List the machines tasks can run on (the hub's registry)",
  usage: `Usage: agent-tasks machines list

Lists this hub (local) and the machines in \`machines\` in its config, with
the SSH alias the hub reaches each one with.`,
  run(ctx, args) {
    parseCommandArgs(args, {}, { maxPositionals: 0 });
    requireHub(ctx);
    const self = localMachine(ctx.config.config);
    const machines = [
      { name: self, local: true, ssh: null },
      ...Object.entries(registry(ctx))
        .filter(([name]) => name !== self)
        .map(([name, entry]) => ({ name, local: false, ssh: entry.ssh ?? null })),
    ];
    const width = Math.max(...machines.map((m) => m.name.length));
    output(ctx, { machines }, () => machines.map((m) => `${m.name.padEnd(width)}  ${m.local ? "local (this hub)" : `ssh ${m.ssh}`}`).join("\n"));
  },
};

const add: Command = {
  name: "machines add",
  summary: "Add a machine to the hub's registry (or change its SSH alias)",
  usage: `Usage: agent-tasks machines add <name> [--ssh <alias>]

Sets machines.<name> = { "ssh": "<alias>" } in the hub's config (the rest of
the file is kept as it is), then checks that the hub reaches the machine:
"ssh <alias> ~/.local/bin/agent-tasks remote ping" must answer, with the
same name and protocol. An unreachable machine is still added (with a
warning). "agent-tasks init --join" runs this for you.

Options:
  --ssh <alias>  The SSH host alias THIS hub uses to reach the machine
                 (default: the machine's name)`,
  run(ctx, args) {
    const { values, positionals } = parseCommandArgs(args, { ssh: { type: "string" } }, { minPositionals: 1, maxPositionals: 1 });
    requireHub(ctx);
    const name = positionals[0]!;
    checkName(name);
    const ssh = values.ssh ?? name;
    if (ssh.trim() === "") throw new UsageError("--ssh must not be empty");
    if (name === localMachine(ctx.config.config)) throw new UsageError(`"${name}" is this hub's own name; it is always local`);
    const before = registry(ctx)[name];
    const action = before?.ssh === ssh ? "unchanged" : before ? "updated" : "added";
    if (action !== "unchanged") writeConfigKeys(ctx.config.file, { machines: { ...registry(ctx), [name]: { ssh } } });
    const { result, check } = checkRegisteredMachine(ctx, name, ssh);
    const file = tildify(ctx.config.file, ctx.env);
    output(ctx, { machine: name, ssh, action, config: ctx.config.file, check, ping: result.answer }, () =>
      [`${action === "unchanged" ? "·" : "✓"} machine ${name} ${action} (ssh ${ssh}) in ${file}`, ...renderCheck(check)].join("\n"),
    );
    return check.status === "error" ? 1 : 0;
  },
};

const rm: Command = {
  name: "machines rm",
  summary: "Remove a machine from the hub's registry",
  usage: `Usage: agent-tasks machines rm <name>

Removes machines.<name> from the hub's config. Refused while tasks still
run on it: move them first with "agent-tasks edit <id> --machine <other>".`,
  run(ctx, args) {
    const { positionals } = parseCommandArgs(args, {}, { minPositionals: 1, maxPositionals: 1 });
    requireHub(ctx);
    const name = positionals[0]!;
    const { [name]: entry, ...rest } = registry(ctx);
    if (!entry) throw new NotFoundError(`machine "${name}" is not in the hub's \`machines\``);
    const tasks = listTasks(ctx.paths).items.filter((t) => t.machine === name);
    if (tasks.length > 0) {
      throw new AgentTasksError(
        "machine_in_use",
        `${tasks.length} task${tasks.length > 1 ? "s run" : " runs"} on machine "${name}"; move ${tasks.length > 1 ? "them" : "it"} first with agent-tasks edit <id> --machine <other>`,
        tasks.map((t) => t.id),
      );
    }
    writeConfigKeys(ctx.config.file, { machines: rest });
    output(ctx, { machine: name, action: "removed", config: ctx.config.file }, `✓ machine ${name} removed from ${tildify(ctx.config.file, ctx.env)}`);
  },
};

const check: Command = {
  name: "machines check",
  summary: "Check that the hub reaches each of its machines over SSH",
  usage: `Usage: agent-tasks machines check [<name>]

For each machine in the hub's registry (or just <name>), runs
"ssh <alias> ~/.local/bin/agent-tasks remote ping" and checks that it
answers with the same protocol, calls itself by the registry's name, is a
client of a hub (so its sub-agents report here), and that its launcher is
ready. An unreachable machine is a warning (machines sleep); the rest are
errors. "agent-tasks doctor" runs the same checks.`,
  run(ctx, args) {
    const { positionals } = parseCommandArgs(args, {}, { maxPositionals: 1 });
    requireHub(ctx);
    const machines = Object.entries(registry(ctx)).filter(([, e]) => e.ssh !== undefined);
    const name = positionals[0];
    if (name !== undefined && !machines.some(([n]) => n === name)) throw new NotFoundError(`machine "${name}" is not in the hub's \`machines\``);
    const checks = machines.filter(([n]) => name === undefined || n === name).map(([n, e]) => checkRegisteredMachine(ctx, n, e.ssh!).check);
    output(ctx, checksJson(checks), () => (checks.length === 0 ? "No machines in the registry." : renderChecks(checks)));
    return hasErrors(checks) ? 1 : 0;
  },
};

export const machinesCommands: Command[] = [add, check, list, rm];
