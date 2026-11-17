import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "./context.ts";
import { lastAttempt, readRunRef, requireTask } from "./execution.ts";
import { resolvePath } from "./paths.ts";
import { callMachine, machineTarget } from "./session-ops.ts";
import type { Task } from "./schema.ts";
import { render, TemplateError, variablesIn } from "./template.ts";

// What `agent-tasks task <run_ref>` prints for the subagent
// (doc/roadmap/phase-1-core.md, "The subagent").

export const DEFAULT_TASK_TEMPLATE = `Task "{{title}}" ({{task_id}}), slot {{slot}}, attempt {{attempt}}
Working directory: {{cwd}}

{{instructions}}

{{personal_instructions}}

When you are done, or if it fails, run:
  {{finish_command}}
`;

export const TASK_TEMPLATE_VARIABLES = ["title", "task_id", "run_ref", "slot", "attempt", "cwd", "instructions", "finish_command", "personal_instructions"];

export interface PersonalInstructions {
  file: string;
  content: string;
}

export interface TaskContext {
  run_ref: string;
  task_id: string;
  title: string;
  slot: string;
  attempt: number;
  cwd: string;
  instructions: string;
  personal_instructions: PersonalInstructions[];
  /** Instruction files listed in the config that do not exist. */
  missing_instructions: string[];
  /** Problems that did not stop the command (e.g. the task's machine was unreachable). */
  warnings: string[];
  finish_command: string;
  /** The rendered text, as printed without `--json`. */
  text: string;
}

export function finishCommand(ref: string): string {
  return `agent-tasks finish ${ref} --status succeeded|failed --summary "<what you did, where the result is>" [--output-file <file>]`;
}

/** Drops `<!-- … -->` comments, so files with only commented examples add nothing. */
export function stripComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** Reads personal instruction files; empty ones (only comments) are skipped, missing ones are listed. */
export function loadPersonalInstructions(files: readonly string[]): { personal: PersonalInstructions[]; missing: string[] } {
  const personal: PersonalInstructions[] = [];
  const missing: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) missing.push(file);
    else {
      const content = stripComments(readFileSync(file, "utf8"));
      if (content !== "") personal.push({ file, content });
    }
  }
  return { personal, missing };
}

export function personalSection(items: readonly PersonalInstructions[]): string {
  if (items.length === 0) return "";
  return `User instructions (they take priority over the defaults above):\n\n${items.map((i) => i.content.trim()).join("\n\n")}`;
}

export function loadTaskTemplate(ctx: Context): { template: string; source: string } {
  const file = join(ctx.paths.templatesDir, "task.md");
  if (!existsSync(file)) return { template: DEFAULT_TASK_TEMPLATE, source: "the built-in task template" };
  const template = readFileSync(file, "utf8");
  if (!variablesIn(template).includes("finish_command")) {
    throw new TemplateError(`${file} does not use {{finish_command}}: without it the agent cannot report and every run would end as exited_without_report`);
  }
  return { template, source: file };
}

/** The personal instruction files of a task, read now: the ones found and the missing paths. */
export function readPersonalInstructions(ctx: Context, task: Task): { personal: PersonalInstructions[]; missing: string[] } {
  return loadPersonalInstructions(ctx.resolveFor(task).instructions);
}

/** The text the subagent reads: the task template filled for one run (also used by `show --instructions`). */
export function renderTaskText(ctx: Context, task: Task, run: { ref: string; slot: string; attempt: number; cwd?: string }, personal: readonly PersonalInstructions[]): string {
  const values = {
    title: task.title,
    task_id: task.id,
    run_ref: run.ref,
    slot: run.slot,
    attempt: String(run.attempt),
    cwd: run.cwd ?? resolvePath(task.cwd, ctx.env),
    instructions: task.instructions.trim(),
    finish_command: finishCommand(run.ref),
    personal_instructions: personalSection(personal),
  };
  const { template, source } = loadTaskTemplate(ctx);
  return `${render(template, { values }, source).replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

interface WhereItRuns {
  /** The task folder, absolute, on the machine that runs the task. */
  cwd: string;
  personal: PersonalInstructions[];
  missing: string[];
  warnings: string[];
}

/**
 * The task folder and personal instructions as the machine that runs the
 * task resolves them: here, or with `remote instructions` over SSH (that
 * machine's config and home). When it cannot be asked, the folder stays as
 * stored and a warning says the personal instructions are missing.
 */
function whereItRuns(ctx: Context, task: Task): WhereItRuns {
  const target = machineTarget(ctx, task.machine);
  if (!target) return { cwd: resolvePath(task.cwd, ctx.env), ...readPersonalInstructions(ctx, task), warnings: [] };
  try {
    const r = callMachine(ctx, target, "instructions", { task: { cwd: task.cwd, agent: task.agent ?? null } });
    const personal = Array.isArray(r.personal_instructions) ? (r.personal_instructions as PersonalInstructions[]) : [];
    const missing = Array.isArray(r.missing_instructions) ? r.missing_instructions.map(String) : [];
    return { cwd: typeof r.cwd === "string" ? r.cwd : task.cwd, personal, missing, warnings: [] };
  } catch (err) {
    return { cwd: task.cwd, personal: [], missing: [], warnings: [`could not read the personal instructions on machine "${target.machine}": ${(err as Error).message}`] };
  }
}

export function taskContext(ctx: Context, ref: string): TaskContext {
  const run = readRunRef(ctx, ref);
  const task = requireTask(ctx, run.task_id);
  const { cwd, personal, missing, warnings } = whereItRuns(ctx, task);
  const attempt = lastAttempt(run)?.n ?? 1;
  return {
    run_ref: ref,
    task_id: task.id,
    title: task.title,
    slot: run.slot,
    attempt,
    cwd,
    instructions: task.instructions,
    personal_instructions: personal,
    missing_instructions: missing,
    warnings,
    finish_command: finishCommand(ref),
    text: renderTaskText(ctx, task, { ref, slot: run.slot, attempt, cwd }, personal),
  };
}
