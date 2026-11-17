import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DataPaths } from "./paths.ts";
import { isObject } from "./schema.ts";
import { writeJsonAtomic } from "./store.ts";
import { orderTaskKeys } from "./task-flags.ts";

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

/**
 * Gives every task (saved or archived) without a `machine` this machine's
 * name: before multi-machine support, every task ran where the data lives.
 * Files that can't be parsed are left alone; reading them reports the problem
 * as usual. Returns the files it rewrote.
 */
export function migrateTaskMachines(paths: DataPaths, machine: string): string[] {
  const rewritten: string[] = [];
  for (const file of [...taskFiles(paths.tasksDir), ...taskFiles(paths.archiveDir)]) {
    let task: unknown;
    try {
      task = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!isObject(task) || "machine" in task) continue;
    writeJsonAtomic(file, orderTaskKeys({ ...task, machine }));
    rewritten.push(file);
  }
  return rewritten;
}

/** Brings the data folder up to date. Run once per process for each data folder, before anything reads it. */
export function migrateData(paths: DataPaths, machine: string): void {
  migrateTaskMachines(paths, machine);
}
