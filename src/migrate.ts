import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DataPaths } from "./paths.ts";
import { isObject, orderTaskKeys } from "./schema.ts";
import { writeJsonAtomic } from "./store.ts";

// One-off rewrites of data files written by older versions. Each step only
// touches files that still need it, so running them on every start is safe.

function taskFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .map((f) => join(dir, f));
  } catch (err) {
    // No data folder yet, or a broken one: nothing to migrate; `doctor` reports the latter.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
}

/** The task in `file` if it still lacks a `machine`; null for anything else (migrated, unreadable, not a task). */
function taskWithoutMachine(file: string): Record<string, unknown> | null {
  try {
    const task: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isObject(task) && !("machine" in task) ? task : null;
  } catch {
    return null;
  }
}

/**
 * Gives every task (saved or archived) without a `machine` this machine's
 * name: before multi-machine support, every task ran where the data lives.
 *
 * Never fails: a file that can't be parsed or rewritten (a read-only data
 * folder) is left alone, and reading it reports the problem as usual. There
 * is no lock: an edit of the same task landing between the read and the
 * write would be lost. The window is a few milliseconds, once per task, on
 * the first run after the upgrade. Returns the files it rewrote.
 */
export function migrateTaskMachines(paths: DataPaths, machine: string): string[] {
  const rewritten: string[] = [];
  for (const file of [...taskFiles(paths.tasksDir), ...taskFiles(paths.archiveDir)]) {
    const task = taskWithoutMachine(file);
    if (!task) continue;
    try {
      writeJsonAtomic(file, orderTaskKeys({ ...task, machine }));
      rewritten.push(file);
    } catch {
      // Left as is: the task then fails validation ("machine: …") where it is read.
    }
  }
  return rewritten;
}

/** Brings the data folder up to date. Run once per process for each data folder, before anything reads it. */
export function migrateData(paths: DataPaths, machine: string): void {
  migrateTaskMachines(paths, machine);
}
