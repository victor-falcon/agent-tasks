# agent-tasks

Scheduled tasks for coding agents. Tasks are JSON files. `agent-tasks runner`
is a plain process (not an agent) that you leave open in a terminal tab, for
example in Herdr. Every few minutes it checks what is due and launches a
sub-agent in the task's folder using launch commands from your own config
(presets for Herdr, Rex, tmux or a plain process). The sub-agent starts with
`/run-agent-task <run_ref>`, reads its task, does it, records the result and
closes itself. The runner shows every launch, success and failure live, and
every scheduled occurrence ends up recorded: succeeded, failed, timed out, or
missed (and why).

The CLI is the interface: `agent-tasks runner`, `status`, `list`, `runs`, `log`.

Personal setup (launch commands, which agent command to use, per-folder
profiles, notifications, extra instructions for agents) lives in
`~/.config/agent-tasks/`, never in this repo.

Status: planning. See [doc/roadmap](doc/roadmap/README.md).

## License

[MIT](LICENSE)
