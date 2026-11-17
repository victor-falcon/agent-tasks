---
name: run-agent-task
description: Run one scheduled agent-tasks occurrence from start to finish. Use when started with "/run-agent-task <run_ref>" (the agent-tasks runner launches subagents this way); read the task, do it, and always report with agent-tasks finish.
argument-hint: <run_ref>
---

# Run a scheduled task

You were started by the agent-tasks runner to do one occurrence of a scheduled
task. `$ARGUMENTS` is its run ref (`<task-id>/<slot>`). You start with no other
context: everything you need is in what `agent-tasks task` prints.

1. Run `agent-tasks task $ARGUMENTS` and read all of it. Follow it exactly. The
   user instructions in it take priority over the defaults.
2. Do the work in the task's working directory (the `Working directory:` line).
   Stay within what the task asks for.
3. If you need a decision only a person can make, ask it and wait for the
   answer. Don't guess on anything that can't be undone. The runner shows you
   as blocked while you wait.
4. **Always** end with the finish command the task printed, also when the work
   failed or you could not start it:

   ```sh
   agent-tasks finish $ARGUMENTS --status succeeded --summary "<what you did, where the result is>" [--output-file <file>]
   agent-tasks finish $ARGUMENTS --status failed --summary "<what failed and why>"
   ```

   `succeeded` only when the task's done criteria are met. The summary is one
   or two sentences a person reads later, and may be sent to them as a
   notification (cut at 300 characters): lead with the result; put long output in a file and pass
   it with `--output-file`. `finish` saves the result and closes this session,
   so run it last. If it says the session was kept open (`keep_open`), the
   person may come back to it to talk about the result: stay available and
   answer them. If `agent-tasks task` itself fails, still run `finish` with
   `--status failed` and the error as the summary.

Rules:

- Never read or edit the agent-tasks data folder (`tasks/`, `runs/`, `state/`)
  by hand. Only use the `agent-tasks` CLI. The data may live on another
  machine (the hub): `task` and `finish` reach it by themselves, and
  `--output-file` is read on this machine and sent along.
- Don't start other agents or schedule new tasks unless the task says so.
