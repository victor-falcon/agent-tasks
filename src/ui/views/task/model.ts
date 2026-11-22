import { FORMATTERS } from "../../../commands/config-resolve.ts";
import { instructionsText, personalInstructions } from "../../../commands/show.ts";
import { formatSource, type ResolvedKey } from "../../../config.ts";
import type { Context } from "../../../context.ts";
import { isArchived, taskExists, readArchivedTask, readTask } from "../../../store.ts";
import type { ListSection } from "../../components/section-list.tsx";
import { runCells, type TaskItem, taskItem } from "../tasks/model.ts";

// What the Task detail shows, as plain data: the task (saved or archived),
// its instructions as written or as the agent receives them, its resolved
// settings with where each comes from, and its runs. Read from the data
// layer, like `agent-tasks show` and `config resolve` do (the same
// functions), so it works for archived tasks and needs no subprocess.

export const SUBTABS = ["overview", "instructions", "runs", "settings"] as const;
export type SubTab = (typeof SUBTABS)[number];

export const SUBTAB_TITLES: Record<SubTab, string> = { overview: "Overview", instructions: "Instructions", runs: "Runs", settings: "Settings" };

/** The task `id`, saved or archived; null when it is neither (removed meanwhile) or can't be read. */
export function readTaskItem(ctx: Context, id: string): { item: TaskItem | null; error: string | null } {
  try {
    if (taskExists(ctx.paths, id)) return { item: taskItem(ctx, readTask(ctx.paths, id), false), error: null };
    if (isArchived(ctx.paths, id)) return { item: taskItem(ctx, readArchivedTask(ctx.paths, id), true), error: null };
    return { item: null, error: `task "${id}" is not saved or archived any more` };
  } catch (err) {
    return { item: null, error: (err as Error).message };
  }
}

export interface Instructions {
  text: string;
  /** Personal instruction files the agent should get but that do not exist. */
  missing: string[];
  /** How many personal files are added to the task's own instructions. */
  personal: number;
}

/** The task's instructions as written, or (`asAgent`) as the agent receives them: `agent-tasks show <id> --instructions`. */
export function instructionsOf(ctx: Context, item: TaskItem, asAgent: boolean): Instructions {
  const personal = personalInstructions(ctx, item.resolution);
  const missing = personal.filter((p) => p.content === null).map((p) => p.path);
  return { text: asAgent ? instructionsText(ctx, item.task, personal) : item.task.instructions, missing, personal: personal.length };
}

export interface SettingRow {
  key: ResolvedKey;
  value: string;
  /** `task`, `profile ~/Projects/**`, `config`, `default (…)`. */
  source: string;
}

/** Every resolved setting and where it comes from: `agent-tasks config resolve <id>`. */
export function settingRows(ctx: Context, item: TaskItem): SettingRow[] {
  const r = item.resolution;
  return (Object.keys(FORMATTERS) as ResolvedKey[]).map((key) => ({ key, value: FORMATTERS[key](r, ctx), source: formatSource(r.sources[key]) }));
}

/** The task's runs, newest first, as one list section (row keys `runs:<ref>`). */
export function runSections(item: TaskItem, now: Date, timezone: string): ListSection[] {
  return [{ id: "runs", title: "Runs", rows: [...item.runs].reverse().map((r) => ({ key: `runs:${r.ref}`, cells: runCells(r, now, timezone) })), empty: "no runs yet" }];
}
