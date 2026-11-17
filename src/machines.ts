import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Check, fail, ok, warn } from "./checks.ts";
import { configErrors } from "./config.ts";
import { formatJson, setTopLevelKeys } from "./config-edit.ts";
import { AgentTasksError } from "./errors.ts";
import type { Env } from "./paths.ts";
import { callRemote, MachineUnreachableError, type RemoteTarget } from "./ssh.ts";

// The machine registry (`machines` in the hub's config) and checking that a
// machine answers: `remote ping` over SSH. Used by `machines …`,
// `init --join` and `doctor`.

/** What `remote ping` on a machine said, or why it could not be asked. */
export interface PingResult {
  machine: string;
  ssh: string;
  /** False when SSH could not connect (the machine may just be asleep). */
  reachable: boolean;
  /** The remote error (code and message) when it answered with one. */
  error: { code: string; message: string } | null;
  /** The ping answer: protocol, version, machine, hub, launcher, launcher_problems. */
  answer: Record<string, unknown> | null;
}

export function pingMachine(target: RemoteTarget, env: Env): PingResult {
  const base = { machine: target.machine, ssh: target.ssh };
  try {
    return { ...base, reachable: true, error: null, answer: callRemote(target, "ping", {}, env, PING_TIMEOUT_MS) };
  } catch (err) {
    if (err instanceof MachineUnreachableError) return { ...base, reachable: false, error: { code: err.code, message: err.message }, answer: null };
    if (err instanceof AgentTasksError) return { ...base, reachable: true, error: { code: err.code, message: err.message.split("\n")[0]! }, answer: null };
    throw err;
  }
}

const PING_TIMEOUT_MS = 30_000;

export interface PingCheckOptions {
  /** Check id. */
  id: string;
  /** The machine must be a client (of a hub): true for the hub's registry. */
  mustBeClient: boolean;
  /** How serious an unreachable machine is: a warning for the hub's machines (they sleep). */
  unreachable: "warn" | "error";
}

/** One doctor line for a ping. */
export function pingCheck(result: PingResult, opts: PingCheckOptions): Check {
  const who = `machine ${result.machine} (ssh ${result.ssh})`;
  if (!result.reachable) {
    const report = opts.unreachable === "warn" ? warn : fail;
    return report(opts.id, `${who} is unreachable`, `check that "ssh ${result.ssh}" works without a password from here (it may just be asleep)`, [result.error!.message]);
  }
  if (result.error) {
    // An agent-tasks without `remote ping` rejects it as a usage error.
    const old = result.error.code === "usage" || result.error.code === "remote_protocol";
    return fail(opts.id, `${who}: ${result.error.message}`, old ? `update agent-tasks on ${result.machine} (git pull in its agent-tasks checkout)` : undefined);
  }
  const a = result.answer!;
  if (a.machine !== result.machine) {
    return fail(opts.id, `${who} calls itself "${String(a.machine)}", not "${result.machine}"`, `set "machine": "${result.machine}" in its config, or register it under its own name`);
  }
  if (opts.mustBeClient && (a.hub === null || a.hub === undefined)) {
    return fail(
      opts.id,
      `${who} has no \`hub\` in its config: its sub-agents' "agent-tasks finish" would not reach this hub`,
      `run "agent-tasks init --join <alias of this hub> --machine ${result.machine}" on it`,
    );
  }
  const problems = Array.isArray(a.launcher_problems) ? a.launcher_problems.map(String) : [];
  const about = `agent-tasks ${String(a.version)}, launcher ${String(a.launcher)}`;
  if (problems.length > 0) return fail(opts.id, `${who}: its launcher is not ready (${about})`, `run "agent-tasks doctor" on ${result.machine}`, problems);
  return ok(opts.id, `${who}: reachable, ${about}`);
}

/**
 * Sets top-level keys of config.json, keeping the rest of the file as it
 * is. A missing file is created with just these keys. Throws (with the lines
 * to write by hand) when the file can't be edited safely, and when the result
 * would not be a valid config.
 */
export function writeConfigKeys(file: string, values: Record<string, unknown>): void {
  const exists = existsSync(file);
  const text = exists ? readFileSync(file, "utf8") : "{}\n";
  const edited = setTopLevelKeys(text, values);
  if (edited === null) {
    const lines = Object.entries(values).map(([k, v]) => `"${k}": ${formatJson(v, "  ")},`);
    throw new AgentTasksError("config_not_edited", `could not edit ${file} safely; set these top-level keys in it by hand:`, lines);
  }
  const errors = configErrors(JSON.parse(edited));
  if (errors.length > 0) throw new AgentTasksError("invalid_config", `${file} would not be a valid config after this change:`, errors);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, edited.endsWith("\n") ? edited : `${edited}\n`);
  renameSync(tmp, file);
}
