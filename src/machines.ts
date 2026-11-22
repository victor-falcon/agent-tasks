import { type Check, fail, ok, warn } from "./checks.ts";
import type { UserConfig } from "./config.ts";
import { AgentTasksError } from "./errors.ts";
import type { Env } from "./paths.ts";
import { callRemote, isOldPeerError, MachineUnreachableError, REMOTE_PROTOCOL, type RemoteTarget } from "./ssh.ts";

// Checking that a machine answers over SSH (`remote ping`): used by
// `machines add|check`, `init --join` and `doctor`.

/** What `remote ping` answers (see remotePing). */
export interface PingAnswer {
  version: string;
  /** The name the machine gives itself. */
  machine: string;
  /** Its `hub.ssh`, or null on a hub. */
  hub: string | null;
  launcher: string;
  launcher_problems: string[];
}

/** What `remote ping` on a machine said, or why it could not be asked. */
export interface PingResult {
  machine: string;
  ssh: string;
  /** False when SSH could not connect (the machine may just be asleep). */
  reachable: boolean;
  /** The remote error (code and message) when it answered with one. */
  error: { code: string; message: string } | null;
  answer: PingAnswer | null;
}

const PING_TIMEOUT_MS = 30_000;

/** Asks a machine who it is. Never throws for what the machine (or SSH) says. */
export function pingMachine(target: RemoteTarget, env: Env): PingResult {
  const base = { machine: target.machine, ssh: target.ssh };
  try {
    return { ...base, reachable: true, error: null, answer: parsePing(callRemote(target, "ping", {}, env, PING_TIMEOUT_MS)) };
  } catch (err) {
    if (err instanceof MachineUnreachableError) return { ...base, reachable: false, error: { code: err.code, message: err.message }, answer: null };
    if (err instanceof AgentTasksError) return { ...base, reachable: true, error: { code: err.code, message: err.message.split("\n")[0]! }, answer: null };
    throw err;
  }
}

function parsePing(a: Record<string, unknown>): PingAnswer {
  const str = (v: unknown) => (typeof v === "string" ? v : String(v ?? "?"));
  return {
    version: str(a.version),
    machine: str(a.machine),
    hub: typeof a.hub === "string" ? a.hub : null,
    launcher: str(a.launcher),
    launcher_problems: Array.isArray(a.launcher_problems) ? a.launcher_problems.map(String) : [],
  };
}

/** The machines in the hub's registry reached over SSH, as targets. */
export function sshMachines(config: UserConfig): RemoteTarget[] {
  return Object.entries(config.machines ?? {}).flatMap(([machine, entry]) => (entry.ssh !== undefined ? [{ machine, ssh: entry.ssh }] : []));
}

const UPDATE_HINT = "(git pull, then bun install, in its agent-tasks checkout)";

/**
 * The hub's check of a machine in its registry: it answers with the same
 * protocol, calls itself by its registry name, is a client (so its
 * sub-agents' `finish` reaches the hub) and its launcher is ready. An
 * unreachable machine is a warning: machines sleep.
 */
export function registeredMachineCheck(result: PingResult): Check {
  const id = "machines.reachable";
  const who = `machine ${result.machine} (ssh ${result.ssh})`;
  if (!result.reachable) {
    return warn(id, `${who} is unreachable`, `check that "ssh ${result.ssh}" works without a password from the hub (it may just be asleep)`, [result.error!.message]);
  }
  if (result.error) return fail(id, `${who}: ${result.error.message}`, isOldPeerError(result.error) ? `update agent-tasks on ${result.machine} ${UPDATE_HINT}` : undefined);
  const a = result.answer!;
  if (a.machine !== result.machine) {
    return fail(id, `${who} calls itself "${a.machine}", not "${result.machine}"`, `set "machine": "${result.machine}" in its config, or register it under its own name`);
  }
  if (a.hub === null) {
    return fail(id, `${who} has no \`hub\` in its config: its sub-agents' "agent-tasks finish" would not reach this hub`, `run "agent-tasks init --join <alias of this hub> --machine ${result.machine}" on it`);
  }
  const about = `agent-tasks ${a.version}, launcher ${a.launcher}`;
  if (a.launcher_problems.length > 0) return fail(id, `${who}: its launcher is not ready (${about})`, `run "agent-tasks doctor" on ${result.machine}`, a.launcher_problems);
  return ok(id, `${who}: reachable, ${about}`);
}

/** Pings a machine of the registry and checks the answer. */
export function checkRegisteredMachine(target: RemoteTarget, env: Env): { result: PingResult; check: Check } {
  const result = pingMachine(target, env);
  return { result, check: registeredMachineCheck(result) };
}

/** A client's check of its hub: it answers, with the same protocol, and is a hub (not a client itself). */
export function hubCheck(result: PingResult): Check {
  const id = "hub.reachable";
  const alias = result.ssh;
  if (!result.reachable) {
    return fail(id, `the hub (ssh ${alias}) is unreachable`, `check that "ssh ${alias}" works without a password from here; every data command goes through it`, [result.error!.message]);
  }
  if (result.error) return fail(id, `the hub (ssh ${alias}): ${result.error.message}`, isOldPeerError(result.error) ? `update agent-tasks on both machines ${UPDATE_HINT}` : undefined);
  const a = result.answer!;
  if (a.hub !== null) return fail(id, `"${alias}" is not a hub: it is a client of "${a.hub}"`, `point "hub" in the config at the machine that holds the data`);
  return ok(id, `hub ${a.machine} (ssh ${alias}): reachable, agent-tasks ${a.version}, protocol ${REMOTE_PROTOCOL}`);
}
