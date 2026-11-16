# Examples

- `config.example.json`: a starting point for `~/.config/agent-tasks/config.json`.
  Every field is optional; see `doc/roadmap/user-config.md`.
- `tasks/`: one one-off task (`once`) and one recurring task (`cron`), in the
  format stored in `<data_dir>/tasks/`.

The example tasks point at `~/Projects/example`, which `add` rejects if the
folder does not exist. Override it, and the id and dates, when trying one:

```sh
agent-tasks add - --cwd . --id my-deps-report < examples/tasks/weekly-deps-report.json
```

`add` replaces `created_at`, `updated_at` and `created_by` with the current values.
