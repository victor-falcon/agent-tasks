// Fake coding agent for the integration tests. It does what the
// run-agent-task skill does: reads its run with `agent-tasks task` and
// reports with `agent-tasks finish`. The task's instructions pick the
// behaviour with a line `MODE: <mode>`:
//   succeed     finish --status succeeded, with an --output-file
//   fail        finish --status failed
//   fail-first  fail on attempt 1, succeed afterwards
//   exit        exit without calling finish
//   hang        never finish (for timeouts)
// It prints the prompt it got, so tests can check quoting.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const prompt = process.argv.at(-1) ?? "";
process.stdout.write(`prompt: ${prompt}\n`);
const ref = process.env.AGENT_TASKS_RUN!;

function cli(...args: string[]) {
  const result = Bun.spawnSync(["agent-tasks", ...args], { env: process.env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) process.stderr.write(result.stderr.toString());
  return result.stdout.toString();
}

const task = JSON.parse(cli("task", ref, "--json"));
const mode = /MODE: (\S+)/.exec(task.instructions)?.[1] ?? "succeed";

switch (mode) {
  case "succeed": {
    const out = join(task.cwd, `report-${task.attempt}.md`);
    writeFileSync(out, `# Report for ${ref}\n`);
    cli("finish", ref, "--status", "succeeded", "--summary", `did it (attempt ${task.attempt})`, "--output-file", out);
    break;
  }
  case "fail":
    cli("finish", ref, "--status", "failed", "--summary", "could not do it");
    break;
  case "fail-first":
    if (task.attempt === 1) cli("finish", ref, "--status", "failed", "--summary", "first try failed");
    else cli("finish", ref, "--status", "succeeded", "--summary", `worked on attempt ${task.attempt}`);
    break;
  case "exit":
    process.exit(3);
  case "hang":
    setInterval(() => {}, 1000);
    break;
}
