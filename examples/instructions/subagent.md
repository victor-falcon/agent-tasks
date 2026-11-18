<!--
Personal instructions for every task's subagent. `agent-tasks task <run_ref>`
adds this file to what the subagent reads, marked as user instructions that
take priority over the defaults. Lines inside these comments are left out, so
this file adds nothing until you write something outside them.

Write what an agent can't guess about your machine and habits. Examples:

- You run inside Herdr as a sub-agent of the agent-tasks runner. Use `hc` if
  you need to read or wait for another terminal; don't open new windows.
- If you need to start another agent, use `myagent`, never plain `claude`: it
  picks the right account for each project. It's a shell alias, so run it in
  an interactive shell.
- Don't run detached scripts (`nohup`, `setsid`).
- Don't read credentials other than the keychain items a task names; the
  environment comes from direnv.
- Write reports in English and keep them short.

Check what a subagent would get with:
  agent-tasks config instructions subagent
-->
