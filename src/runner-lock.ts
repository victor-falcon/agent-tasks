import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AgentTasksError } from "./errors.ts";
import type { DataPaths } from "./paths.ts";
import { createJsonExclusive, writeJsonAtomic } from "./store.ts";

// Only one runner at a time: `state/runner.lock` holds the live runner's pid,
// terminal and interval, and its last and next tick (rewritten every tick).
// A lock whose pid no longer exists is stale and is taken over.

export interface RunnerLock {
  pid: number;
  /** `$HC_TERMINAL_ID` of the runner's terminal, when it runs in Herdr. */
  terminal: string | null;
  started_at: string;
  every: string;
  last_tick_at?: string | null;
  next_tick_at?: string | null;
}

export function runnerLockPath(paths: DataPaths): string {
  return join(paths.stateDir, "runner.lock");
}

export function runnerLogPath(paths: DataPaths): string {
  return join(paths.stateDir, "runner.log");
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const str = (v: unknown): v is string => typeof v === "string";
const optStr = (v: unknown) => v === undefined || v === null || str(v);

/** The lock's content, or null when there is none or it is not a valid lock. */
export function readRunnerLock(paths: DataPaths): RunnerLock | null {
  const file = runnerLockPath(paths);
  if (!existsSync(file)) return null;
  try {
    const lock = JSON.parse(readFileSync(file, "utf8"));
    const valid = Number.isInteger(lock?.pid) && optStr(lock.terminal) && str(lock.started_at) && str(lock.every) && optStr(lock.last_tick_at) && optStr(lock.next_tick_at);
    return valid ? { terminal: null, ...lock } : null;
  } catch {
    return null;
  }
}

export class RunnerLockedError extends AgentTasksError {
  constructor(readonly holder: RunnerLock) {
    const where = holder.terminal ? ` in terminal ${holder.terminal}` : "";
    super("runner_running", `a runner is already running (pid ${holder.pid}${where}, since ${holder.started_at}, every ${holder.every}). Stop it first, or check it with "agent-tasks runner status".`);
  }
}

function sameLock(a: RunnerLock | null, b: RunnerLock | null): boolean {
  return a?.pid === b?.pid && a?.started_at === b?.started_at;
}

/**
 * Takes the runner lock. Throws `RunnerLockedError` if a live process holds
 * it; a stale one (dead pid, or not a valid lock) is removed and taken over.
 * The lock file is created complete (temp file + link), so another runner
 * never reads it half-written. Returns the previous stale holder, if any.
 */
export function acquireRunnerLock(paths: DataPaths, lock: RunnerLock, alive: (pid: number) => boolean = pidAlive): { stale: RunnerLock | null } {
  mkdirSync(paths.stateDir, { recursive: true });
  const file = runnerLockPath(paths);
  let stale: RunnerLock | null = null;
  for (let i = 0; i < 5; i++) {
    if (createJsonExclusive(file, lock)) return { stale };
    const holder = readRunnerLock(paths);
    if (holder && holder.pid !== lock.pid && alive(holder.pid)) throw new RunnerLockedError(holder);
    // Remove it only if it is still the stale lock we looked at: another runner may have just taken it over.
    if (!sameLock(readRunnerLock(paths), holder)) continue;
    stale = holder;
    rmSync(file, { force: true });
  }
  throw new AgentTasksError("runner_running", `could not take ${file}: another runner keeps taking it`);
}

/** Rewrites the lock (last/next tick) if this process still holds it. */
export function updateRunnerLock(paths: DataPaths, lock: RunnerLock): void {
  if (readRunnerLock(paths)?.pid !== lock.pid) return;
  writeJsonAtomic(runnerLockPath(paths), lock);
}

/** Removes the lock if this process still holds it. */
export function releaseRunnerLock(paths: DataPaths, pid: number): void {
  if (readRunnerLock(paths)?.pid === pid) rmSync(runnerLockPath(paths), { force: true });
}
