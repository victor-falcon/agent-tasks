import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "./context.ts";
import { lastAttempt, readRunRef, requireTask } from "./execution.ts";
import { resolvePath } from "./paths.ts";
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
  finish_command: string;
  /** The rendered text, as printed without `--json`. */
  text: string;
}

export function finishCommand(ref: string): string {
  return `agent-tasks finish ${ref} --status succeeded|failed --summary "<what you did, where the result is>" [--output-file <file>]`;
}

function personalSection(items: PersonalInstructions[]): string {
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

export function taskContext(ctx: Context, ref: string): TaskContext {
  const run = readRunRef(ctx, ref);
  const task = requireTask(ctx, run.task_id);
  const resolution = ctx.resolveFor(task);
  const personal: PersonalInstructions[] = [];
  const missing: string[] = [];
  for (const file of resolution.instructions) {
    if (existsSync(file)) personal.push({ file, content: readFileSync(file, "utf8") });
    else missing.push(file);
  }
  const values = {
    title: task.title,
    task_id: task.id,
    run_ref: ref,
    slot: run.slot,
    attempt: String(lastAttempt(run)?.n ?? 1),
    cwd: resolvePath(task.cwd, ctx.env),
    instructions: task.instructions.trim(),
    finish_command: finishCommand(ref),
    personal_instructions: personalSection(personal),
  };
  const { template, source } = loadTaskTemplate(ctx);
  const text = `${render(template, { values }, source).replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
  return {
    run_ref: ref,
    task_id: task.id,
    title: task.title,
    slot: run.slot,
    attempt: Number(values.attempt),
    cwd: values.cwd,
    instructions: task.instructions,
    personal_instructions: personal,
    missing_instructions: missing,
    finish_command: values.finish_command,
    text,
  };
}
